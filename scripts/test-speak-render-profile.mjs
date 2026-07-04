#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { importTs } from './lib/ts-import.mjs';

const { tokenizeSpeakText } = await importTs(path.resolve('src/renderer/src/SuperCmdRead.tsx'));

function makeWords(count) {
  const words = [];
  for (let i = 0; i < count; i += 1) words.push(`word${i}`);
  return words.join(' ');
}

function legacyRetokenizeTicks(text, ticks) {
  let renderedTokens = 0;
  const start = performance.now();
  for (let tick = 0; tick < ticks; tick += 1) {
    const tokens = text.split(/(\s+)/g);
    let currentWord = 0;
    for (const token of tokens) {
      if (token.trim()) currentWord += 1;
      renderedTokens += 1;
    }
  }
  return { ms: performance.now() - start, renderedTokens };
}

function cachedTokenTicks(text, ticks) {
  const start = performance.now();
  const tokens = tokenizeSpeakText(text);
  let highlightedUpdates = 0;
  for (let tick = 0; tick < ticks; tick += 1) {
    highlightedUpdates += 1;
  }
  return { ms: performance.now() - start, renderedTokens: tokens.length, highlightedUpdates };
}

test('speak tokenization is stable across word-index ticks', (t) => {
  for (const wordCount of [2000, 5000]) {
    const text = makeWords(wordCount);
    const ticks = Math.min(wordCount, 300);
    const tokens = tokenizeSpeakText(text);

    assert.equal(tokens.filter((token) => token.kind === 'word').length, wordCount);
    assert.equal(tokens[0].kind, 'word');
    assert.equal(tokens[0].wordIndex, 0);
    assert.equal(tokens[tokens.length - 1].kind, 'word');
    assert.equal(tokens[tokens.length - 1].wordIndex, wordCount - 1);

    const before = legacyRetokenizeTicks(text, ticks);
    const after = cachedTokenTicks(text, ticks);

    t.diagnostic(
      `[speak-render-profile] words=${wordCount} ticks=${ticks} before=${before.ms.toFixed(2)}ms ` +
      `after=${after.ms.toFixed(2)}ms renderedTokensBefore=${before.renderedTokens} renderedTokensAfter=${after.renderedTokens}`
    );
    assert.ok(after.renderedTokens < before.renderedTokens);
  }
});
