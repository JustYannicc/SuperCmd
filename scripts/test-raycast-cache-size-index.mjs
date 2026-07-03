#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const CACHE_SOURCE_FILE = 'src/renderer/src/raycast-api/index.tsx';
const ENTRY_COUNT = 120;
const ENTRY_SIZE = 1024;

function extractCacheSource() {
  const source = fs.readFileSync(CACHE_SOURCE_FILE, 'utf8');
  const start = source.indexOf('export namespace Cache');
  const end = source.indexOf('// =====================================================================\n// \u2500\u2500\u2500 AI', start);
  assert.notEqual(start, -1, 'Cache namespace marker should exist');
  assert.notEqual(end, -1, 'AI section marker should exist after Cache');
  return source.slice(start, end);
}

const transpiledCache = ts.transpileModule(extractCacheSource(), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: CACHE_SOURCE_FILE,
});

function createInstrumentedLocalStorage() {
  const data = new Map();
  const stats = {
    getItem: 0,
    setItem: 0,
    removeItem: 0,
    key: 0,
    length: 0,
  };

  return {
    getItem(key) {
      stats.getItem += 1;
      const normalizedKey = String(key);
      return data.has(normalizedKey) ? data.get(normalizedKey) : null;
    },
    setItem(key, value) {
      stats.setItem += 1;
      data.set(String(key), String(value));
    },
    removeItem(key) {
      stats.removeItem += 1;
      data.delete(String(key));
    },
    key(index) {
      stats.key += 1;
      return Array.from(data.keys())[index] ?? null;
    },
    get length() {
      stats.length += 1;
      return data.size;
    },
    clear() {
      data.clear();
    },
    resetStats() {
      stats.getItem = 0;
      stats.setItem = 0;
      stats.removeItem = 0;
      stats.key = 0;
      stats.length = 0;
    },
    snapshotStats() {
      return { ...stats };
    },
    rawValue(key) {
      return data.get(String(key));
    },
  };
}

function loadCache(storage, sandboxConsole = console) {
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    console: sandboxConsole,
    localStorage: storage,
    JSON,
    Map,
    Set,
  };

  vm.runInNewContext(transpiledCache.outputText, sandbox, { filename: CACHE_SOURCE_FILE });
  return module.exports.Cache;
}

function measure(storage, name, fn) {
  storage.resetStats();
  const startedAt = performance.now();
  const result = fn();
  const durationMs = performance.now() - startedAt;
  return {
    name,
    durationMs: Number(durationMs.toFixed(3)),
    ...storage.snapshotStats(),
    ...result,
  };
}

function payload(size = ENTRY_SIZE, char = 'x') {
  return char.repeat(size);
}

function cacheStorageKey(namespace) {
  return `sc-cache-${namespace}`;
}

function cacheItemStorageKey(namespace, key) {
  return `${cacheStorageKey(namespace)}-item-${key}`;
}

function readMetadata(storage, namespace) {
  return JSON.parse(storage.rawValue(cacheStorageKey(namespace)));
}

function runBenchmark() {
  const setStorage = createInstrumentedLocalStorage();
  const SetCache = loadCache(setStorage);
  const setCache = new SetCache({ namespace: 'bench-set', capacity: ENTRY_COUNT * ENTRY_SIZE * 10 });
  const setReport = measure(setStorage, 'set-fill', () => {
    for (let index = 0; index < ENTRY_COUNT; index += 1) {
      setCache.set(`key-${index}`, payload());
    }
    return { entries: ENTRY_COUNT };
  });

  const getReport = measure(setStorage, 'get-existing', () => {
    for (let index = 0; index < ENTRY_COUNT; index += 1) {
      assert.equal(setCache.get(`key-${index}`), payload());
    }
    return { entries: ENTRY_COUNT };
  });

  const evictionStorage = createInstrumentedLocalStorage();
  const EvictionCache = loadCache(evictionStorage);
  const seedCache = new EvictionCache({
    namespace: 'bench-eviction',
    capacity: ENTRY_COUNT * ENTRY_SIZE * 10,
  });
  for (let index = 0; index < ENTRY_COUNT; index += 1) {
    seedCache.set(`key-${index}`, payload());
  }

  const evictingCache = new EvictionCache({
    namespace: 'bench-eviction',
    capacity: Math.floor(ENTRY_COUNT / 2) * ENTRY_SIZE,
  });
  const evictionReport = measure(evictionStorage, 'set-with-eviction', () => {
    evictingCache.set('new-key', payload());
    return { entries: ENTRY_COUNT, targetCapacityEntries: Math.floor(ENTRY_COUNT / 2) };
  });

  return [setReport, getReport, evictionReport];
}

function printBenchmarkReport(reports) {
  console.log('Raycast Cache localStorage benchmark');
  for (const report of reports) {
    console.log(
      [
        `  ${report.name}`,
        `entries=${report.entries}`,
        `durationMs=${report.durationMs}`,
        `getItem=${report.getItem}`,
        `setItem=${report.setItem}`,
        `removeItem=${report.removeItem}`,
        `key=${report.key}`,
        `length=${report.length}`,
      ].join(' ')
    );
  }
}

test('Cache stores, removes, clears, and notifies subscribers', () => {
  const storage = createInstrumentedLocalStorage();
  const Cache = loadCache(storage);
  const cache = new Cache({ namespace: 'behavior', capacity: 4096 });
  const notifications = [];
  cache.subscribe((key, data) => notifications.push([key, data]));

  cache.set('alpha', 'one');
  assert.equal(cache.get('alpha'), 'one');
  assert.equal(cache.has('alpha'), true);
  assert.equal(cache.remove('alpha'), true);
  assert.equal(cache.remove('alpha'), false);
  assert.equal(cache.has('alpha'), false);

  cache.set('beta', 'two');
  cache.set('gamma', 'three');
  assert.equal(cache.isEmpty, false);
  cache.clear();
  assert.equal(cache.isEmpty, true);
  assert.equal(cache.has('beta'), false);
  assert.equal(cache.has('gamma'), false);
  assert.deepEqual(notifications, [
    ['alpha', 'one'],
    ['alpha', undefined],
    ['beta', 'two'],
    ['gamma', 'three'],
    [undefined, undefined],
  ]);
});

test('Cache eviction honors least-recently-used ordering', () => {
  const storage = createInstrumentedLocalStorage();
  const Cache = loadCache(storage);
  const cache = new Cache({ namespace: 'lru', capacity: 9 });

  cache.set('a', '111');
  cache.set('b', '222');
  cache.set('c', '333');
  assert.equal(cache.get('a'), '111');
  cache.set('d', '444');

  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.has('c'), true);
  assert.equal(cache.has('d'), true);
});

test('Cache migrates legacy LRU metadata into size metadata', () => {
  const storage = createInstrumentedLocalStorage();
  storage.setItem(cacheStorageKey('legacy'), JSON.stringify({ lruOrder: ['alpha', 'beta'] }));
  storage.setItem(cacheItemStorageKey('legacy', 'alpha'), '111');
  storage.setItem(cacheItemStorageKey('legacy', 'beta'), '2222');
  storage.resetStats();

  const Cache = loadCache(storage);
  const cache = new Cache({ namespace: 'legacy', capacity: 4096 });
  const metadata = readMetadata(storage, 'legacy');

  assert.deepEqual(metadata.lruOrder, ['alpha', 'beta']);
  assert.deepEqual(metadata.sizeByKey, { alpha: 3, beta: 4 });
  assert.equal(metadata.totalSize, 7);
  assert.equal(cache.get('alpha'), '111');
  assert.equal(cache.get('beta'), '2222');
});

test('Cache recovers corrupt metadata by scanning cache item keys', () => {
  const storage = createInstrumentedLocalStorage();
  storage.setItem(cacheStorageKey('corrupt'), '{not valid json');
  storage.setItem(cacheItemStorageKey('corrupt', 'alpha'), 'aaa');
  storage.setItem(cacheItemStorageKey('corrupt', 'beta'), 'bbbb');
  storage.resetStats();

  const errors = [];
  const Cache = loadCache(storage, {
    ...console,
    error: (...args) => errors.push(args),
  });
  const cache = new Cache({ namespace: 'corrupt', capacity: 4096 });
  const metadata = readMetadata(storage, 'corrupt');

  assert.equal(errors.length, 1);
  assert.deepEqual(metadata.lruOrder, ['alpha', 'beta']);
  assert.deepEqual(metadata.sizeByKey, { alpha: 3, beta: 4 });
  assert.equal(metadata.totalSize, 7);
  assert.equal(cache.get('alpha'), 'aaa');
  assert.equal(cache.get('beta'), 'bbbb');
});

test('Cache recovers malformed LRU metadata by scanning cache item keys', () => {
  const storage = createInstrumentedLocalStorage();
  storage.setItem(cacheStorageKey('malformed'), JSON.stringify({ lruOrder: [42], sizeByKey: {} }));
  storage.setItem(cacheItemStorageKey('malformed', 'alpha'), 'aaa');
  storage.resetStats();

  const Cache = loadCache(storage);
  const cache = new Cache({ namespace: 'malformed', capacity: 4096 });
  const metadata = readMetadata(storage, 'malformed');

  assert.deepEqual(metadata.lruOrder, ['alpha']);
  assert.deepEqual(metadata.sizeByKey, { alpha: 3 });
  assert.equal(metadata.totalSize, 3);
  assert.equal(cache.get('alpha'), 'aaa');
});

test('Cache repairs stale size metadata for individual key operations', () => {
  const storage = createInstrumentedLocalStorage();
  storage.setItem(cacheStorageKey('stale'), JSON.stringify({
    version: 2,
    lruOrder: ['missing', 'external'],
    sizeByKey: { missing: 10, external: 1 },
    totalSize: 11,
  }));
  storage.setItem(cacheItemStorageKey('stale', 'external'), 'actual');

  const Cache = loadCache(storage);
  const cache = new Cache({ namespace: 'stale', capacity: 4096 });

  assert.equal(cache.has('missing'), false);
  assert.equal(cache.has('external'), true);
  assert.equal(cache.remove('external'), true);
  assert.equal(cache.has('external'), false);

  const metadata = readMetadata(storage, 'stale');
  assert.deepEqual(metadata.lruOrder, []);
  assert.deepEqual(metadata.sizeByKey, {});
  assert.equal(metadata.totalSize, 0);
});

test('Cache benchmark reports localStorage reads for set, get, and eviction', () => {
  const reports = runBenchmark();
  printBenchmarkReport(reports);

  const byName = Object.fromEntries(reports.map((report) => [report.name, report]));
  assert.equal(byName['set-fill'].getItem, 0);
  assert.equal(byName['get-existing'].getItem, ENTRY_COUNT);
  assert.equal(byName['set-with-eviction'].getItem, 0);
  assert.ok(byName['set-with-eviction'].removeItem > 0, 'eviction scenario should remove LRU entries');
});
