import type { ExtensionBundle } from '../../types/electron';

export type BackgroundNoViewLaunchType = 'userInitiated' | 'background';

export interface BackgroundNoViewRun {
  runId: string;
  bundle: ExtensionBundle;
  launchType: BackgroundNoViewLaunchType;
  /** When true, execution status is mirrored to the system status-bar badge. */
  reportStatus?: boolean;
}

export interface BackgroundNoViewQueueResult {
  runs: BackgroundNoViewRun[];
  enqueued: boolean;
}

export function getBackgroundNoViewRunIdentity(bundle: Partial<ExtensionBundle>): string | null {
  const extName = String(bundle.extName || bundle.extensionName || '').trim();
  const cmdName = String(bundle.cmdName || bundle.commandName || '').trim();
  if (!extName || !cmdName) return null;
  return `${extName}/${cmdName}`;
}

export function enqueueBackgroundNoViewRun(
  prev: BackgroundNoViewRun[],
  bundle: ExtensionBundle,
  launchType: BackgroundNoViewLaunchType = 'userInitiated',
  reportStatus = false,
  now: () => number = Date.now
): BackgroundNoViewQueueResult {
  const identity = getBackgroundNoViewRunIdentity(bundle);
  if (
    launchType === 'background' &&
    identity &&
    prev.some((run) => getBackgroundNoViewRunIdentity(run.bundle) === identity)
  ) {
    return { runs: prev, enqueued: false };
  }

  const runIdPrefix =
    identity ||
    `${String(bundle.extName || bundle.extensionName || '').trim()}/${String(
      bundle.cmdName || bundle.commandName || ''
    ).trim()}`;

  return {
    runs: [
      ...prev,
      {
        runId: `${runIdPrefix}/${now()}`,
        bundle,
        launchType,
        reportStatus,
      },
    ],
    enqueued: true,
  };
}

export function removeBackgroundNoViewRun(
  prev: BackgroundNoViewRun[],
  runId: string
): BackgroundNoViewRun[] {
  const next = prev.filter((run) => run.runId !== runId);
  return next.length === prev.length ? prev : next;
}
