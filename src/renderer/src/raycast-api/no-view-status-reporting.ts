export type NoViewStatusVariant = 'processing' | 'success' | 'error';

type NoViewStatusWindow = Window & {
  __scNoViewStatusTracking?: boolean;
  __scNoViewStatusReported?: boolean;
  __scNoViewStatusLastPayloadKey?: string;
  electron?: {
    reportNoViewStatus?: (variant: NoViewStatusVariant, text: string) => Promise<void> | void;
  };
};

export function reportNoViewStatusIfChanged(variant: NoViewStatusVariant, text: string): boolean {
  const target = globalThis.window as NoViewStatusWindow;
  if (!target.__scNoViewStatusTracking) return false;

  if (!target.__scNoViewStatusReported) {
    target.__scNoViewStatusLastPayloadKey = undefined;
  }

  const normalizedText = String(text || '');
  const payloadKey = `${variant}\u0000${normalizedText}`;
  if (target.__scNoViewStatusLastPayloadKey === payloadKey) {
    return false;
  }

  target.__scNoViewStatusLastPayloadKey = payloadKey;
  target.__scNoViewStatusReported = true;
  void target.electron?.reportNoViewStatus?.(variant, normalizedText);
  return true;
}
