#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

function loadPlatformRuntimeWithObservedMaps() {
  const filePath = path.resolve('src/renderer/src/raycast-api/platform-runtime.ts');
  const source = fs.readFileSync(filePath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
    fileName: filePath,
  });

  const observedMaps = [];
  class ObservableMap extends Map {
    constructor(...args) {
      super(...args);
      observedMaps.push(this);
    }
  }

  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    require,
    console,
    Date,
    Error,
    JSON,
    Map: ObservableMap,
    Promise,
    window: {},
  };

  vm.runInNewContext(transpiled.outputText, sandbox, { filename: filePath });
  return { exports: module.exports, observedMaps };
}

test('withCache sweeps expired unique keys when maxAge is configured', async () => {
  const originalNow = Date.now;
  const uniqueKeyCount = 1_000;
  let now = 1_000;
  let calls = 0;

  Date.now = () => now;
  try {
    const { exports, observedMaps } = loadPlatformRuntimeWithObservedMaps();
    const cached = exports.withCache(async (key) => {
      calls += 1;
      return `value:${key}:${calls}`;
    }, { maxAge: 10 });

    for (let index = 0; index < uniqueKeyCount; index += 1) {
      await cached(`expired-${index}`);
      now += 11;
    }

    await cached('latest');

    const retainedSize = observedMaps[0]?.size;
    console.log(`[withCache metric] retained entries after unique expired inserts: ${retainedSize}`);
    assert.equal(retainedSize, 1);
  } finally {
    Date.now = originalNow;
  }
});

test('withCache recomputes and replaces an expired hit', async () => {
  const originalNow = Date.now;
  let now = 1_000;
  let calls = 0;

  Date.now = () => now;
  try {
    const { exports, observedMaps } = loadPlatformRuntimeWithObservedMaps();
    const cached = exports.withCache(async (key) => {
      calls += 1;
      return { key, calls };
    }, { maxAge: 10 });

    assert.deepEqual(await cached('same-key'), { key: 'same-key', calls: 1 });
    now += 11;
    assert.deepEqual(await cached('same-key'), { key: 'same-key', calls: 2 });
    assert.equal(observedMaps[0]?.size, 1);
  } finally {
    Date.now = originalNow;
  }
});

test('withCache retains non-expiring entries until clearCache is called', async () => {
  const { exports, observedMaps } = loadPlatformRuntimeWithObservedMaps();
  let calls = 0;
  const cached = exports.withCache(async (key) => {
    calls += 1;
    return `value:${key}:${calls}`;
  });

  assert.equal(await cached('a'), 'value:a:1');
  assert.equal(await cached('b'), 'value:b:2');
  assert.equal(await cached('a'), 'value:a:1');
  assert.equal(observedMaps[0]?.size, 2);
  assert.equal(calls, 2);

  cached.clearCache();
  assert.equal(observedMaps[0]?.size, 0);
});
