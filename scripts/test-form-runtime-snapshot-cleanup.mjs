#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const FORM_RUNTIME_ENTRY = `
  export { createFormRuntime } from './src/renderer/src/raycast-api/form-runtime';
  export {
    getFormErrors,
    getFormSnapshotMetrics,
    getFormValues,
  } from './src/renderer/src/raycast-api/form-runtime-context';
`;

const REACT_STUB = `
const runtime = () => {
  const current = globalThis.__supercmdFormSnapshotRuntime;
  if (!current) throw new Error('Form snapshot React runtime is not installed');
  return current;
};

function createContext(defaultValue) {
  const context = { _currentValue: defaultValue };
  function Provider(props) {
    return { type: Provider, props: props || {} };
  }
  Provider.__context = context;
  context.Provider = Provider;
  context.Consumer = ({ children }) => typeof children === 'function' ? children(context._currentValue) : children;
  return context;
}

const React = {
  Fragment: Symbol.for('react.fragment'),
  createContext,
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
  useCallback: (callback, deps) => runtime().useCallback(callback, deps),
  useContext: (context) => runtime().useContext(context),
  useEffect: (effect, deps) => runtime().useEffect(effect, deps),
  useMemo: (factory, deps) => runtime().useMemo(factory, deps),
  useRef: (initialValue) => runtime().useRef(initialValue),
  useState: (initialValue) => runtime().useState(initialValue),
};

module.exports = React;
module.exports.default = React;
module.exports.__esModule = true;
`;

const JSX_RUNTIME_STUB = `
const Fragment = Symbol.for('react.fragment');
const jsx = (type, props, key) => ({ type, key, props: props || {} });
module.exports = { Fragment, jsx, jsxs: jsx };
module.exports.default = module.exports;
module.exports.__esModule = true;
`;

const I18N_STUB = `
export function useI18n() {
  return { t: (key) => key };
}
`;

async function importFormRuntime() {
  const result = await build({
    absWorkingDir: process.cwd(),
    stdin: {
      contents: FORM_RUNTIME_ENTRY,
      resolveDir: process.cwd(),
      sourcefile: 'form-runtime-snapshot-cleanup-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
    loader: {
      '.ts': 'ts',
      '.tsx': 'tsx',
    },
    plugins: [
      {
        name: 'form-runtime-snapshot-cleanup-stubs',
        setup(esbuild) {
          esbuild.onResolve({ filter: /^(react|react\/jsx-runtime|react\/jsx-dev-runtime|\.\.\/i18n)$/ }, (args) => ({
            path: args.path,
            namespace: 'form-runtime-snapshot-cleanup-stub',
          }));
          esbuild.onLoad({ filter: /.*/, namespace: 'form-runtime-snapshot-cleanup-stub' }, (args) => {
            if (args.path === 'react') return { contents: REACT_STUB, loader: 'js' };
            if (args.path === '../i18n') return { contents: I18N_STUB, loader: 'js' };
            return { contents: JSX_RUNTIME_STUB, loader: 'js' };
          });
        },
      },
    ],
  });

  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64');
  return import(dataUrl);
}

function depsChanged(previousDeps, nextDeps) {
  if (!previousDeps || !nextDeps) return true;
  if (previousDeps.length !== nextDeps.length) return true;
  return previousDeps.some((value, index) => !Object.is(value, nextDeps[index]));
}

function createFormRenderer(Form) {
  const hooks = [];
  const effects = [];
  let hookIndex = 0;
  let pendingEffects = [];
  let mounted = false;
  let needsRender = false;
  let rootProps = {};
  let latestFormContext = null;

  const runtime = {
    useState(initialValue) {
      const index = hookIndex;
      hookIndex += 1;

      if (!hooks[index]) {
        hooks[index] = {
          value: typeof initialValue === 'function' ? initialValue() : initialValue,
        };
      }

      const setState = (nextValueOrUpdater) => {
        const currentValue = hooks[index].value;
        const nextValue = typeof nextValueOrUpdater === 'function'
          ? nextValueOrUpdater(currentValue)
          : nextValueOrUpdater;

        if (Object.is(currentValue, nextValue)) return;
        hooks[index].value = nextValue;
        if (mounted) needsRender = true;
      };

      return [hooks[index].value, setState];
    },
    useRef(initialValue) {
      const index = hookIndex;
      hookIndex += 1;
      if (!hooks[index]) hooks[index] = { current: initialValue };
      return hooks[index];
    },
    useContext(context) {
      return context?._currentValue;
    },
    useCallback(callback, deps) {
      return this.useMemo(() => callback, deps);
    },
    useMemo(factory, deps) {
      const index = hookIndex;
      hookIndex += 1;
      const previous = hooks[index];
      if (previous && !depsChanged(previous.deps, deps)) return previous.value;

      const value = factory();
      hooks[index] = { value, deps };
      return value;
    },
    useEffect(effect, deps) {
      const index = hookIndex;
      hookIndex += 1;
      const previous = effects[index];
      if (previous && !depsChanged(previous.deps, deps)) return;
      pendingEffects.push({ index, effect, deps });
    },
  };

  function renderElement(element) {
    if (element == null || typeof element === 'boolean') return;
    if (Array.isArray(element)) {
      for (const child of element) renderElement(child);
      return;
    }
    if (typeof element !== 'object') return;

    const { type, props = {} } = element;
    if (type?.__context) {
      const previousValue = type.__context._currentValue;
      type.__context._currentValue = props.value;
      latestFormContext = props.value;
      renderElement(props.children);
      type.__context._currentValue = previousValue;
      return;
    }
    if (typeof type === 'function') {
      renderElement(type(props));
      return;
    }
    renderElement(props.children);
  }

  function flushEffects() {
    const queue = pendingEffects;
    pendingEffects = [];
    for (const pending of queue) {
      const previous = effects[pending.index];
      if (previous?.cleanup) previous.cleanup();
      const cleanup = pending.effect();
      effects[pending.index] = {
        deps: pending.deps,
        cleanup: typeof cleanup === 'function' ? cleanup : null,
      };
    }
  }

  function render(nextProps = rootProps) {
    rootProps = nextProps;
    hookIndex = 0;
    latestFormContext = null;
    needsRender = false;
    mounted = true;
    globalThis.__supercmdFormSnapshotRuntime = runtime;
    renderElement({ type: Form, props: rootProps });
    flushEffects();
    return latestFormContext;
  }

  function rerenderUntilSettled() {
    let renders = 0;
    while (needsRender) {
      render(rootProps);
      renders += 1;
      assert.ok(renders < 10, 'Form renderer did not settle');
    }
    return latestFormContext;
  }

  function unmount() {
    mounted = false;
    for (const effect of effects) {
      if (effect?.cleanup) effect.cleanup();
    }
    effects.length = 0;
    hooks.length = 0;
    delete globalThis.__supercmdFormSnapshotRuntime;
  }

  return {
    render,
    rerenderUntilSettled,
    unmount,
  };
}

function createRuntimeDeps() {
  return {
    ExtensionInfoReactContext: { _currentValue: {} },
    useNavigation: () => ({ pop() {} }),
    useCollectedActions: () => ({ collectedActions: [], registryAPI: {} }),
    ActionRegistryContext: { Provider: ({ children }) => children },
    ActionPanelOverlay: () => null,
    matchesShortcut: () => false,
    isMetaK: () => false,
    renderShortcut: () => null,
    getExtensionContext: () => ({ extensionName: 'Snapshot Test Extension' }),
  };
}

async function measureFormSnapshotCleanup() {
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
  };

  const {
    createFormRuntime,
    getFormErrors,
    getFormSnapshotMetrics,
    getFormValues,
  } = await importFormRuntime();

  const { Form } = createFormRuntime(createRuntimeDeps());
  const renderer = createFormRenderer(Form);
  let formContext = renderer.render({
    draftValues: {
      initial: 'draft value',
      nested: { payload: 'x'.repeat(512) },
    },
  });

  formContext.setValue('filled', { payload: 'y'.repeat(512) });
  formContext.setPlaceholder('empty', 'placeholder fallback');
  formContext.setValue('empty', '');
  formContext.setError('filled', 'Required');
  formContext = renderer.rerenderUntilSettled();

  const submittedValuesBeforeUnmount = getFormValues();
  const submittedErrorsBeforeUnmount = getFormErrors();
  const beforeUnmount = getFormSnapshotMetrics();

  assert.equal(submittedValuesBeforeUnmount.empty, 'placeholder fallback');
  assert.equal(submittedErrorsBeforeUnmount.filled, 'Required');
  assert.ok(formContext.values.filled, 'updated Form context should remain live before unmount');

  renderer.unmount();
  const afterUnmount = getFormSnapshotMetrics();

  return {
    beforeUnmount,
    afterUnmount,
  };
}

if (process.argv.includes('--report')) {
  console.log(JSON.stringify(await measureFormSnapshotCleanup(), null, 2));
} else {
  test('Form unmount clears submitted global value, error, and placeholder snapshots', async () => {
    const { beforeUnmount, afterUnmount } = await measureFormSnapshotCleanup();

    assert.ok(beforeUnmount.totalKeys > 0, 'mounted form should publish snapshot keys before cleanup');
    assert.ok(beforeUnmount.totalBytes > 6, 'mounted form should publish serialized snapshot bytes before cleanup');
    assert.equal(afterUnmount.valuesKeys, 0);
    assert.equal(afterUnmount.errorsKeys, 0);
    assert.equal(afterUnmount.placeholdersKeys, 0);
    assert.equal(afterUnmount.totalKeys, 0);
    assert.equal(afterUnmount.totalBytes, 6);
  });
}
