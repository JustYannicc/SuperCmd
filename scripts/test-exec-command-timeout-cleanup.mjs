#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTs } from './lib/ts-import.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { runExecCommand } = await importTs(path.join(root, 'src/main/exec-command.ts'));

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
    runNext() {
      const next = active.entries().next();
      if (next.done) return false;
      const [id, timer] = next.value;
      active.delete(id);
      timer.callback();
      return true;
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
  proc.stdin = {
    writes: [],
    ended: false,
    write(value) {
      this.writes.push(value);
    },
    end() {
      this.ended = true;
    },
  };
  proc.killCount = 0;
  proc.kill = () => {
    proc.killCount += 1;
  };
  return proc;
}

function createHarness() {
  const timer = createTimerHarness();
  const spawned = [];
  const dependencies = {
    spawn(command, args, options) {
      const proc = createFakeProc();
      spawned.push({ command, args, options, proc });
      return proc;
    },
    existsSync() {
      return true;
    },
    env: { PATH: '/test/bin' },
    cwd: () => '/test/cwd',
    setTimeout: timer.setTimeout,
    clearTimeout: timer.clearTimeout,
  };

  return {
    timer,
    spawned,
    run(command = '/bin/test-command', args = ['--flag'], options) {
      return runExecCommand(command, args, options, dependencies);
    },
  };
}

test('exec-command timeout cleanup', async (t) => {
  await t.test('clears timeout handle when process closes before timeout', async () => {
    const harness = createHarness();
    const promise = harness.run();
    const { proc } = harness.spawned[0];

    proc.stdout.emit('data', Buffer.from('done'));
    proc.stderr.emit('data', Buffer.from('warn'));
    proc.emit('close', 0);

    assert.deepEqual(await promise, { stdout: 'done', stderr: 'warn', exitCode: 0 });
    assert.equal(harness.timer.activeCount, 0);
    assert.equal(harness.timer.cleared.length, 1);
    assert.equal(proc.killCount, 0);
  });

  await t.test('clears timeout handle when process errors before timeout', async () => {
    const harness = createHarness();
    const promise = harness.run();
    const { proc } = harness.spawned[0];

    proc.stderr.emit('data', Buffer.from('partial stderr'));
    proc.emit('error', new Error('spawn failed'));

    assert.deepEqual(await promise, { stdout: '', stderr: 'spawn failed', exitCode: 1 });
    assert.equal(harness.timer.activeCount, 0);
    assert.equal(harness.timer.cleared.length, 1);
    assert.equal(proc.killCount, 0);
  });

  await t.test('kills process and resolves with timeout result on timeout path', async () => {
    const harness = createHarness();
    const promise = harness.run();
    const { proc } = harness.spawned[0];

    proc.stdout.emit('data', Buffer.from('before-timeout'));
    assert.equal(harness.timer.runNext(), true);

    assert.deepEqual(await promise, {
      stdout: 'before-timeout',
      stderr: 'Command timed out',
      exitCode: 124,
    });
    assert.equal(proc.killCount, 1);
    assert.equal(harness.timer.activeCount, 0);
    assert.equal(harness.timer.cleared.length, 1);
  });

  await t.test('settles once when close, error, and timeout race', async () => {
    const harness = createHarness();
    const promise = harness.run();
    const { proc } = harness.spawned[0];

    proc.emit('close', 7);
    proc.emit('error', new Error('late error'));
    assert.equal(harness.timer.runNext(), false);

    assert.deepEqual(await promise, { stdout: '', stderr: '', exitCode: 7 });
    assert.equal(harness.timer.activeCount, 0);
    assert.equal(harness.timer.cleared.length, 1);
    assert.equal(proc.killCount, 0);
  });
});
