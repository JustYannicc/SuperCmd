#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.join(root, 'src/renderer/src/App.tsx'), 'utf8');
const hiddenRunnersSource = fs.readFileSync(
  path.join(root, 'src/renderer/src/components/HiddenExtensionRunners.tsx'),
  'utf8'
);
const detachedRunnersSource = fs.readFileSync(
  path.join(root, 'src/renderer/src/components/DetachedOverlayRunners.tsx'),
  'utf8'
);

test('secondary launcher views stay lazy-loaded from App startup chunk', () => {
  const lazyOnlySpecifiers = [
    './ExtensionView',
    './ClipboardManager',
    './SnippetManager',
    './NotesSearchInline',
    './CanvasSearchInline',
    './QuickLinkManager',
    './CameraExtension',
    './ScheduleExtension',
    './OnboardingExtension',
    './FileSearchExtension',
    './MenuItemSearchExtension',
    './views/ScriptCommandSetupView',
    './views/ScriptCommandOutputView',
    './views/ExtensionPreferenceSetupView',
    './views/AiChatView',
    './views/CursorPromptView',
    './views/AppUninstallView',
    './views/BrowserResultsView',
    './views/WebSearchView',
  ];

  for (const specifier of lazyOnlySpecifiers) {
    assert.doesNotMatch(
      appSource,
      new RegExp(`^import\\s+.*?from ['"]${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"];`, 'm'),
      `${specifier} should not be statically imported by App.tsx`
    );
    assert.match(
      appSource,
      new RegExp(`lazy\\(\\(\\) => import\\(['"]${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\)\\)`),
      `${specifier} should have an explicit React.lazy import`
    );
  }

  assert.doesNotMatch(appSource, /from ['"]\.\/raycast-api['"];/, 'App.tsx should not eagerly import the Raycast shim');
  assert.match(appSource, /import\(['"]\.\/raycast-api\/oauth\/with-access-token['"]\)/);
});

test('extension and detached runners keep heavy runtime views behind lazy boundaries', () => {
  assert.doesNotMatch(hiddenRunnersSource, /import\s+ExtensionView\s+from ['"]\.\.\/ExtensionView['"];/);
  assert.match(hiddenRunnersSource, /lazy\(\(\) => import\(['"]\.\.\/ExtensionView['"]\)\)/);
  assert.match(hiddenRunnersSource, /<React\.Suspense fallback=\{null\}>/);

  for (const specifier of ['../SuperCmdWhisper', '../SuperCmdRead', '../WindowManagerPanel', '../views/CursorPromptView']) {
    assert.doesNotMatch(
      detachedRunnersSource,
      new RegExp(`^import\\s+.*?from ['"]${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"];`, 'm')
    );
    assert.match(
      detachedRunnersSource,
      new RegExp(`lazy\\(\\(\\) => import\\(['"]${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\)\\)`)
    );
  }
  assert.match(detachedRunnersSource, /<React\.Suspense fallback=\{null\}>/);
});
