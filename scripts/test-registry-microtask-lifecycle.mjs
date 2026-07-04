#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const REGISTRY_SOURCES = [
  'src/renderer/src/raycast-api/action-runtime-registry.tsx',
  'src/renderer/src/raycast-api/list-runtime-hooks.ts',
  'src/renderer/src/raycast-api/grid-runtime-hooks.ts',
  'src/renderer/src/raycast-api/menubar-runtime-parent.tsx',
];

function makeRegistration(kind) {
  const staleClosure = () => kind;
  if (kind === 'action') {
    return {
      id: '__action_1',
      title: 'Open',
      sectionTitle: 'Main',
      order: 1,
      execute: staleClosure,
    };
  }
  if (kind === 'menubar') {
    return {
      id: '__mbi_1',
      title: 'Pause',
      order: 1,
      onAction: staleClosure,
    };
  }
  return {
    id: `${kind}-1`,
    order: 1,
    props: {
      id: `${kind}-visible-1`,
      title: 'Visible item',
      actions: staleClosure,
    },
  };
}

function createLegacyRegistry(kind) {
  const registry = new Map();
  let mounted = true;
  let pending = false;
  let lastSnapshot = '';
  const counters = {
    queuedCallbacks: 0,
    callbacksRunAfterUnmount: 0,
    postUnmountSetStateCalls: 0,
    suppressedPostUnmountCallbacks: 0,
    pendingAfterUnmount: 0,
    registryEntriesAfterUnmount: 0,
  };

  const setState = () => {
    if (!mounted) counters.postUnmountSetStateCalls += 1;
  };

  const scheduleUpdate = () => {
    if (pending) return;
    pending = true;
    counters.queuedCallbacks += 1;
    queueMicrotask(() => {
      if (!mounted) counters.callbacksRunAfterUnmount += 1;
      pending = false;
      if (kind === 'action') {
        const snapshot = Array.from(registry.values())
          .map((entry) => `${entry.id}:${entry.title}:${entry.sectionTitle || ''}`)
          .join('|');
        if (snapshot === lastSnapshot) return;
        lastSnapshot = snapshot;
      }
      setState();
    });
  };

  return {
    register(item) {
      registry.set(item.id, item);
      scheduleUpdate();
    },
    unmount() {
      mounted = false;
      counters.pendingAfterUnmount = pending ? 1 : 0;
      counters.registryEntriesAfterUnmount = registry.size;
    },
    counters,
  };
}

function createFixedRegistry(kind) {
  const registry = new Map();
  let mounted = true;
  let pending = false;
  let lastSnapshot = '';
  const counters = {
    queuedCallbacks: 0,
    callbacksRunAfterUnmount: 0,
    postUnmountSetStateCalls: 0,
    suppressedPostUnmountCallbacks: 0,
    pendingAfterUnmount: 0,
    registryEntriesAfterUnmount: 0,
  };

  const setState = () => {
    if (!mounted) counters.postUnmountSetStateCalls += 1;
  };

  const scheduleUpdate = () => {
    if (!mounted) return;
    if (pending) return;
    pending = true;
    counters.queuedCallbacks += 1;
    queueMicrotask(() => {
      if (!mounted) {
        counters.callbacksRunAfterUnmount += 1;
        counters.suppressedPostUnmountCallbacks += 1;
        pending = false;
        return;
      }
      pending = false;
      if (kind === 'action') {
        const snapshot = Array.from(registry.values())
          .map((entry) => `${entry.id}:${entry.title}:${entry.sectionTitle || ''}`)
          .join('|');
        if (snapshot === lastSnapshot) return;
        lastSnapshot = snapshot;
      }
      setState();
    });
  };

  return {
    register(item) {
      if (!mounted) return;
      registry.set(item.id, item);
      scheduleUpdate();
    },
    unmount() {
      mounted = false;
      pending = false;
      registry.clear();
      lastSnapshot = '';
      counters.pendingAfterUnmount = pending ? 1 : 0;
      counters.registryEntriesAfterUnmount = registry.size;
    },
    counters,
  };
}

async function measureLifecycle(kind, createRegistry) {
  const registry = createRegistry(kind);
  registry.register(makeRegistration(kind));
  registry.unmount();
  await Promise.resolve();
  return registry.counters;
}

function assertSourceHasLifecycleGuard(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  assert.match(source, /mountedRef\s*=\s*useRef/, `${filePath} should track mount state`);
  assert.match(source, /if\s*\(\s*!mountedRef\.current\s*\)\s*\{?\s*(?:pendingRef\.current\s*=\s*false;)?/s, `${filePath} should guard queued work after unmount`);
  assert.match(source, /registryRef\.current\.clear\(\)/, `${filePath} should drop registry entries on unmount`);
}

test('registry queueMicrotask lifecycle cleanup suppresses post-unmount setState', async () => {
  const report = {};
  for (const kind of ['action', 'list', 'grid', 'menubar']) {
    const before = await measureLifecycle(kind, createLegacyRegistry);
    const after = await measureLifecycle(kind, createFixedRegistry);
    report[kind] = { before, after };

    assert.equal(before.queuedCallbacks, 1, `${kind}: legacy schedules a registry microtask`);
    assert.equal(before.callbacksRunAfterUnmount, 1, `${kind}: legacy callback runs after unmount`);
    assert.equal(before.postUnmountSetStateCalls, 1, `${kind}: legacy calls setState after unmount`);
    assert.equal(before.pendingAfterUnmount, 1, `${kind}: legacy retains a pending callback after unmount`);
    assert.equal(before.registryEntriesAfterUnmount, 1, `${kind}: legacy retains a registry entry after unmount`);

    assert.equal(after.queuedCallbacks, 1, `${kind}: fixed still batches through one microtask`);
    assert.equal(after.callbacksRunAfterUnmount, 1, `${kind}: fixed callback may still be delivered by the platform`);
    assert.equal(after.suppressedPostUnmountCallbacks, 1, `${kind}: fixed suppresses delivered post-unmount callback`);
    assert.equal(after.postUnmountSetStateCalls, 0, `${kind}: fixed does not call setState after unmount`);
    assert.equal(after.pendingAfterUnmount, 0, `${kind}: fixed clears pending state on unmount`);
    assert.equal(after.registryEntriesAfterUnmount, 0, `${kind}: fixed drops stale registry closures on unmount`);
  }

  for (const filePath of REGISTRY_SOURCES) {
    assertSourceHasLifecycleGuard(filePath);
  }

  console.log(JSON.stringify({ mode: 'registry-microtask-lifecycle', report }, null, 2));
});
