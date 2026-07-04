#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { importTs } from './lib/ts-import.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FS_PREFIX = 'sc-fs:';

function createLocalStorage() {
  const map = new Map();
  return {
    get length() {
      return map.size;
    },
    key(index) {
      return Array.from(map.keys())[index] ?? null;
    },
    getItem(key) {
      const normalized = String(key);
      return map.has(normalized) ? map.get(normalized) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    clear() {
      map.clear();
    },
  };
}

globalThis.localStorage = createLocalStorage();
globalThis.sessionStorage = createLocalStorage();
globalThis.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {}, remove: () => {} }),
  body: { appendChild: () => {}, removeChild: () => {} },
  documentElement: {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    classList: {
      contains: () => false,
      add: () => {},
      remove: () => {},
      toggle: () => {},
    },
    style: {},
  },
};
globalThis.MutationObserver = class MutationObserver {
  observe() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
};
globalThis.window = {
  document: globalThis.document,
  navigator: globalThis.navigator,
  localStorage: globalThis.localStorage,
  sessionStorage: globalThis.sessionStorage,
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
  electron: {},
  location: { href: 'about:blank', reload: () => {} },
};

const {
  getVirtualFsDirectoryEntriesForTests,
  getVirtualFsDirectoryIndexStatsForTests,
} = await importTs(path.join(root, 'src/renderer/src/ExtensionView.tsx'), {
  stubModules: ['react-dom/server'],
  stubs: {
    'react-dom/server': 'export const renderToStaticMarkup = () => ""; export default { renderToStaticMarkup };',
  },
});

test('virtual fs directory reads use a maintained localStorage index', () => {
  const unrelatedKeys = 20000;
  const targetEntries = 250;

  globalThis.localStorage.clear();
  for (let index = 0; index < unrelatedKeys; index += 1) {
    globalThis.localStorage.setItem(`unrelated:${index}`, 'noise');
  }
  for (let index = 0; index < targetEntries; index += 1) {
    globalThis.localStorage.setItem(`${FS_PREFIX}/extensions/cache/items/item-${index}.json`, '{}');
  }

  const firstStart = performance.now();
  const firstEntries = getVirtualFsDirectoryEntriesForTests('/extensions/cache/items');
  const firstDurationMs = performance.now() - firstStart;
  const firstStats = getVirtualFsDirectoryIndexStatsForTests();

  const repeatedReads = 50;
  const repeatedStart = performance.now();
  for (let index = 0; index < repeatedReads; index += 1) {
    assert.equal(getVirtualFsDirectoryEntriesForTests('/extensions/cache/items').length, targetEntries);
  }
  const repeatedDurationMs = performance.now() - repeatedStart;
  const repeatedStats = getVirtualFsDirectoryIndexStatsForTests();

  assert.equal(firstEntries.length, targetEntries);
  assert.equal(firstStats.buildScans, 1);
  assert.equal(repeatedStats.buildScans, 1);

  console.log(JSON.stringify({
    mode: 'virtual-fs-directory-index',
    unrelatedKeys,
    targetEntries,
    repeatedReads,
    before: {
      localStorageKeysScannedPerRead: unrelatedKeys + targetEntries,
    },
    after: {
      indexBuildScans: repeatedStats.buildScans,
      repeatedReadScans: repeatedStats.buildScans - firstStats.buildScans,
      indexedDirectories: repeatedStats.directories,
      indexedEntries: repeatedStats.entries,
    },
    durationMs: {
      initialIndexedRead: Number(firstDurationMs.toFixed(3)),
      repeatedIndexedReads: Number(repeatedDurationMs.toFixed(3)),
    },
  }, null, 2));
});
