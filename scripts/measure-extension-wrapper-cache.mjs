#!/usr/bin/env node

import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTs } from './lib/ts-import.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  clearCompiledExtensionWrapperCache,
  EXTENSION_WRAPPER_ARGUMENTS,
  getCompiledExtensionWrapper,
  getCompiledExtensionWrapperCacheStats,
} = await importTs(path.join(root, 'src/renderer/src/utils/extension-wrapper-cache.ts'));

const ITERATIONS = Number.parseInt(process.env.SUPERCMD_WRAPPER_MEASURE_ITERATIONS || '1000', 10);

function patchSchemeDynamicImports(sourceCode) {
  return String(sourceCode || '').replace(
    /\bimport\(\s*(["'])(swift:[^"']+|rust:[^"']+)\1\s*\)/g,
    (_match, quote, specifier) => `__scDynamicImport(${quote}${specifier}${quote})`
  );
}

function createFixtureExtensionCode() {
  const body = `
Object.defineProperty(exports, "__esModule", { value: true });
const React = require("react");
let moduleScopedCounter = 0;
moduleScopedCounter += 1;
const pendingTimer = setTimeout(() => {}, 60000);
exports.default = function FixtureCommand() {
  return {
    reactVersion: React.version,
    moduleScopedCounter,
    pendingTimerType: typeof pendingTimer
  };
};
`;
  return body + '\n'.repeat(20) + '// filler '.repeat(250);
}

function createRunEnv() {
  const moduleExports = {};
  const fakeModule = { exports: moduleExports };
  const timers = new Set();
  const trackTimeout = (cb, ms, ...rest) => {
    const id = setTimeout(cb, ms, ...rest);
    timers.add(id);
    return id;
  };
  const trackClearTimeout = (id) => {
    timers.delete(id);
    clearTimeout(id);
  };
  const fakeRequire = (name) => {
    if (name === 'react') return { version: '18.2.0' };
    return {};
  };

  return {
    args: [
      moduleExports,
      fakeRequire,
      fakeModule,
      '/extension/index.js',
      '/extension',
      { env: {} },
      Buffer,
      globalThis,
      globalThis,
      (fn, ...args) => trackTimeout(() => fn(...args), 0),
      trackClearTimeout,
      () => 0,
      () => {},
      trackTimeout,
      trackClearTimeout,
      () => 0,
      () => {},
      undefined,
      async () => ({}),
    ],
    fakeModule,
    cleanup: () => {
      timers.forEach((id) => clearTimeout(id));
      timers.clear();
    },
    getTimerCount: () => timers.size,
  };
}

function measureUncachedLoads(code, iterations) {
  let wrapperCreationCount = 0;
  let wrapperCreationMs = 0;
  let executionMs = 0;
  let leakedTimerPeak = 0;

  for (let i = 0; i < iterations; i++) {
    const executableCode = patchSchemeDynamicImports(code);

    const compileStart = performance.now();
    const wrapper = new Function(...EXTENSION_WRAPPER_ARGUMENTS, executableCode);
    wrapperCreationMs += performance.now() - compileStart;
    wrapperCreationCount++;

    const env = createRunEnv();
    const executionStart = performance.now();
    wrapper(...env.args);
    executionMs += performance.now() - executionStart;
    leakedTimerPeak = Math.max(leakedTimerPeak, env.getTimerCount());
    env.cleanup();

    if (typeof env.fakeModule.exports.default !== 'function') {
      throw new Error('Fixture did not export a function');
    }
  }

  return {
    iterations,
    wrapperCreationCount,
    wrapperCreationMs,
    executionMs,
    totalLoadMs: wrapperCreationMs + executionMs,
    leakedTimerPeak,
  };
}

function measureCachedLoads(code, iterations) {
  clearCompiledExtensionWrapperCache();

  let cacheLookupMs = 0;
  let executionMs = 0;
  let leakedTimerPeak = 0;

  for (let i = 0; i < iterations; i++) {
    const executableCode = patchSchemeDynamicImports(code);

    const cacheStart = performance.now();
    const { wrapper } = getCompiledExtensionWrapper({
      extensionIdentity: 'fixture-owner/fixture-extension/fixture-command',
      code,
      executableCode,
    });
    cacheLookupMs += performance.now() - cacheStart;

    const env = createRunEnv();
    const executionStart = performance.now();
    wrapper(...env.args);
    executionMs += performance.now() - executionStart;
    leakedTimerPeak = Math.max(leakedTimerPeak, env.getTimerCount());
    env.cleanup();

    if (typeof env.fakeModule.exports.default !== 'function') {
      throw new Error('Fixture did not export a function');
    }
  }

  const stats = getCompiledExtensionWrapperCacheStats();
  return {
    iterations,
    wrapperCreationCount: stats.wrapperCreationCount,
    wrapperCreationMs: stats.wrapperCreationMs,
    cacheHits: stats.hits,
    cacheMisses: stats.misses,
    cacheLookupMs,
    executionMs,
    totalLoadMs: cacheLookupMs + executionMs,
    leakedTimerPeak,
  };
}

const fixtureCode = createFixtureExtensionCode();

console.log(JSON.stringify({
  scenario: 'extension-wrapper-cache',
  codeLength: fixtureCode.length,
  uncached: measureUncachedLoads(fixtureCode, ITERATIONS),
  cached: measureCachedLoads(fixtureCode, ITERATIONS),
}, null, 2));
