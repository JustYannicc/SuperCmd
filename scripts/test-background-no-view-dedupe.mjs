#!/usr/bin/env node

import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import test from 'node:test';
import vm from 'vm';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const moduleCache = new Map();

function loadTsModule(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (moduleCache.has(resolvedPath)) return moduleCache.get(resolvedPath).exports;

  const source = fs.readFileSync(resolvedPath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
    fileName: resolvedPath,
  });

  const module = { exports: {} };
  moduleCache.set(resolvedPath, module);
  const localRequire = (request) => {
    if (request.startsWith('.')) {
      const candidate = path.resolve(path.dirname(resolvedPath), request);
      for (const suffix of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx']) {
        const nextPath = `${candidate}${suffix}`;
        if (fs.existsSync(nextPath) && fs.statSync(nextPath).isFile()) {
          if (nextPath.endsWith('.ts') || nextPath.endsWith('.tsx')) return loadTsModule(nextPath);
          return require(nextPath);
        }
      }
    }
    return require(request);
  };
  const sandbox = {
    module,
    exports: module.exports,
    require: localRequire,
    console,
    Date,
    Math,
    String,
    Number,
    Set,
    Map,
    Object,
    Array,
    RegExp,
  };
  vm.runInNewContext(transpiled.outputText, sandbox, { filename: resolvedPath });
  return module.exports;
}

const {
  enqueueBackgroundNoViewRun,
  getBackgroundNoViewRunIdentity,
  removeBackgroundNoViewRun,
} = loadTsModule('src/renderer/src/utils/background-no-view-runs.ts');

function runIdentity(bundle) {
  return `${bundle.extensionName || bundle.extName || ''}/${bundle.commandName || bundle.cmdName || ''}`;
}

function legacyQueueNoViewBundleRun(prev, bundle, launchType = 'background', reportStatus = false, now = Date.now) {
  const runId = `${runIdentity(bundle)}/${now()}`;
  return [...prev, { runId, bundle, launchType, reportStatus }];
}

function simulateRepeatedBackgroundTicks({ enqueue, ticks, intervalMs }) {
  const bundle = {
    code: 'export default async function Command() {}',
    mode: 'no-view',
    title: 'Refresh Widgets',
    extensionName: 'widgets',
    commandName: 'refresh',
  };
  let runs = [];
  const tickTimes = Array.from({ length: ticks }, (_, index) => index * intervalMs);
  for (const elapsedMs of tickTimes) {
    runs = enqueue(runs, bundle, 'background', false, () => elapsedMs);
  }
  return {
    runs,
    ticks,
    intervalMs,
    elapsedMs: tickTimes.at(-1) ?? 0,
  };
}

function simulateDedupedBackgroundTicks({ ticks, intervalMs }) {
  const bundle = {
    code: 'export default async function Command() {}',
    mode: 'no-view',
    title: 'Refresh Widgets',
    extName: 'widgets',
    cmdName: 'refresh',
    extensionName: 'widgets',
    commandName: 'refresh',
  };
  let runs = [];
  let enqueued = 0;
  const tickTimes = Array.from({ length: ticks }, (_, index) => index * intervalMs);
  for (const elapsedMs of tickTimes) {
    const result = enqueueBackgroundNoViewRun(runs, bundle, 'background', false, () => elapsedMs);
    runs = result.runs;
    if (result.enqueued) enqueued += 1;
  }
  return {
    runs,
    enqueued,
    skipped: ticks - enqueued,
    ticks,
    intervalMs,
    elapsedMs: tickTimes.at(-1) ?? 0,
  };
}

function testBundle(overrides = {}) {
  return {
    code: 'export default async function Command() {}',
    mode: 'no-view',
    title: 'Refresh Widgets',
    extName: 'widgets',
    cmdName: 'refresh',
    ...overrides,
  };
}

test('baseline: legacy background no-view queue accepts overlapping duplicate ticks', () => {
  const metrics = simulateRepeatedBackgroundTicks({
    enqueue: legacyQueueNoViewBundleRun,
    ticks: 3,
    intervalMs: 25,
  });

  console.log(
    `[baseline] background no-view duplicate ticks: ticks=${metrics.ticks} intervalMs=${metrics.intervalMs} elapsedMs=${metrics.elapsedMs} queued=${metrics.runs.length}`
  );

  assert.equal(metrics.runs.length, 3);
  assert.deepEqual(metrics.runs.map((run) => runIdentity(run.bundle)), [
    'widgets/refresh',
    'widgets/refresh',
    'widgets/refresh',
  ]);
});

test('background no-view queue dedupes overlapping ticks for the same extension command', () => {
  const metrics = simulateDedupedBackgroundTicks({
    ticks: 3,
    intervalMs: 25,
  });

  console.log(
    `[after] background no-view duplicate ticks: ticks=${metrics.ticks} intervalMs=${metrics.intervalMs} elapsedMs=${metrics.elapsedMs} queued=${metrics.runs.length} skipped=${metrics.skipped}`
  );

  assert.equal(metrics.enqueued, 1);
  assert.equal(metrics.skipped, 2);
  assert.equal(metrics.runs.length, 1);
  assert.equal(getBackgroundNoViewRunIdentity(metrics.runs[0].bundle), 'widgets/refresh');
});

test('background no-view identity matches legacy and hydrated bundle fields', () => {
  const legacyFields = testBundle();
  const hydratedFields = {
    code: legacyFields.code,
    mode: legacyFields.mode,
    title: legacyFields.title,
    extensionName: 'widgets',
    commandName: 'refresh',
  };

  const first = enqueueBackgroundNoViewRun([], legacyFields, 'background', false, () => 0);
  assert.equal(first.enqueued, true);

  const duplicate = enqueueBackgroundNoViewRun(first.runs, hydratedFields, 'background', false, () => 25);
  assert.equal(duplicate.enqueued, false);
  assert.equal(duplicate.runs.length, 1);
});

test('user-initiated no-view launches are not deduped', () => {
  const bundle = testBundle();
  let runs = [];
  for (const elapsedMs of [0, 25, 50]) {
    const result = enqueueBackgroundNoViewRun(runs, bundle, 'userInitiated', false, () => elapsedMs);
    assert.equal(result.enqueued, true);
    runs = result.runs;
  }

  assert.equal(runs.length, 3);
  assert.deepEqual(Array.from(runs, (run) => run.launchType), [
    'userInitiated',
    'userInitiated',
    'userInitiated',
  ]);
});

test('background no-view launch skips while same command is already in flight', () => {
  const bundle = testBundle({
    extensionName: 'widgets',
    commandName: 'refresh',
  });
  const userLaunch = enqueueBackgroundNoViewRun([], bundle, 'userInitiated', false, () => 0);
  assert.equal(userLaunch.enqueued, true);

  const backgroundTick = enqueueBackgroundNoViewRun(userLaunch.runs, bundle, 'background', false, () => 25);
  assert.equal(backgroundTick.enqueued, false);
  assert.equal(backgroundTick.runs.length, 1);

  const explicitLaunch = enqueueBackgroundNoViewRun(backgroundTick.runs, bundle, 'userInitiated', false, () => 50);
  assert.equal(explicitLaunch.enqueued, true);
  assert.equal(explicitLaunch.runs.length, 2);
});

test('clearing a background no-view run allows the next background tick to enqueue', () => {
  const bundle = testBundle({
    extensionName: 'widgets',
    commandName: 'refresh',
  });

  for (const reason of ['success', 'error', 'unmount']) {
    const first = enqueueBackgroundNoViewRun([], bundle, 'background', false, () => 0);
    assert.equal(first.enqueued, true, reason);

    const overlapping = enqueueBackgroundNoViewRun(first.runs, bundle, 'background', false, () => 25);
    assert.equal(overlapping.enqueued, false, reason);
    assert.equal(overlapping.runs.length, 1, reason);

    const cleared = removeBackgroundNoViewRun(overlapping.runs, overlapping.runs[0].runId);
    assert.equal(cleared.length, 0, reason);

    const afterClear = enqueueBackgroundNoViewRun(cleared, bundle, 'background', false, () => 50);
    assert.equal(afterClear.enqueued, true, reason);
    assert.equal(afterClear.runs.length, 1, reason);
  }
});
