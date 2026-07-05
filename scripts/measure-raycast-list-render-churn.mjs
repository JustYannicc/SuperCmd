#!/usr/bin/env node

import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const listRenderersPath = path.join(repoRoot, 'src/renderer/src/raycast-api/list-runtime-renderers.tsx');

const visibleListItems = readNumberArg('--visible-list-items', 64);
const visibleEmojiCells = readNumberArg('--visible-emoji-cells', 112);
const selectionSteps = readNumberArg('--selection-steps', 800);
const iterations = readNumberArg('--iterations', 10);
const warmups = readNumberArg('--warmups', 2);
const jsonOnly = process.argv.includes('--json');

function readNumberArg(name, fallback) {
  const raw = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (!raw) return fallback;
  const value = Number(raw.slice(name.length + 1));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function loadEsbuild() {
  const require = createRequire(import.meta.url);
  try {
    return require('esbuild');
  } catch (error) {
    const moduleRoot = process.env.SUPERCMD_NODE_MODULES;
    if (!moduleRoot) throw error;
    return require(path.join(moduleRoot, 'esbuild'));
  }
}

const esbuild = loadEsbuild();
const tmpDir = await fs.mkdtemp(path.join(repoRoot, '.raycast-list-render-measure-'));
const entryPath = path.join(tmpDir, 'entry.tsx');
const bundlePath = path.join(tmpDir, 'bundle.mjs');
const nodePaths = [
  path.join(repoRoot, 'node_modules'),
  process.env.SUPERCMD_NODE_MODULES,
].filter(Boolean);

await fs.writeFile(entryPath, `
import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { performance } from 'node:perf_hooks';
import { createListRenderers } from ${JSON.stringify(listRenderersPath)};

type Metrics = {
  listItemRenderCount: number;
  emojiGridItemRenderCount: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __raycastListRenderMetrics: Metrics | undefined;
}

const visibleListItems = ${visibleListItems};
const visibleEmojiCells = ${visibleEmojiCells};
const selectionSteps = ${selectionSteps};
const iterations = ${iterations};
const warmups = ${warmups};
const noop = () => {};

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
    return this._text;
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
    : icon?.source || icon?.value || icon?.fileIcon || icon?.fallback || 'icon';
  return <span className={className} data-assets-path={assetsPath || ''}>{String(label)}</span>;
}

function resolveTintColor(value?: string) {
  return value;
}

function addHexAlpha(hex: string, alphaHex: string) {
  return hex.startsWith('#') ? \`\${hex}\${alphaHex}\` : undefined;
}

const { ListItemRenderer, ListEmojiGridItemRenderer } = createListRenderers({
  renderIcon,
  resolveTintColor,
  resolveReadableTintColor: resolveTintColor,
  addHexAlpha,
});

const listItems = Array.from({ length: visibleListItems }, (_, index) => ({
  id: \`list-\${index}\`,
  title: index % 3 === 0 ? { value: \`List Item \${index}\`, tooltip: \`Item \${index}\` } : \`List Item \${index}\`,
  subtitle: index % 4 === 0 ? { value: \`Subtitle \${index}\`, tooltip: \`Subtitle tip \${index}\` } : (index % 2 === 0 ? \`Subtitle \${index}\` : undefined),
  icon: index % 5 === 0 ? { source: 'Icon.Dot', tintColor: 'blue' } : (index % 5 === 1 ? 'Icon.Star' : undefined),
  accessories: index % 2 === 0 ? [{
    text: index % 4 === 0 ? { value: \`Meta \${index}\`, color: '#4f46e5' } : \`Meta \${index}\`,
    icon: index % 6 === 0 ? { source: 'Icon.CheckCircle', tintColor: 'green' } : undefined,
    tag: index % 8 === 0 ? { value: 'Ready', color: '#22c55e' } : undefined,
    date: index % 10 === 0 ? new Date(2026, 6, (index % 28) + 1) : undefined,
  }] : undefined,
  assetsPath: '/tmp/supercmd-assets',
}));

const emojiCells = Array.from({ length: visibleEmojiCells }, (_, index) => ({
  id: \`emoji-\${index}\`,
  icon: [String.fromCodePoint(0x1f600), String.fromCodePoint(0x1f680), '\\u2318', '\\u2605'][index % 4],
  title: \`Emoji \${index}\`,
}));

function ListSelectionWindow({ selectedIdx }: { selectedIdx: number }) {
  return (
    <div>
      {listItems.map((item, index) => (
        <ListItemRenderer
          key={item.id}
          {...item}
          isSelected={index === selectedIdx}
          dataIdx={index}
          onSelect={() => {}}
          onActivate={() => {}}
          onContextAction={() => {}}
        />
      ))}
    </div>
  );
}

function EmojiSelectionWindow({ selectedIdx }: { selectedIdx: number }) {
  return (
    <div>
      {emojiCells.map((cell, index) => (
        <ListEmojiGridItemRenderer
          key={cell.id}
          icon={cell.icon}
          title={cell.title}
          isSelected={index === selectedIdx}
          dataIdx={index}
          onSelect={() => {}}
          onActivate={() => {}}
          onContextAction={() => {}}
        />
      ))}
    </div>
  );
}

function measureSelectionChurn(kind: 'list' | 'emoji') {
  const container = document.createElement('div');
  const root = createRoot(container);
  const Component = kind === 'list' ? ListSelectionWindow : EmojiSelectionWindow;
  const visibleCount = kind === 'list' ? visibleListItems : visibleEmojiCells;

  flushSync(() => {
    root.render(<Component selectedIdx={0} />);
  });

  globalThis.__raycastListRenderMetrics = { listItemRenderCount: 0, emojiGridItemRenderCount: 0 };
  const started = performance.now();
  for (let step = 1; step <= selectionSteps; step += 1) {
    flushSync(() => {
      root.render(<Component selectedIdx={step % visibleCount} />);
    });
  }
  const durationMs = performance.now() - started;
  const metrics = globalThis.__raycastListRenderMetrics;
  root.unmount();

  return {
    durationMs,
    itemRenderCount: kind === 'list'
      ? metrics?.listItemRenderCount || 0
      : metrics?.emojiGridItemRenderCount || 0,
  };
}

installMiniDom();

for (let i = 0; i < warmups; i += 1) {
  measureSelectionChurn('list');
  measureSelectionChurn('emoji');
}

const listSamples = [];
const emojiSamples = [];
for (let index = 0; index < iterations; index += 1) {
  listSamples.push(measureSelectionChurn('list'));
  emojiSamples.push(measureSelectionChurn('emoji'));
}

const listDurations = listSamples.map((sample) => sample.durationMs);
const emojiDurations = emojiSamples.map((sample) => sample.durationMs);

const summary = {
  visibleListItems,
  visibleEmojiCells,
  selectionSteps,
  iterations,
  selectionRenderChurn: {
    listItemRenderCount: listSamples[0]?.itemRenderCount || 0,
    emojiGridItemRenderCount: emojiSamples[0]?.itemRenderCount || 0,
    listMedianDurationMs: median(listDurations),
    listP95DurationMs: percentile(listDurations, 0.95),
    emojiMedianDurationMs: median(emojiDurations),
    emojiP95DurationMs: percentile(emojiDurations, 0.95),
  },
};

if (!${JSON.stringify(jsonOnly)}) {
  console.log(\`Raycast List render churn measurement (visibleListItems=\${visibleListItems}, visibleEmojiCells=\${visibleEmojiCells}, iterations=\${iterations})\`);
  console.log([
    '- list selection render churn',
    \`steps=\${selectionSteps}\`,
    \`itemRenders=\${summary.selectionRenderChurn.listItemRenderCount}\`,
    \`median=\${summary.selectionRenderChurn.listMedianDurationMs.toFixed(3)}ms\`,
    \`p95=\${summary.selectionRenderChurn.listP95DurationMs.toFixed(3)}ms\`,
  ].join(' | '));
  console.log([
    '- emoji selection render churn',
    \`steps=\${selectionSteps}\`,
    \`itemRenders=\${summary.selectionRenderChurn.emojiGridItemRenderCount}\`,
    \`median=\${summary.selectionRenderChurn.emojiMedianDurationMs.toFixed(3)}ms\`,
    \`p95=\${summary.selectionRenderChurn.emojiP95DurationMs.toFixed(3)}ms\`,
  ].join(' | '));
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
    nodePaths,
    loader: {
      '.svg': 'dataurl',
      '.png': 'dataurl',
    },
    plugins: [{
      name: 'instrument-list-renderers',
      setup(build) {
        build.onLoad({ filter: /list-runtime-renderers\.tsx$/ }, async (args) => {
          let source = await fs.readFile(args.path, 'utf8');
          const listMarker = "    const titleStr = typeof title === 'string' ? title : (title as any)?.value || '';";
          const emojiMarker = "    const emoji = typeof icon === 'string' ? icon : '';";
          if (!source.includes(listMarker) || !source.includes(emojiMarker)) {
            throw new Error('Unable to instrument list renderer render counts.');
          }
          source = source
            .replace(
              listMarker,
              '    const __listMetrics = (globalThis.__raycastListRenderMetrics ||= { listItemRenderCount: 0, emojiGridItemRenderCount: 0 });\n    __listMetrics.listItemRenderCount += 1;\n' + listMarker,
            )
            .replace(
              emojiMarker,
              '    const __emojiMetrics = (globalThis.__raycastListRenderMetrics ||= { listItemRenderCount: 0, emojiGridItemRenderCount: 0 });\n    __emojiMetrics.emojiGridItemRenderCount += 1;\n' + emojiMarker,
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
