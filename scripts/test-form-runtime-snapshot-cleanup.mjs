#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const FORM_RUNTIME_PATH = 'src/renderer/src/raycast-api/form-runtime.tsx';
const FORM_RUNTIME_CONTEXT_PATH = 'src/renderer/src/raycast-api/form-runtime-context.tsx';

function importSnapshotContext() {
  const source = fs.readFileSync(FORM_RUNTIME_CONTEXT_PATH, 'utf8');
  const executableSource = source
    .replace("import { createContext } from 'react';\n\n", 'const createContext = (value) => ({ _currentValue: value, Provider: ({ children }) => children });\n\n')
    .replace(/export interface FormContextType \{[\s\S]*?\n\}\n\n/, '')
    .replace(/createContext<FormContextType>/g, 'createContext')
    .replace(/export const /g, 'const ')
    .replace(/export function /g, 'function ')
    .replace(/: Record<string, any>/g, '')
    .replace(/: Record<string, string>/g, '')
    .replace(/: string/g, '')
    .replace(/: \{\n  values;\n  errors;\n  placeholders;\n\}/g, '');

  const context = {};
  vm.runInNewContext(
    `${executableSource}
this.api = {
  setCurrentFormValues,
  setCurrentFormErrors,
  setCurrentFormPlaceholders,
  clearCurrentFormSnapshots,
  getFormValues,
  getFormErrors,
  __getCurrentFormSnapshotForTests,
};`,
    context,
  );
  return context.api;
}

function analyzeFormRuntimeSource() {
  const source = fs.readFileSync(FORM_RUNTIME_PATH, 'utf8');
  return {
    importsClearHelper: source.includes('clearCurrentFormSnapshots,'),
    tracksLatestSnapshots: source.includes('const publishedSnapshotsRef = useRef({ values, errors, placeholders });'),
    updatesRefOnValuePublish: source.includes('publishedSnapshotsRef.current = { ...publishedSnapshotsRef.current, values: next };'),
    updatesRefOnErrorPublish: source.includes('publishedSnapshotsRef.current = { ...publishedSnapshotsRef.current, errors: next };'),
    updatesRefOnPlaceholderPublish: source.includes('publishedSnapshotsRef.current = { ...publishedSnapshotsRef.current, placeholders: next };'),
    clearsOnUnmount: source.includes('clearCurrentFormSnapshots(publishedSnapshotsRef.current);'),
  };
}

function mountFormRuntimeSnapshotHarness(api, draftValues = {}) {
  let values = draftValues;
  let errors = {};
  let placeholders = {};
  let publishedSnapshots = { values, errors, placeholders };

  const publish = () => {
    publishedSnapshots = { values, errors, placeholders };
    api.setCurrentFormValues(values);
    api.setCurrentFormErrors(errors);
    api.setCurrentFormPlaceholders(placeholders);
  };

  publish();

  return {
    setValue(id, value) {
      values = { ...values, [id]: value };
      publishedSnapshots = { ...publishedSnapshots, values };
      api.setCurrentFormValues(values);
      if (Object.prototype.hasOwnProperty.call(errors, id)) {
        const nextErrors = { ...errors };
        delete nextErrors[id];
        errors = nextErrors;
        publishedSnapshots = { ...publishedSnapshots, errors };
        api.setCurrentFormErrors(errors);
      }
    },
    setError(id, error) {
      if (errors[id] === error) return;
      errors = { ...errors, [id]: error };
      publishedSnapshots = { ...publishedSnapshots, errors };
      api.setCurrentFormErrors(errors);
    },
    setPlaceholder(id, placeholder) {
      if (placeholders[id] === placeholder) return;
      placeholders = { ...placeholders, [id]: placeholder };
      publishedSnapshots = { ...publishedSnapshots, placeholders };
      api.setCurrentFormPlaceholders(placeholders);
    },
    update() {
      publish();
    },
    unmount() {
      api.clearCurrentFormSnapshots(publishedSnapshots);
    },
  };
}

function measureSnapshot(snapshot) {
  const valueKeys = Object.keys(snapshot.values).length;
  const errorKeys = Object.keys(snapshot.errors).length;
  const placeholderKeys = Object.keys(snapshot.placeholders).length;
  const totalKeys = valueKeys + errorKeys + placeholderKeys;
  const retained = {};
  if (valueKeys > 0) retained.values = snapshot.values;
  if (errorKeys > 0) retained.errors = snapshot.errors;
  if (placeholderKeys > 0) retained.placeholders = snapshot.placeholders;

  return {
    valueKeys,
    errorKeys,
    placeholderKeys,
    totalKeys,
    retainedSerializedBytes: totalKeys === 0 ? 0 : Buffer.byteLength(JSON.stringify(retained), 'utf8'),
  };
}

function getMetrics() {
  const api = importSnapshotContext();
  const form = mountFormRuntimeSnapshotHarness(api);

  form.setValue('payload', { label: 'retained', data: 'x'.repeat(2048) });
  form.setValue('blank', '');
  form.setError('payload', 'Invalid');
  form.setPlaceholder('blank', 'fallback');
  form.setPlaceholder('placeholderOnly', 'placeholder fallback');
  form.update();

  const submittedValues = api.getFormValues();
  const beforeUnmount = measureSnapshot(api.__getCurrentFormSnapshotForTests());
  form.unmount();
  const afterUnmount = measureSnapshot(api.__getCurrentFormSnapshotForTests());

  return {
    source: analyzeFormRuntimeSource(),
    submittedValues,
    beforeUnmount,
    afterUnmount,
  };
}

if (process.argv.includes('--report')) {
  console.log(JSON.stringify(getMetrics(), null, 2));
} else {
  test('Form runtime clears global snapshots on unmount', () => {
    const metrics = getMetrics();

    assert.deepEqual(metrics.source, {
      importsClearHelper: true,
      tracksLatestSnapshots: true,
      updatesRefOnValuePublish: true,
      updatesRefOnErrorPublish: true,
      updatesRefOnPlaceholderPublish: true,
      clearsOnUnmount: true,
    });
    assert.equal(metrics.submittedValues.blank, 'fallback');
    assert.equal(metrics.submittedValues.placeholderOnly, 'placeholder fallback');
    assert.equal(metrics.beforeUnmount.totalKeys, 5);
    assert.ok(metrics.beforeUnmount.retainedSerializedBytes > 2048);

    assert.deepEqual(metrics.afterUnmount, {
      valueKeys: 0,
      errorKeys: 0,
      placeholderKeys: 0,
      totalKeys: 0,
      retainedSerializedBytes: 0,
    });
  });
}
