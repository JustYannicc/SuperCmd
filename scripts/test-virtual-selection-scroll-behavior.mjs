#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function sourceWindow(source, anchor, radius = 900) {
  const index = source.indexOf(anchor);
  assert.notEqual(index, -1, `Expected to find source anchor: ${anchor}`);
  return source.slice(Math.max(0, index - radius), Math.min(source.length, index + anchor.length + radius));
}

test('virtualized selected-item scrolls do not queue smooth animations', () => {
  const gridSelectionScroll = sourceWindow(
    readRepoFile('src/renderer/src/raycast-api/grid-runtime.tsx'),
    'getScrollTopForItemIndex(virtualLayout, selectedIdx'
  );
  assert.match(
    gridSelectionScroll,
    /node\.scrollTo\(\{\s*top:\s*nextScrollTop,\s*behavior:\s*'auto'\s*\}\);/,
    'Raycast grid selection correction should scroll instantly'
  );
  assert.doesNotMatch(
    gridSelectionScroll,
    /behavior:\s*['"]smooth['"]/,
    'Raycast grid selection correction must not queue smooth scroll animations'
  );

  const launcherSelectionScroll = sourceWindow(
    readRepoFile('src/renderer/src/components/LauncherCommandList.tsx'),
    'selectedEntry.top + selectedEntry.height > currentBottom'
  );
  assert.match(
    launcherSelectionScroll,
    /element\.scrollTo\(\{\s*top:\s*Math\.max\(0,\s*nextTop\),\s*behavior:\s*'auto'\s*\}\);/,
    'Launcher command list selected-row correction should scroll instantly'
  );
  assert.doesNotMatch(
    launcherSelectionScroll,
    /behavior:\s*['"]smooth['"]/,
    'Launcher command list selected-row correction must not queue smooth scroll animations'
  );
});
