#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function createMicrotaskQueue() {
  const callbacks = [];
  return {
    enqueue(callback) {
      callbacks.push(callback);
    },
    flush() {
      while (callbacks.length > 0) {
        const callback = callbacks.shift();
        callback();
      }
    },
    get pendingCallbacks() {
      return callbacks.length;
    },
  };
}

function createSchedulerHarness(createScheduler) {
  const microtasks = createMicrotaskQueue();
  let mounted = true;
  let setStateCalls = 0;
  let postUnmountSetStateCalls = 0;

  const scheduler = createScheduler({
    enqueueMicrotask: microtasks.enqueue,
    setState() {
      setStateCalls += 1;
      if (!mounted) postUnmountSetStateCalls += 1;
    },
  });

  return {
    schedule: scheduler.schedule,
    flush: microtasks.flush,
    unmount() {
      mounted = false;
      scheduler.unmount();
    },
    metrics() {
      return {
        setStateCalls,
        postUnmountSetStateCalls,
        pendingCallbacks: microtasks.pendingCallbacks,
        retainedQueuedCallbacks: scheduler.retainedQueuedCallbacks(),
      };
    },
  };
}

function createLegacyRegistryScheduler({ enqueueMicrotask, setState }) {
  let pending = false;

  return {
    schedule() {
      if (pending) return;
      pending = true;
      enqueueMicrotask(() => {
        pending = false;
        setState();
      });
    },
    unmount() {},
    retainedQueuedCallbacks() {
      return pending ? 1 : 0;
    },
  };
}

function createGuardedRegistryScheduler({ enqueueMicrotask, setState }) {
  let mounted = true;
  let pending = false;
  let queuedUpdate = null;

  return {
    schedule() {
      if (!mounted || pending) return;
      pending = true;
      queuedUpdate = setState;
      enqueueMicrotask(() => {
        const update = queuedUpdate;
        queuedUpdate = null;
        pending = false;
        if (!mounted || !update) return;
        update();
      });
    },
    unmount() {
      mounted = false;
      pending = false;
      queuedUpdate = null;
    },
    retainedQueuedCallbacks() {
      return queuedUpdate ? 1 : 0;
    },
  };
}

function measurePostUnmountMicrotask(createScheduler) {
  const harness = createSchedulerHarness(createScheduler);
  harness.schedule();
  const beforeUnmount = harness.metrics();
  harness.unmount();
  const afterUnmountBeforeFlush = harness.metrics();
  harness.flush();
  const afterFlush = harness.metrics();
  harness.schedule();
  const afterStaleSchedule = harness.metrics();
  harness.flush();
  const afterStaleFlush = harness.metrics();

  return {
    beforeUnmount,
    afterUnmountBeforeFlush,
    afterFlush,
    afterStaleSchedule,
    afterStaleFlush,
  };
}

function measureMountedCoalescing(createScheduler) {
  const harness = createSchedulerHarness(createScheduler);
  harness.schedule();
  harness.schedule();
  const beforeFlush = harness.metrics();
  harness.flush();
  return {
    beforeFlush,
    afterFlush: harness.metrics(),
  };
}

function readSource(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('guarded registry microtasks suppress pending state updates after unmount', () => {
  const legacy = measurePostUnmountMicrotask(createLegacyRegistryScheduler);
  const fixed = measurePostUnmountMicrotask(createGuardedRegistryScheduler);

  assert.equal(legacy.beforeUnmount.pendingCallbacks, 1);
  assert.equal(legacy.afterUnmountBeforeFlush.retainedQueuedCallbacks, 1);
  assert.equal(legacy.afterFlush.postUnmountSetStateCalls, 1);

  assert.equal(fixed.beforeUnmount.pendingCallbacks, 1);
  assert.equal(fixed.afterUnmountBeforeFlush.retainedQueuedCallbacks, 0);
  assert.equal(fixed.afterFlush.postUnmountSetStateCalls, 0);
  assert.equal(fixed.afterStaleSchedule.pendingCallbacks, 0);
  assert.equal(fixed.afterStaleFlush.postUnmountSetStateCalls, 0);

  console.log(JSON.stringify({
    mode: 'registry-microtask-lifecycle',
    scenario: 'post-unmount-suppression',
    legacy,
    fixed,
  }, null, 2));
});

test('guarded registry microtasks preserve mounted coalescing', () => {
  const legacy = measureMountedCoalescing(createLegacyRegistryScheduler);
  const fixed = measureMountedCoalescing(createGuardedRegistryScheduler);

  assert.equal(legacy.beforeFlush.pendingCallbacks, 1);
  assert.equal(legacy.afterFlush.setStateCalls, 1);
  assert.equal(fixed.beforeFlush.pendingCallbacks, 1);
  assert.equal(fixed.afterFlush.setStateCalls, 1);

  console.log(JSON.stringify({
    mode: 'registry-microtask-lifecycle',
    scenario: 'mounted-coalescing',
    legacy,
    fixed,
  }, null, 2));
});

test('runtime registries clear queued microtask callbacks on unmount', () => {
  const files = [
    'src/renderer/src/raycast-api/action-runtime-registry.tsx',
    'src/renderer/src/raycast-api/list-runtime-hooks.ts',
    'src/renderer/src/raycast-api/grid-runtime-hooks.ts',
    'src/renderer/src/raycast-api/menubar-runtime-parent.tsx',
  ];

  for (const file of files) {
    const source = readSource(file);
    assert.match(source, /mountedRef = useRef\(true\)/, `${file} should track mount state`);
    assert.match(source, /queuedUpdateRef = useRef<\(\(\) => void\) \| null>\(null\)/, `${file} should keep the queued callback clearable`);
    assert.match(source, /queuedUpdateRef\.current = null;/, `${file} should release queued callbacks`);
    assert.match(source, /if \(!mountedRef\.current \|\| !queuedUpdate\) return;/, `${file} should suppress post-unmount updates`);
  }
});
