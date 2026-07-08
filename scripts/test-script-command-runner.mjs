#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadScriptCommandRunner } from './lib/script-command-runner-harness.mjs';

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

async function withScriptCommandRunner(t, files, {
  instrumentFs = false,
  mockChildProcess = false,
} = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supercmd-script-runner-test-'));
  const scriptsDir = path.join(tempRoot, 'script-commands');
  const userDataDir = path.join(tempRoot, 'user-data');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  for (const [name, contents] of Object.entries(files)) {
    const filePath = path.join(scriptsDir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, { mode: 0o755 });
  }

  const previousPaths = process.env.SUPERCMD_SCRIPT_COMMAND_PATHS;
  process.env.SUPERCMD_SCRIPT_COMMAND_PATHS = scriptsDir;
  t.after(() => {
    if (previousPaths === undefined) {
      delete process.env.SUPERCMD_SCRIPT_COMMAND_PATHS;
    } else {
      process.env.SUPERCMD_SCRIPT_COMMAND_PATHS = previousPaths;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const loaded = await loadScriptCommandRunner({
    userDataDir,
    scriptCommandFolders: [],
    instrumentFs,
    mockChildProcess,
  });

  return { ...loaded, scriptsDir, tempRoot };
}

function createTimerHarness() {
  let nextId = 1;
  const active = new Map();
  const cleared = [];

  return {
    setTimeout(callback, ms) {
      const id = nextId++;
      active.set(id, { callback, ms });
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
      active.delete(id);
    },
    get activeCount() {
      return active.size;
    },
    get cleared() {
      return cleared;
    },
  };
}

function createFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killCount = 0;
  proc.kill = () => {
    proc.killCount += 1;
  };
  return proc;
}

async function withFakeGlobalTimers(timer, callback) {
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = timer.setTimeout;
  globalThis.clearTimeout = timer.clearTimeout;
  try {
    return await callback();
  } finally {
    globalThis.setTimeout = previousSetTimeout;
    globalThis.clearTimeout = previousClearTimeout;
  }
}

function scriptHeader({
  title = 'Test Command',
  mode = 'fullOutput',
  prefix = '#',
  extra = '',
} = {}) {
  return `${prefix} @raycast.schemaVersion 1
${prefix} @raycast.title ${title}
${prefix} @raycast.mode ${mode}
${extra}`;
}

test('Script command runner', async (t) => {
  await t.test('parses Raycast metadata and argument definitions from command headers', async (t) => {
    const { module: runner, scriptsDir } = await withScriptCommandRunner(t, {
      'metadata.js': `#!/usr/bin/env node --no-warnings
${scriptHeader({
  title: 'Deploy Helper',
  prefix: '//',
  extra: `// @raycast.packageName Ops Tools
// @raycast.icon 🚀
// @raycast.description Deploys a selected environment
// @raycast.needsConfirmation yes
// @raycast.currentDirectoryPath ./workdir
// @raycast.argument1 {"type":"text","placeholder":"Service","required":true}
// @raycast.argument2 {"type":"dropdown","placeholder":"Environment","optional":true,"data":[{"title":"Production","value":"prod"},{"title":"Staging","value":"staging"}]}
`,
})}
console.log('ok');
`,
    });
    fs.mkdirSync(path.join(scriptsDir, 'workdir'), { recursive: true });

    const commands = runner.discoverScriptCommands();
    assert.equal(commands.length, 1);
    const command = commands[0];
    assert.equal(command.title, 'Deploy Helper');
    assert.equal(command.mode, 'fullOutput');
    assert.equal(command.packageName, 'Ops Tools');
    assert.equal(command.iconEmoji, '🚀');
    assert.equal(command.description, 'Deploys a selected environment');
    assert.equal(command.needsConfirmation, true);
    assert.equal(command.currentDirectoryPath, path.join(scriptsDir, 'workdir'));
    assert.deepEqual(command.arguments, [
      {
        name: 'argument1',
        index: 1,
        type: 'text',
        placeholder: 'Service',
        required: true,
        percentEncoded: undefined,
        data: undefined,
      },
      {
        name: 'argument2',
        index: 2,
        type: 'dropdown',
        placeholder: 'Environment',
        required: false,
        percentEncoded: undefined,
        data: [
          { title: 'Production', value: 'prod' },
          { title: 'Staging', value: 'staging' },
        ],
      },
    ]);
  });

  await t.test('executes shebang scripts with a bounded first-line interpreter lookup', async (t) => {
    const { module: runner, metrics, resetMetrics } = await withScriptCommandRunner(t, {
      'with-shebang.sh': `#!/bin/bash
${scriptHeader({ title: 'Shebang Command' })}
echo "shebang:$RAYCAST_TITLE"
`,
    }, { instrumentFs: true });

    const [command] = runner.discoverScriptCommands();
    assert.equal(command.interpreter, '/bin/bash');
    assert.deepEqual(command.interpreterArgs, []);

    resetMetrics();
    const result = await runner.executeScriptCommand(command.id);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), 'shebang:Shebang Command');
    assert.equal(metrics.readFileSyncBytes, 0);
    assert.ok(
      metrics.readSyncBytes <= 8 * 1024,
      `expected only a bounded first-line read, got ${metrics.readSyncBytes} bytes`,
    );
  });

  await t.test('uses updated shebangs within the discovery cache window', async (t) => {
    const { module: runner, scriptsDir } = await withScriptCommandRunner(t, {
      'fresh-shebang.sh': `#!/bin/sh
${scriptHeader({ title: 'Fresh Shebang' })}
[[ "$RAYCAST_TITLE" == "Fresh Shebang" ]] && echo "fresh"
`,
    });

    const [command] = runner.discoverScriptCommands();
    assert.equal(command.interpreter, '/bin/sh');

    fs.writeFileSync(path.join(scriptsDir, 'fresh-shebang.sh'), `#!/bin/bash
${scriptHeader({ title: 'Fresh Shebang' })}
[[ "$RAYCAST_TITLE" == "Fresh Shebang" ]] && echo "fresh"
`, { mode: 0o755 });

    const result = await runner.executeScriptCommand(command.id);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), 'fresh');
  });

  await t.test('uses the bash fallback when a cached shebang is removed', async (t) => {
    const { module: runner, scriptsDir } = await withScriptCommandRunner(t, {
      'removed-shebang.sh': `#!/bin/false
${scriptHeader({ title: 'Removed Shebang' })}
echo "removed"
`,
    });

    const [command] = runner.discoverScriptCommands();
    assert.equal(command.interpreter, '/bin/false');

    fs.writeFileSync(path.join(scriptsDir, 'removed-shebang.sh'), `${scriptHeader({ title: 'Removed Shebang' })}
echo "removed"
`, { mode: 0o755 });

    const result = await runner.executeScriptCommand(command.id);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), 'removed');
  });

  await t.test('executes no-shebang scripts with the bash fallback', async (t) => {
    const { module: runner } = await withScriptCommandRunner(t, {
      'no-shebang.sh': `${scriptHeader({ title: 'No Shebang Command' })}
echo "fallback:$RAYCAST_MODE"
`,
    });

    const [command] = runner.discoverScriptCommands();

    const result = await runner.executeScriptCommand(command.id);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), 'fallback:fullOutput');
  });

  await t.test('caches file icon data across invalidated discoveries and refreshes changed icons', async (t) => {
    const { module: runner, scriptsDir, metrics, resetMetrics } = await withScriptCommandRunner(t, {}, {
      instrumentFs: true,
    });
    const iconsDir = path.join(scriptsDir, '.icons');
    const iconPath = path.join(iconsDir, 'icon.png');
    const scriptPath = path.join(scriptsDir, 'with-file-icon.sh');
    const firstIcon = Buffer.alloc(4096, 1);
    const secondIcon = Buffer.alloc(8192, 2);

    fs.mkdirSync(iconsDir, { recursive: true });
    fs.writeFileSync(iconPath, firstIcon);
    fs.writeFileSync(scriptPath, `#!/bin/bash
${scriptHeader({
  title: 'File Icon Command',
  extra: '# @raycast.icon .icons/icon.png\n',
})}
echo ok
`, { mode: 0o755 });

    resetMetrics();
    const [initialCommand] = runner.discoverScriptCommands();
    assert.equal(initialCommand.title, 'File Icon Command');
    assert.ok(initialCommand.iconDataUrl?.startsWith('data:image/png;base64,'));
    const initialReadBytes = metrics.readFileSyncBytes;
    assert.ok(
      initialReadBytes >= firstIcon.byteLength,
      `expected first discovery to read the icon, got ${initialReadBytes} bytes`,
    );

    resetMetrics();
    runner.invalidateScriptCommandsCache();
    const [cachedCommand] = runner.discoverScriptCommands();
    assert.equal(cachedCommand.iconDataUrl, initialCommand.iconDataUrl);
    assert.ok(
      metrics.readFileSyncBytes < firstIcon.byteLength,
      `expected cached discovery to skip unchanged icon bytes, got ${metrics.readFileSyncBytes} bytes`,
    );

    fs.writeFileSync(iconPath, secondIcon);
    resetMetrics();
    runner.invalidateScriptCommandsCache();
    const [changedCommand] = runner.discoverScriptCommands();
    assert.notEqual(changedCommand.iconDataUrl, initialCommand.iconDataUrl);
    assert.ok(
      metrics.readFileSyncBytes >= secondIcon.byteLength,
      `expected changed icon to be read again, got ${metrics.readFileSyncBytes} bytes`,
    );
  });

  for (const streamName of ['stdout', 'stderr']) {
    await t.test(`clears timeout handle when ${streamName} exceeds output limit`, async (t) => {
      const timer = createTimerHarness();
      await withFakeGlobalTimers(timer, async () => {
        const { module: runner, childProcess } = await withScriptCommandRunner(t, {
          'overflow.sh': `#!/bin/bash
${scriptHeader({ title: 'Overflow Command' })}
echo "overflow"
`,
        }, { mockChildProcess: true });
        const spawned = [];
        childProcess.spawn = (command, args, options) => {
          const proc = createFakeProc();
          spawned.push({ command, args, options, proc });
          return proc;
        };

        const [command] = runner.discoverScriptCommands();
        const promise = runner.executeScriptCommand(command.id, undefined, 60_000);
        const activeBeforeOverflow = timer.activeCount;
        assert.equal(activeBeforeOverflow, 1);
        assert.equal(spawned.length, 1);

        const { proc } = spawned[0];
        proc[streamName].emit('data', Buffer.alloc(MAX_OUTPUT_BYTES + 1, 'x'));

        const result = await promise;
        assert.equal(result.exitCode, 1);
        assert.match(
          result.stderr,
          streamName === 'stdout'
            ? /Output exceeded 2MB limit\./
            : /Error output exceeded 2MB limit\./,
        );
        assert.equal(proc.killCount, 1);
        assert.equal(timer.activeCount, 0);
        assert.equal(timer.cleared.length, 1);
        t.diagnostic(
          `${streamName} overflow timeout handles: before=${activeBeforeOverflow} after=${timer.activeCount} cleared=${timer.cleared.length}`,
        );
      });
    });
  }

  await t.test('discovers metadata in large scripts', async (t) => {
    const body = `# ${'x'.repeat(1022)}\n`.repeat(2048);
    const { module: runner } = await withScriptCommandRunner(t, {
      'large.sh': `#!/bin/bash
${scriptHeader({ title: 'Large Command' })}
exit 0
${body}
`,
    }, { instrumentFs: true });

    const commands = runner.discoverScriptCommands();
    assert.equal(commands.length, 1);
    assert.equal(commands[0].title, 'Large Command');
  });
});
