#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundledPreferences = await build({
  entryPoints: ['src/renderer/src/utils/extension-preferences.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent',
});

const bundledPreferencesUrl =
  'data:text/javascript;base64,' + Buffer.from(bundledPreferences.outputFiles[0].text).toString('base64');

let moduleCounter = 0;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function copyPayload(value) {
  return JSON.parse(JSON.stringify(value));
}

async function loadPreferencesWithMocks() {
  const storage = new Map();
  const commandArgumentWrites = [];

  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => {
      storage.set(key, String(value));
    },
    removeItem: (key) => {
      storage.delete(key);
    },
    key: (index) => Array.from(storage.keys())[index] ?? null,
    get length() {
      return storage.size;
    },
  };
  globalThis.window = {
    electron: {
      saveExtensionCommandArguments: async (args) => {
        commandArgumentWrites.push(copyPayload(args));
        return {};
      },
      saveExtensionPreferences: async (args) => {
        return {};
      },
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    dispatchEvent: () => true,
  };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  };

  moduleCounter += 1;
  const preferences = await import(`${bundledPreferencesUrl}#test-${moduleCounter}`);
  return { preferences, storage, commandArgumentWrites };
}

test('inline command argument settings mirror coalesces rapid writes', async () => {
  const { preferences, storage, commandArgumentWrites } = await loadPreferencesWithMocks();
  const key = preferences.getCmdArgsKey('coalesce-extension', 'no-view-command');
  const values = ['s', 'se', 'sea', 'sear', 'searc', 'search', 'search ', 'search t', 'search te', 'search tex', 'search text'];

  for (const value of values) {
    preferences.writeJsonObject(
      key,
      { query: value },
      { commandArgumentSettingsSync: 'debounced' }
    );
  }

  assert.equal(JSON.parse(storage.get(key)).query, 'search text');
  assert.equal(commandArgumentWrites.length, 0);

  await wait(preferences.COMMAND_ARGUMENT_SETTINGS_SYNC_DEBOUNCE_MS + 50);

  assert.equal(commandArgumentWrites.length, 1);
  assert.deepEqual(commandArgumentWrites[0], {
    extName: 'coalesce-extension',
    cmdName: 'no-view-command',
    values: { query: 'search text' },
  });
});

test('launch flush writes pending inline command arguments immediately once', async () => {
  const { preferences, commandArgumentWrites } = await loadPreferencesWithMocks();
  const key = preferences.getCmdArgsKey('flush-extension', 'no-view-command');

  preferences.writeJsonObject(
    key,
    { query: 'stale' },
    { commandArgumentSettingsSync: 'debounced' }
  );
  preferences.writeJsonObject(
    key,
    { query: 'fresh at launch' },
    { commandArgumentSettingsSync: 'debounced' }
  );

  await preferences.flushCommandArgumentSettingsSync(key);

  assert.equal(commandArgumentWrites.length, 1);
  assert.deepEqual(commandArgumentWrites[0], {
    extName: 'flush-extension',
    cmdName: 'no-view-command',
    values: { query: 'fresh at launch' },
  });

  await wait(preferences.COMMAND_ARGUMENT_SETTINGS_SYNC_DEBOUNCE_MS + 50);
  assert.equal(commandArgumentWrites.length, 1);
});

test('immediate command argument writes cancel pending debounced settings sync', async () => {
  const { preferences, commandArgumentWrites } = await loadPreferencesWithMocks();
  const key = preferences.getCmdArgsKey('submit-extension', 'no-view-command');

  preferences.writeJsonObject(
    key,
    { query: 'pending inline value' },
    { commandArgumentSettingsSync: 'debounced' }
  );
  preferences.writeJsonObject(key, { query: 'submitted value' });

  assert.equal(commandArgumentWrites.length, 1);
  assert.deepEqual(commandArgumentWrites[0], {
    extName: 'submit-extension',
    cmdName: 'no-view-command',
    values: { query: 'submitted value' },
  });

  await wait(preferences.COMMAND_ARGUMENT_SETTINGS_SYNC_DEBOUNCE_MS + 50);
  assert.equal(commandArgumentWrites.length, 1);
});
