#!/usr/bin/env node

import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { importTs } from './lib/ts-import.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const commandCount = Number(process.env.SUPERCMD_BENCH_COMMAND_COUNT || 5_000);
const iconBytes = Number(process.env.SUPERCMD_BENCH_COMMAND_ICON_BYTES || 2_048);
const iterations = Number(process.env.SUPERCMD_BENCH_COMMAND_ITERATIONS || 120);

const {
  createLauncherCommandPayloadCache,
  estimateLauncherCommandPayloadBytes,
} = await importTs(path.join(root, 'src/main/launcher-command-payload.ts'), { root });

function makeCommands() {
  const iconDataUrl = `data:image/png;base64,${Buffer.alloc(iconBytes, 7).toString('base64')}`;
  const commands = [];
  for (let index = 0; index < commandCount; index += 1) {
    commands.push({
      id: `command-${index}`,
      title: `Synthetic Command ${index}`,
      subtitle: `Synthetic subtitle ${index}`,
      keywords: ['synthetic', 'command', String(index)],
      category: index % 5 === 0 ? 'extension' : 'app',
      path: `/Applications/Synthetic ${index}.app`,
      iconDataUrl,
      disabledByDefault: index % 17 === 0,
    });
  }
  return commands;
}

function makeSettings() {
  return {
    disabledCommands: Array.from({ length: Math.floor(commandCount / 50) }, (_, index) => `command-${index * 13}`),
    enabledCommands: Array.from({ length: Math.floor(commandCount / 60) }, (_, index) => `command-${index * 17}`),
    ai: {
      enabled: true,
      readEnabled: true,
      whisperEnabled: true,
      llmEnabled: true,
    },
  };
}

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

function buildLegacyPayload(commands, settings) {
  const disabled = new Set(settings.disabledCommands || []);
  const enabled = new Set(settings.enabledCommands || []);
  const aiDisabled = visibility.isAIDisabled(settings);
  return commands.filter((command) => {
    const commandId = String(command?.id || '');
    if (aiDisabled && visibility.isAIDependentSystemCommand(commandId)) return false;
    if (visibility.isAISectionDisabledForCommand(commandId, settings)) return false;
    if (disabled.has(command.id)) return false;
    if (command?.disabledByDefault && !enabled.has(command.id)) return false;
    return true;
  });
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    minMs: Number(sorted[0].toFixed(3)),
    meanMs: Number((sum / Math.max(1, values.length)).toFixed(3)),
    medianMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(3)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
  };
}

function measure(fn) {
  const durations = [];
  let payload = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    payload = fn();
    durations.push(performance.now() - startedAt);
  }
  return {
    payload,
    timings: stats(durations),
  };
}

const commands = makeCommands();
const settings = makeSettings();
const cache = createLauncherCommandPayloadCache();

const legacy = measure(() => buildLegacyPayload(commands, settings));
const cached = measure(() => cache.build(commands, settings, {
  ...visibility,
  updateBannerSignature: 'none',
}));
const changedSettingsStart = performance.now();
const changedSettingsPayload = cache.build(commands, {
  ...settings,
  disabledCommands: [...settings.disabledCommands, 'command-42'],
}, {
  ...visibility,
  updateBannerSignature: 'none',
});
const changedSettingsMs = performance.now() - changedSettingsStart;

const report = {
  commandCount,
  iconBytes,
  iterations,
  payloadBytes: estimateLauncherCommandPayloadBytes(cached.payload),
  payloadCommands: cached.payload.length,
  legacyFilterMs: legacy.timings,
  cachedPayloadMs: cached.timings,
  changedSettingsRebuildMs: Number(changedSettingsMs.toFixed(3)),
  changedSettingsPayloadCommands: changedSettingsPayload.length,
};

console.log(`COMMAND_IPC_PAYLOAD ${JSON.stringify(report)}`);
