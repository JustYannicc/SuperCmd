#!/usr/bin/env node

import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { performance } from 'perf_hooks';
import vm from 'vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = process.cwd();
const EXTENSION_VIEW_PATH = path.join(ROOT, 'src/renderer/src/ExtensionView.tsx');
const SYNC_METHODS = ['execCommandSync', 'fileExistsSync', 'readFileSync', 'statSync'];

function parseArgs() {
  const args = new Set(process.argv.slice(2));
  const modeArg = process.argv.find((arg) => arg.startsWith('--mode=')) || '--mode=both';
  const mode = modeArg.slice('--mode='.length);
  if (!['fallback', 'node', 'both'].includes(mode)) {
    throw new Error(`Unsupported --mode value: ${mode}`);
  }
  return {
    mode,
    assertNodeDirect: !args.has('--report-only') || args.has('--assert-node-direct'),
  };
}

function createLocalStorage() {
  const store = new Map();
  return {
    get length() {
      return store.size;
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
    getItem(key) {
      return store.has(String(key)) ? store.get(String(key)) : null;
    },
    setItem(key, value) {
      store.set(String(key), String(value));
    },
    removeItem(key) {
      store.delete(String(key));
    },
    clear() {
      store.clear();
    },
  };
}

function createSyncIpcProbe() {
  const entries = [];
  const counts = Object.fromEntries(SYNC_METHODS.map((name) => [name, 0]));
  const timeMs = Object.fromEntries(SYNC_METHODS.map((name) => [name, 0]));

  function record(name, fn) {
    const started = performance.now();
    try {
      return fn();
    } finally {
      const elapsed = performance.now() - started;
      counts[name] += 1;
      timeMs[name] += elapsed;
      entries.push({ name, elapsedMs: elapsed });
    }
  }

  function snapshot() {
    return {
      counts: { ...counts },
      timeMs: { ...timeMs },
      totalCount: Object.values(counts).reduce((sum, value) => sum + value, 0),
      totalTimeMs: Object.values(timeMs).reduce((sum, value) => sum + value, 0),
    };
  }

  function delta(before) {
    const after = snapshot();
    const deltaCounts = {};
    const deltaTimeMs = {};
    for (const name of SYNC_METHODS) {
      deltaCounts[name] = after.counts[name] - before.counts[name];
      deltaTimeMs[name] = after.timeMs[name] - before.timeMs[name];
    }
    return {
      counts: deltaCounts,
      timeMs: deltaTimeMs,
      totalCount: Object.values(deltaCounts).reduce((sum, value) => sum + value, 0),
      totalTimeMs: Object.values(deltaTimeMs).reduce((sum, value) => sum + value, 0),
    };
  }

  return { entries, record, snapshot, delta };
}

function statPayload(filePath) {
  const stat = fs.statSync(filePath);
  return {
    exists: true,
    isDirectory: stat.isDirectory(),
    isFile: stat.isFile(),
    size: stat.size,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    dev: stat.dev,
    ino: stat.ino,
    nlink: stat.nlink,
    atimeMs: stat.atimeMs,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    birthtimeMs: stat.birthtimeMs,
  };
}

function createElectronFacade(probe) {
  return {
    execCommandSync(command, args = [], options = {}) {
      return probe.record('execCommandSync', () => {
        if (command === '/bin/ls' && args[0] === '-A1') {
          return {
            stdout: fs.readdirSync(args[1]).join('\n'),
            stderr: '',
            exitCode: 0,
          };
        }
        const childProcess = require('child_process');
        const result = childProcess.spawnSync(command, args, {
          shell: options.shell ?? false,
          env: { ...process.env, ...options.env },
          cwd: options.cwd || process.cwd(),
          input: options.input,
          encoding: 'utf8',
        });
        return {
          stdout: result.stdout || '',
          stderr: result.stderr || '',
          exitCode: typeof result.status === 'number' ? result.status : result.error ? 1 : 0,
        };
      });
    },
    fileExistsSync(filePath) {
      return probe.record('fileExistsSync', () => fs.existsSync(filePath));
    },
    readFileSync(filePath) {
      return probe.record('readFileSync', () => {
        try {
          return { data: fs.readFileSync(filePath, 'utf8'), error: null };
        } catch (error) {
          return { data: null, error: error instanceof Error ? error.message : String(error) };
        }
      });
    },
    statSync(filePath) {
      return probe.record('statSync', () => {
        try {
          return statPayload(filePath);
        } catch {
          return { exists: false, isDirectory: false, isFile: false, size: 0 };
        }
      });
    },
  };
}

function extractFsFacadeSource() {
  const source = fs.readFileSync(EXTENSION_VIEW_PATH, 'utf8');
  const start = source.indexOf('const _bufferMarker');
  const end = source.indexOf('// ── path stub', start);
  assert.notEqual(start, -1, 'Could not locate Buffer/fs facade start marker');
  assert.notEqual(end, -1, 'Could not locate fs facade end marker');
  return source.slice(start, end);
}

function assertFacadeFallthroughWiring() {
  const source = fs.readFileSync(EXTENSION_VIEW_PATH, 'utf8');
  const helperIndex = source.indexOf('function getSuperCmdBuiltinFacade');
  assert.notEqual(helperIndex, -1, 'fakeRequire should use a facade helper with real-node fallthrough');
  assert.notEqual(
    source.indexOf('new Proxy(facade', helperIndex),
    -1,
    'SuperCmd fs/child_process facades should proxy missing members to real Node modules'
  );

  const fakeRequireIndex = source.indexOf('const fakeRequire: any = (name: string): any =>');
  const facadeCallIndex = source.indexOf('getSuperCmdBuiltinFacade(name)', fakeRequireIndex);
  const realRequireIndex = source.indexOf('tryRealNodeRequire(name)', fakeRequireIndex);
  assert.ok(
    fakeRequireIndex !== -1 && facadeCallIndex !== -1 && realRequireIndex !== -1 && facadeCallIndex < realRequireIndex,
    'fakeRequire should resolve SuperCmd fs/child_process facades before generic real require'
  );
}

function loadFsFacade({ nodeAvailable, electron, localStorage }) {
  const source = `
    const USE_REAL_NODE_BUILTINS = ${nodeAvailable ? 'true' : 'false'};
    const _realNodeRequire = ${nodeAvailable ? '__REAL_NODE_REQUIRE' : 'undefined'};
    const _realNodeProcess = ${nodeAvailable ? '__REAL_NODE_PROCESS' : 'undefined'};
    const noop = () => {};
    const noopAsync = (..._args) => Promise.resolve();
    const noopCb = (...args) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') cb(null);
    };
    ${extractFsFacadeSource()}
    globalThis.__extensionSyncFacadeHarness = { fsStub, commandPathCache };
  `;
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: EXTENSION_VIEW_PATH,
  });
  const sandbox = {
    __REAL_NODE_REQUIRE: nodeAvailable ? require : undefined,
    __REAL_NODE_PROCESS: nodeAvailable ? process : undefined,
    console,
    localStorage,
    window: {
      electron,
      __scNodeRequire: nodeAvailable ? require : undefined,
    },
    performance,
    TextEncoder,
    TextDecoder,
    URL,
    Uint8Array,
    ArrayBuffer,
    DataView,
    Blob: globalThis.Blob,
    File: globalThis.File,
    ReadableStream: globalThis.ReadableStream,
    WritableStream: globalThis.WritableStream,
    TransformStream: globalThis.TransformStream,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Promise,
    Date,
    Error,
    Map,
    Set,
    Symbol,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Math,
  };
  vm.createContext(sandbox);
  vm.runInContext(transpiled.outputText, sandbox, { filename: EXTENSION_VIEW_PATH });
  return sandbox.__extensionSyncFacadeHarness.fsStub;
}

function writeFixtureTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supercmd-extension-sync-facade-'));
  const nestedDir = path.join(dir, 'nested');
  fs.mkdirSync(nestedDir);
  fs.writeFileSync(path.join(dir, 'real.txt'), 'real text', 'utf8');
  fs.writeFileSync(path.join(dir, 'shadow.txt'), 'real shadow', 'utf8');
  fs.writeFileSync(path.join(nestedDir, 'child.txt'), 'child text', 'utf8');
  return dir;
}

function runScenario(mode) {
  const probe = createSyncIpcProbe();
  const localStorage = createLocalStorage();
  const electron = createElectronFacade(probe);
  const tmpDir = writeFixtureTree();
  const fsStub = loadFsFacade({
    nodeAvailable: mode === 'node',
    electron,
    localStorage,
  });

  try {
    const realFile = path.join(tmpDir, 'real.txt');
    const shadowFile = path.join(tmpDir, 'shadow.txt');
    const virtualFile = path.join(tmpDir, 'virtual.txt');

    fsStub.writeFileSync(shadowFile, 'virtual shadow');
    fsStub.writeFileSync(virtualFile, 'virtual only');

    const beforeVirtual = probe.snapshot();
    assert.equal(fsStub.readFileSync(shadowFile, 'utf8'), 'virtual shadow');
    assert.equal(fsStub.existsSync(shadowFile), true);
    assert.equal(fsStub.statSync(shadowFile).size, 'virtual shadow'.length);
    const virtualDelta = probe.delta(beforeVirtual);
    assert.equal(virtualDelta.totalCount, 0, 'virtual/localStorage operations must not hit sync IPC');

    const beforeReal = probe.snapshot();
    assert.equal(fsStub.existsSync(realFile), true);
    assert.equal(fsStub.statSync(realFile).isFile(), true);
    assert.equal(fsStub.readFileSync(realFile, 'utf8'), 'real text');
    assert.doesNotThrow(() => fsStub.accessSync(realFile));
    const entries = fsStub.readdirSync(tmpDir, { withFileTypes: true });
    assert.ok(entries.some((entry) => String(entry.name) === 'real.txt' && entry.isFile()));
    assert.ok(entries.some((entry) => String(entry.name) === 'nested' && entry.isDirectory()));
    assert.ok(entries.some((entry) => String(entry.name) === 'virtual.txt' && entry.isFile()));
    const realDelta = probe.delta(beforeReal);

    return {
      mode,
      realPathOps: realDelta,
      virtualPathOps: virtualDelta,
      total: probe.snapshot(),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function formatCounts(result) {
  return SYNC_METHODS
    .map((name) => `${name}=${result.realPathOps.counts[name]}`)
    .join(', ');
}

const { mode, assertNodeDirect } = parseArgs();
assertFacadeFallthroughWiring();
const modes = mode === 'both' ? ['fallback', 'node'] : [mode];
const results = modes.map((entry) => runScenario(entry));

for (const result of results) {
  const elapsed = result.realPathOps.totalTimeMs.toFixed(3);
  console.log(
    `[extension-sync-facade:${result.mode}] real path ops sync IPC calls: ${result.realPathOps.totalCount} (${formatCounts(result)}), sync IPC time: ${elapsed}ms`
  );
  console.log(
    `[extension-sync-facade:${result.mode}] virtual precedence sync IPC calls: ${result.virtualPathOps.totalCount}`
  );
}

const fallbackResult = results.find((result) => result.mode === 'fallback');
if (fallbackResult) {
  assert.ok(
    fallbackResult.realPathOps.totalCount > 0,
    'fallback mode should exercise the sync IPC path for real filesystem operations'
  );
}

const nodeResult = results.find((result) => result.mode === 'node');
if (assertNodeDirect && nodeResult) {
  assert.equal(
    nodeResult.realPathOps.totalCount,
    0,
    'node mode should avoid sync IPC for representative real filesystem operations'
  );
}
