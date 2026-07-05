#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parentPath = path.join(root, 'src/renderer/src/raycast-api/menubar-runtime-parent.tsx');
const sharedPath = path.join(root, 'src/renderer/src/raycast-api/menubar-runtime-shared.ts');

function depsChanged(prevDeps, nextDeps) {
  if (!prevDeps || !nextDeps || prevDeps.length !== nextDeps.length) return true;
  return nextDeps.some((dep, index) => !Object.is(dep, prevDeps[index]));
}

const reactStub = `
const state = globalThis.__menubarSerializationTest.react;
export function createContext(defaultValue) {
  return {
    defaultValue,
    Provider(props) {
      state.providerValues.push(props.value);
      return props.children;
    },
  };
}
export function useContext(ctx) {
  return state.currentContext ?? ctx.defaultValue;
}
export function useRef(initialValue) {
  const index = state.hookIndex++;
  if (!state.hookSlots[index]) state.hookSlots[index] = { current: initialValue };
  return state.hookSlots[index];
}
export function useState(initialValue) {
  const index = state.hookIndex++;
  if (!state.hookSlots[index]) {
    state.hookSlots[index] = { value: typeof initialValue === 'function' ? initialValue() : initialValue };
  }
  const setState = (nextValue) => {
    state.hookSlots[index].value =
      typeof nextValue === 'function' ? nextValue(state.hookSlots[index].value) : nextValue;
  };
  return [state.hookSlots[index].value, setState];
}
export function useCallback(callback, deps) {
  const index = state.hookIndex++;
  const slot = state.hookSlots[index];
  if (!slot || state.depsChanged(slot.deps, deps)) state.hookSlots[index] = { value: callback, deps };
  return state.hookSlots[index].value;
}
export function useMemo(factory, deps) {
  const index = state.hookIndex++;
  const slot = state.hookSlots[index];
  if (!slot || state.depsChanged(slot.deps, deps)) state.hookSlots[index] = { value: factory(), deps };
  return state.hookSlots[index].value;
}
export function useEffect(effect, deps) {
  const index = state.hookIndex++;
  const slot = state.effectSlots[index];
  if (!slot || state.depsChanged(slot.deps, deps)) state.pendingEffects.push({ index, effect, deps });
}
export default { createContext, useContext, useRef, useState, useCallback, useMemo, useEffect };
`;

const jsxRuntimeStub = `
export function jsx(type, props) {
  if (typeof type === 'function') return type(props || {});
  return { type, props };
}
export function jsxs(type, props) {
  return jsx(type, props);
}
export const Fragment = Symbol('Fragment');
`;

const configStub = `
export function getMenuBarRuntimeDeps() {
  return {
    ExtensionInfoReactContext: {
      defaultValue: {
        extId: 'bench/ext',
        assetsPath: '/assets',
        commandMode: 'menu-bar',
        extensionIconDataUrl: '',
      },
    },
    getExtensionContext: () => ({
      extensionName: 'Bench',
      commandName: 'Menu',
      commandMode: 'menu-bar',
      assetsPath: '/assets',
    }),
    setExtensionContext: () => {},
    isEmojiOrSymbol: (src) => [...src].length <= 2 && !src.includes('/') && !src.includes('.'),
  };
}
`;

const phosphorStub = `
export function renderPhosphorIconDataUrl() {
  return 'data:image/svg+xml;base64,AAAA';
}
export async function renderPhosphorIconDataUrlForNative() {
  return 'data:image/png;base64,AAAA';
}
`;

const tintStub = `export function resolveTintColor(value) { return value || ''; }`;

async function createSubject() {
  let hookSlots = [];
  let effectSlots = [];
  let hookIndex = 0;
  let pendingEffects = [];
  let updateSends = 0;
  let clickListener;
  const providerValues = [];
  const metrics = {
    serializeItemEntries: 0,
    itemIconPayloadCalls: 0,
    trayIconPayloadCalls: 0,
  };

  const parentSource = fs.readFileSync(parentPath, 'utf8').replace(
    /const serializeItem = async \(item: MBItemRegistration\): Promise<any> => \{/,
    'const serializeItem = async (item: MBItemRegistration): Promise<any> => { globalThis.__menubarSerializationTest.metrics.serializeItemEntries += 1;',
  );
  const sharedSource = fs.readFileSync(sharedPath, 'utf8').replace(
    /export async function toMenuBarIconPayloadAsync\(icon: any, assetsPath: string\): Promise<SerializedMenuBarIcon \| undefined> \{/,
    `export async function toMenuBarIconPayloadAsync(icon: any, assetsPath: string): Promise<SerializedMenuBarIcon | undefined> {
  if (icon === 'Icon.Clock') globalThis.__menubarSerializationTest.metrics.trayIconPayloadCalls += 1;
  else globalThis.__menubarSerializationTest.metrics.itemIconPayloadCalls += 1;`,
  );

  const { outputFiles } = await build({
    entryPoints: [parentPath],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
    plugins: [{
      name: 'menubar-serialization-test',
      setup(esbuild) {
        esbuild.onLoad({ filter: /menubar-runtime-parent\.tsx$/ }, () => ({ contents: parentSource, loader: 'tsx' }));
        esbuild.onLoad({ filter: /menubar-runtime-shared\.ts$/ }, () => ({ contents: sharedSource, loader: 'ts' }));
        esbuild.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'stub' }));
        esbuild.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'react/jsx-runtime', namespace: 'stub' }));
        esbuild.onResolve({ filter: /^\.\/menubar-runtime-config$/ }, () => ({ path: 'config', namespace: 'stub' }));
        esbuild.onResolve({ filter: /^\.\/icon-runtime-phosphor$/ }, () => ({ path: 'phosphor', namespace: 'stub' }));
        esbuild.onResolve({ filter: /^\.\/icon-runtime-assets$/ }, () => ({ path: 'tint', namespace: 'stub' }));
        esbuild.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents:
            args.path === 'react' ? reactStub :
            args.path === 'react/jsx-runtime' ? jsxRuntimeStub :
            args.path === 'config' ? configStub :
            args.path === 'phosphor' ? phosphorStub :
            tintStub,
          loader: 'js',
        }));
      },
    }],
  });

  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    require,
    console,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    globalThis: null,
    window: {
      electron: {
        onMenuBarItemClick(listener) {
          clickListener = listener;
        },
        updateMenuBar() {
          updateSends += 1;
        },
        removeMenuBar() {},
      },
    },
    __menubarSerializationTest: null,
  };
  sandbox.globalThis = sandbox;
  sandbox.__menubarSerializationTest = {
    metrics,
    react: {
      get hookSlots() { return hookSlots; },
      get effectSlots() { return effectSlots; },
      get hookIndex() { return hookIndex; },
      set hookIndex(value) { hookIndex = value; },
      get pendingEffects() { return pendingEffects; },
      providerValues,
      depsChanged,
      currentContext: null,
    },
  };

  vm.runInNewContext(outputFiles[0].text, sandbox, { filename: parentPath });
  const { MenuBarExtraComponent } = module.exports;

  function flushEffects() {
    const effectsToRun = pendingEffects;
    pendingEffects = [];
    for (const next of effectsToRun) {
      const prev = effectSlots[next.index];
      if (typeof prev?.cleanup === 'function') prev.cleanup();
      const cleanup = next.effect();
      effectSlots[next.index] = {
        deps: next.deps,
        cleanup: typeof cleanup === 'function' ? cleanup : undefined,
      };
    }
  }

  async function settle() {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function render(title, tooltip = 'stable tooltip') {
    hookIndex = 0;
    providerValues.length = 0;
    MenuBarExtraComponent({ title, tooltip, icon: 'Icon.Clock', children: null });
    flushEffects();
    return providerValues.at(-1);
  }

  return {
    metrics,
    render,
    settle,
    click(itemId) {
      clickListener?.({ extId: 'bench/ext', itemId });
    },
    get updateSends() {
      return updateSends;
    },
    resetCounters() {
      metrics.serializeItemEntries = 0;
      metrics.itemIconPayloadCalls = 0;
      metrics.trayIconPayloadCalls = 0;
      updateSends = 0;
    },
  };
}

function makeItem(index, onAction = () => {}) {
  return {
    id: `item-${index}`,
    type: 'item',
    title: `Item ${index}`,
    subtitle: `Sub ${index}`,
    tooltip: `Tip ${index}`,
    icon: 'Icon.Circle',
    onAction,
    sectionId: `section-${Math.floor(index / 10)}`,
    sectionTitle: index % 10 === 0 ? `Section ${Math.floor(index / 10)}` : undefined,
    order: index + 1,
    alternate: index % 5 === 0 ? {
      id: `alt-${index}`,
      type: 'item',
      title: `Alt ${index}`,
      icon: 'Icon.Star',
      onAction,
      order: 1000 + index,
    } : undefined,
  };
}

test('MenuBarExtra renderer serialization cache', async (t) => {
  await t.test('title-only ticks reuse serialized items and only resolve the tray icon', async () => {
    const subject = await createSubject();
    const api = subject.render('tick-0');
    for (let i = 0; i < 60; i += 1) api.register(makeItem(i));
    await subject.settle();
    subject.render('tick-0');
    await subject.settle();

    subject.resetCounters();
    for (let i = 1; i <= 8; i += 1) {
      subject.render(`tick-${i}`);
      await subject.settle();
    }

    assert.equal(subject.metrics.serializeItemEntries, 0, 'stable menu items are not reserialized');
    assert.equal(subject.metrics.itemIconPayloadCalls, 0, 'stable menu item icons are not resolved again');
    assert.equal(subject.metrics.trayIconPayloadCalls, 8, 'tray icon still refreshes for visible tray payloads');
    assert.equal(subject.updateSends, 8, 'title updates still cross IPC');
  });

  await t.test('registry handler changes rebuild actions before skipping unchanged visible payloads', async () => {
    const subject = await createSubject();
    let oldActionCalls = 0;
    let newActionCalls = 0;
    const api = subject.render('same-title');
    api.register(makeItem(0, () => { oldActionCalls += 1; }));
    await subject.settle();
    subject.render('same-title');
    await subject.settle();

    subject.click('item-0');
    assert.equal(oldActionCalls, 1, 'initial action is installed');

    subject.resetCounters();
    api.register(makeItem(0, () => { newActionCalls += 1; }));
    await subject.settle();
    subject.render('same-title');
    await subject.settle();

    assert.equal(subject.updateSends, 0, 'unchanged visible payload is skipped after handler-only update');
    assert.ok(subject.metrics.serializeItemEntries > 0, 'registry changes invalidate the item/action cache');

    subject.click('item-0');
    assert.equal(oldActionCalls, 1, 'old action is replaced');
    assert.equal(newActionCalls, 1, 'new action is installed before the skipped payload returns');
  });
});
