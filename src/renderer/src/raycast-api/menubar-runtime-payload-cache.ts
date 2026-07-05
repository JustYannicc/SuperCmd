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
  itemsRef: any[] | null;
  itemsHash: string | null;
};

export function createMenuBarVisiblePayloadHashCache(): MenuBarVisiblePayloadHashCache {
  return { current: null, itemsRef: null, itemsHash: null };
}

export function hashMenuBarVisiblePayload(payload: SerializedMenuBarVisiblePayload): string {
  return JSON.stringify(payload);
}

function hashMenuBarVisiblePayloadWithItemCache(
  cache: MenuBarVisiblePayloadHashCache,
  payload: SerializedMenuBarVisiblePayload,
): string {
  let itemsHash = cache.itemsHash;
  if (cache.itemsRef !== payload.items || itemsHash == null) {
    itemsHash = JSON.stringify(payload.items);
    cache.itemsRef = payload.items;
    cache.itemsHash = itemsHash;
  }

  return JSON.stringify({
    extId: payload.extId,
    iconPath: payload.iconPath,
    iconDataUrl: payload.iconDataUrl,
    iconEmoji: payload.iconEmoji,
    iconTemplate: payload.iconTemplate,
    iconBitmapScale: payload.iconBitmapScale,
    fallbackIconDataUrl: payload.fallbackIconDataUrl,
    title: payload.title,
    tooltip: payload.tooltip,
    itemsHash,
  });
}

export function shouldSendMenuBarVisiblePayload(
  cache: MenuBarVisiblePayloadHashCache,
  payload: SerializedMenuBarVisiblePayload,
): boolean {
  const nextHash = hashMenuBarVisiblePayloadWithItemCache(cache, payload);
  if (cache.current === nextHash) return false;
  cache.current = nextHash;
  return true;
}
