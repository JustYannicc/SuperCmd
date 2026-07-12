/**
 * raycast-api/menubar-runtime-payload-cache.ts
 * Purpose: Detect unchanged MenuBarExtra payloads before crossing IPC.
 */

export type SerializedMenuBarVisiblePayload = {
  extId: string;
  iconPath?: string;
  iconDataUrl?: string;
  iconEmoji?: string;
  iconTemplate?: boolean;
  iconBitmapScale?: number;
  fallbackIconDataUrl: string;
  title: string;
  tooltip: string;
  items: any[];
};

export type MenuBarVisiblePayloadHashCache = {
  current: string | null;
};

export function createMenuBarVisiblePayloadHashCache(): MenuBarVisiblePayloadHashCache {
  return { current: null };
}

export function hashMenuBarVisiblePayload(payload: SerializedMenuBarVisiblePayload): string {
  return JSON.stringify(payload);
}

export function shouldSendMenuBarVisiblePayload(
  cache: MenuBarVisiblePayloadHashCache,
  payload: SerializedMenuBarVisiblePayload,
): boolean {
  const nextHash = hashMenuBarVisiblePayload(payload);
  if (cache.current === nextHash) return false;
  cache.current = nextHash;
  return true;
}
