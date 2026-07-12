/**
 * raycast-api/storage-events.ts
 * Purpose: Shared extension storage change event bridge.
 */

export type ExtensionStorageChangedDetail = {
  extensionName: string;
  commandName?: string;
  commandMode?: string;
};

type ExtensionCtx = {
  extensionName?: string;
  commandName?: string;
  commandMode?: string;
};

let getExtensionContextRef: () => ExtensionCtx = () => ({ extensionName: '' });

export function configureStorageEvents(deps: { getExtensionContext: () => ExtensionCtx }) {
  getExtensionContextRef = deps.getExtensionContext;
}

export function emitExtensionStorageChanged(origin?: Partial<ExtensionStorageChangedDetail>): void {
  try {
    const context = getExtensionContextRef();
    const extensionName = (origin?.extensionName || context.extensionName || '').trim();
    if (!extensionName) return;

    const commandName = (origin?.commandName || context.commandName || '').trim();
    const commandMode = (origin?.commandMode || context.commandMode || '').trim();
    const detail: ExtensionStorageChangedDetail = { extensionName };
    if (commandName) detail.commandName = commandName;
    if (commandMode) detail.commandMode = commandMode;

    window.dispatchEvent(
      new CustomEvent('sc-extension-storage-changed', {
        detail,
      })
    );
  } catch {
    // best-effort
  }
}
