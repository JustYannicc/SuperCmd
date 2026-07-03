#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const RAYCAST_API_PATH = path.resolve('src/renderer/src/raycast-api/index.tsx');
const TTL_EXPIRY_ADVANCE_MS = 60_000;
const AI_RESOURCE = { Model: {}, ask() {} };

function extractAIAvailabilitySource() {
  const source = fs.readFileSync(RAYCAST_API_PATH, 'utf8');
  const launchTypeStart = source.indexOf('export enum LaunchType');
  const environmentEnd = source.indexOf('// =====================================================================\n// \u2500\u2500\u2500 Alert Types', launchTypeStart);
  const aiInitStart = source.indexOf('// Initialize AI availability cache');
  const aiInitEnd = source.indexOf('export const AI =', aiInitStart);

  assert.notEqual(launchTypeStart, -1, 'LaunchType marker should exist');
  assert.notEqual(environmentEnd, -1, 'Environment block end marker should exist');
  assert.notEqual(aiInitStart, -1, 'AI availability init marker should exist');
  assert.notEqual(aiInitEnd, -1, 'AI export marker should exist after availability init');

  return `${source.slice(launchTypeStart, environmentEnd)}\n${source.slice(aiInitStart, aiInitEnd)}`;
}

const transpiledAIAvailability = ts.transpileModule(extractAIAvailabilitySource(), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: RAYCAST_API_PATH,
});

function createStorage() {
  const data = new Map();
  return {
    getItem(key) {
      const normalizedKey = String(key);
      return data.has(normalizedKey) ? data.get(normalizedKey) : null;
    },
    setItem(key, value) {
      data.set(String(key), String(value));
    },
    removeItem(key) {
      data.delete(String(key));
    },
    clear() {
      data.clear();
    },
  };
}

function createClassList() {
  const values = new Set(['dark']);
  return {
    add(value) {
      values.add(value);
    },
    remove(value) {
      values.delete(value);
    },
    contains(value) {
      return values.has(value);
    },
    toggle(value, force) {
      if (force === undefined ? !values.has(value) : force) {
        values.add(value);
        return true;
      }
      values.delete(value);
      return false;
    },
  };
}

function addListener(listeners, type, listener) {
  const registered = listeners.get(type) ?? new Set();
  registered.add(listener);
  listeners.set(type, registered);
}

function removeListener(listeners, type, listener) {
  listeners.get(type)?.delete(listener);
}

function emit(listeners, type, event = { type }) {
  for (const listener of listeners.get(type) ?? []) {
    listener(event);
  }
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function createRaycastApiHarness() {
  const windowListeners = new Map();
  const documentListeners = new Map();
  const rootListeners = new Map();
  let now = 1_000_000;
  let calls = 0;
  let availabilityResults = [true];
  let visibilityState = 'visible';

  const root = {
    classList: createClassList(),
    style: {},
    addEventListener(type, listener) {
      addListener(rootListeners, type, listener);
    },
    removeEventListener(type, listener) {
      removeListener(rootListeners, type, listener);
    },
    dispatchEvent(event) {
      emit(rootListeners, event.type, event);
      return true;
    },
  };

  const documentStub = {
    documentElement: root,
    body: { classList: createClassList(), appendChild() {}, removeChild() {} },
    createElement: () => ({
      style: {},
      setAttribute() {},
      appendChild() {},
      remove() {},
      click() {},
    }),
    addEventListener(type, listener) {
      addListener(documentListeners, type, listener);
    },
    removeEventListener(type, listener) {
      removeListener(documentListeners, type, listener);
    },
    get visibilityState() {
      return visibilityState;
    },
  };

  const windowStub = {
    document: documentStub,
    navigator: { platform: 'test', userAgent: 'node' },
    localStorage: createStorage(),
    sessionStorage: createStorage(),
    location: { href: 'about:blank', reload() {} },
    electron: {
      async aiIsAvailable() {
        calls += 1;
        const result = availabilityResults.length > 0 ? availabilityResults.shift() : true;
        if (result instanceof Error) throw result;
        return result;
      },
    },
    addEventListener(type, listener) {
      addListener(windowListeners, type, listener);
    },
    removeEventListener(type, listener) {
      removeListener(windowListeners, type, listener);
    },
    dispatchEvent(event) {
      emit(windowListeners, event.type, event);
      return true;
    },
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    setTimeout,
    clearTimeout,
  };

  const DateStub = class extends Date {
    static now() {
      return now;
    }
  };
  const module = { exports: {} };
  const sandbox = {
    Date: DateStub,
    document: documentStub,
    exports: module.exports,
    module,
    onThemeChange: () => () => {},
    Promise,
    window: windowStub,
  };

  vm.runInNewContext(transpiledAIAvailability.outputText, sandbox, { filename: RAYCAST_API_PATH });
  await flushAsync();

  return {
    api: module.exports,
    advance(ms) {
      now += ms;
    },
    emitDocument(type) {
      emit(documentListeners, type, { type });
    },
    emitWindow(type) {
      emit(windowListeners, type, { type });
    },
    flush: flushAsync,
    get availabilityCalls() {
      return calls;
    },
    resetCalls() {
      calls = 0;
    },
    setAvailabilityResults(...results) {
      availabilityResults = results;
    },
    setVisibilityState(nextState) {
      visibilityState = nextState;
    },
  };
}

test('environment.canAccess(AI) caches settled sequential checks within the TTL', async () => {
  const harness = await createRaycastApiHarness();
  harness.resetCalls();
  harness.advance(TTL_EXPIRY_ADVANCE_MS);

  for (let index = 0; index < 100; index += 1) {
    harness.api.environment.canAccess(AI_RESOURCE);
    await harness.flush();
  }

  assert.equal(harness.availabilityCalls, 1);
});

test('environment.canAccess(AI) refreshes after the TTL expires', async () => {
  const harness = await createRaycastApiHarness();
  harness.resetCalls();
  harness.advance(TTL_EXPIRY_ADVANCE_MS);

  harness.api.environment.canAccess(AI_RESOURCE);
  await harness.flush();
  harness.api.environment.canAccess(AI_RESOURCE);
  await harness.flush();
  assert.equal(harness.availabilityCalls, 1);

  harness.advance(TTL_EXPIRY_ADVANCE_MS);
  harness.api.environment.canAccess(AI_RESOURCE);
  await harness.flush();

  assert.equal(harness.availabilityCalls, 2);
});

test('focus and visibility refreshes bypass the TTL', async () => {
  const harness = await createRaycastApiHarness();
  harness.resetCalls();

  harness.emitWindow('focus');
  await harness.flush();
  assert.equal(harness.availabilityCalls, 1);

  harness.setVisibilityState('visible');
  harness.emitDocument('visibilitychange');
  await harness.flush();
  assert.equal(harness.availabilityCalls, 2);
});

test('failed availability checks do not poison the cache TTL', async () => {
  const harness = await createRaycastApiHarness();
  harness.resetCalls();
  harness.advance(TTL_EXPIRY_ADVANCE_MS);
  harness.setAvailabilityResults(new Error('temporary IPC failure'), true);

  harness.api.environment.canAccess(AI_RESOURCE);
  await harness.flush();
  assert.equal(harness.availabilityCalls, 1);

  harness.api.environment.canAccess(AI_RESOURCE);
  await harness.flush();
  assert.equal(harness.availabilityCalls, 2);

  harness.api.environment.canAccess(AI_RESOURCE);
  await harness.flush();
  assert.equal(harness.availabilityCalls, 2);
});
