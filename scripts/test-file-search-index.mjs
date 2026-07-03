#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const SOURCE_PATH = path.resolve('src/main/file-search-index.ts');
const BASELINE_MODE = process.env.SUPERCMD_FILE_INDEX_BASELINE === '1';
const HEALTHY_INTERVAL_TICKS = 3;
const CLOCK_STEP_MS = 60_000;

function createFakeDate(clock) {
  return class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length > 0 ? args : [clock.now]));
    }

    static now() {
      return clock.now;
    }
  };
}

function loadFileSearchIndexModule({ clock, logs }) {
  const source = `${fs.readFileSync(SOURCE_PATH, 'utf8')}

export const __fileSearchIndexTestInternals = {
  configureForTest(homeDir: string) {
    configuredHomeDir = path.resolve(homeDir);
    includeRoots = resolveIncludeRoots(configuredHomeDir);
    includeProtectedHomeRoots = false;
    refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS;
    lastBuildStartedAt = 0;
  },
  async applyWatchEventBatchForTest(paths: string[]) {
    await applyWatchEventBatch(paths);
  },
  setWatcherAvailableForTest(available: boolean) {
    activeWatcher = available ? ({ close() {} } as fs.FSWatcher) : null;
    watchedHomeDir = available ? configuredHomeDir : '';
    if (available && typeof lastWatcherError !== 'undefined') lastWatcherError = null;
  },
  async waitForIdleForTest() {
    while (rebuildPromise || indexing) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  },
};
`;

  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
    fileName: SOURCE_PATH,
  });

  const module = { exports: {} };
  const localRequire = (request) => require(request);
  const quietConsole = {
    ...console,
    log: (...args) => {
      logs.push(args.map(String).join(' '));
    },
    warn: (...args) => {
      logs.push(args.map(String).join(' '));
    },
    error: (...args) => {
      logs.push(args.map(String).join(' '));
    },
  };
  const sandboxProcess = Object.create(process);
  Object.defineProperty(sandboxProcess, 'platform', { value: 'linux' });

  const sandbox = {
    module,
    exports: module.exports,
    require: localRequire,
    console: quietConsole,
    Date: createFakeDate(clock),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    process: sandboxProcess,
  };

  vm.runInNewContext(transpiled.outputText, sandbox, { filename: SOURCE_PATH });
  return module.exports;
}

async function createFixtureTree(rootDir) {
  const projectRoot = path.join(rootDir, 'Projects');
  await fs.promises.mkdir(projectRoot, { recursive: true });

  for (let dirIndex = 0; dirIndex < 40; dirIndex += 1) {
    const dir = path.join(projectRoot, `bucket-${String(dirIndex).padStart(2, '0')}`);
    await fs.promises.mkdir(dir, { recursive: true });
    const writes = [];
    for (let fileIndex = 0; fileIndex < 25; fileIndex += 1) {
      writes.push(
        fs.promises.writeFile(
          path.join(dir, `alpha-file-${String(dirIndex).padStart(2, '0')}-${String(fileIndex).padStart(2, '0')}.txt`),
          `fixture ${dirIndex} ${fileIndex}\n`
        )
      );
    }
    await Promise.all(writes);
  }
}

function rebuildLogCount(logs) {
  return logs.filter((line) => line.includes('[FileIndex] Rebuilt')).length;
}

async function measure(label, fn) {
  const startedAt = performance.now();
  const value = await fn();
  return {
    label,
    value,
    ms: Number((performance.now() - startedAt).toFixed(2)),
  };
}

async function runRequestedRefresh(indexModule, reason, logs) {
  const before = rebuildLogCount(logs);
  const measurement = await measure(reason, async () => {
    indexModule.requestFileSearchIndexRefresh(reason);
    await indexModule.__fileSearchIndexTestInternals.waitForIdleForTest();
  });
  return {
    rebuilds: rebuildLogCount(logs) - before,
    ms: measurement.ms,
  };
}

async function runScenario() {
  const tempParent = await fs.promises.realpath(os.tmpdir());
  const tempHome = await fs.promises.mkdtemp(path.join(tempParent, 'supercmd-file-index-'));
  const clock = { now: 1_800_000_000_000 };
  const logs = [];
  const indexModule = loadFileSearchIndexModule({ clock, logs });
  const internals = indexModule.__fileSearchIndexTestInternals;

  try {
    await createFixtureTree(tempHome);
    internals.configureForTest(tempHome);

    const startupBefore = rebuildLogCount(logs);
    const startup = await measure('startup', () => indexModule.rebuildFileSearchIndex('startup'));
    const startupRebuilds = rebuildLogCount(logs) - startupBefore;
    assert.equal(startupRebuilds, 1, 'startup should perform one full rebuild');

    internals.setWatcherAvailableForTest(true);

    internals.setWatcherAvailableForTest(false);
    const watcherErrorRecovery = await runRequestedRefresh(indexModule, 'watcher-error', logs);
    internals.setWatcherAvailableForTest(true);

    const existingFile = path.join(tempHome, 'Projects', 'bucket-00', 'alpha-file-00-00.txt');
    await fs.promises.writeFile(existingFile, 'updated fixture\n');
    const updateBefore = rebuildLogCount(logs);
    await internals.applyWatchEventBatchForTest([existingFile]);
    const updatedResults = await indexModule.searchIndexedFiles('alpha file 00 00', { limit: 5 });
    assert.ok(updatedResults.some((result) => result.path === existingFile), 'updated file should remain searchable');
    const updateRebuilds = rebuildLogCount(logs) - updateBefore;

    const createdFile = path.join(tempHome, 'Projects', 'bucket-00', 'new-alpha-special.txt');
    await fs.promises.writeFile(createdFile, 'new fixture\n');
    const createBefore = rebuildLogCount(logs);
    await internals.applyWatchEventBatchForTest([createdFile]);
    const createdResults = await indexModule.searchIndexedFiles('new alpha special', { limit: 5 });
    assert.ok(createdResults.some((result) => result.path === createdFile), 'created file should be searchable');
    const createRebuilds = rebuildLogCount(logs) - createBefore;

    await fs.promises.unlink(createdFile);
    const deleteBefore = rebuildLogCount(logs);
    await internals.applyWatchEventBatchForTest([createdFile]);
    const deletedResults = await indexModule.searchIndexedFiles('new alpha special', { limit: 5 });
    assert.equal(deletedResults.some((result) => result.path === createdFile), false, 'deleted file should be tombstoned');
    const deleteRebuilds = rebuildLogCount(logs) - deleteBefore;

    const addedDir = path.join(tempHome, 'Projects', 'fresh-folder');
    const nestedFile = path.join(addedDir, 'nested-special-note.md');
    await fs.promises.mkdir(addedDir, { recursive: true });
    await fs.promises.writeFile(nestedFile, 'nested fixture\n');
    const directoryBefore = rebuildLogCount(logs);
    await internals.applyWatchEventBatchForTest([addedDir]);
    const nestedResults = await indexModule.searchIndexedFiles('nested special note', { limit: 5 });
    assert.ok(nestedResults.some((result) => result.path === nestedFile), 'new directory contents should be indexed');
    const directoryRebuilds = rebuildLogCount(logs) - directoryBefore;

    const healthyIntervalRuns = [];
    for (let tick = 0; tick < HEALTHY_INTERVAL_TICKS; tick += 1) {
      clock.now += CLOCK_STEP_MS;
      healthyIntervalRuns.push(await runRequestedRefresh(indexModule, 'interval', logs));
    }

    internals.setWatcherAvailableForTest(false);
    clock.now += CLOCK_STEP_MS;
    const fallbackInterval = await runRequestedRefresh(indexModule, 'interval', logs);

    return {
      startupMs: startup.ms,
      startupRebuilds,
      watcherErrorRecoveryRebuilds: watcherErrorRecovery.rebuilds,
      watcherErrorRecoveryMs: watcherErrorRecovery.ms,
      watcherBatchRebuilds: updateRebuilds + createRebuilds + deleteRebuilds + directoryRebuilds,
      healthyIntervalRebuilds: healthyIntervalRuns.reduce((sum, run) => sum + run.rebuilds, 0),
      healthyIntervalMs: Number(healthyIntervalRuns.reduce((sum, run) => sum + run.ms, 0).toFixed(2)),
      fallbackIntervalRebuilds: fallbackInterval.rebuilds,
      fallbackIntervalMs: fallbackInterval.ms,
      indexedEntryCount: indexModule.getFileSearchIndexStatus().indexedEntryCount,
    };
  } finally {
    indexModule.stopFileSearchIndexing();
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  }
}

test('file search index uses watcher batches and avoids healthy interval rebuilds', async () => {
  const metrics = await runScenario();
  console.log(`[FileIndexTest] ${JSON.stringify({ mode: BASELINE_MODE ? 'baseline' : 'assert', ...metrics })}`);

  assert.equal(metrics.watcherBatchRebuilds, 0, 'watcher-style updates should not trigger full rebuilds');
  assert.equal(metrics.watcherErrorRecoveryRebuilds, 1, 'watcher-error recovery should bypass the rebuild throttle');
  assert.equal(metrics.fallbackIntervalRebuilds, 1, 'interval should rebuild when watcher state is unavailable');

  if (!BASELINE_MODE) {
    assert.equal(metrics.healthyIntervalRebuilds, 0, 'healthy watcher interval ticks should use incremental state');
  }
});
