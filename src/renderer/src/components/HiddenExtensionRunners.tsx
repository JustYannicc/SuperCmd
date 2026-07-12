import React, { memo, useCallback, useEffect, useMemo } from 'react';
import ExtensionView from '../ExtensionView';
import type { BackgroundNoViewRun, MenuBarEntry } from '../hooks/useMenuBarExtensions';
import { NOOP_ON_CLOSE } from '../utils/launcher-misc';
import { removeBackgroundNoViewRun } from '../utils/background-no-view-runs';

type HiddenExtensionRunnersProps = {
  menuBarExtensions: MenuBarEntry[];
  backgroundNoViewRuns: BackgroundNoViewRun[];
  setBackgroundNoViewRuns: React.Dispatch<React.SetStateAction<BackgroundNoViewRun[]>>;
};

type BackgroundNoViewRunnerProps = {
  run: BackgroundNoViewRun;
  onRunFinished: (runId: string) => void;
};

const BackgroundNoViewRunner: React.FC<BackgroundNoViewRunnerProps> = ({ run, onRunFinished }) => {
  const closeRun = useCallback(() => {
    onRunFinished(run.runId);
  }, [onRunFinished, run.runId]);

  return (
    <ExtensionView
      code={run.bundle.code}
      title={run.bundle.title}
      mode="no-view"
      extensionName={(run.bundle as any).extensionName || run.bundle.extName}
      extensionDisplayName={(run.bundle as any).extensionDisplayName}
      extensionIconDataUrl={(run.bundle as any).extensionIconDataUrl}
      commandName={(run.bundle as any).commandName || run.bundle.cmdName}
      assetsPath={(run.bundle as any).assetsPath}
      supportPath={(run.bundle as any).supportPath}
      owner={(run.bundle as any).owner}
      preferences={(run.bundle as any).preferences}
      preferenceDefinitions={(run.bundle as any).preferenceDefinitions}
      launchArguments={(run.bundle as any).launchArguments}
      launchContext={(run.bundle as any).launchContext}
      fallbackText={(run.bundle as any).fallbackText}
      launchType={run.launchType}
      reportStatus={run.reportStatus}
      onClose={closeRun}
    />
  );
};

const HiddenExtensionRunners: React.FC<HiddenExtensionRunnersProps> = ({
  menuBarExtensions,
  backgroundNoViewRuns,
  setBackgroundNoViewRuns,
}) => {
  const onBackgroundNoViewRunFinished = useCallback((runId: string) => {
    setBackgroundNoViewRuns((prev) => removeBackgroundNoViewRun(prev, runId));
  }, [setBackgroundNoViewRuns]);

  useEffect(() => {
    return () => {
      setBackgroundNoViewRuns((prev) => (prev.length === 0 ? prev : []));
    };
  }, [setBackgroundNoViewRuns]);

  const menuBarRunner = useMemo(() => {
    if (menuBarExtensions.length === 0) return null;
    return (
      <div style={{ display: 'none', position: 'absolute', width: 0, height: 0, overflow: 'hidden', pointerEvents: 'none' }}>
        {menuBarExtensions.map((entry) => (
          <ExtensionView
            key={`menubar-${entry.key}`}
            code={entry.bundle.code}
            title={entry.bundle.title}
            mode="menu-bar"
            extensionName={(entry.bundle as any).extensionName || entry.bundle.extName}
            extensionDisplayName={(entry.bundle as any).extensionDisplayName}
            extensionIconDataUrl={(entry.bundle as any).extensionIconDataUrl}
            commandName={(entry.bundle as any).commandName || entry.bundle.cmdName}
            assetsPath={(entry.bundle as any).assetsPath}
            supportPath={(entry.bundle as any).supportPath}
            owner={(entry.bundle as any).owner}
            preferences={(entry.bundle as any).preferences}
            preferenceDefinitions={(entry.bundle as any).preferenceDefinitions}
            launchArguments={(entry.bundle as any).launchArguments}
            launchContext={(entry.bundle as any).launchContext}
            fallbackText={(entry.bundle as any).fallbackText}
            launchType={(entry.bundle as any).launchType}
            onClose={NOOP_ON_CLOSE}
          />
        ))}
      </div>
    );
  }, [menuBarExtensions]);

  const backgroundNoViewRunner = useMemo(() => {
    if (backgroundNoViewRuns.length === 0) return null;
    return (
      <div style={{ display: 'none', position: 'absolute', width: 0, height: 0, overflow: 'hidden', pointerEvents: 'none' }}>
        {backgroundNoViewRuns.map((run) => (
          <BackgroundNoViewRunner
            key={`bg-no-view-${run.runId}`}
            run={run}
            onRunFinished={onBackgroundNoViewRunFinished}
          />
        ))}
      </div>
    );
  }, [backgroundNoViewRuns, onBackgroundNoViewRunFinished]);

  return (
    <>
      {menuBarRunner}
      {backgroundNoViewRunner}
    </>
  );
};

export default memo(HiddenExtensionRunners);
