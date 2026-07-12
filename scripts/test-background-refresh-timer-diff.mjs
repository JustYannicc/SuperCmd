import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const helperPath = path.join(rootDir, 'src/renderer/src/hooks/backgroundRefreshTimers.ts');

function loadHelperModule() {
  const source = fs.readFileSync(helperPath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: helperPath,
  });
  const module = { exports: {} };

  vm.runInNewContext(
    compiled.outputText,
    {
      exports: module.exports,
      module,
      require: (specifier) => {
        throw new Error(`Unexpected runtime import while loading timer helper: ${specifier}`);
      },
    },
    { filename: helperPath }
  );

  return module.exports;
}

const {
  getBackgroundRefreshTimerDescriptors,
  reconcileBackgroundRefreshTimers,
  clearBackgroundRefreshTimers,
} = loadHelperModule();

function parseIntervalToMs(interval) {
  return {
    '1m': 60_000,
    '5m': 300_000,
    '10m': 600_000,
  }[interval] ?? null;
}

function extensionCommand(overrides = {}) {
  return {
    id: 'extension-weather-current',
    title: 'Current Weather',
    category: 'extension',
    path: 'weather/current',
    mode: 'no-view',
    interval: '1m',
    ...overrides,
  };
}

function inlineScriptCommand(overrides = {}) {
  return {
    id: 'script-stock-ticker',
    title: 'Stock Ticker',
    category: 'script',
    path: '/Users/example/Scripts/stocks.sh',
    mode: 'inline',
    interval: '5m',
    ...overrides,
  };
}

function descriptors(commands) {
  return getBackgroundRefreshTimerDescriptors(commands, parseIntervalToMs);
}

function legacyReconcile(commands, activeTimers) {
  const cleared = activeTimers.length;
  activeTimers.length = 0;

  for (const descriptor of descriptors(commands)) {
    activeTimers.push(descriptor.key);
  }

  return { created: activeTimers.length, cleared };
}

function createHarness() {
  const timers = new Map();
  const created = [];
  const cleared = [];
  let nextTimerId = 1;

  return {
    timers,
    created,
    cleared,
    reconcile(commands) {
      return reconcileBackgroundRefreshTimers({
        timers,
        descriptors: descriptors(commands),
        createTimer(descriptor) {
          const timerId = nextTimerId++;
          created.push({ timerId, key: descriptor.key, commandId: descriptor.command.id });
          return timerId;
        },
        clearTimer(timerId) {
          cleared.push(timerId);
        },
      });
    },
    clearAll() {
      return clearBackgroundRefreshTimers(timers, (timerId) => {
        cleared.push(timerId);
      });
    },
  };
}

function activeTimerIds(harness) {
  return Array.from(harness.timers.values()).map((entry) => entry.timerId);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('Background refresh timer diff', async (t) => {
  await t.test('baseline legacy strategy clears and recreates unchanged background commands', () => {
    const activeTimers = [];
    const initialCommands = [
      extensionCommand(),
      inlineScriptCommand(),
      { id: 'app-terminal', title: 'Terminal', category: 'app' },
    ];
    const refreshedCommands = [
      extensionCommand({ subtitle: 'Updated metadata' }),
      inlineScriptCommand({ subtitle: 'AAPL 210.00' }),
      { id: 'app-terminal', title: 'Terminal', category: 'app', subtitle: 'Terminal.app' },
    ];

    const first = legacyReconcile(initialCommands, activeTimers);
    const second = legacyReconcile(refreshedCommands, activeTimers);

    console.log(
      `[background-refresh baseline] unchanged update legacy created=${second.created} cleared=${second.cleared}`
    );
    assert.deepEqual(first, { created: 2, cleared: 0 });
    assert.deepEqual(second, { created: 2, cleared: 2 });
  });

  await t.test('unchanged background commands retain their timers across command-list updates', () => {
    const harness = createHarness();
    const initial = harness.reconcile([
      extensionCommand(),
      inlineScriptCommand(),
      { id: 'app-terminal', title: 'Terminal', category: 'app' },
    ]);
    const timerIdsBeforeUpdate = activeTimerIds(harness);

    const update = harness.reconcile([
      extensionCommand({ subtitle: 'Updated metadata' }),
      inlineScriptCommand({ subtitle: 'AAPL 210.00' }),
      { id: 'app-terminal', title: 'Terminal', category: 'app', subtitle: 'Terminal.app' },
    ]);

    console.log(
      `[background-refresh keyed] unchanged update created=${update.created} retained=${update.retained} cleared=${update.cleared}`
    );
    assert.deepEqual(plain(initial), { created: 2, retained: 0, cleared: 0 });
    assert.deepEqual(plain(update), { created: 0, retained: 2, cleared: 0 });
    assert.deepEqual(activeTimerIds(harness), timerIdsBeforeUpdate);
    assert.equal(harness.created.length, 2);
    assert.equal(harness.cleared.length, 0);
  });

  await t.test('added background commands create timers and removed commands clear timers', () => {
    const harness = createHarness();
    const extension = extensionCommand();
    const script = inlineScriptCommand();

    assert.deepEqual(plain(harness.reconcile([extension])), { created: 1, retained: 0, cleared: 0 });
    assert.deepEqual(plain(harness.reconcile([extension, script])), { created: 1, retained: 1, cleared: 0 });
    assert.deepEqual(plain(harness.reconcile([script])), { created: 0, retained: 1, cleared: 1 });
    assert.deepEqual(activeTimerIds(harness), [2]);
    assert.deepEqual(harness.cleared, [1]);
  });

  await t.test('changed background command identity fields restart only the changed timer', () => {
    const harness = createHarness();
    const extension = extensionCommand();
    const script = inlineScriptCommand();

    assert.deepEqual(plain(harness.reconcile([extension, script])), { created: 2, retained: 0, cleared: 0 });
    assert.deepEqual(plain(harness.reconcile([extensionCommand({ interval: '5m' }), script])), {
      created: 1,
      retained: 1,
      cleared: 1,
    });
    assert.deepEqual(activeTimerIds(harness), [2, 3]);
    assert.deepEqual(harness.cleared, [1]);

    assert.deepEqual(plain(harness.reconcile([extensionCommand({ interval: '5m', mode: 'menu-bar' }), script])), {
      created: 1,
      retained: 1,
      cleared: 1,
    });
    assert.deepEqual(activeTimerIds(harness), [2, 4]);
    assert.deepEqual(harness.cleared, [1, 3]);
  });

  await t.test('unmount cleanup clears all remaining timers once', () => {
    const harness = createHarness();

    assert.deepEqual(plain(harness.reconcile([extensionCommand(), inlineScriptCommand()])), {
      created: 2,
      retained: 0,
      cleared: 0,
    });
    assert.equal(harness.clearAll(), 2);
    assert.deepEqual(activeTimerIds(harness), []);
    assert.deepEqual(harness.cleared, [1, 2]);
  });
});
