#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function listenerEffectBlock(source, addListenerLine) {
  const start = source.indexOf(addListenerLine);
  assert.notEqual(start, -1, `missing listener line: ${addListenerLine}`);
  const end = source.indexOf(');', source.indexOf('}, [', start));
  assert.notEqual(end, -1, 'missing listener effect dependency terminator');
  return source.slice(start, end + 2);
}

test('List global shortcut listener reads latest selected actions from a ref', () => {
  const source = readSource('src/renderer/src/raycast-api/list-runtime.tsx');
  const listenerBlock = listenerEffectBlock(source, "window.addEventListener('keydown', handler, true);");
  assert.match(source, /const selectedActionsRef = useRef\(selectedActions\)/);
  assert.match(source, /selectedActionsRef\.current = selectedActions/);
  assert.match(source, /for \(const action of selectedActionsRef\.current\)/);
  assert.doesNotMatch(listenerBlock, /selectedActions/);
});

test('Form global shortcut listener reads latest actions and primary action from refs', () => {
  const source = readSource('src/renderer/src/raycast-api/form-runtime.tsx');
  const listenerBlock = listenerEffectBlock(source, "window.addEventListener('keydown', handler);");
  assert.match(source, /const formActionsRef = useRef\(formActions\)/);
  assert.match(source, /const primaryActionRef = useRef\(primaryAction\)/);
  assert.match(source, /for \(const action of formActionsRef\.current\)/);
  assert.match(source, /const currentPrimaryAction = primaryActionRef\.current/);
  assert.doesNotMatch(listenerBlock, /formActions|primaryAction/);
});

test('Detail global shortcut listener reads latest actions and primary action from refs', () => {
  const source = readSource('src/renderer/src/raycast-api/detail-runtime.tsx');
  const listenerBlock = listenerEffectBlock(source, "window.addEventListener('keydown', handler);");
  assert.match(source, /const detailActionsRef = useRef\(detailActions\)/);
  assert.match(source, /const primaryActionRef = useRef\(primaryAction\)/);
  assert.match(source, /for \(const action of detailActionsRef\.current\)/);
  assert.match(source, /const currentPrimaryAction = primaryActionRef\.current/);
  assert.doesNotMatch(listenerBlock, /detailActions|primaryAction/);
});
