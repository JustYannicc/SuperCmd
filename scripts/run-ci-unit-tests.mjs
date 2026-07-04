#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PERF_TESTS = new Set([
  'test-browser-search-performance.mjs',
  'test-file-search-perf-harness.mjs',
  'test-root-search-perf.mjs',
]);

const entries = await fs.readdir(SCRIPT_DIR);
const testFiles = entries
  .filter((entry) => entry.startsWith('test-') && entry.endsWith('.mjs') && !PERF_TESTS.has(entry))
  .sort()
  .map((entry) => path.join('scripts', entry));

if (testFiles.length === 0) {
  throw new Error('No CI unit test files found');
}

const child = spawn(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
