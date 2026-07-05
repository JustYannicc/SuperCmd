#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const listRenderersPath = path.join(repoRoot, 'src/renderer/src/raycast-api/list-runtime-renderers.tsx');

const visibleRows = readNumberArg('--visible-rows', 80);
const visibleEmojiCells = readNumberArg('--visible-emoji-cells', 96);
const selectionSteps = readNumberArg('--selection-steps', 600);
const parentUpdates = readNumberArg('--parent-updates', 300);
const iterations = readNumberArg('--iterations', 9);
const warmups = readNumberArg('--warmups', 2);
const jsonOnly = process.argv.includes('--json');

function readNumberArg(name, fallback) {
  const raw = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (!raw) return fallback;
  const value = Number(raw.slice(name.length + 1));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const tmpDir = await fs.mkdtemp(path.join(repoRoot, '.raycast-list-render-measure-'));
const entryPath = path.join(tmpDir, 'entry.tsx');
const bundlePath = path.join(tmpDir, 'bundle.mjs');

await fs.writeFile(entryPath, `
import React from 'react';
import { performance } from 'node:perf_hooks';
import { createListRenderers } from ${JSON.stringify(listRenderersPath)};

type Metrics = {
  listRowRenderCount: number;
  emojiCellRenderCount: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __raycastListRowMetrics: Metrics | undefined;
}

const visibleRows = ${visibleRows};
const visibleEmojiCells = ${visibleEmojiCells};
const selectionSteps = ${selectionSteps};
const parentUpdates = ${parentUpdates};
const iterations = ${iterations};
const warmups = ${warmups};
const jsonOnly = ${JSON.stringify(jsonOnly)};

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 0;
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * pct) - 1));
  return sorted[index] || 0;
}

class MiniNode {
  nodeType: number;
  nodeName: string;
  tagName: string;
  ownerDocument: any;
  childNodes: any[];
  parentNode: any;
  style: Record<string, string>;
  attributes: Record<string, string>;
  namespaceURI: string;
  _text: string;

  constructor(nodeType: number, nodeName: string, ownerDocument?: any) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.tagName = nodeName;
    this.ownerDocument = ownerDocument || this;
    this.childNodes = [];
    this.parentNode = null;
    this.style = {};
    this.attributes = {};
    this.namespaceURI = 'http://www.w3.org/1999/xhtml';
    this._text = '';
  }

  appendChild(child: any) {
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }

  insertBefore(child: any, before: any) {
    const index = this.childNodes.indexOf(before);
    if (index < 0) return this.appendChild(child);
    this.childNodes.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild(child: any) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = String(value);
  }

  removeAttribute(name: string) {
    delete this.attributes[name];
  }

  addEventListener() {}
  removeEventListener() {}
  focus() {}

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }

  get textContent() {
    if (this.nodeType === 3) return this._text;
    return this.childNodes.map((child) => child.textContent || '').join('');
  }

  set textContent(value: string) {
    this._text = String(value);
    this.childNodes = [];
  }
}

class MiniText extends MiniNode {
  nodeValue: string;

  constructor(text: string, ownerDocument: any) {
    super(3, '#text', ownerDocument);
    this.nodeValue = String(text);
    this._text = String(text);
  }
}

class MiniDocument extends MiniNode {
  documentElement: MiniNode;
  body: MiniNode;
  defaultView: any;

  constructor() {
    super(9, '#document');
    this.ownerDocument = this;
    this.documentElement = new MiniNode(1, 'HTML', this);
    this.body = new MiniNode(1, 'BODY', this);
    this.defaultView = globalThis;
  }

  createElement(tag: string) {
    return new MiniNode(1, tag.toUpperCase(), this);
  }

  createElementNS(namespaceURI: string, tag: string) {
    const node = new MiniNode(1, tag.toUpperCase(), this);
    node.namespaceURI = namespaceURI;
    return node;
  }

  createTextNode(text: string) {
    return new MiniText(text, this);
  }

  addEventListener() {}
  removeEventListener() {}
}

function installMiniDom() {
  const document = new MiniDocument();
  (globalThis as any).document = document;
  (globalThis as any).window = globalThis;
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'supercmd-list-benchmark' },
    configurable: true,
  });
  (globalThis as any).HTMLElement = MiniNode;
  (globalThis as any).HTMLIFrameElement = class {};
}

function renderIcon(icon: any, className?: string, assetsPath?: string) {
  const label = typeof icon === 'string'
    ? icon
    : typeof icon?.source === 'string'
      ? icon.source
      : typeof icon?.value === 'string'
        ? icon.value
        : 'icon';
  return <span className={className} data-assets-path={assetsPath || ''}>{label}</span>;
}

function resolveTintColor(value?: string) {
  if (!value) return undefined;
  if (value.startsWith('#')) return value;
  if (value === 'red') return '#ff453a';
  if (value === 'green') return '#32d74b';
  if (value === 'blue') return '#0a84ff';
  if (value === 'yellow') return '#ffd60a';
  return '#8e8e93';
}

const deps = {
  renderIcon,
  resolveTintColor,
  resolveReadableTintColor: resolveTintColor,
  addHexAlpha: (hex: string, alphaHex: string) => \`\${hex}\${alphaHex}\`,
};

const { ListItemRenderer, ListEmojiGridItemRenderer } = createListRenderers(deps);

function makeAccessories(index: number) {
  switch (index % 6) {
    case 0:
      return [{ text: \`Meta \${index}\`, icon: 'Icon.Tag' }];
    case 1:
      return [{ tag: { value: \`Tag \${index}\`, color: 'blue' } }];
    case 2:
      return [{ date: new Date(2026, index % 11, (index % 27) + 1).toISOString() }];
    case 3:
      return [{ text: { value: \`Tint \${index}\`, color: 'green' }, icon: { source: 'Icon.CheckCircle' } }];
    default:
      return undefined;
  }
}

const listRows = Array.from({ length: visibleRows }, (_, index) => ({
  id: \`list-\${index}\`,
  title: index % 5 === 0 ? { value: \`List Item \${String(index).padStart(4, '0')}\` } : \`List Item \${String(index).padStart(4, '0')}\`,
  subtitle: index % 3 === 0 ? \`Subtitle \${index}\` : undefined,
  icon: index % 4 === 0 ? { source: 'Icon.Dot', color: 'red' } : index % 4 === 1 ? 'Icon.Document' : undefined,
  accessories: makeAccessories(index),
  dataIdx: index,
}));

const emojiRows = Array.from({ length: visibleEmojiCells }, (_, index) => ({
  id: \`emoji-\${index}\`,
  icon: String.fromCodePoint(0x1f600 + (index % 64)),
  title: \`Emoji \${index}\`,
  dataIdx: index,
}));

function ListSelectionWindow({ selectedIdx, parentTick = 0 }: { selectedIdx: number; parentTick?: number }) {
  return (
    <div data-parent-tick={parentTick}>
      {listRows.map((row) => (
        <ListItemRenderer
          key={row.id}
          title={row.title}
          subtitle={row.subtitle}
          icon={row.icon}
          accessories={row.accessories}
          assetsPath="/measure/assets"
          isSelected={row.dataIdx === selectedIdx}
          dataIdx={row.dataIdx}
          onSelect={() => {}}
          onActivate={() => {}}
          onContextAction={() => {}}
        />
      ))}
    </div>
  );
}

function EmojiSelectionWindow({ selectedIdx, parentTick = 0 }: { selectedIdx: number; parentTick?: number }) {
  return (
    <div data-parent-tick={parentTick}>
      {emojiRows.map((row) => (
        <ListEmojiGridItemRenderer
          key={row.id}
          icon={row.icon}
          title={row.title}
          isSelected={row.dataIdx === selectedIdx}
          dataIdx={row.dataIdx}
          onSelect={() => {}}
          onActivate={() => {}}
          onContextAction={() => {}}
        />
      ))}
    </div>
  );
}

async function measureClientRenderChurn(kind: 'list' | 'emoji', mode: 'selection' | 'parent') {
  const [{ createRoot }, { flushSync }] = await Promise.all([
    import('react-dom/client'),
    import('react-dom'),
  ]);
  const container = document.createElement('div');
  const root = createRoot(container);
  const Window = kind === 'list' ? ListSelectionWindow : EmojiSelectionWindow;
  const count = kind === 'list' ? visibleRows : visibleEmojiCells;
  const updates = mode === 'selection' ? selectionSteps : parentUpdates;

  flushSync(() => {
    root.render(<Window selectedIdx={0} parentTick={0} />);
  });

  globalThis.__raycastListRowMetrics = { listRowRenderCount: 0, emojiCellRenderCount: 0 };
  const started = performance.now();
  for (let step = 1; step <= updates; step += 1) {
    flushSync(() => {
      root.render(
        <Window
          selectedIdx={mode === 'selection' ? step % count : 0}
          parentTick={mode === 'parent' ? step : 0}
        />,
      );
    });
  }

  const durationMs = performance.now() - started;
  const metrics = globalThis.__raycastListRowMetrics || { listRowRenderCount: 0, emojiCellRenderCount: 0 };
  root.unmount();

  return {
    durationMs,
    renderCount: kind === 'list' ? metrics.listRowRenderCount : metrics.emojiCellRenderCount,
  };
}

installMiniDom();

for (let i = 0; i < warmups; i += 1) {
  await measureClientRenderChurn('list', 'selection');
  await measureClientRenderChurn('list', 'parent');
  await measureClientRenderChurn('emoji', 'selection');
  await measureClientRenderChurn('emoji', 'parent');
}

async function collect(kind: 'list' | 'emoji', mode: 'selection' | 'parent') {
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    samples.push(await measureClientRenderChurn(kind, mode));
  }
  const durations = samples.map((sample) => sample.durationMs);
  return {
    renderCount: samples[0]?.renderCount || 0,
    medianDurationMs: median(durations),
    p95DurationMs: percentile(durations, 0.95),
    minDurationMs: Math.min(...durations),
    maxDurationMs: Math.max(...durations),
  };
}

const summary = {
  visibleRows,
  visibleEmojiCells,
  selectionSteps,
  parentUpdates,
  iterations,
  listSelectionChurn: await collect('list', 'selection'),
  listParentChurn: await collect('list', 'parent'),
  emojiSelectionChurn: await collect('emoji', 'selection'),
  emojiParentChurn: await collect('emoji', 'parent'),
};

if (!jsonOnly) {
  console.log(\`Raycast List render churn measurement (visibleRows=\${visibleRows}, visibleEmojiCells=\${visibleEmojiCells}, iterations=\${iterations})\`);
  for (const [name, result] of Object.entries({
    'list selection churn': summary.listSelectionChurn,
    'list parent churn': summary.listParentChurn,
    'emoji selection churn': summary.emojiSelectionChurn,
    'emoji parent churn': summary.emojiParentChurn,
  })) {
    console.log([
      \`- \${name}\`,
      \`renders=\${result.renderCount}\`,
      \`median=\${result.medianDurationMs.toFixed(3)}ms\`,
      \`p95=\${result.p95DurationMs.toFixed(3)}ms\`,
      \`min=\${result.minDurationMs.toFixed(3)}ms\`,
      \`max=\${result.maxDurationMs.toFixed(3)}ms\`,
    ].join(' | '));
  }
}

console.log(JSON.stringify(summary, null, 2));
`);

try {
  await esbuild.build({
    entryPoints: [entryPath],
    outfile: bundlePath,
    absWorkingDir: repoRoot,
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    packages: 'external',
    nodePaths: [path.join(repoRoot, 'node_modules')],
    loader: {
      '.svg': 'dataurl',
      '.png': 'dataurl',
    },
    plugins: [{
      name: 'instrument-list-row-renderers',
      setup(build) {
        build.onLoad({ filter: /list-runtime-renderers\.tsx$/ }, async (args) => {
          let source = await fs.readFile(args.path, 'utf8');
          const listMarker = "    const titleStr = typeof title === 'string' ? title : (title as any)?.value || '';";
          const emojiMarker = "    const emoji = typeof icon === 'string' ? icon : '';";
          if (!source.includes(listMarker) || !source.includes(emojiMarker)) {
            throw new Error('Unable to instrument List render count.');
          }
          source = source
            .replace(
              listMarker,
              '    const __listMetrics = (globalThis.__raycastListRowMetrics ||= { listRowRenderCount: 0, emojiCellRenderCount: 0 });\n    __listMetrics.listRowRenderCount += 1;\n' + listMarker,
            )
            .replace(
              emojiMarker,
              '    const __emojiMetrics = (globalThis.__raycastListRowMetrics ||= { listRowRenderCount: 0, emojiCellRenderCount: 0 });\n    __emojiMetrics.emojiCellRenderCount += 1;\n' + emojiMarker,
            );
          return { contents: source, loader: 'tsx' };
        });
      },
    }],
    logLevel: 'silent',
  });

  await import(pathToFileURL(bundlePath).href);
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}
