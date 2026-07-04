#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { importTs } from './lib/ts-import.mjs';

const {
  buildCachedLocalWaveSnapshot,
  downsampleTo16k,
  encodeWavePcm16,
  flattenFloat32Chunks,
} = await importTs(path.resolve('src/renderer/src/SuperCmdWhisper.tsx'), {
  stubs: {
    './i18n': 'export function useI18n() { return { t: (key) => key }; }',
    './utils/hyper-key': 'export function formatShortcutForDisplay(value) { return value || ""; }',
  },
});

function makeChunks({ seconds, sampleRate = 16000, chunkSize = 4096 }) {
  const totalSamples = seconds * sampleRate;
  const chunks = [];
  for (let offset = 0; offset < totalSamples; offset += chunkSize) {
    const length = Math.min(chunkSize, totalSamples - offset);
    const chunk = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      chunk[i] = Math.sin((offset + i) / 29) * 0.3;
    }
    chunks.push(chunk);
  }
  return chunks;
}

function legacySnapshot(chunks, sampleRate) {
  const merged = flattenFloat32Chunks(chunks);
  const downsampled = downsampleTo16k(merged, sampleRate);
  return encodeWavePcm16(downsampled, 16000);
}

function benchSnapshots(chunks, sampleRate) {
  const stepChunks = Math.max(1, Math.round((sampleRate * 3.5) / 4096));
  const windows = [];
  for (let count = stepChunks; count < chunks.length; count += stepChunks) {
    windows.push(count);
  }
  windows.push(chunks.length);

  let legacyBytes = 0;
  const legacyStart = performance.now();
  for (const count of windows) {
    legacyBytes += legacySnapshot(chunks.slice(0, count), sampleRate).byteLength;
  }
  const legacyMs = performance.now() - legacyStart;

  let cache = null;
  let cachedBytes = 0;
  const cachedStart = performance.now();
  for (const count of windows) {
    const result = buildCachedLocalWaveSnapshot(chunks.slice(0, count), sampleRate, cache);
    cache = result.cache;
    cachedBytes += result.buffer?.byteLength || 0;
  }
  const cachedMs = performance.now() - cachedStart;

  return {
    cachedBytes,
    cachedMs,
    legacyBytes,
    legacyMs,
    snapshots: windows.length,
  };
}

test('cached local WAV snapshots preserve 16 kHz output and reduce repeated encode work', (t) => {
  const chunks = makeChunks({ seconds: 30 });
  const legacy = legacySnapshot(chunks, 16000);
  const cached = buildCachedLocalWaveSnapshot(chunks, 16000, null);

  assert.equal(cached.buffer?.byteLength, legacy.byteLength);
  assert.deepEqual(new Uint8Array(cached.buffer), new Uint8Array(legacy));

  const chunks48k = makeChunks({ seconds: 30, sampleRate: 48000 });
  const legacy48k = legacySnapshot(chunks48k, 48000);
  const cached48k = buildCachedLocalWaveSnapshot(chunks48k, 48000, null);
  assert.equal(cached48k.buffer?.byteLength, legacy48k.byteLength);
  assert.deepEqual(new Uint8Array(cached48k.buffer), new Uint8Array(legacy48k));

  const bench30 = benchSnapshots(makeChunks({ seconds: 30, sampleRate: 48000 }), 48000);
  const bench120 = benchSnapshots(makeChunks({ seconds: 120, sampleRate: 48000 }), 48000);

  t.diagnostic(
    `[whisper-local-wave] 30s before=${bench30.legacyMs.toFixed(2)}ms after=${bench30.cachedMs.toFixed(2)}ms snapshots=${bench30.snapshots} bytes=${bench30.cachedBytes}`
  );
  t.diagnostic(
    `[whisper-local-wave] 2m before=${bench120.legacyMs.toFixed(2)}ms after=${bench120.cachedMs.toFixed(2)}ms snapshots=${bench120.snapshots} bytes=${bench120.cachedBytes}`
  );

  assert.equal(bench30.cachedBytes, bench30.legacyBytes);
  assert.equal(bench120.cachedBytes, bench120.legacyBytes);
});
