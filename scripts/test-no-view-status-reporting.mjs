#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTs } from './lib/ts-import.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  reportNoViewStatusIfChanged,
} = await importTs(path.join(root, 'src/renderer/src/raycast-api/no-view-status-reporting.ts'));

test('No-view toast status reporting', async (t) => {
  await t.test('coalesces duplicate show/refresh status payloads but keeps changes', () => {
    const reports = [];
    globalThis.window = {
      __scNoViewStatusTracking: true,
      __scNoViewStatusReported: false,
      electron: {
        reportNoViewStatus(variant, text) {
          reports.push({ variant, text });
        },
      },
    };

    assert.equal(reportNoViewStatusIfChanged('processing', 'Running'), true);
    assert.equal(reportNoViewStatusIfChanged('processing', 'Running'), false);
    assert.equal(reportNoViewStatusIfChanged('success', 'Running'), true);
    assert.equal(reportNoViewStatusIfChanged('success', 'Running'), false);
    assert.deepEqual(reports, [
      { variant: 'processing', text: 'Running' },
      { variant: 'success', text: 'Running' },
    ]);

    t.diagnostic(`duplicate no-view toast status reports: before=4 IPC calls, after=${reports.length}`);
  });

  await t.test('new no-view runs can report the same first payload again', () => {
    const reports = [];
    globalThis.window = {
      __scNoViewStatusTracking: true,
      __scNoViewStatusReported: false,
      __scNoViewStatusLastPayloadKey: 'success\u0000Done',
      electron: {
        reportNoViewStatus(variant, text) {
          reports.push({ variant, text });
        },
      },
    };

    assert.equal(reportNoViewStatusIfChanged('success', 'Done'), true);
    assert.deepEqual(reports, [{ variant: 'success', text: 'Done' }]);
  });

  await t.test('main process keeps an identical-payload burst guard on the IPC handler', () => {
    const mainSource = fs.readFileSync(path.join(root, 'src/main/main.ts'), 'utf8');
    const helperIndex = mainSource.indexOf('function shouldAcceptNoViewStatusReport(');
    const handlerIndex = mainSource.indexOf("ipcMain.handle('no-view-status'");
    const callIndex = mainSource.indexOf('shouldAcceptNoViewStatusReport(variant, normalizedText)', handlerIndex);

    assert.ok(helperIndex >= 0, 'main process has a no-view status burst guard');
    assert.ok(handlerIndex >= 0, 'main process registers no-view-status IPC');
    assert.ok(callIndex > handlerIndex, 'IPC handler consults the burst guard before showing the badge');
  });
});
