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

function simulateTitleOnlyTicks({ ticks, splitStaticPayload }) {
  let itemSerializations = 0;
  let iconSerializations = 0;
  let sends = 0;
  const cache = createMenuBarVisiblePayloadHashCache();

  const serializeStaticPayload = () => {
    itemSerializations += 12;
    iconSerializations += 13;
    return {
      extId: 'demo/timer',
      iconEmoji: '*',
      fallbackIconDataUrl: '',
      items: Array.from({ length: 12 }, (_, index) => ({
        type: 'item',
        id: `__mbi_${index}`,
        title: `Item ${index}`,
        disabled: false,
        iconEmoji: index % 2 === 0 ? '*' : undefined,
      })),
    };
  };

  let staticPayload = splitStaticPayload ? serializeStaticPayload() : null;
  for (let index = 0; index < ticks; index += 1) {
    if (!splitStaticPayload) {
      staticPayload = serializeStaticPayload();
    }
    const payload = {
      ...staticPayload,
      title: `Timer ${String(index).padStart(2, '0')}`,
      tooltip: 'Timer status',
    };
    if (shouldSendMenuBarVisiblePayload(cache, payload)) {
      sends += 1;
    }
  }

  return { itemSerializations, iconSerializations, sends };
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
    const staticEffectIndex = parentSource.indexOf('const syncMenuBarStaticPayload = async () =>');
    const actionIndex = parentSource.indexOf('setMenuBarActions(extId', staticEffectIndex);
    const sendIndex = parentSource.indexOf('sendMenuBarVisiblePayload(staticPayload)', staticEffectIndex);
    const cacheIndex = parentSource.indexOf('shouldSendMenuBarVisiblePayload(');
    const updateIndex = parentSource.indexOf('updateMenuBar?.(payload)', cacheIndex);

    assert.ok(staticEffectIndex >= 0, 'parent has a static payload sync path');
    assert.ok(actionIndex >= 0, 'parent updates the action map');
    assert.ok(sendIndex >= 0, 'parent sends through the visible payload helper');
    assert.ok(cacheIndex >= 0, 'parent checks the visible payload cache');
    assert.ok(updateIndex >= 0, 'parent sends the cached payload object');
    assert.ok(actionIndex < sendIndex, 'actions update before unchanged payloads are skipped');
    assert.ok(cacheIndex < updateIndex, 'IPC send happens only after the cache check');
  });

  await t.test('title-only ticks reuse serialized item and icon payloads', () => {
    const ticks = 60;
    const before = simulateTitleOnlyTicks({ ticks, splitStaticPayload: false });
    const after = simulateTitleOnlyTicks({ ticks, splitStaticPayload: true });

    t.diagnostic(
      `title-only ticks (${ticks} updates, 12 items, 13 icons): ` +
      `before=${before.itemSerializations} item serializations/${before.iconSerializations} icon serializations, ` +
      `after=${after.itemSerializations}/${after.iconSerializations}`
    );

    assert.equal(before.sends, ticks, 'changing titles still send visible title updates');
    assert.equal(after.sends, ticks, 'split payload keeps visible title updates intact');
    assert.equal(before.itemSerializations, 720);
    assert.equal(before.iconSerializations, 780);
    assert.equal(after.itemSerializations, 12);
    assert.equal(after.iconSerializations, 13);
  });

  await t.test('parent keeps title and tooltip out of static serialization dependencies', () => {
    const parentSource = fs.readFileSync(
      path.join(root, 'src/renderer/src/raycast-api/menubar-runtime-parent.tsx'),
      'utf8',
    );
    const staticEffectStart = parentSource.indexOf('const syncMenuBarStaticPayload = async () =>');
    const staticEffectDepsStart = parentSource.indexOf('}, [assetsPath', staticEffectStart);
    const staticEffectDepsEnd = parentSource.indexOf(']);', staticEffectDepsStart);
    const staticDeps = parentSource.slice(staticEffectDepsStart, staticEffectDepsEnd);

    assert.ok(staticEffectStart >= 0, 'parent has a static payload serialization effect');
    assert.ok(staticDeps.includes('registryVersion'), 'static payload still updates when menu registrations change');
    assert.equal(staticDeps.includes('title'), false, 'title changes use cached static serialization');
    assert.equal(staticDeps.includes('tooltip'), false, 'tooltip changes use cached static serialization');
  });
});
