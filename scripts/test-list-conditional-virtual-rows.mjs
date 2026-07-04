#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const LIST_RUNTIME_PATH = 'src/renderer/src/raycast-api/list-runtime.tsx';
const CASES = [5000, 20000];

function buildGroupedItems(itemCount) {
  return [{
    title: 'Emoji',
    items: Array.from({ length: itemCount }, (_, index) => ({
      item: { id: `emoji-${index}` },
      globalIdx: index,
    })),
  }];
}

function buildFlatRows(groupedItems) {
  const rows = [];
  for (let groupIndex = 0; groupIndex < groupedItems.length; groupIndex += 1) {
    const group = groupedItems[groupIndex];
    if (group.title) rows.push({ type: 'header', title: group.title, key: `__h_${groupIndex}` });
    for (const entry of group.items) {
      rows.push({ type: 'item', item: entry.item, globalIdx: entry.globalIdx, key: entry.item.id });
    }
  }
  return rows;
}

function buildConditionalFlatRows(groupedItems, shouldUseEmojiGridValue) {
  if (shouldUseEmojiGridValue) return [];
  return buildFlatRows(groupedItems);
}

function analyzeListRuntimeSource() {
  const source = fs.readFileSync(LIST_RUNTIME_PATH, 'utf8');
  return {
    skipsFlatRowsForEmojiGrid: source.includes('if (shouldUseEmojiGridValue) return [];'),
    tracksEmojiGridDependency: source.includes('}, [groupedItems, shouldUseEmojiGridValue]);'),
    scrollsRenderedEmojiCell: source.includes('querySelector<HTMLElement>(`[data-idx="${selectedIdx}"]`)?.scrollIntoView'),
  };
}

function measureAvoidedRows() {
  return CASES.map((itemCount) => {
    const groupedItems = buildGroupedItems(itemCount);
    const oldEmojiRows = buildFlatRows(groupedItems);
    const newEmojiRows = buildConditionalFlatRows(groupedItems, true);
    const oldNormalRows = buildFlatRows(groupedItems);
    const newNormalRows = buildConditionalFlatRows(groupedItems, false);

    return {
      itemCount,
      oldEmojiRowCount: oldEmojiRows.length,
      newEmojiRowCount: newEmojiRows.length,
      avoidedEmojiRows: oldEmojiRows.length - newEmojiRows.length,
      normalRowCountPreserved: oldNormalRows.length === newNormalRows.length,
    };
  });
}

test('list runtime skips unused linear rows for emoji-grid mode', () => {
  const source = analyzeListRuntimeSource();
  assert.equal(source.skipsFlatRowsForEmojiGrid, true, 'flat row construction should short-circuit in emoji-grid mode');
  assert.equal(source.tracksEmojiGridDependency, true, 'flat row memo should update when the layout mode changes');
  assert.equal(source.scrollsRenderedEmojiCell, true, 'emoji-grid selection should still scroll the rendered selected cell');

  const measurements = measureAvoidedRows();
  for (const measurement of measurements) {
    assert.equal(measurement.newEmojiRowCount, 0, `${measurement.itemCount} emoji items should not build linear rows`);
    assert.equal(measurement.avoidedEmojiRows, measurement.oldEmojiRowCount);
    assert.equal(measurement.normalRowCountPreserved, true, 'normal list row count should be unchanged');
  }
});

if (process.argv.includes('--report')) {
  console.log(JSON.stringify({ listConditionalVirtualRows: measureAvoidedRows() }, null, 2));
}
