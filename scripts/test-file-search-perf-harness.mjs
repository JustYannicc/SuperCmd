#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import { runFileSearchPerfHarness } from './file-search-perf-harness.mjs';

const IS_PERF_CI = process.env.SUPERCMD_PERF_CI === '1';

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

test('file search perf harness covers deterministic temp-home scenarios', async () => {
  const summary = await runFileSearchPerfHarness({
    projects: 8,
    modulesPerProject: 3,
    filesPerModule: 6,
    queryRuns: 2,
    updateCount: 10,
    deleteCount: 10,
    limit: 8,
    thresholds: {
      initialIndexMs: 15_000,
      normalQueryP95Ms: 2_000,
      pathQueryP95Ms: 2_000,
      eventLoopLagP95Ms: 2_000,
      watchUpdateBatchMs: 5_000,
      deleteBatchMs: 5_000,
    },
  });

  assert.equal(summary.thresholds.passed, true, summary.thresholds.failures.join('\n'));
  assert.equal(summary.verification.homeDirectoryUsed, summary.fixture.homeDir);
  assert.equal(summary.verification.homeIsTempDirectory, true);
  assert.ok(
    summary.fixture.homeDir.startsWith(await fs.realpath(os.tmpdir())),
    'harness must use an OS temp home'
  );
  assert.equal(summary.cleanup.completed, true);
  assert.equal(await pathExists(summary.fixture.tempRoot), false, 'temp fixture should be cleaned up');

  assert.ok(summary.fixture.initialEntryCount >= summary.fixture.initialFileCount);
  assert.ok(summary.metrics.initialIndexMs >= 0);
  assert.ok(summary.metrics.normalQueries.totalResults > 0);
  assert.ok(summary.metrics.pathLikeQueries.totalResults > 0);
  assert.ok(summary.metrics.eventLoopLag.p95Ms >= 0);
  assert.ok(summary.verification.postUpdateResultCount > 0);
  assert.equal(summary.verification.deletedExactMatches, 0);
});

test('file search perf CI covers large path-query p95 and event-loop lag budgets', { skip: !IS_PERF_CI }, async () => {
  const summary = await runFileSearchPerfHarness({
    projects: 120,
    modulesPerProject: 8,
    filesPerModule: 32,
    queryRuns: 3,
    updateCount: 64,
    deleteCount: 64,
    limit: 16,
    thresholds: {
      initialIndexMs: 60_000,
      normalQueryP95Ms: 3_000,
      pathQueryP95Ms: 3_000,
      eventLoopLagP95Ms: 5_000,
      watchUpdateBatchMs: 10_000,
      deleteBatchMs: 10_000,
    },
  });

  assert.equal(summary.thresholds.passed, true, summary.thresholds.failures.join('\n'));
  assert.ok(
    summary.fixture.initialEntryCount >= 30_000 && summary.fixture.initialEntryCount <= 60_000,
    `expected 30k-60k indexed entries, got ${summary.fixture.initialEntryCount}`
  );
  assert.ok(summary.metrics.pathLikeQueries.p95Ms <= summary.thresholds.applied.pathQueryP95Ms);
  assert.ok(summary.metrics.eventLoopLag.p95Ms <= summary.thresholds.applied.eventLoopLagP95Ms);
  assert.equal(summary.cleanup.completed, true);
  assert.equal(await pathExists(summary.fixture.tempRoot), false, 'large temp fixture should be cleaned up');
});
