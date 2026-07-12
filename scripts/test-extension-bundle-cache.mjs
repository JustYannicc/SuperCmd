#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  bundleExtensionRunner,
  createCounters,
  createFixture,
} from './measure-extension-bundle-cache.mjs';

const require = createRequire(import.meta.url);

function updatedFixtureManifest() {
  return {
    name: 'bundle-cache-fixture',
    title: 'Bundle Cache Fixture',
    description: 'Fixture for extension bundle cache measurement',
    owner: 'codex',
    commands: [
      {
        name: 'background',
        title: 'Background Updated',
        description: 'No-view command',
        mode: 'no-view',
        preferences: [
          {
            name: 'freshCommandPref',
            title: 'Fresh Command Pref',
            type: 'textfield',
            default: 'default-command',
          },
        ],
      },
      {
        name: 'menu',
        title: 'Menu',
        description: 'Menu-bar command',
        mode: 'menu-bar',
      },
    ],
    preferences: [
      {
        name: 'freshExtensionPref',
        title: 'Fresh Extension Pref',
        type: 'textfield',
        default: 'default-extension',
      },
    ],
  };
}

test('extension bundle cache hits and invalidates by file stats', async () => {
  const fixture = createFixture();
  const bundledRunner = await bundleExtensionRunner(fixture.userDataDir);
  const runner = require(bundledRunner);
  const { counters, restore } = createCounters(fixture.extDir);

  try {
    globalThis.__extensionPreferenceValues = {
      'bundle-cache-fixture': { freshExtensionPref: 'stored-extension-1' },
      'bundle-cache-fixture/background': { freshCommandPref: 'stored-command-1' },
    };

    const first = await runner.getExtensionBundle('bundle-cache-fixture', 'background');
    assert.equal(first.title, 'Background');
    assert.match(first.code, /background/);
    assert.equal(first.preferences.freshExtensionPref, 'stored-extension-1');
    assert.equal(first.preferences.freshCommandPref, 'stored-command-1');
    assert.equal(counters.packageJsonReads, 1);
    assert.equal(counters.bundleReads, 1);
    assert.equal(counters.jsonParseCalls, 1);
    assert.equal(counters.readdirSync, 1);

    const afterFirst = { ...counters };
    globalThis.__extensionPreferenceValues = {
      'bundle-cache-fixture': { freshExtensionPref: 'stored-extension-2' },
      'bundle-cache-fixture/background': { freshCommandPref: 'stored-command-2' },
    };

    const second = await runner.getExtensionBundle('bundle-cache-fixture', 'background');
    assert.equal(second.preferences.freshExtensionPref, 'stored-extension-2');
    assert.equal(second.preferences.freshCommandPref, 'stored-command-2');
    assert.equal(counters.packageJsonReads, afterFirst.packageJsonReads);
    assert.equal(counters.bundleReads, afterFirst.bundleReads);
    assert.equal(counters.jsonParseCalls, afterFirst.jsonParseCalls);
    assert.equal(counters.readdirSync, afterFirst.readdirSync);

    const bundlePath = path.join(fixture.extDir, '.sc-build', 'background.js');
    fs.writeFileSync(bundlePath, 'module.exports = { name: "background", version: 2 };\n');
    const beforeBundleInvalidation = { ...counters };
    const third = await runner.getExtensionBundle('bundle-cache-fixture', 'background');
    assert.match(third.code, /version: 2/);
    assert.equal(counters.bundleReads, beforeBundleInvalidation.bundleReads + 1);
    assert.equal(counters.packageJsonReads, beforeBundleInvalidation.packageJsonReads);

    const manifestPath = path.join(fixture.extDir, 'package.json');
    fs.writeFileSync(manifestPath, JSON.stringify(updatedFixtureManifest(), null, 2));
    const beforeManifestInvalidation = { ...counters };
    const fourth = await runner.getExtensionBundle('bundle-cache-fixture', 'background');
    assert.equal(fourth.title, 'Background Updated');
    assert.equal(counters.packageJsonReads, beforeManifestInvalidation.packageJsonReads + 1);
    assert.equal(counters.jsonParseCalls, beforeManifestInvalidation.jsonParseCalls + 1);
    assert.equal(counters.bundleReads, beforeManifestInvalidation.bundleReads);
  } finally {
    restore();
    try { fs.unlinkSync(bundledRunner); } catch {}
    try { fs.rmSync(fixture.tmpDir, { recursive: true, force: true }); } catch {}
  }
});
