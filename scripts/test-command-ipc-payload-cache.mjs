#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTs } from './lib/ts-import.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  createLauncherCommandPayloadCache,
  estimateLauncherCommandPayloadBytes,
} = await importTs(path.join(root, 'src/main/launcher-command-payload.ts'), { root });

const visibility = {
  isAIDisabled(settings) {
    return settings?.ai?.enabled === false;
  },
  isAIDependentSystemCommand(commandId) {
    return commandId === 'system-cursor-prompt';
  },
  isAISectionDisabledForCommand(commandId, settings) {
    if (commandId === 'system-supercmd-speak') return settings?.ai?.readEnabled === false;
    return false;
  },
};

test('launcher command payload cache reuses filtered IPC payloads until visibility inputs change', () => {
  const cache = createLauncherCommandPayloadCache();
  const commands = [
    { id: 'app-visible', title: 'Visible', category: 'app' },
    { id: 'app-disabled', title: 'Disabled', category: 'app' },
    { id: 'app-default-disabled', title: 'Default Disabled', category: 'app', disabledByDefault: true },
    { id: 'system-cursor-prompt', title: 'AI Prompt', category: 'system' },
  ];
  const settings = {
    disabledCommands: ['app-disabled'],
    enabledCommands: [],
    ai: { enabled: true, readEnabled: true },
  };

  const first = cache.build(commands, settings, visibility);
  const second = cache.build(commands, settings, visibility);
  assert.equal(second, first);
  assert.deepEqual(first.map((command) => command.id), ['app-visible', 'system-cursor-prompt']);
  assert.ok(estimateLauncherCommandPayloadBytes(first) > 0);

  const aiDisabled = cache.build(commands, {
    ...settings,
    ai: { enabled: false, readEnabled: true },
  }, visibility);
  assert.notEqual(aiDisabled, first);
  assert.deepEqual(aiDisabled.map((command) => command.id), ['app-visible']);

  cache.clear();
  const afterClear = cache.build(commands, settings, visibility);
  assert.notEqual(afterClear, first);
  assert.deepEqual(afterClear.map((command) => command.id), ['app-visible', 'system-cursor-prompt']);
});
