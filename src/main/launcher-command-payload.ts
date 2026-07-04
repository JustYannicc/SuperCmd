export type LauncherCommandPayloadVisibility = {
  isAIDisabled(settings: any): boolean;
  isAIDependentSystemCommand(commandId: string): boolean;
  isAISectionDisabledForCommand(commandId: string, settings: any): boolean;
};

export type LauncherCommandPayloadOptions = LauncherCommandPayloadVisibility & {
  updateBannerCommand?: any;
  updateBannerSignature?: string;
};

function getLauncherCommandPayloadCacheKey(settings: any, updateBannerSignature = ''): string {
  return JSON.stringify({
    disabledCommands: settings?.disabledCommands || [],
    enabledCommands: settings?.enabledCommands || [],
    aiEnabled: settings?.ai?.enabled,
    aiReadEnabled: settings?.ai?.readEnabled,
    aiWhisperEnabled: settings?.ai?.whisperEnabled,
    aiLlmEnabled: settings?.ai?.llmEnabled,
    updateBanner: updateBannerSignature,
  });
}

export function estimateLauncherCommandPayloadBytes(payload: any[]): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

export function createLauncherCommandPayloadCache() {
  let cache: {
    sourceCommands: any[];
    cacheKey: string;
    payload: any[];
  } | null = null;

  return {
    clear(): void {
      cache = null;
    },

    build(commands: any[], settings: any, options: LauncherCommandPayloadOptions): any[] {
      const cacheKey = getLauncherCommandPayloadCacheKey(settings, options.updateBannerSignature || '');
      if (cache && cache.sourceCommands === commands && cache.cacheKey === cacheKey) {
        return cache.payload;
      }

      const disabled = new Set(settings?.disabledCommands || []);
      const enabled = new Set(settings?.enabledCommands || []);
      const aiDisabled = options.isAIDisabled(settings);
      const filtered = commands.filter((command: any) => {
        const commandId = String(command?.id || '');
        if (aiDisabled && options.isAIDependentSystemCommand(commandId)) return false;
        if (options.isAISectionDisabledForCommand(commandId, settings)) return false;
        if (disabled.has(command.id)) return false;
        if (command?.disabledByDefault && !enabled.has(command.id)) return false;
        return true;
      });

      if (options.updateBannerCommand) {
        filtered.unshift(options.updateBannerCommand);
      }

      cache = { sourceCommands: commands, cacheKey, payload: filtered };
      return filtered;
    },
  };
}
