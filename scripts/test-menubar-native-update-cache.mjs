#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTs } from './lib/ts-import.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  createMenuBarNativeUpdateState,
  getMenuBarNativeItemsKey,
  getMenuBarNativeTitle,
  getMenuBarNativeTooltip,
  isMenuBarNativeIconRefreshNeeded,
  isMenuBarNativeMenuUpdateNeeded,
  isMenuBarNativeTitleUpdateNeeded,
  isMenuBarNativeTooltipUpdateNeeded,
  rememberMenuBarNativeIcon,
  rememberMenuBarNativeMenu,
  rememberMenuBarNativeTitle,
  rememberMenuBarNativeTooltip,
  withMenuBarNativeIconFileIdentity,
} = await importTs(path.join(root, 'src/main/menubar-native-update-cache.ts'));

function makeItems(overrides = {}) {
  return [
    {
      type: 'label',
      title: 'Timer',
    },
    {
      type: 'submenu',
      id: '__mbi_group',
      title: 'Controls',
      children: [
        {
          type: 'item',
          id: '__mbi_pause',
          title: 'Pause',
          subtitle: 'Current session',
          disabled: false,
          alternate: {
            id: '__mbi_pause_alt',
            title: 'Pause without alert',
          },
          ...overrides,
        },
      ],
    },
    {
      type: 'separator',
    },
    {
      type: 'item',
      id: '__mbi_stop',
      title: 'Stop',
      disabled: true,
    },
  ];
}

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
    items: makeItems(),
    ...overrides,
  };
}

function makeCounters() {
  return {
    createTray: 0,
    resolveTrayIcon: 0,
    setImage: 0,
    setTitle: 0,
    setToolTip: 0,
    buildMenuBarTemplate: 0,
    buildFromTemplate: 0,
    setContextMenu: 0,
  };
}

function makeFs(files = new Map()) {
  return {
    statSync(pathValue) {
      const file = files.get(pathValue);
      if (!file) throw new Error(`ENOENT: ${pathValue}`);
      return {
        size: file.size,
        mtimeMs: file.mtimeMs,
        isFile: () => true,
      };
    },
  };
}

function runUncachedNativeWork(payloads) {
  const counters = makeCounters();
  let trayExists = false;

  for (const payload of payloads) {
    counters.resolveTrayIcon += 1;
    if (!trayExists) {
      counters.createTray += 1;
      trayExists = true;
    } else {
      counters.setImage += 1;
    }

    counters.setTitle += 1;
    if (payload.tooltip) counters.setToolTip += 1;
    counters.buildMenuBarTemplate += 1;
    counters.buildFromTemplate += 1;
    counters.setContextMenu += 1;
  }

  return counters;
}

function runCachedNativeWork(payloads, { iconResolvesOk = true, fs = makeFs() } = {}) {
  const counters = makeCounters();
  const state = createMenuBarNativeUpdateState();
  let trayExists = false;

  for (const payload of payloads) {
    const iconPayload = withMenuBarNativeIconFileIdentity(fs, payload);
    if (!trayExists) {
      counters.resolveTrayIcon += 1;
      counters.createTray += 1;
      trayExists = true;
      rememberMenuBarNativeIcon(state, iconPayload, iconResolvesOk);
    } else if (isMenuBarNativeIconRefreshNeeded(state, iconPayload)) {
      counters.resolveTrayIcon += 1;
      counters.setImage += 1;
      rememberMenuBarNativeIcon(state, iconPayload, iconResolvesOk);
    }

    const nextTitle = getMenuBarNativeTitle(payload, state.lastResolvedTrayIconOk);
    if (isMenuBarNativeTitleUpdateNeeded(state, nextTitle)) {
      counters.setTitle += 1;
      rememberMenuBarNativeTitle(state, nextTitle);
    }

    const nextTooltip = getMenuBarNativeTooltip(payload);
    if (isMenuBarNativeTooltipUpdateNeeded(state, nextTooltip)) {
      counters.setToolTip += 1;
      rememberMenuBarNativeTooltip(state, nextTooltip);
    }

    const nextItemsKey = getMenuBarNativeItemsKey(payload.items);
    if (isMenuBarNativeMenuUpdateNeeded(state, nextItemsKey)) {
      counters.buildMenuBarTemplate += 1;
      counters.buildFromTemplate += 1;
      counters.setContextMenu += 1;
      rememberMenuBarNativeMenu(state, nextItemsKey);
    }
  }

  return counters;
}

test('MenuBarExtra native update cache', async (t) => {
  await t.test('rebuilds stable native menus once across 60 title ticks', () => {
    const payloads = Array.from({ length: 60 }, (_, index) => makePayload({
      title: `Timer ${String(index).padStart(2, '0')}`,
    }));
    const before = runUncachedNativeWork(payloads);
    const after = runCachedNativeWork(payloads);

    t.diagnostic(
      `60 title ticks with unchanged items: before=${before.buildFromTemplate} Menu.buildFromTemplate calls, ` +
      `after=${after.buildFromTemplate}`,
    );
    t.diagnostic(
      `60 title ticks with unchanged items: before=${before.setContextMenu} setContextMenu calls, ` +
      `after=${after.setContextMenu}`,
    );

    assert.equal(before.buildFromTemplate, 60);
    assert.equal(before.setContextMenu, 60);
    assert.equal(after.buildFromTemplate, 1);
    assert.equal(after.setContextMenu, 1);
    assert.equal(after.setTitle, 60, 'changing title text still updates the native title every tick');
    assert.equal(after.setToolTip, 1, 'stable tooltip is applied once');
    assert.equal(after.setImage, 0, 'stable non-file icon payload does not call setImage after tray creation');
  });

  await t.test('rebuilds when serialized item payloads change', () => {
    const payloads = [
      makePayload(),
      makePayload({ title: 'Timer tick' }),
      makePayload({
        title: 'Timer tick 2',
        items: makeItems({
          alternate: {
            id: '__mbi_pause_alt',
            title: 'Pause silently',
          },
        }),
      }),
      makePayload({
        title: 'Timer tick 3',
        items: makeItems({
          alternate: {
            id: '__mbi_pause_alt',
            title: 'Pause silently',
          },
        }),
      }),
    ];
    const after = runCachedNativeWork(payloads);

    assert.equal(after.buildFromTemplate, 2, 'initial menu and changed serialized items rebuild');
    assert.equal(after.setContextMenu, 2);
  });

  await t.test('skips stable file-backed tray icon refreshes on accepted updates', () => {
    const iconFiles = new Map([
      ['/tmp/supercmd-timer.png', { size: 128, mtimeMs: 1000 }],
    ]);
    const payloads = Array.from({ length: 3 }, (_, index) => makePayload({
      iconEmoji: undefined,
      iconPath: '/tmp/supercmd-timer.png',
      title: `Timer ${index}`,
    }));
    const after = runCachedNativeWork(payloads, { fs: makeFs(iconFiles) });

    assert.equal(after.resolveTrayIcon, 1, 'unchanged file identity resolves only on tray creation');
    assert.equal(after.setImage, 0, 'stable file-backed icons do not call setImage after tray creation');
    assert.equal(after.buildFromTemplate, 1);
  });

  await t.test('refreshes file-backed tray icons when file identity or icon options change', () => {
    const iconFiles = new Map([
      ['/tmp/supercmd-timer.png', { size: 128, mtimeMs: 1000 }],
      ['/tmp/supercmd-timer-alt.png', { size: 128, mtimeMs: 1000 }],
    ]);
    const fs = makeFs(iconFiles);
    const stable = makePayload({ iconEmoji: undefined, iconPath: '/tmp/supercmd-timer.png' });
    const payloads = [
      stable,
      stable,
      makePayload({ iconEmoji: undefined, iconPath: '/tmp/supercmd-timer-alt.png' }),
      makePayload({ iconEmoji: undefined, iconPath: '/tmp/supercmd-timer-alt.png', iconTemplate: true }),
      makePayload({ iconEmoji: undefined, iconPath: '/tmp/supercmd-timer-alt.png', iconTemplate: true, iconBitmapScale: 2 }),
    ];

    const after = runCachedNativeWork(payloads, { fs });

    assert.equal(after.resolveTrayIcon, 4, 'path, template, and scale changes refresh the tray icon');
    assert.equal(after.setImage, 3);
  });

  await t.test('refreshes file-backed tray icons when mtime or size changes', () => {
    const identities = [
      { size: 128, mtimeMs: 1000 },
      { size: 128, mtimeMs: 1000 },
      { size: 129, mtimeMs: 1001 },
    ];
    let statCalls = 0;
    const fs = {
      statSync() {
        const identity = identities[Math.min(statCalls, identities.length - 1)];
        statCalls += 1;
        return {
          ...identity,
          isFile: () => true,
        };
      },
    };
    const payloads = Array.from({ length: 3 }, (_, index) => makePayload({
      iconEmoji: undefined,
      iconPath: '/tmp/supercmd-timer.png',
      title: `Timer ${index}`,
    }));
    const after = runCachedNativeWork(payloads, { fs });

    assert.equal(after.resolveTrayIcon, 2, 'unchanged file identity skips once, changed mtime/size refreshes once');
    assert.equal(after.setImage, 1);
  });

  await t.test('preserves fallback title decisions', () => {
    assert.equal(getMenuBarNativeTitle(makePayload({ title: '', iconEmoji: '+' }), false), '+');
    assert.equal(getMenuBarNativeTitle(makePayload({ title: '', iconEmoji: '' }), false), '\u23f1');
    assert.equal(getMenuBarNativeTitle(makePayload({ title: '', iconEmoji: '' }), true), '');
  });

  await t.test('keeps empty tooltip payloads non-clearing', () => {
    const state = createMenuBarNativeUpdateState();
    const initialTooltip = getMenuBarNativeTooltip(makePayload({ tooltip: 'Timer status' }));
    assert.equal(isMenuBarNativeTooltipUpdateNeeded(state, initialTooltip), true);
    rememberMenuBarNativeTooltip(state, initialTooltip);

    const emptyTooltip = getMenuBarNativeTooltip(makePayload({ tooltip: '' }));
    assert.equal(isMenuBarNativeTooltipUpdateNeeded(state, emptyTooltip), false);
    assert.equal(state.tooltip, 'Timer status');
  });
});
