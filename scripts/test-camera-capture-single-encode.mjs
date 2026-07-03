#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cameraExtensionPath = path.join(root, 'src/renderer/src/CameraExtension.tsx');
const mainPath = path.join(root, 'src/main/main.ts');

test('Camera capture save path avoids redundant mkdir subprocess', async (t) => {
  await t.test('camera capture writes image bytes without shelling out for mkdir', () => {
    const source = fs.readFileSync(cameraExtensionPath, 'utf8');

    assert.ok(!source.includes('/bin/mkdir'));
    assert.ok(!source.includes("['-p', saveDir]"));
    assert.ok(source.includes('const saveDir = homeDir ? `${homeDir}/Pictures/SuperCmd Captures` : \'/tmp/SuperCmd Captures\';'));
    assert.ok(source.includes('const savePath = `${saveDir}/supercmd-capture-${timestamp}.png`;'));
    assert.ok(source.includes('const bytes = new Uint8Array(await captureBlob.arrayBuffer());'));
    assert.ok(source.includes('await window.electron.fsWriteBinaryFile(savePath, bytes);'));
  });

  await t.test('fsWriteBinaryFile IPC creates parent directories recursively', () => {
    const source = fs.readFileSync(mainPath, 'utf8');
    const mkdirLine = 'await fs.promises.mkdir(nodePath.dirname(filePath), { recursive: true });';
    const writeLine = 'await fs.promises.writeFile(filePath, Buffer.from(data));';

    assert.ok(source.includes("ipcMain.handle('fs-write-binary-file'"));
    assert.ok(source.includes(mkdirLine));
    assert.ok(source.includes(writeLine));
    assert.ok(source.indexOf(mkdirLine) < source.indexOf(writeLine));
  });
});
