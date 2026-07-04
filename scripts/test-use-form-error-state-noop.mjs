#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const USE_FORM_PATH = 'src/renderer/src/raycast-api/hooks/use-form.ts';
const FORM_RUNTIME_STATE_PATH = 'src/renderer/src/raycast-api/form-runtime-state.ts';
const FIELD_CHANGE_COUNTS = [10, 100, 1000];

function importStateHelpers() {
  const source = fs.readFileSync(FORM_RUNTIME_STATE_PATH, 'utf8');
  const executableSource = source
    .replace(/export type FormErrorMap = Record<string, string>;\n\n/, '')
    .replace(/export function /g, 'function ')
    .replace(/: FormErrorMap/g, '')
    .replace(/: string/g, '');

  const context = {};
  vm.runInNewContext(`${executableSource}\nthis.clearFormFieldError = clearFormFieldError;\nthis.setFormFieldError = setFormFieldError;`, context);
  return {
    clearFormFieldError: context.clearFormFieldError,
    setFormFieldError: context.setFormFieldError,
  };
}

function analyzeUseFormSource() {
  const source = fs.readFileSync(USE_FORM_PATH, 'utf8');
  return {
    importsStateHelpers: source.includes("from '../form-runtime-state'"),
    usesClearHelper: source.includes('clearFormFieldError(prev, key as string)'),
    usesSetValidationErrorHelper: source.includes('setFormFieldError(prev, key as string, error)'),
    usesBlurSetHelper: source.includes('setFormFieldError(prev, key as string, err)'),
    removedCloneDeleteClear: !source.includes('const next = { ...prev };\n      delete next[key];\n      return next;'),
  };
}

function previousClearFormFieldError(previous, id) {
  const next = { ...previous };
  delete next[id];
  return next;
}

function measureNoErrorFieldChanges(clearFormFieldError, fieldChanges) {
  let errors = {};
  let currentSnapshot = errors;
  let errorIdentityChanges = 0;

  for (let index = 0; index < fieldChanges; index += 1) {
    const next = clearFormFieldError(errors, `field-${index}`);
    if (next !== currentSnapshot) {
      errorIdentityChanges += 1;
    }
    currentSnapshot = next;
    errors = next;
  }

  return { fieldChanges, errorIdentityChanges };
}

function getMetrics() {
  const { clearFormFieldError, setFormFieldError } = importStateHelpers();
  return {
    noExistingErrors: FIELD_CHANGE_COUNTS.map((count) => {
      const before = measureNoErrorFieldChanges(previousClearFormFieldError, count);
      const after = measureNoErrorFieldChanges(clearFormFieldError, count);
      return {
        fieldChanges: count,
        beforeIdentityChanges: before.errorIdentityChanges,
        afterIdentityChanges: after.errorIdentityChanges,
      };
    }),
    clearExistingErrorPreservesOthers: (() => {
      const previous = { first: 'Required', second: 'Invalid' };
      const next = clearFormFieldError(previous, 'first');
      return {
        changedIdentity: next !== previous,
        clearedFieldMissing: !Object.prototype.hasOwnProperty.call(next, 'first'),
        preservedOtherField: next.second === 'Invalid',
      };
    })(),
    setSameError: (() => {
      const previous = { first: 'Required' };
      const next = setFormFieldError(previous, 'first', 'Required');
      return { changedIdentity: next !== previous };
    })(),
    setNewError: (() => {
      const previous = { first: 'Required' };
      const next = setFormFieldError(previous, 'first', 'Invalid');
      return { changedIdentity: next !== previous, value: next.first };
    })(),
  };
}

if (process.argv.includes('--report')) {
  console.log(JSON.stringify({ source: analyzeUseFormSource(), metrics: getMetrics() }, null, 2));
} else {
  test('useForm setValue skips error state updates when the field has no error', () => {
    const source = analyzeUseFormSource();
    assert.equal(source.importsStateHelpers, true, 'useForm should import the guarded error state helpers');
    assert.equal(source.usesClearHelper, true, 'useForm setValue should use the guarded error clear helper');
    assert.equal(source.removedCloneDeleteClear, true, 'useForm setValue should not clone errors for no-op clears');

    for (const metric of getMetrics().noExistingErrors) {
      assert.equal(metric.beforeIdentityChanges, metric.fieldChanges, `${metric.fieldChanges} previous no-error changes cloned errors every time`);
      assert.equal(metric.afterIdentityChanges, 0, `${metric.fieldChanges} no-error changes should keep the same errors object`);
    }
  });

  test('useForm setValue still clears an existing field error only', () => {
    const metric = getMetrics().clearExistingErrorPreservesOthers;
    assert.equal(metric.changedIdentity, true, 'clearing an existing error should publish a new errors object');
    assert.equal(metric.clearedFieldMissing, true, 'the changed field error should be removed');
    assert.equal(metric.preservedOtherField, true, 'unrelated field errors should be preserved');
  });

  test('useForm validation error writes skip same-value updates but publish changed errors', () => {
    const source = analyzeUseFormSource();
    assert.equal(source.usesSetValidationErrorHelper, true, 'useForm setValidationError should use the guarded error set helper');
    assert.equal(source.usesBlurSetHelper, true, 'useForm onBlur validation should use the guarded error set helper');

    const metrics = getMetrics();
    assert.equal(metrics.setSameError.changedIdentity, false, 'setting the same error should keep the previous errors object');
    assert.equal(metrics.setNewError.changedIdentity, true, 'setting a different error should publish a new errors object');
    assert.equal(metrics.setNewError.value, 'Invalid');
  });
}
