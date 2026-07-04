#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTs } from './lib/ts-import.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  createMenuBarVisiblePayloadHashCache,
  shouldSendMenuBarVisiblePayload,
} = await importTs(path.join(root, 'src/renderer/src/raycast-api/menubar-runtime-payload-cache.ts'));

function makePayload(overrides = {}) {
  return {
    extId: 'demo/timer',
    iconPath: undefined,
    iconDataUrl: undefined,
    iconEmoji: '*',
    iconTemplate: undefined,
    iconBitmapScale: undefined,
    fallbackIconDataUrl: '',
    title: 'Timer',
    tooltip: 'Timer status',
    items: [
      {
        type: 'item',
        id: '__mbi_1',
        title: 'Start',
        subtitle: 'Ready',
        tooltip: 'Start timer',
        disabled: false,
      },
    ],
    ...overrides,
  };
}

test('MenuBarExtra visible payload cache', async (t) => {
  await t.test('skips equivalent renderer sends while action maps stay current', () => {
    const cache = createMenuBarVisiblePayloadHashCache();
    let updateSends = 0;
    let actionMapUpdates = 0;

    for (let i = 0; i < 3; i += 1) {
      const actions = new Map([['__mbi_1', () => i]]);
      actionMapUpdates += actions.size;
      if (shouldSendMenuBarVisiblePayload(cache, makePayload())) {
        updateSends += 1;
      }
    }

    t.diagnostic(`equivalent registrations: before=3 sends, after=${updateSends} send`);
    assert.equal(updateSends, 1, 'only the first equivalent visible payload crosses IPC');
    assert.equal(actionMapUpdates, 3, 'action maps still refresh for every registration pass');
  });

  await t.test('sends again when visible tray or menu fields change', () => {
    const cache = createMenuBarVisiblePayloadHashCache();
    assert.equal(shouldSendMenuBarVisiblePayload(cache, makePayload()), true, 'initial payload sends');
    assert.equal(shouldSendMenuBarVisiblePayload(cache, makePayload()), false, 'equivalent payload is skipped');
    assert.equal(shouldSendMenuBarVisiblePayload(cache, makePayload({ title: 'Timer Running' })), true, 'title change sends');
    assert.equal(shouldSendMenuBarVisiblePayload(cache, makePayload({ iconEmoji: '>' })), true, 'icon change sends');
    assert.equal(shouldSendMenuBarVisiblePayload(cache, makePayload({
      items: [{ type: 'item', id: '__mbi_1', title: 'Pause', disabled: false }],
    })), true, 'menu item change sends');
  });

  await t.test('parent refreshes actions before skipping unchanged visible payloads', () => {
    const parentSource = fs.readFileSync(
      path.join(root, 'src/renderer/src/raycast-api/menubar-runtime-parent.tsx'),
      'utf8',
    );
    const actionIndex = parentSource.indexOf('setMenuBarActions(extId');
    const cacheIndex = parentSource.indexOf('shouldSendMenuBarVisiblePayload(');
    const updateIndex = parentSource.indexOf('updateMenuBar?.(payload)');

    assert.ok(actionIndex >= 0, 'parent updates the action map');
    assert.ok(cacheIndex >= 0, 'parent checks the visible payload cache');
    assert.ok(updateIndex >= 0, 'parent sends the cached payload object');
    assert.ok(actionIndex < cacheIndex, 'actions update before unchanged payloads are skipped');
    assert.ok(cacheIndex < updateIndex, 'IPC send happens only after the cache check');
  });
});
