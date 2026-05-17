# Browser Root Search Plan

## Context

SuperCMD already has fast root search for commands, applications, calculator output, URL/search dispatch, and indexed file results. Browser support currently behaves more like a command/action helper than a browser omnibox:

- The root list can show a synthetic "open URL" or "search web" command.
- The input has browser-history autocomplete based on SuperCMD's own browser-search history.
- Browser history import exists for Chrome, Arc, Brave, Edge, Vivaldi, Safari, and Firefox, but not Helium.
- Helium has a Raycast extension, but it is view/command based and is not suitable for instant root results.

The goal for the first implementation slice is browser root search only. Clipboard, snippets, notes, quicklinks, and extension-provided root search should fit the architecture later, but should not block the browser work.

## Product Goal

Typing in SuperCMD root should feel like typing in the browser address/search box, but with SuperCMD's launcher context mixed in.

The browser root search should support:

- URL entry.
- Web search.
- Bangs, using Helium-compatible behavior.
- Open tabs.
- Bookmarks.
- Browsing history.
- Browser/profile attribution in the result row.
- Nicknames for bookmarks or URLs.
- Per-source priority settings.
- Excluding unwanted results from future root suggestions.
- Learning from selected results through frecency.

Performance requirement: root results must be available from memory on every keystroke. No live SQLite query, AppleScript call, network request, or extension render should sit on the keystroke path.

Product assumption: for users who want SuperCMD to be their primary browser
entry point, browser data cannot be treated as a one-time import. The system
must import all eligible local history/bookmark rows and then keep hot in-memory
browser data refreshed continuously in the background.

## Non-Goals For First Slice

- Do not implement root search for clipboard, snippets, notes, or quicklinks yet.
- Do not require existing Raycast extensions to support root result providers.
- Do not run hidden extension views to harvest results.
- Do not attempt full cross-browser tab management beyond opening/switching where the browser supports it reliably.
- Do not redesign root search visuals beyond what is required to display browser/profile/source metadata and actions.

## Current Code Anchors

- Root result assembly and ordering: `src/renderer/src/App.tsx`
- Browser autocomplete hook: `src/renderer/src/hooks/useBrowserSearch.ts`
- Browser history import/cache: `src/main/browser-search-history.ts`
- Browser search settings UI: `src/renderer/src/settings/AdvancedTab.tsx`
- Shared settings schema: `src/main/settings-store.ts`, `src/renderer/types/electron.d.ts`
- File search index pattern to imitate: `src/main/file-search-index.ts`

## Architecture

Introduce an internal root provider pipeline, but only wire browser providers at first.

```ts
type RootSearchProviderId =
  | 'calculator'
  | 'commands'
  | 'files'
  | 'browser-url'
  | 'browser-web-search'
  | 'browser-bangs'
  | 'browser-tabs'
  | 'browser-bookmarks'
  | 'browser-history';

type RootSearchResult = {
  id: string;
  providerId: RootSearchProviderId;
  sourceId?: string;
  browserId?: string;
  profileId?: string;
  title: string;
  subtitle?: string;
  url?: string;
  keywords?: string[];
  iconDataUrl?: string;
  matchScore: number;
  frecencyScore?: number;
  priorityScore?: number;
  lastUsedAt?: number;
  useCount?: number;
  exclusionKey: string;
  action:
    | { type: 'open-url'; url: string; browserId?: string; profileId?: string }
    | { type: 'search-web'; query: string; browserId?: string; profileId?: string }
    | { type: 'switch-tab'; browserId: string; profileId?: string; tabId: string; url: string }
    | { type: 'open-bang'; bang: string; query: string; url: string };
};
```

The renderer should request browser root results through a synchronous-feeling cached IPC call or preload snapshot. The provider search itself should run in the renderer against data already loaded into memory, or in main against hot in-memory indexes. Avoid async chains that delay UI updates after each keypress.

## Browser Data Model

Add profile-aware browser discovery.

```ts
type BrowserProfileSource = {
  id: string;                 // "helium:Default", "chrome:Profile 1"
  browserId: string;          // "helium", "chrome", "vivaldi"
  browserName: string;        // "Helium"
  appBundleId?: string;       // "net.imput.helium"
  profileId: string;          // "Default", "Profile 1"
  profileName: string;        // "Personal", "Work", or fallback profileId
  historyPath?: string;
  bookmarksPath?: string;
  localStatePath?: string;
  available: boolean;
  enabled: boolean;
};

type BrowserTabEntry = {
  id: string;                 // "helium:Default:<windowId>:<tabId>"
  browserId: string;
  browserName: string;
  profileId: string;
  profileSourceId: string;    // "helium:Default"
  profileName: string;
  windowId: string;
  tabId: string;
  title: string;
  url: string;
  host: string;
  active: boolean;
  updatedAt: number;
};
```

For Chromium-family browsers, discover profiles from `Local State` via `profile.info_cache`, then verify profile directories and their `History`/`Bookmarks` files.

Required browser roots:

- Helium: `~/Library/Application Support/net.imput.helium`
- Chrome: `~/Library/Application Support/Google/Chrome`
- Vivaldi: `~/Library/Application Support/Vivaldi`
- Brave: `~/Library/Application Support/BraveSoftware/Brave-Browser`
- Edge: `~/Library/Application Support/Microsoft Edge`
- Arc: keep existing support, but verify its profile layout separately

Safari and Firefox can remain import-only initially unless their profile behavior is clean enough to fit the same model.

Opening behavior should follow the same browser/profile model:

- If a history/bookmark/tab result came from a specific profile, prefer opening
  it in that same browser/profile.
- Keep fallback to the system default browser when profile-specific open
  semantics are unavailable or fail.
- Current foundation: imported Chromium profile history can be opened back into
  the source browser/profile for Helium, Chrome, Brave, Edge, and Vivaldi using
  `--profile-directory`; Arc remains fallback/default-browser behavior until its
  profile/space open semantics are verified.

## Browser Extension And Tab Sync

Open tabs should be extension-first and event-driven. History and bookmarks can
be read from local files, but open tabs change too quickly for a durable import
model. The browser extension should own live tab observation:

- On extension connect, send a full tab snapshot for its browser/profile.
- Listen to tab create/update/remove/activate/move events and push deltas to
  SuperCMD immediately.
- When the launcher opens, request a fresh full snapshot to repair missed
  events.
- Keep tabs in a volatile in-memory store keyed by browser/profile/window/tab,
  not in the durable history/bookmark database.
- Search reads the last completed in-memory snapshot. No extension call,
  AppleScript call, or browser IPC is allowed on the keystroke path.
- If a tab navigates in-place, the extension must push the new URL/title through
  the tab update event, replacing the existing tab row by stable tab id.
- Extension tab snapshots should also feed a small recent-navigation overlay so
  SuperCMD can see just-visited pages immediately, before the browser's durable
  history database flushes them.
- Opening a tab result should first ask the extension to focus the existing tab.
  If the tab is gone, fall back to opening the URL in the source browser/profile.
- Browser-like default behavior should be preserved: plain Enter opens the URL
  again, while a modifier action can focus the existing open tab when the match
  came from live tab state.

Browser-extension install/onboarding flow remains unresolved:

- When a user adds a browser profile in SuperCMD, mark that profile as needing
  the SuperCMD browser extension.
- If the extension is already installed and connected for that profile, request
  a full tab snapshot immediately.
- If it is not installed/connected, show install/setup status in Settings and
  keep history/bookmarks working.
- Do not silently claim live tabs are available until the extension has connected
  and sent a snapshot.
- We still need to design the user-facing installation flow. SuperCMD should not
  force-install the extension, restart a browser, or silently launch a browser
  with extension flags as profile enrollment behavior.

Chrome distribution constraints:

- Normal users install Chrome extensions from the Chrome Web Store. Chrome's
  official distribution docs say Windows and macOS external installs must point
  to a Chrome Web Store update URL, and local CRX external installs are blocked
  on those platforms.
- A macOS app can place an external extension preferences JSON file under the
  user's Chrome `External Extensions` directory, but that path still requires a
  published Chrome Web Store extension ID/update URL and Chrome shows an enable
  confirmation.
- Self-hosted CRX distribution is only generally available on Linux or managed
  enterprise policy deployments.
- Therefore, production Chromium tab sync likely requires publishing the
  SuperCMD browser extension to the Chrome Web Store. The PR that adds the
  extension should mention this release/distribution requirement explicitly.
- For local testing, developer mode is enabled, so the first implementation can
  use an unpacked Chromium extension pointed at a loopback SuperCMD development
  bridge. This is a development/testing path only; the production plan remains
  Chrome Web Store distribution plus the correct native-messaging enrollment
  flow.

Current implementation slice:

- Added a volatile main-process tab store keyed by
  `profileSourceId/windowId/tabId`.
- Added a loopback-only development ingest endpoint for unpacked Chromium
  extensions to push debounced full tab snapshots into SuperCMD.
- Added an unpacked MV3 extension scaffold that listens to tab lifecycle/update
  events, sends debounced snapshots, and sends periodic repair snapshots.
- Local testing currently uses manual developer-mode installation of the
  unpacked extension scaffold. SuperCMD does not generate, force-install,
  restart, or force-load the extension for a profile.
- Chromium only honors `--load-extension` at process startup, and we should not
  use a browser restart as enrollment behavior. The proper user install flow
  remains a separate Chrome Web Store/native-messaging onboarding problem.
- Settings shows tab counts on added profiles so profile-level ingestion can be
  verified without adding a separate stats table.
- SuperCMD derives a volatile pending history overlay from extension tab
  snapshots by comparing stable tab ids and URL/title changes. That overlay is
  exposed through the same browser-history list as durable imported history, so
  the renderer sees one combined history surface instead of a separate recent
  navigation type.
- Pending recent navigations are flushed as soon as a browser history refresh
  imports the same `source/profile/url` into durable history. The cap/TTL are
  only fallback guards for cases where browser history never catches up.
- Root search reads the cached in-memory snapshot. It does not call the
  extension/browser on the keystroke path.
- Opening a tab result currently opens the URL in the source browser/profile as
  the best available one-way-bridge fallback. The production native-messaging
  path should replace this with "focus existing tab, then fall back to open URL".

Next focus-existing-tab slice:

- Use a browser-extension command channel for explicit focus commands only, not
  for keystroke search.
- Plain Enter keeps browser-like behavior and opens the resolved URL again.
- Cmd+Enter on the browser-search synthetic result asks the extension to focus
  the matching live tab by `windowId/tabId`; if the tab cannot be focused, fall
  back to the normal URL open path.
- Open tabs continue to rank above history because any open URL is also likely
  present in combined history.
- Root search will likely need a richer browser result UI soon, with multiple
  browser lines/results instead of one synthetic line.

## Ranking And Web Search Follow-Ups

Browser ranking needs a dedicated pass. The current implementation has grown
from history autocomplete, open tabs, pending extension-fed history, and
bookmarks. We need to inspect exactly how ranking works end to end and compare
it to browser omnibox behavior:

- Open tabs should outrank duplicate history rows because any open URL is likely
  also in history.
- History should not blindly dominate just because a URL has ever been visited.
  We need a better balance of typed prefix, title/URL match quality, recency,
  frequency, bookmarks, and open-tab state.
- Browser-like behavior should be replicated intentionally, not accidentally.
  Chromium's omnibox combines multiple providers (history, search suggestions,
  bookmarks, open tabs/site search) and scores candidates rather than treating
  all history matches as equally useful.
- The richer browser-results UI should make ranking visible and debuggable by
  showing separate rows/badges for open tabs, history, and bookmarks.
- The top browser row should continue to autocomplete when possible; pressing
  Enter accepts/opens the completed top result, while additional Browser-section
  rows expose a configurable number of suggestions from each provider.
- Browser-section rows should use clear source icons/badges so tabs, bookmarks,
  and history are distinguishable at scan speed.
- Browser-section provider order and per-provider row counts should be user
  configurable. This gives us a local priority control while the deeper ranking
  model is still being studied.
- The top autocomplete result definitely needs a dedicated rework. Current
  completion can pick surprising candidates because it still relies on the
  earlier history-oriented autocomplete path instead of a proper omnibox-style
  provider/ranking model.
- Follow Vivaldi's address-bar model more closely: category/provider priority
  should be a real input to ranking, not just presentation. Vivaldi exposes
  address-field drop-down priority and bookmark preference, while Chromium's
  omnibox uses provider-generated candidates with relevance scores and
  deduplication.
- Open-tab ranking must not depend on whether the browser is focused right now,
  because SuperCMD owns focus while the user searches. The extension should
  track `windowLastFocusedAt` and rank tabs from the browser window that was most
  recently focused before SuperCMD opened.
- Add a "show all browser results" row at the bottom of the Browser section so
  debugging and tuning can inspect the full ranked result set instead of only
  the limited root rows. Implemented as a global deduped ranked list, capped at
  100 rows, because provider-separated sections should not dictate the top
  autofill/default result.
- Implemented a first proper fuzzy multi-token matching slice for browser
  candidates. A query like
  `github nuzu` should match `github.com/nuzu/repo` or a title containing both
  words even when the terms are separated across host, owner, repo, title, and
  URL path segments. The current implementation keeps exact/prefix behavior in
  place and adds conservative all-token matching to root results, scoped open
  tabs, scoped bookmarks, and scoped history. Further tuning can still improve
  typo tolerance and field-specific ranking.
- Implemented a first Omnibox-inspired ranking adjustment:
  - history ranking now uses a stronger freshness curve plus recency-weighted
    frequency instead of letting stale broad matches rank too highly;
  - fuzzy/contains matches are damped when stale, while exact and strong prefix
    matches keep their authority;
  - bookmark ranking no longer receives history-style recency/frequency boosts,
    matching the idea that bookmarks are user-curated provider results;
  - open-tab fuzzy/broad matches are damped when the browser window has not
    been focused recently, using the tracked `windowLastFocusedAt` signal.
  - top autocomplete/default result now uses the same global deduped ranked
    browser list as "show all", with provider priority applied as a modest bias
    instead of a hard grouping rule.
- Later ranking input to consider: track SuperCMD-open frequency separately
  from browser history frequency. Browser history frequency should remain the
  primary browser usage signal, but SuperCMD frequency could learn what the user
  repeatedly chooses from SuperCMD even if browser history alone would not rank
  it highly.
- SuperCMD frequency should also be considered for zero-query and low-query
  suggestions. If the user repeatedly opens a destination through SuperCMD, that
  destination should be eligible to appear as a recent/frequent browser item
  before the user has typed much or anything. We still need to decide whether
  this belongs in the existing Recent section, a Browser Recent section, or the
  blended root ranking model.
- Implemented the first bookmark nickname slice, modeled after Vivaldi-style
  nicknames:
  - nicknames are stored in Browser Profile settings, keyed by
    browser/profile URL rather than in imported bookmark rows;
  - nickname editing now lives in the scoped Search Bookmarks view instead of
    Settings. Selecting a bookmark exposes a Cmd+N action that opens a compact
    prompt for that bookmark;
  - nickname input is constrained to lowercase alphanumeric tokens, suggestions
    come from the first word of the bookmark title, and Tab accepts the
    suggested token;
  - nicknames are keyed by browser/profile URL, so moving a bookmark preserves
    the nickname and removing/re-adding the same URL in the same profile can
    recover the nickname;
  - nicknames are first-token aliases only. Partial nickname prefixes
    autocomplete to the full nickname and can force the nicknamed bookmark to
    the top, but whitespace terminates nickname mode so `github nuzu` uses the
    normal browser search/ranking path.
- Later URL-intent question: decide how pasted full URLs should appear in root
  search. We may want a clear "Open exact URL" row even when browser history,
  bookmarks, or open tabs also match.
- Later profile-filter parity: add profile pickers for the scoped Bookmarks and
  Open Tabs commands, matching the profile filtering already added to scoped
  History.
- Duplicate bookmarks/URLs across profiles need deliberate action behavior. If
  the same destination exists in work and personal profiles, the result row and
  action menu should make the source profile obvious and expose modifier/action
  choices for opening in the source profile, default profile, or another
  browser/profile target. This is especially important for nicknamed common
  destinations like GitHub.
- Research notes to preserve:
  - Chromium's HistoryQuickProvider indexes URL/title words, intersects all
    query terms, caps broad candidate sets, then scores by topicality,
    recency/frequency, and specificity.
  - Chromium's HistoryURLProvider uses typed/visit count and last-visit decay to
    demote stale or never-typed URLs rather than only boosting recent URLs.
  - Chromium's BookmarkProvider breaks input into terms, requires word-prefix
    style matches, and scores by match coverage and earlier match positions.
  - Chromium's OpenTabProvider requires every input term to match title or URL
    and scores by title/URL match coverage; SuperCMD additionally needs recent
    browser-window focus because SuperCMD itself owns focus while searching.
  - Vivaldi layers user-controlled Address Field Priorities and "Always Prefer
    Bookmarks" behavior over Chromium-style suggestion providers.

Web search and bangs should be one cohesive built-in root-search feature, not
part of browser profile/history integration:

- Add a built-in Web Search category/section, similar to built-in Ask AI,
  Memory, Snippets, Files, etc.
- Root search must always include a Search section whenever the query is
  non-empty. This is separate from the Browser section. The top result can still
  be a nickname/bookmark/open tab/history item, but the next section should
  offer "Search `<query>`" so one ArrowDown + Enter searches the web directly.
- The first web-search row should search the typed query verbatim, after any
  recognized bang token has been removed, using the user's configured default
  web-search provider unless a bang overrides the target.
- Additional rows can show search suggestions fetched from the configured
  suggestion provider.
- Selecting a suggestion should submit that suggestion to the user's normal
  browser/search provider, equivalent to typing it into the browser address bar
  and pressing Enter.
- The number of search suggestions should be configurable in Settings.
- The default web-search provider should be configurable in Settings so
  SuperCMD knows which favicon/provider label to show for non-bang searches.
- Search suggestions should remain separate from browser profile history,
  bookmarks, and open tabs so those systems can be ranked and debugged
  independently.
- Root result sections themselves should become configurable, not just the rows
  inside the Browser section. Users should be able to decide whether Search,
  Browser, Files, Commands, etc. appear in a particular order and how many
  rows each section contributes.
- If a bang is recognized, the row should visibly indicate that the bang was
  applied and which provider it will use. The displayed/search-submitted query
  should not include the bang token itself.
- While typing a bang-like token, show a compact bang picker/menu with the
  available bangs so users can discover valid bang shortcuts.
- Bangs must work everywhere in the query, not only at the beginning:
  `!g query`, `query !g`, and `query !g more terms` should all resolve the bang
  token, remove only that token from the submitted query, and keep the remaining
  words in order.
- When a bang is active in root search, the result surface should switch to a
  search-only mode: show the direct bang search row and autocomplete suggestions
  for that provider/query, but do not mix in Browser, Files, Commands, or other
  root providers. A bang is an explicit search intent, so unrelated launcher
  sections should not compete with it.
- The `Search Web` command should behave as a bang/search cockpit:
  - empty query lists available bangs;
  - used bangs sort first by SuperCMD use frequency;
  - unused bangs sort alphabetically after the frequent group;
  - typing filters the bang catalog itself, not the web;
  - Enter on a bang inserts that bang into the search field so the user can
    continue typing the actual web query.
- Verify Helium bang behavior against DuckDuckGo bangs before replacing the
  seed list. Helium documents "Native Bangs" as a URL-rewrite shortcut feature,
  and product behavior should remain compatible with DuckDuckGo-style bang
  names/targets unless Helium intentionally differs.
- The bang catalog cannot depend on local browser data or Helium. SuperCMD
  should ship a small seed list only as offline fallback, then fetch/cache the
  public DuckDuckGo bang catalog used by `duckduckgo.com/bang.html` /
  `bang_lite.html` (currently exposed by versioned `bang.v*.js` data on the
  DuckDuckGo page). The cached catalog should live in SuperCMD app data and be
  periodically refreshed outside the keystroke path.
- Bang catalog UI must be capped and virtualized/search-filtered because the
  public catalog has thousands of entries.
- Bangs should support user customization:
  - a user can edit the bang aliases for an existing catalog item;
  - editing starts from the catalog default but only persists when the value is
    actually changed;
  - overrides should be stored separately from the fetched catalog so catalog
    updates do not destroy user changes;
  - multiple aliases are comma-separated, e.g. `!gh, !git`;
  - a user can add new custom bangs for providers not in the catalog;
  - if a custom alias collides with a catalog alias, the user override wins and
    the UI should make that clear.
- Image search should be part of the search surface. If the user pastes an
  image into SuperCMD, offer image-search actions instead of treating the input
  as plain text. The exact provider/upload/privacy model needs a dedicated
  design pass before implementation.

Browser data should also be accessible through explicit scoped entry points:

- Add built-in commands/entry points for Search History, Search Bookmarks, and
  Search Open Tabs.
- First scoped slice: Search Open Tabs should open a dedicated live-tab result
  view backed by extension snapshots. Empty query should list all current tabs,
  and typing should narrow to matching tab title/URL. In this scoped view, Enter
  focuses the existing tab by default because the user is explicitly searching
  open tabs; Cmd+Enter opens normally as the alternate action.
- Open tab snapshots must recover regardless of startup order. If the extension
  is loaded before SuperCMD starts, failed snapshot sends must not be marked as
  delivered, and the extension should send a fresh snapshot as soon as it can
  reconnect.
- The scoped Open Tabs view should be organized like the browser: sections per
  browser window, windows ordered by last focus, and tabs ordered left-to-right
  by their browser tab index. Root search can continue using ranked open-tab
  results.
- Second scoped slice: `Search Bookmarks` should open the same scoped browser
  result view filtered to imported bookmarks. Empty query should list all
  imported bookmarks, typing should narrow by title/URL, and Enter should open
  normally.
- Bookmark import should preserve browser folder paths and browser order so the
  scoped Bookmarks view can section results by folder. Bookmarks Bar should be
  the first section when non-empty; nested folders should be displayed with a
  joined path such as `Bookmarks Bar - Work`.
- Third scoped slice: `Search History` should open the same scoped browser
  result view filtered to imported history. Empty query should list imported
  history entries, typing should narrow by title/URL, results should keep
  favicons, entries should be sorted newest-first, sections should group by
  date, and rows should show the visit date/time. History can grow into tens of
  thousands of entries, so the scoped view should cap rendered results and keep
  filtering in the data layer. Histories from all enabled profiles should be
  merged chronologically, with a profile multi-select control for narrowing the
  view. Profile context should be shown on rows when multiple profiles are in
  play.
- Manual verification note: single-profile history was verified. Re-test the
  History profile dropdown once a second browser/profile is added, because the
  current local setup only has one profile available.
- The default root-search browser behavior should stay algorithm-driven and
  blend tabs/history/bookmarks intelligently.
- If the blended result is not what the user wants, they should be able to open
  a scoped History/Bookmarks/Open Tabs view and search only that dataset.
- Scoped views should support useful ordering modes. Default can be ranked by
  relevance/frecency, but we should consider toggles for most recent, oldest,
  most visited, browser/profile, and possibly manual/profile priority.
- This should make browser data discoverable without forcing every history or
  bookmark result into the top-level root search.

## Root Search Architecture Follow-Ups

The browser/search work is exposing a broader root-search ordering problem.
SuperCMD currently pushes generic "Results" below richer custom sections, and
that bucket includes important app/command launches. That can recreate the
classic Windows Search failure mode where the thing you most likely wanted is
buried under web/browser/file suggestions.

Follow-up work:

- Replace the coarse "Results" bucket with deliberate root providers/sections:
  Apps, Commands, Search, Browser, Files, Calculator, AI, etc.
- Make provider/section order configurable, not just Browser sub-provider
  order. Users should be able to put Apps/Commands above or below Browser,
  Search, and Files depending on how they use SuperCMD.
- Separate section order from top-result selection. The top result should be
  algorithmic, but section order should still control where secondary results
  are displayed.
- Add per-provider row limits, including the direct-search row exemption:
  "Search `<query>`" should not count against search suggestion rows.
- Revisit zero-query and low-query behavior so frequent apps/commands are not
  hidden behind unrelated browser/search suggestions.
- Make the launcher window expandable/resizable. The current fixed launcher
  height is tight for Browser/Search sections, scoped views, and long bang
  catalogs; users should be able to temporarily expand it without losing the
  fast launcher feel.
- Add a migration/design note for Vivaldi Sessions. The current user workflow
  includes transferring from Vivaldi to Helium on a new laptop, and Vivaldi's
  Sessions feature needs an equivalent story: either import/surface session
  URLs in SuperCMD, map them to Helium-compatible workflows, or otherwise make
  saved session pages discoverable from root search.

`src/renderer/src/App.tsx` has also grown too large and now mixes root
provider assembly, browser-search ranking UI, web-search/bang behavior,
settings-driven launcher layout, extension launch flow, and many internal views.
After this slice, split it into focused modules before adding the full bang
catalog/editor:

- root result assembly/provider hooks;
- browser result view component;
- web search/bang utilities and view component;
- launcher command list component;
- command execution/action helpers.

## Helium Import

Add Helium to `BrowserSearchSource` and importable browser discovery.

Minimum first step:

- [x] Add `helium` source.
- [x] Detect `~/Library/Application Support/net.imput.helium/Default/History`.
- [x] Import history from the Chromium `urls` table using the existing Chromium timestamp decoder.

Completed implementation notes:

- Helium is now included in `BrowserSearchSource` in both the main process and renderer IPC type surface.
- `listImportableBrowsers()` now exposes Helium as an importable Chromium-family browser when `Default/History` exists.
- Helium uses the same legacy browser-search import path as Chrome, Arc, Brave, Edge, and Vivaldi:
  - copy the live SQLite `History` DB to a temp file;
  - best-effort copy `History-wal` and `History-shm`;
  - read the Chromium `urls` table;
  - import up to `MAX_IMPORT_PER_BROWSER` most recent HTTP(S) visited pages;
  - store rows as `BrowserSearchEntry` records with `type: 'url'`, `source: 'helium'`, title-or-host query text, full URL, host, visit count, and decoded last-visit timestamp.
- This intentionally does not add bookmark import, tab snapshots, profile discovery, root result ranking, exclusions, or browser-root search IPC yet.
- Manual verification: import Helium from Settings -> Advanced -> Browser Search, then type a visited Helium host/title in root search and confirm it appears via existing browser-search autocomplete/history behavior.

Better first browser slice:

- Replace `listImportableBrowsers()` with profile-aware `listImportableBrowserProfiles()`.
- Preserve existing UI compatibility by grouping profile rows under browser labels.
- Import selected browser/profile instead of whole browser only.
- Store source as browser + profile, not just browser.

## Hot Cache / Index

Create `src/main/browser-root-index.ts` with a similar shape to `file-search-index.ts`.

Responsibilities:

- Discover browser profiles.
- Load bookmarks from JSON files.
- Load history from copied SQLite databases.
- Maintain in-memory normalized entries.
- Watch bookmark files for changes.
- Refresh history on startup, on manual import, and periodically.
- Continuously refresh enabled browser/profile history while SuperCMD is running,
  without querying SQLite on the keystroke path.
- Track open tabs using fast background snapshots, not keystroke calls.
- Expose status and search IPC.

Suggested caps:

- History: import all eligible rows from enabled profiles. If memory pressure
  becomes a real problem, add a setting or storage-tier strategy rather than a
  hidden fixed cap.
- Bookmarks: all bookmarks from enabled profiles.
- Tabs: all tabs from the most recent snapshot.
- Results returned per provider: default 5-10 each before final merge.

## Open Tabs

First implementation slice:

- Add the internal volatile tab store and IPC.
- Show tab counts per added profile in Settings.
- Keep the count at zero until an adapter/extension starts feeding snapshots.
- Do not persist tab rows into the history/bookmark JSON store.

Extension-backed implementation:

- Browser extension uses the WebExtensions tabs API to send full snapshots and
  deltas through native messaging.
- SuperCMD maintains a hot in-memory snapshot keyed by profile/window/tab.
- Refresh on launcher open by asking the extension for a full snapshot.
- Search uses the last completed snapshot immediately.
- If a snapshot is stale, mark result confidence lower but still show it.

AppleScript fallback:

- Acceptable only as a temporary Helium-specific adapter if extension support is
  not yet available.
- Never call AppleScript while processing a keystroke.
- Avoid high-frequency full-tab polling unless measured performance is
  acceptable. In-place navigation must be detected quickly without degrading the
  launcher.

Switching to a tab should use the extension tab id when available. If switching fails, fall back to opening the URL in the source browser/profile.

## Bookmarks

Parse Chromium bookmark JSON recursively:

- title
- url
- folder path
- browser/profile
- stable bookmark id where available
- date added if available

Bookmark import must be replace-on-refresh per profile, not append-only. Unlike
history, bookmarks can be renamed, moved, or deleted; every refresh should remove
that profile's old bookmark rows and import the current bookmark file snapshot.

Store bookmark root results with browser/profile attribution:

```txt
YouTube
youtube.com
Bookmark - Helium - Personal
```

## History

Read Chromium `History` SQLite DB from a temporary copy:

- `urls.url`
- `urls.title`
- `urls.visit_count`
- `urls.last_visit_time`

Do not query the live DB on keystrokes. Refresh into memory on a schedule and after import.

History result display:

```txt
GitHub Pull Requests
github.com/...
History - Chrome - Work - visited today
```

## URL And Web Search

Keep URL detection local and instant.

Change default search engine from hardcoded Google to a setting:

- Google
- DuckDuckGo
- Kagi
- Brave
- Bing
- Custom URL template

Opening should prefer the configured default browser target for browser root search. For the user's current goal, Helium should be selectable as the browser target.

Open question: browser/profile targeting needs a deliberate model before root
results become more than imported history.

- Treat every browser/profile pair as an addressable target, even when the user
  thinks of it as "my work browser" or "my personal browser". A target might be
  Chrome Work, Chrome Personal, Helium Default, Vivaldi Default, or another
  browser/profile combination.
- Let the user choose one default browser/profile target for URL entry, web
  search, and bangs.
- When a result comes from a specific profile, the default action should likely
  open it back in that source browser/profile if the browser supports reliable
  profile-targeted opening.
- We need a fallback policy for browsers that cannot reliably open a URL in a
  specific profile from the command line or AppleScript. Options include opening
  in the configured default target, opening in the source browser without a
  profile guarantee, or showing an action that asks the user to choose.
- We should consider modifier actions or action-panel entries for "Open in
  Default Profile", "Open in Source Profile", and "Open in Other Profile" so
  users can override the default without changing settings.
- This is also relevant for cross-browser users who separate work and personal
  contexts across different browsers rather than profiles inside one browser.
- The implementation should not assume every source can switch/open profiles the
  same way. The profile model can be shared, but the opener will likely need
  browser-specific adapters.
- Duplicate bookmarks/history rows for the same URL across multiple profiles
  should not collapse away important context. If GitHub exists in both a work
  and personal profile, SuperCMD needs visible source/profile context and quick
  modifier/action choices to open in the intended target.

## Release/PR Story

After the browser-root-search stack of PRs is filed, prepare a short promo
video for Twitter/X that shows the end-to-end workflow: browser profiles,
history/bookmarks/open tabs, nicknames, focused tab behavior, search/bangs, and
any profile-targeting behavior that lands by then.

The current stacked-PR approach is still the preferred workflow, but the final
submission may need to be split into even smaller, more focused PRs if the
maintainers want narrower review surfaces or more implementation detail per
slice.

Before filing the final issues/PRs, use all available context sources to decide
the cleanest split and write accurate descriptions: this plan, the relevant
Codex/chat history, and the actual PR branch diffs. The final split may differ
from the working slices if that makes review clearer.

## Bangs

Implement bang parsing as part of the combined Web Search/Bangs slice:

- Leading bang: `!g query`
- Trailing bang: `query !g`
- Middle bang: `query !g extra terms`
- Case-insensitive bang key.
- If bang is known, transform to the bang URL and remove the bang token from
  the submitted query.
- If a bang is recognized, show a clear inline indicator/badge on the search
  row so the user understands that the search provider was overridden.
- If the user is typing a bang token, show a compact menu of available bangs and
  let the user choose one.
- If bang is unknown, fall back to normal search.
- Bangs should work anywhere root search text can become a web search, not only
  in one explicit Web Search command. The parser should be shared by root web
  search, search suggestions, and any scoped search-submit surfaces that route
  to web search.

Cache bang definitions in SuperCMD user data:

```txt
~/Library/Application Support/SuperCmd/browser-root/bangs.json
```

Refresh policy:

- Use cached bangs immediately.
- Refresh automatically at most once per day when the catalog is requested.
- Keep last good cache if network fails.

If the exact Helium source endpoint is stable and public, use it. Otherwise vendor a snapshot and add an update task later.

Current implementation checklist:

- [x] Root search has a direct `Search "<query>"` row near the top, separate
  from autocomplete suggestions.
- [x] Search suggestions live in their own Search section instead of being
  mixed into Browser history/bookmark/tab rows.
- [x] The configured suggestion count limits autocomplete suggestions, not the
  direct `Search "<query>"` row.
- [x] Bang tokens are parsed anywhere in the query and removed from the
  submitted web-search text.
- [x] The `Search Web` command behaves as a bang picker: empty query shows
  bangs, typing filters bangs, and Enter inserts the selected bang into root
  search.
- [x] The bang picker fetches and caches the public DuckDuckGo
  `bang_lite.html` catalog in SuperCMD app data, with a seed fallback.
- [x] The cached bang catalog refreshes automatically once per day when the
  catalog is requested.
- [x] The empty bang picker orders used bangs first, then common seeded bangs,
  then the remaining catalog alphabetically.
- [x] The empty bang picker shows section headers for Used Bangs, Common Bangs,
  and All Bangs A-Z so it is clear where the alphabetic catalog begins.
- [x] The bang picker progressively renders more rows while scrolling so the
  full catalog remains reachable without putting all rows in the DOM at once.
- [x] Common providers with multiple known aliases, such as GitHub
  `!gh`/`!github`, are represented as one provider row in the seeded metadata
  instead of duplicate rows.
- [x] Seeded Google Images aliases include `!gi`, `!gim`, `!gimg`, and
  `!gimages` as default aliases, not custom aliases.
- [x] Cmd+N on a selected bang opens a compact alias editor; custom aliases are
  stored separately from the fetched catalog.
- [x] Only entries with user overrides show the Custom chip.
- [ ] Evaluate `t3-content/unduck` as a fast fallback redirect/template for
  long-tail bangs. It helps with redirect speed, but by itself it does not
  provide the full editable/provider-rich catalog UI SuperCMD needs.
- [ ] Replace the seeded "common bangs" ordering with real popularity/ranking
  metadata if a reliable catalog source exposes it. Once SuperCMD has local
  usage data, user bang frequency should dominate the top section.
- [ ] Use richer target metadata for the full DuckDuckGo catalog. The current
  `bang_lite.html` source exposes aliases/categories but not every target host
  and display name, so non-seeded rows route through DuckDuckGo and use the
  DuckDuckGo favicon until we switch to a richer source such as the versioned
  DuckDuckGo bang data used by the page.
- [ ] Add first-class creation/editing for fully custom bang providers,
  including custom URL templates, not just alias overrides for existing catalog
  entries.
- [ ] Add image-search handling for pasted images.
- [ ] Revisit root-search provider ordering and App.tsx decomposition before
  expanding this further.

## Ranking

Use one ranker for browser root results.

```txt
finalScore =
  providerPriority
  + matchQuality
  + nicknameBoost
  + frecencyBoost
  + recencyBoost
  + profilePreferenceBoost
  - exclusionPenalty
```

Match quality:

- Exact nickname: dominant score.
- Exact title/host/url token.
- Prefix title/host/url token.
- Contains.
- Fuzzy/subsequence, with lower score.

Frecency:

- Store use count and last used time for selected browser root results.
- Increment on open/switch/search.
- Apply logarithmic recency decay like existing browser-search history.

Provider priority:

Initial default order based on the user's Vivaldi setup:

1. Calculator
2. URL entry / web search / bangs
3. Open tabs
4. Bookmarks
5. Browsing history
6. Recently closed tabs, later
7. Files and commands remain as existing root results until we deliberately merge everything into the provider pipeline

Exact nickname matches should be allowed to jump above this order.

## Settings

Add a dedicated Root Search section. It can live in the existing Extensions/Commands settings area later, but for the browser slice it can start under Advanced next to Browser Search.

Browser root settings:

```ts
type BrowserRootSearchSettings = {
  enabled: boolean;
  defaultBrowserId: string;        // "helium"
  defaultProfileId?: string;       // optional
  searchEngine: 'google' | 'duckduckgo' | 'kagi' | 'brave' | 'bing' | 'custom';
  customSearchUrlTemplate?: string;
  providers: Array<{
    id: 'browser-url' | 'browser-web-search' | 'browser-bangs' | 'browser-tabs' | 'browser-bookmarks' | 'browser-history';
    enabled: boolean;
    priority: number;
    maxResults: number;
    minQueryLength: number;
  }>;
  profiles: Record<string, {
    enabled: boolean;
    displayName?: string;
    priorityBoost?: number;
  }>;
};
```

UI:

- Enable browser root search.
- Choose default browser/profile.
- Select search engine.
- Enable/disable browser result types.
- Drag result types to reorder.
- Toggle browser profiles.
- Treat the enabled browser/profile list order as future ranking input, so a
  higher profile in the list can boost matching history/bookmark/tab results
  ahead of lower-priority profiles.
- Show import/refresh status per profile.

## Exclusions

Every browser root result needs a stable `exclusionKey`.

Examples:

- `browser-history:helium:Default:https://example.com/page`
- `browser-bookmark:chrome:Profile 1:https://youtube.com/`
- `browser-tab:helium:Default:<tab-id>` for tab-specific exclusion, or URL key for durable exclusion

Actions menu:

- Exclude This Result
- Exclude This Domain
- Exclude This Profile From Root Search

Settings should include an exclusions manager with search and remove.

## Nicknames

Nicknames are SuperCMD metadata, not browser-native metadata.

Storage:

```ts
type BrowserNickname = {
  id: string;
  nickname: string;
  url: string;
  title?: string;
  browserId?: string;
  profileId?: string;
  createdAt: number;
  updatedAt: number;
  useCount: number;
  lastUsedAt?: number;
};
```

Matching:

- Case-insensitive.
- Exact nickname match should rank above normal browser suggestions.
- Prefix nickname match should rank very high.
- Nickname should apply to matching bookmark/history/url results.

Usability:

- Root result action: Set Nickname.
- Root result action: Edit Nickname.
- Root result action: Remove Nickname.
- Browser Root Search settings: Nicknames table with search, add, edit, delete.

Suggested nickname table columns:

```txt
Nickname | Title | URL | Browser/Profile | Last Used
```

Conflict handling:

- Duplicate nickname warning.
- Allow duplicate only if scoped to profile, but default should discourage duplicates.
- If duplicate exists, exact match shows the most-used item first and still exposes the other matches below.

## Renderer Integration

Initial browser slice can keep existing command/file behavior intact.

Steps:

1. Keep current `filteredCommands`, file results, calculator, and synthetic browser command.
2. Add browser root result commands as a new group before files.
3. Replace the synthetic browser search command once URL/web/bang providers produce equivalent results.
4. Add execution handling for browser root result ids.
5. Preserve keyboard navigation and current root result row layout.

Implementation detail:

- Use prefixed ids like `browser-root:<encoded-result-id>`.
- Store the latest result map in a ref so selection execution does not need another lookup.

## Main Process IPC

Add IPC surface:

```ts
browser-root:list-profiles
browser-root:refresh-profile
browser-root:search
browser-root:open-result
browser-root:set-nickname
browser-root:remove-nickname
browser-root:list-nicknames
browser-root:add-exclusion
browser-root:remove-exclusion
browser-root:list-exclusions
browser-root:get-status
```

For latency, consider also:

- `browser-root:get-snapshot`, loaded once into renderer on launcher open.
- `browser-root:snapshot-changed` event to update renderer caches.

## Migration

Existing `browserSearch.history.json` should remain valid.

Migration plan:

1. Keep existing browser search settings.
2. Add new browser root settings with defaults.
3. Import existing browser-search entries into the browser-root learning store as `source: user`.
4. Do not delete old history.
5. Once browser root is stable, the old browser synthetic command can become a compatibility layer.

## Testing

Unit tests:

- URL detection.
- Bang parsing.
- Chromium profile discovery from fixture `Local State`.
- Bookmark JSON recursive parsing.
- Chromium history timestamp conversion.
- Ranking exact nickname over provider priority.
- Exclusion key filtering.

Integration tests:

- Import Helium Default history.
- Import multiple Chrome profiles.
- Search returns profile-labeled bookmark/history results.
- Disabled profile results do not appear.
- Nickname set/edit/remove affects ranking.

Manual tests:

- Type `youtube` with nickname `yt`.
- Type URL-like text.
- Type search query.
- Type leading and trailing bang.
- Open Helium bookmark/history result.
- Search while Helium is closed.
- Search while Helium is open with tabs.
- Switch a Helium tab by result.

Performance checks:

- Root typing remains responsive with 25k history entries.
- Search path does not touch SQLite, AppleScript, network, or disk.
- Background refresh does not visibly stall the launcher.

## Implementation Phases

### Phase 1: Helium Import And Profiles

- [x] Add Helium source.
- [ ] Add profile-aware browser discovery.
- Update settings/import UI to show browser profiles.
- [x] Import Helium history from `net.imput.helium`.
- [x] Preserve existing browser imports.

First PR scope:

- Ship only the Helium import parity slice against the existing browser-search import pipeline.
- Keep the current default-profile-only behavior consistent with Chrome, Arc, Brave, Edge, and Vivaldi.
- Leave the broader profile-aware import and browser-root index work for follow-up PRs.

### Phase 2: Browser Root Index

- Add `browser-root-index.ts`.
- Load bookmarks/history/tabs into memory.
- Expose search IPC.
- Add status IPC and basic refresh.

### Phase 3: Root Browser Results

- Add browser root result ids and execution path in `App.tsx`.
- Show URL/web/search/bookmark/history results in root.
- Keep existing file and command behavior stable.
- Add browser/profile/source labels.

### Phase 4: Ranking, Learning, Exclusions

- Add shared browser ranker.
- Add frecency store.
- Add result/domain/profile exclusions.
- Add actions menu entries for exclusions.

### Phase 5: Bangs And Nicknames

- Add bang cache and parser.
- Add nickname store.
- Add root actions for nickname CRUD.
- Add settings table for nicknames.

### Phase 6: Prepare For Non-Browser Providers

- Extract provider interface if not already clean.
- Document how clipboard/snippets/notes/quicklinks can join the same pipeline.
- Do not implement those providers until browser behavior is solid.

## Open Questions

- What exact URL should SuperCMD use to refresh Helium's bang database?
- Does Helium support opening a URL into a specific profile via command-line args?
- Does Helium expose recently closed tabs in a stable local file or AppleScript API?
- Should browser root search default to only Helium for this user, or enable all discovered profiles by default?
- Should URL/web search rank before open tabs for all users, or only for this user's configured default?
- Should root nicknames apply globally by URL, or be scoped by browser/profile by default?
