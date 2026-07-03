#!/usr/bin/env node

import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { createRequire } from 'module';
import { performance } from 'perf_hooks';

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
    URL,
    Date,
    Math,
    String,
    Number,
    Boolean,
    Set,
    Map,
    WeakMap,
    Object,
    Array,
    RegExp,
    Promise,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(transpiled.outputText, sandbox, { filename: resolvedPath });
  return module.exports;
}

function writeFile(filePath, contents = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function makeTempHome(label) {
  const tmpRoot = fs.realpathSync(os.tmpdir());
  return fs.mkdtempSync(path.join(tmpRoot, `supercmd-file-search-${label}-`));
}

function removeTempHome(homeDir) {
  try {
    fs.rmSync(homeDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup for temp fixtures.
  }
}

async function withIndexedHome(homeDir, fn) {
  moduleCache.delete(path.resolve('src/main/file-search-index.ts'));
  const fileSearch = loadTsModule('src/main/file-search-index.ts');
  fileSearch.startFileSearchIndexing({
    homeDir,
    refreshIntervalMs: 30_000,
    includeProtectedHomeRoots: true,
  });
  await fileSearch.rebuildFileSearchIndex('test');
  try {
    await fn(fileSearch);
  } finally {
    fileSearch.stopFileSearchIndexing();
  }
}

function resultPaths(results) {
  return results.map((result) => result.path);
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

await test('path-like queries match absolute, tilde, and relative paths', async () => {
  const homeDir = makeTempHome('correctness');
  try {
    const srcDir = path.join(homeDir, 'Projects', 'app-042', 'src');
    const exactFile = path.join(srcDir, 'Report Final.txt');
    writeFile(exactFile, 'report');
    writeFile(path.join(srcDir, 'Report Notes.md'), 'notes');
    writeFile(path.join(homeDir, 'Projects', 'app-042', 'README.md'), 'readme');
    writeFile(path.join(homeDir, 'Archive', 'Reports', 'src', 'Q2 Plan.txt'), 'plan');

    await withIndexedHome(homeDir, async ({ searchIndexedFiles }) => {
      const absolute = await searchIndexedFiles(srcDir, { limit: 8 });
      assert.equal(absolute[0]?.path, srcDir);
      assert.ok(resultPaths(absolute).includes(exactFile));

      const tilde = await searchIndexedFiles('~/Projects/app-042/src', { limit: 8 });
      assert.equal(tilde[0]?.path, srcDir);
      assert.ok(resultPaths(tilde).includes(exactFile));

      const relative = await searchIndexedFiles('Projects/app-042/src', { limit: 8 });
      assert.equal(relative[0]?.path, srcDir);
      assert.ok(resultPaths(relative).includes(exactFile));

      const exact = await searchIndexedFiles('~/Projects/app-042/src/Report Final.txt', { limit: 4 });
      assert.equal(exact[0]?.path, exactFile);
      assert.equal(exact[0]?.matchKind, 'path');
    });
  } finally {
    removeTempHome(homeDir);
  }
});

await test('path-like fallback preserves mid-token slash matches', async () => {
  const homeDir = makeTempHome('fallback');
  try {
    const fallbackFile = path.join(homeDir, 'Archive', 'Reports', 'src', 'Q2 Plan.txt');
    writeFile(fallbackFile, 'plan');
    writeFile(path.join(homeDir, 'Archive', 'Exports', 'src', 'Other.txt'), 'other');

    await withIndexedHome(homeDir, async ({ searchIndexedFiles }) => {
      const midToken = await searchIndexedFiles('ports/src', { limit: 8 });
      assert.ok(resultPaths(midToken).includes(fallbackFile));

      const trailingSlash = await searchIndexedFiles('ports/', { limit: 8 });
      assert.ok(resultPaths(trailingSlash).includes(fallbackFile));

      const noMatch = await searchIndexedFiles('~/Archive/Missing/src', { limit: 8 });
      assert.equal(noMatch.length, 0);
    });
  } finally {
    removeTempHome(homeDir);
  }
});

function populateSyntheticTree(homeDir, targetEntries) {
  const projectsDir = path.join(homeDir, 'Projects');
  const filesPerApp = 48;
  const appCount = Math.max(1, Math.ceil(targetEntries / (filesPerApp + 2)));

  for (let appIndex = 0; appIndex < appCount; appIndex += 1) {
    const appName = `app-${String(appIndex).padStart(4, '0')}`;
    const srcDir = path.join(projectsDir, appName, 'src');
    const docsDir = path.join(projectsDir, appName, 'docs');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(docsDir, { recursive: true });
    for (let fileIndex = 0; fileIndex < filesPerApp; fileIndex += 1) {
      const bucket = fileIndex % 2 === 0 ? srcDir : docsDir;
      const name = `module-${String(fileIndex).padStart(3, '0')}-${appName}.ts`;
      fs.writeFileSync(path.join(bucket, name), '');
    }
  }

  return {
    appCount,
    filesPerApp,
    indexedEntryEstimate: appCount * (filesPerApp + 3) + 1,
  };
}

async function runPerformanceHarness() {
  const targetEntries = Number(process.env.FILE_SEARCH_PERF_ENTRIES || 60000);
  const iterations = Number(process.env.FILE_SEARCH_PERF_ITERATIONS || 24);
  const homeDir = makeTempHome('perf');
  try {
    const fixture = populateSyntheticTree(homeDir, targetEntries);
    await withIndexedHome(homeDir, async ({ getFileSearchIndexStatus, searchIndexedFiles }) => {
      const status = getFileSearchIndexStatus();
      const queryAppIds = [7, 42, 137, Math.floor(fixture.appCount / 2), fixture.appCount - 3]
        .filter((value, index, values) => value >= 0 && value < fixture.appCount && values.indexOf(value) === index)
        .map((value) => String(value).padStart(4, '0'));
      const queries = queryAppIds.flatMap((id) => [
        path.join(homeDir, 'Projects', `app-${id}`, 'src'),
        `~/Projects/app-${id}/src`,
        `Projects/app-${id}/src`,
      ]);

      const startedAt = performance.now();
      let totalResults = 0;
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        for (const query of queries) {
          const results = await searchIndexedFiles(query, { limit: 1 });
          totalResults += results.length;
        }
      }
      const elapsedMs = performance.now() - startedAt;
      const queryCount = iterations * queries.length;
      const metric = {
        entries: status.indexedEntryCount,
        estimatedEntries: fixture.indexedEntryEstimate,
        queries: queryCount,
        elapsedMs: Number(elapsedMs.toFixed(2)),
        avgMsPerQuery: Number((elapsedMs / queryCount).toFixed(3)),
        totalResults,
      };
      console.log(`FILE_SEARCH_PERF ${JSON.stringify(metric)}`);
    });
  } finally {
    removeTempHome(homeDir);
  }
}

if (process.env.SUPERCMD_FILE_SEARCH_PERF === '1') {
  await runPerformanceHarness();
}
