#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const fileSizeMb = Number.parseInt(process.env.SUPERCMD_CANVAS_ASSET_MB || '32', 10);
const iterations = Number.parseInt(process.env.SUPERCMD_CANVAS_ASSET_ITERATIONS || '8', 10);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-canvas-asset-delay-'));
const assetPath = path.join(tmpDir, 'asset.bin');

function summarize(histogram, elapsedMs) {
  return {
    elapsedMs: Number(elapsedMs.toFixed(3)),
    meanDelayMs: Number((histogram.mean / 1e6).toFixed(3)),
    maxDelayMs: Number((histogram.max / 1e6).toFixed(3)),
    p95DelayMs: Number((histogram.percentile(95) / 1e6).toFixed(3)),
  };
}

async function measure(label, fn) {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  const started = performance.now();
  await fn();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const elapsedMs = performance.now() - started;
  histogram.disable();
  return { label, ...summarize(histogram, elapsedMs) };
}

try {
  fs.writeFileSync(assetPath, Buffer.alloc(fileSizeMb * 1024 * 1024, 7));

  const syncRead = await measure('sync-readFileSync-baseline', async () => {
    for (let index = 0; index < iterations; index += 1) {
      fs.readFileSync(assetPath);
    }
  });

  const asyncRead = await measure('async-fs.promises.readFile', async () => {
    for (let index = 0; index < iterations; index += 1) {
      await fs.promises.readFile(assetPath);
    }
  });

  console.log(JSON.stringify({
    fileSizeMb,
    iterations,
    measurements: [syncRead, asyncRead],
  }, null, 2));
} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}
