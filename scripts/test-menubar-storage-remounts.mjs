#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MENU_BAR_HOOK_PATH = path.join(root, 'src/renderer/src/hooks/useMenuBarExtensions.ts');

function depsChanged(prevDeps, nextDeps) {
  if (!prevDeps || !nextDeps || prevDeps.length !== nextDeps.length) return true;
  return nextDeps.some((dep, index) => !Object.is(dep, prevDeps[index]));
}

function createReactHookHarness() {
  const hooks = [];
  const effects = [];
  let hookIndex = 0;
  let pendingEffects = [];

  const react = {
    useState(initialValue) {
      const index = hookIndex++;
      if (!hooks[index]) {
        hooks[index] = {
          value: typeof initialValue === 'function' ? initialValue() : initialValue,
        };
      }
      const setState = (nextValue) => {
        hooks[index].value =
          typeof nextValue === 'function' ? nextValue(hooks[index].value) : nextValue;
      };
      return [hooks[index].value, setState];
    },

    useRef(initialValue) {
      const index = hookIndex++;
      if (!hooks[index]) hooks[index] = { current: initialValue };
      return hooks[index];
    },

    useCallback(callback, deps) {
      const index = hookIndex++;
      const slot = hooks[index];
      if (!slot || depsChanged(slot.deps, deps)) {
        hooks[index] = { value: callback, deps };
      }
      return hooks[index].value;
    },

    useEffect(effect, deps) {
      const index = hookIndex++;
      const slot = effects[index];
      if (!slot || depsChanged(slot.deps, deps)) {
        pendingEffects.push({ index, effect, deps });
      }
    },
  };

  function flushEffects() {
    const toRun = pendingEffects;
    pendingEffects = [];
    for (const next of toRun) {
      const prev = effects[next.index];
      if (typeof prev?.cleanup === 'function') prev.cleanup();
      effects[next.index] = {
        deps: next.deps,
        cleanup: next.effect() || undefined,
      };
    }
  }

  return {
    react,
    render(callback) {
      hookIndex = 0;
      const result = callback();
      flushEffects();
      return result;
    },
    cleanup() {
      for (const effect of effects) {
        if (typeof effect?.cleanup === 'function') effect.cleanup();
      }
    },
  };
}

function installWindowHarness() {
  const listeners = new Map();
  const removedMenuBars = [];

  const win = {
    electron: {
      removeMenuBar(extId) {
        removedMenuBars.push(extId);
      },
      onExtensionPreferencesUpdated() {
        return () => {};
      },
    },
    addEventListener(type, listener) {
      const next = listeners.get(type) || new Set();
      next.add(listener);
      listeners.set(type, next);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) {
        listener(event);
      }
      return true;
    },
  };

  globalThis.window = win;
  globalThis.CustomEvent = class TestCustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  };

  return {
    removedMenuBars,
    restore() {
      delete globalThis.window;
      delete globalThis.CustomEvent;
    },
  };
}

function loadTsModule(filePath, stubs = {}) {
  const resolvedPath = path.resolve(root, filePath);
  const source = fs.readFileSync(resolvedPath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
    fileName: resolvedPath,
  });

  const module = { exports: {} };
  const localRequire = (request) => {
    if (request in stubs) return stubs[request];
    if (request.startsWith('.')) {
      const candidate = path.resolve(path.dirname(resolvedPath), request);
      for (const suffix of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx']) {
        const nextPath = `${candidate}${suffix}`;
        if (fs.existsSync(nextPath) && fs.statSync(nextPath).isFile()) {
          return loadTsModule(path.relative(root, nextPath), stubs);
        }
      }
    }
    return require(request);
  };

  vm.runInNewContext(transpiled.outputText, {
    module,
    exports: module.exports,
    require: localRequire,
    console,
    window: globalThis.window,
    CustomEvent: globalThis.CustomEvent,
    Date,
    Math,
  }, { filename: resolvedPath });

  return module.exports;
}

function makeBundle(extName, cmdName) {
  return {
    code: 'module.exports = function Command() { return null; }',
    title: cmdName,
    extName,
    cmdName,
    extensionName: extName,
    commandName: cmdName,
  };
}

function findEntry(entries, extName, cmdName) {
  return entries.find((entry) => {
    const entryExt = entry.bundle.extName || entry.bundle.extensionName;
    const entryCmd = entry.bundle.cmdName || entry.bundle.commandName;
    return entryExt === extName && entryCmd === cmdName;
  });
}

function createMenuBarSubject() {
  const windowHarness = installWindowHarness();
  const reactHarness = createReactHookHarness();
  const { useMenuBarExtensions } = loadTsModule('src/renderer/src/hooks/useMenuBarExtensions.ts', {
    react: reactHarness.react,
  });

  let current = reactHarness.render(() => useMenuBarExtensions());

  return {
    get current() {
      return current;
    },
    rerender() {
      current = reactHarness.render(() => useMenuBarExtensions());
      return current;
    },
    cleanup() {
      reactHarness.cleanup();
      windowHarness.restore();
    },
  };
}

test('menu-bar storage refresh behavior', async (t) => {
  await t.test('remount throttle timestamp is recorded before React state updates', () => {
    const source = fs.readFileSync(MENU_BAR_HOOK_PATH, 'utf8');
    const remountIndex = source.indexOf('const remountMenuBarExtensionsForExtension');
    const timestampAssignment = 'menuBarRemountTimestampsRef.current[normalized] = now;';
    const timestampIndex = source.indexOf(timestampAssignment, remountIndex);
    const setStateIndex = source.indexOf('setMenuBarExtensions((prev) =>', remountIndex);
    assert.ok(timestampIndex !== -1, 'remount throttle should record the timestamp synchronously');
    assert.ok(setStateIndex !== -1, 'remount function should update menu-bar entries');
    assert.ok(
      timestampIndex < setStateIndex,
      'synchronous storage events should be throttled before React flushes queued state updates'
    );
    assert.equal(
      source.match(new RegExp(timestampAssignment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length,
      1,
      'timestamp mutation should not also happen inside the state updater'
    );
  });

  await t.test('emitted storage events keep extensionName compatibility and include command origin', () => {
    const windowHarness = installWindowHarness();
    const events = [];
    globalThis.window.addEventListener('sc-extension-storage-changed', (event) => {
      events.push(event.detail);
    });

    const { configureStorageEvents, emitExtensionStorageChanged } = loadTsModule(
      'src/renderer/src/raycast-api/storage-events.ts'
    );

    configureStorageEvents({
      getExtensionContext: () => ({
        extensionName: 'Demo',
        commandName: 'Menu',
        commandMode: 'menu-bar',
      }),
    });
    emitExtensionStorageChanged();

    assert.equal(events.length, 1);
    assert.equal(events[0].extensionName, 'Demo');
    assert.equal(events[0].commandName, 'Menu');
    assert.equal(events[0].commandMode, 'menu-bar');
    windowHarness.restore();
  });

  await t.test('self-originated menu-bar storage writes do not remount the writer', () => {
    const subject = createMenuBarSubject();
    try {
      subject.current.upsertMenuBarExtension(makeBundle('Demo', 'Menu'));
      subject.rerender();
      const before = findEntry(subject.current.menuBarExtensions, 'Demo', 'Menu')?.key;
      assert.ok(before, 'menu-bar command should be mounted');

      globalThis.window.dispatchEvent(
        new CustomEvent('sc-extension-storage-changed', {
          detail: {
            extensionName: 'Demo',
            commandName: 'Menu',
            commandMode: 'menu-bar',
          },
        })
      );
      subject.rerender();

      const after = findEntry(subject.current.menuBarExtensions, 'Demo', 'Menu')?.key;
      assert.equal(after, before, 'the writer keeps its ExtensionView key');
    } finally {
      subject.cleanup();
    }
  });

  await t.test('self-originated no-op writes do not throttle the next external refresh', () => {
    const subject = createMenuBarSubject();
    const originalNow = Date.now;
    try {
      let now = 1_000;
      Date.now = () => now;
      subject.current.upsertMenuBarExtension(makeBundle('Demo', 'Menu'));
      subject.rerender();
      const before = findEntry(subject.current.menuBarExtensions, 'Demo', 'Menu')?.key;
      assert.ok(before, 'menu-bar command should be mounted');

      globalThis.window.dispatchEvent(
        new CustomEvent('sc-extension-storage-changed', {
          detail: {
            extensionName: 'Demo',
            commandName: 'Menu',
            commandMode: 'menu-bar',
          },
        })
      );
      now += 50;
      globalThis.window.dispatchEvent(
        new CustomEvent('sc-extension-storage-changed', {
          detail: { extensionName: 'Demo' },
        })
      );
      subject.rerender();

      const after = findEntry(subject.current.menuBarExtensions, 'Demo', 'Menu')?.key;
      assert.notEqual(after, before, 'the external update still refreshes immediately after a no-op self write');
    } finally {
      Date.now = originalNow;
      subject.cleanup();
    }
  });

  await t.test('sibling menu-bar commands still remount for same-extension writes', () => {
    const subject = createMenuBarSubject();
    try {
      subject.current.upsertMenuBarExtension(makeBundle('Demo', 'Writer'));
      subject.current.upsertMenuBarExtension(makeBundle('Demo', 'Reader'));
      subject.rerender();
      const writerBefore = findEntry(subject.current.menuBarExtensions, 'Demo', 'Writer')?.key;
      const readerBefore = findEntry(subject.current.menuBarExtensions, 'Demo', 'Reader')?.key;

      globalThis.window.dispatchEvent(
        new CustomEvent('sc-extension-storage-changed', {
          detail: {
            extensionName: 'Demo',
            commandName: 'Writer',
            commandMode: 'menu-bar',
          },
        })
      );
      subject.rerender();

      const writerAfter = findEntry(subject.current.menuBarExtensions, 'Demo', 'Writer')?.key;
      const readerAfter = findEntry(subject.current.menuBarExtensions, 'Demo', 'Reader')?.key;
      assert.equal(writerAfter, writerBefore, 'writer is not remounted');
      assert.notEqual(readerAfter, readerBefore, 'sibling command is refreshed');
    } finally {
      subject.cleanup();
    }
  });

  await t.test('external storage updates without origin metadata still remount every command', () => {
    const subject = createMenuBarSubject();
    try {
      subject.current.upsertMenuBarExtension(makeBundle('Demo', 'Menu'));
      subject.rerender();
      const before = findEntry(subject.current.menuBarExtensions, 'Demo', 'Menu')?.key;

      globalThis.window.dispatchEvent(
        new CustomEvent('sc-extension-storage-changed', {
          detail: { extensionName: 'Demo' },
        })
      );
      subject.rerender();

      const after = findEntry(subject.current.menuBarExtensions, 'Demo', 'Menu')?.key;
      assert.notEqual(after, before, 'external update refreshes the mounted command');
    } finally {
      subject.cleanup();
    }
  });
});
