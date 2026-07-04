/**
 * Main-process MenuBarExtra native update cache.
 *
 * Tracks the last native tray sub-payload applied per extension so title-only
 * ticks do not rebuild unchanged Electron menu templates.
 */

export type MenuBarNativeUpdatePayload = {
  iconPath?: unknown;
  iconPathMtimeMs?: unknown;
  iconPathSize?: unknown;
  iconDataUrl?: unknown;
  iconEmoji?: unknown;
  iconTemplate?: unknown;
  iconBitmapScale?: unknown;
  fallbackIconDataUrl?: unknown;
  title?: unknown;
  tooltip?: unknown;
  items?: unknown;
};

export type MenuBarNativeUpdateFsLike = {
  statSync: (pathValue: string) => {
    size?: number;
    mtimeMs?: number;
    isFile?: () => boolean;
  };
};

export type MenuBarNativeUpdateState = {
  iconKey: string | null;
  lastResolvedTrayIconOk: boolean;
  title: string | null;
  tooltip: string | null;
  itemsKey: string | null;
};

export function createMenuBarNativeUpdateState(): MenuBarNativeUpdateState {
  return {
    iconKey: null,
    lastResolvedTrayIconOk: false,
    title: null,
    tooltip: null,
    itemsKey: null,
  };
}

export function getMenuBarNativeIconKey(payload: MenuBarNativeUpdatePayload): string {
  return safeJsonStringify([
    payload.iconPath ?? null,
    payload.iconPathMtimeMs ?? null,
    payload.iconPathSize ?? null,
    payload.iconDataUrl ?? null,
    payload.iconEmoji ?? null,
    typeof payload.iconTemplate === 'boolean' ? payload.iconTemplate : null,
    payload.iconBitmapScale ?? null,
    payload.fallbackIconDataUrl ?? null,
  ]);
}

export function hasFileBackedMenuBarNativeIcon(payload: MenuBarNativeUpdatePayload): boolean {
  return typeof payload.iconPath === 'string' && payload.iconPath.trim().length > 0;
}

export function withMenuBarNativeIconFileIdentity(
  fs: MenuBarNativeUpdateFsLike,
  payload: MenuBarNativeUpdatePayload,
): MenuBarNativeUpdatePayload {
  if (!hasFileBackedMenuBarNativeIcon(payload)) return payload;

  const iconPath = String(payload.iconPath || '').trim();
  try {
    const stat = fs.statSync(iconPath);
    if (typeof stat?.isFile === 'function' && !stat.isFile()) return payload;
    return {
      ...payload,
      iconPathMtimeMs: Number.isFinite(Number(stat?.mtimeMs)) ? Number(stat.mtimeMs) : 0,
      iconPathSize: Number.isFinite(Number(stat?.size)) ? Number(stat.size) : 0,
    };
  } catch {
    return {
      ...payload,
      iconPathMtimeMs: null,
      iconPathSize: null,
    };
  }
}

export function isMenuBarNativeIconRefreshNeeded(
  state: MenuBarNativeUpdateState,
  payload: MenuBarNativeUpdatePayload,
): boolean {
  const nextIconKey = getMenuBarNativeIconKey(payload);
  return state.iconKey !== nextIconKey;
}

export function rememberMenuBarNativeIcon(
  state: MenuBarNativeUpdateState,
  payload: MenuBarNativeUpdatePayload,
  lastResolvedTrayIconOk: boolean,
): void {
  state.iconKey = getMenuBarNativeIconKey(payload);
  state.lastResolvedTrayIconOk = lastResolvedTrayIconOk;
}

export function getMenuBarNativeTitle(
  payload: MenuBarNativeUpdatePayload,
  lastResolvedTrayIconOk: boolean,
): string {
  const title = normalizeMenuBarNativeString(payload.title);
  if (title) return title;
  const iconEmoji = normalizeMenuBarNativeString(payload.iconEmoji);
  if (iconEmoji) return iconEmoji;
  return lastResolvedTrayIconOk ? '' : '\u23f1';
}

export function isMenuBarNativeTitleUpdateNeeded(
  state: MenuBarNativeUpdateState,
  nextTitle: string,
): boolean {
  return state.title !== nextTitle;
}

export function rememberMenuBarNativeTitle(
  state: MenuBarNativeUpdateState,
  nextTitle: string,
): void {
  state.title = nextTitle;
}

export function getMenuBarNativeTooltip(payload: MenuBarNativeUpdatePayload): string {
  return normalizeMenuBarNativeString(payload.tooltip);
}

export function isMenuBarNativeTooltipUpdateNeeded(
  state: MenuBarNativeUpdateState,
  nextTooltip: string,
): boolean {
  return nextTooltip.length > 0 && state.tooltip !== nextTooltip;
}

export function rememberMenuBarNativeTooltip(
  state: MenuBarNativeUpdateState,
  nextTooltip: string,
): void {
  state.tooltip = nextTooltip;
}

export function getMenuBarNativeItemsKey(items: unknown): string {
  return safeJsonStringify(items ?? []);
}

export function isMenuBarNativeMenuUpdateNeeded(
  state: MenuBarNativeUpdateState,
  nextItemsKey: string,
): boolean {
  return state.itemsKey !== nextItemsKey;
}

export function rememberMenuBarNativeMenu(
  state: MenuBarNativeUpdateState,
  nextItemsKey: string,
): void {
  state.itemsKey = nextItemsKey;
}

function normalizeMenuBarNativeString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function safeJsonStringify(value: unknown): string {
  try {
    const result = JSON.stringify(value);
    return typeof result === 'string' ? result : '';
  } catch {
    return String(value);
  }
}
