# Testing plan

This plan lists what to test, at which level, and with which tools. Most of the risk is in the background worker's window and tab tracking, so most of the tests go there.

Levels 1 to 4 are implemented in `test/` and run in CI. Level 5 is the manual checklist. Run them with:

```sh
npm test             # unit, background and page tests (a few seconds)
npm run test:e2e     # builds, then runs the end-to-end tests in Chromium
```

The first `npm run test:e2e` needs Playwright's Chromium: `npx playwright install chromium`.

## Goals

- **Never open more tabs than a collection has.** In November 2026, Vivaldi opened 89 tabs for a 3-page collection. The background tests must catch any path that opens anything but the saved pages.
- **The open/closed state is always true.** A toggle must never show a window that has already closed, and closing one must never fail with "No window with id …".
- **No collection without pages,** whichever way it is created: the Collection page, the popup, the prompt, import, or Vivaldi workspaces.
- **The update prompt shows when it should, and only then.** A changed window asks; an unchanged window, an empty window, or a redirect during the first load doesn't.
- **The same behaviour in Chromium, Firefox and Safari.**

## Test levels

| Level | What it covers | Tool | Runs |
|---|---|---|---|
| 1. Unit | Pure helpers in `common.js` | `node:test` with a fake browser API | Every push (CI) |
| 2. Background integration | `background.js` driven by fake browser events: sessions, drift, prompts, startup | `node:test` with a scriptable fake browser | Every push (CI) |
| 3. Page (DOM) | `popup.js`, `collections.js`, `collection.js`, `prompt.js` rendering and actions | `node:test` with `happy-dom`, fake `send()` and storage | Every push (CI) |
| 4. End-to-end | The built `dist/chromium` in a real Chromium | Playwright, persistent context with `--load-extension` | Every push (CI) |
| 5. Manual | Vivaldi, Firefox, Safari, plus anything the fakes can't reproduce | The checklist below | Before each release |

Why these tools:

- `node:test` comes with Node, so the unit and integration levels add no dependency.
- `happy-dom` is lighter and faster than jsdom, and these pages use only basic DOM.
- Playwright can load an unpacked extension into Chromium only. Firefox and Safari stay manual: Playwright's Firefox can't load extensions, and Safari needs the Xcode host app.

Pin every new dev dependency to an exact version: `.npmrc` sets `save-exact=true`.

## Setup

### Layout
```
playwright.config.js
test/
  fake-browser.js            # in-memory api: storage.local (+ onChanged), windows, tabs, runtime, action
  unit/common.test.js        # U
  background/background.test.js  # B
  pages/harness.js           # loads a page's HTML into happy-dom, with canned background replies
  pages/{popup,collections,collection,prompt}.test.js  # P, C, E, R
  e2e/fixtures.js            # Chromium with dist/chromium loaded, a local web site, chrome.* helpers
  e2e/flows.spec.js          # X
```

Each test's name starts with its ID from the tables below.

### Scripts in `package.json`

- `test`: `node --test` over `test/unit`, `test/background` and `test/pages`
- `test:e2e`: `npm run build && playwright test`

### The fake browser (`test/fake-browser.js`)

The fake is installed as `globalThis.chrome` when `test/fake-browser.js` is imported, so every test file imports it first: `common.js` reads `api.storage.local` and `api.runtime.getURL` at load time.

It has:

- **`storage.local`:** an in-memory store with `get`, `set` and `onChanged`. `set` fires `onChanged` with `{ oldValue, newValue }`, like the real API.
- **`windows`:** `create` returns the new window and creates one tab per URL. Also `get` (rejects with `No window with id: N.` once the window is gone), `getCurrent`, `remove` and `update`. Events: `onRemoved`.
- **`tabs`:** `query`, `get`, `create`, `update` and `remove`. Events: `onCreated`, `onUpdated` (with `changeInfo`), `onRemoved` (with `isWindowClosing`), `onMoved`, `onAttached`, `onDetached` and `onReplaced`.
- **`runtime`:**
  - `getURL` returns `chrome-extension://test/…`.
  - `sendMessage` is routed to the background's `onMessage` listener.
  - `onStartup` and `onInstalled` can be fired by the test.
- **`action.setBadgeText`**.

Test controls:

- **Delays:** a delay before `onRemoved` fires, so a test can reproduce a slow close.
- **A window that disappears:** closed with its events (`closeWindowNow`), or without them, as when an event is lost (`vanishWindow`). Tests also replace `windows.create` or `windows.remove` to close a window mid-call.
- **Tab loading:** start a tab with `status: 'loading'` and `pendingUrl`, then complete it with a redirected URL.
- **`windows.create({ type: 'popup' })` can be made to throw:** this is Safari's behaviour.
- **`flush()`:** awaits every queued promise and listener, so tests don't depend on timing.
- **Time:** the prompt's 5-minute auto-close uses `node:test` `mock.timers`. For `SETTLE_WINDOW_MS` (60 s), tests move the session's `openedAt` back instead.

### Making background.js testable

`background.js` registers its listeners when it is imported, so the test file imports it once, after the fake. Each test then empties the fake's storage, windows and tabs (`fake.reset()`, which keeps the listeners) and drives it with events. `node:test` runs each file in its own process, so files don't share a fake.

There's no need to export internals. Assertions go through storage (`collections`, `sessions`, `pending`) and through the fake's window and tab lists. This tests behaviour, not implementation.

## 1. Unit tests: `common.js`

| ID | Function | Cases |
|---|---|---|
| U1 | `cleanPages` | Drops pages whose URL is ignorable; keeps the order of the rest |
| U2 | `diffPages` | Added; removed; both; duplicates are counted as a multiset (two copies of A → one copy is "removed"); `reordered` is true only with no additions or removals and a different order; empty inputs |
| U3 | `groupByWorkspace` | `null` without `vivExtData`; groups by rounded workspace id; skips `panelId` tabs and ignorable URLs; sorts by window, then by index; `none` last |
| U4 | `hasPages` | `null`, missing `pages`, `[]`, pages all without `url` → false; one page with a URL → true |
| U5 | `isIgnorableUrl` | Empty string; `about:blank`, `about:newtab`; `favorites:`; `chrome://newtab`, `chrome://new-tab-page`, `chrome-search://`; `edge://newtab`, `brave://newtab`, `opera://startpage`, `vivaldi://startpage`, `chrome://vivaldi-webui/startpage`, `chrome://startpageshared`; the extension's own URLs. Not ignorable: `https://…`, `file://…`, `chrome://settings` |
| U6 | `makeCollection` | Default id, name `Untitled collection` and dates; trims the name; normalizes page URLs; drops pages without a URL; keeps a given `id` and `createdAt` |
| U7 | `normalizeUrl` | `example.com` → `https://example.com`; `localhost:3000/x` and `127.0.0.1` → `http://…`; schemes are kept (`http:`, `file:`, `chrome:`); trims; empty → `''` |
| U8 | `parseImport` | Formats: an export object, a bare array, a single collection object. Errors: invalid JSON → "not valid JSON"; no list → "No collections found"; an entry without `name` or `pages` → "invalid collection entry". Pages that aren't objects with a string `url` are dropped. Collections left with no page are counted in `skipped`. `id` and `createdAt` are kept when valid |
| U9 | `plural`, `slug` | `1 page` / `2 pages` / `0 pages`; `slug` of punctuation only → `collection` |
| U10 | `putCollection`, `saveCollections` (fake storage) | Refuse an empty collection with the "needs at least one page" message; accept an already stored empty collection when it is unchanged (so deleting another one still works); refuse it once it is changed; `putCollection` sets `updatedAt` |
| U11 | `removeCollection` | Removes the collection and its pending changes, both live and closed; leaves other collections' pending changes |
| U12 | `sameUrlList` | Same order → true; different length or order → false |
| U13 | `suggestName` | 0 hosts → `Workspace`; strips `www.`; dedupes hosts; `a, b +3` |
| U14 | `vivaldiData`, `workspaceKey`, `workspaceCreated` | Parses `vivExtData` given as an object or as a JSON string; bad JSON → `null`; float workspace ids are rounded; missing, empty or NaN id → `none`; only 13-digit timestamps give a date |
| U15 | `buildExport` → `parseImport` | A round trip keeps `id`, `name`, `description`, `pages` and `createdAt` |
| U16 | `suspiciousGrowth` | True for more than 10 added tabs and more than double the pages; false for smaller, proportionate or shrinking changes |

## 2. Background integration tests

Every test starts from a known storage state, then fires events. "Prompt opens" means the fake has a new window whose URL is `prompt.html?id=…`.

### 2.1 Opening (`open` message)

| ID | Scenario | Expected |
|---|---|---|
| B1 | Open a 3-page collection | One new window with exactly 3 tabs, in order; a `sessions` entry with `baseline` = the 3 URLs |
| B2 | **Regression (PR #19):** open a 3-page collection that has an undecided closed-window drift of 89 pages | Exactly 3 tabs; the drift is still in `pending` |
| B3 | Open a collection that is already open | Its window is focused; no new window |
| B4 | The open collection's window has gone, but its session is still stored | The stale session is dropped; a new window opens |
| B5 | The window closes before the session is written (race) | No session is written; no empty drift |
| B6 | Open a stored empty collection (from before empty ones were refused) | Error "This collection has no pages…"; no window |
| B7 | Open a collection id that doesn't exist | Error "Collection not found" |
| B8 | Tabs still loading when the window opens, then redirected within 60 s | `baseline` takes each redirected URL; closing then shows no prompt |
| B9 | A redirect after 60 s | Counts as a change |

### 2.2 Tracking tabs

| ID | Scenario | Expected |
|---|---|---|
| B10 | Add, remove, move, attach, detach and replace tabs in a collection window | `sessions[w].tabs` follows the window, in tab order |
| B11 | Tab events in a window that isn't a collection's | Storage is unchanged |
| B12 | `tabs.onRemoved` with `isWindowClosing: true` | No refresh, so the session keeps its last tabs |
| B13 | A burst of 100 tab events | Writes are serialized; the final `tabs` matches the window; no lost update |

### 2.3 Closing a window (`windows.onRemoved`)

| ID | Scenario | Expected |
|---|---|---|
| B14 | Close an unchanged window | Session removed; no pending change; no prompt |
| B15 | Close a window with an added tab | A pending entry `{ live: false, pages }` is stored; the prompt opens; `promptWindowId` is set |
| B16 | Close a window whose tabs were only reordered | Prompt (a reorder is a change) |
| B17 | Close a window whose only extra tabs are new-tab pages | No prompt |
| B18 | Close a window whose tabs all match the collection, though not the baseline (the collection was edited while it was open) | No prompt |
| B19 | Close a window left with no tabs, or only ignorable ones | No pending entry (no empty drift) |
| B20 | Close a window whose collection was deleted while it was open | Session removed; nothing else |
| B21 | Close a changed window twice in a row (same collection) | Only the newest closed drift is kept; the earlier prompt is closed |
| B22 | Close the prompt window without answering (closed drift) | The pending entry stays, with `promptWindowId: null` |
| B23 | Close the prompt window without answering (live drift) | The pending entry is deleted |
| B24 | `windows.create({ type: 'popup' })` throws | The prompt opens as a normal window |
| B25 | Both window creations throw (live review) | The live pending entry is deleted |
| B26 | A slow `onRemoved` (delayed by the fake), a changed 93-tab window | The session is gone by the time `driftStatus` returns; the prompt still opens, once |
| B26b | **Regression:** `driftStatus` (a page rendering) runs as a changed window closes | One closed drift, one prompt |

### 2.4 Closing from a toggle (`closeCollection`)

| ID | Scenario | Expected |
|---|---|---|
| B27 | Close an open collection | Its window is removed, and so is its session |
| B27b | Close a changed collection window | The prompt opens |
| B28 | **Regression (PR #19):** the window is already gone; its session is stale | Resolves without error; the session is pruned |
| B29 | `windows.remove` fails for another reason, while the window still exists | Rejects with that error |

### 2.5 State for the pages (`driftStatus`, `windowStatus`, `reviewWindow`, `updateFromWindow`)

| ID | Scenario | Expected |
|---|---|---|
| B30 | `driftStatus` with one live window, and one changed window that closed without `onRemoved` reaching the worker | Only the live one is listed: `{ windowId, changed, count, empty }`; the closed one is handled as `onRemoved` would: a closed drift and a prompt |
| B31 | `windowStatus` for a collection window | `{ changed, name }`; `null` for any other window |
| B32 | `reviewWindow` on a changed open window | A `live: true` pending entry is stored; the prompt opens |
| B33 | `reviewWindow` on a window that isn't a collection | Error "This window is not a collection" |
| B34 | `updateFromWindow` | The collection takes the window's pages; the window counts as unchanged afterwards; live pending entries for it are removed |
| B35 | `updateFromWindow` on a window with no pages left | Refused (the collection can't become empty) |
| B36 | `saveAndAdopt` | Collection stored; the window is tracked with `baseline` = its tabs; closing it unchanged → no prompt |
| B37 | `adopt` a window that has already closed | No session written |
| B38 | An unknown message type | `{ ok: false, error: 'Unknown message: …' }` |

### 2.6 Browser restart and extension reload

| ID | Scenario | Expected |
|---|---|---|
| B39 | `onStartup` with two stored sessions, one changed | Sessions cleared; one closed drift, without a prompt; live pending entries dropped; every `promptWindowId` cleared |
| B40 | `onStartup`, a changed session, then reopen that collection | Opens the saved pages only (the B2 path, through the startup route) |
| B41 | `onInstalled` with stale sessions and a stale prompt | Stale sessions pruned; live pending entries without a prompt dropped; closed ones kept with `promptWindowId: null`; badge text cleared |

## 3. Page tests (DOM)

Each test loads the page's HTML into happy-dom, installs the fake browser, and replaces `send()` with a stub that records messages and returns canned results.

### Popup (`popup.js`)

| ID | Scenario | Expected |
|---|---|---|
| P1 | Collections listed by name; current window's collection marked `*` | Order and marker correct |
| P2 | Toggles follow `driftStatus`, not `storage.sessions` | A stale session shows as off |
| P3 | Toggle off → `closeCollection`; error → the toggle turns back on and the message shows | |
| P4 | A drifted open collection shows the warning badge; a click sends `reviewWindow` | |
| P5 | The Save label and the pages it saves: several tabs selected → the selected tabs; Vivaldi workspace data → this workspace's tabs, without web panels; otherwise → the whole window | |
| P6 | Save with 0 pages | The button is disabled |
| P7 | Save the whole window | Sends `saveAndAdopt` |
| P8 | Save the selected tabs or a workspace | `putCollection` only (the window isn't adopted) |
| P9 | In a collection window | The save form is hidden; "differs from" or "displays" is shown, depending on `windowStatus`, with *Save changes* only when it changed |

### Collections page (`collections.js`)

| ID | Scenario | Expected |
|---|---|---|
| C1 | Cards: name, description, page count, Open/Closed, "This window" badge | |
| C2 | Filter by name and description | Matches update as you type; the "No match" state shows |
| C3 | The toggle opens or closes the window; an error flips it back and shows a toast | |
| C4 | Delete: confirmed → removed; cancelled → kept | |
| C5 | *New collection* goes to `collection.html?new=1` | Nothing is stored |
| C6 | Export | With no collections → toast; otherwise a file named `tab-collections-YYYY-MM-DD.json` |
| C7 | Import | New collections; overwrites listed by name; cancel stores nothing; skipped empty ones counted in the confirmation and the toast; only empty collections → alert, nothing stored; invalid file → "Import failed: …" |
| C8 | Vivaldi | The button shows only with workspace data; the dialog lists the workspaces, with `none` unticked; Create stores the ticked ones and skips the empty ones |
| C9 | Settings | `closeDefault` loads, saves and shows a toast |
| C10 | Drift strip | For a closed drift: Details, Update (not when the drift has 0 pages) and Restore. For a live drift: Details and Update, no Restore |
| C10b | Drift strip, suspicious growth | Update on a closed or live drift that grows suspiciously opens the review (prompt or `reviewWindow`) instead of saving, with a "Check the tabs" toast |
| C11 | A storage change in another tab | The page renders again |

### Collection page (`collection.js`)

| ID | Scenario | Expected |
|---|---|---|
| E1 | `?new=1` | Unsaved; Save disabled until a page is added; Open, Export and Delete hidden; leaving stores nothing |
| E2 | The first save of a new collection | Stored; the URL becomes `?id=…`; "Collection created" |
| E3 | Add a page | The URL is normalized; invalid URL → toast; title optional |
| E4 | Edit a title or URL in place | Dirty state, savebar shown; an invalid URL is marked |
| E5 | Remove every page, then save | Refused with a toast; nothing stored |
| E6 | Reorder with the up/down arrow keys on the handle (dragging is in the manual checklist) | Order changes; focus follows the moved page |
| E7 | Save with Ctrl/Cmd+S; Revert | |
| E8 | `beforeunload` while dirty | The browser asks before leaving |
| E9 | Another tab saves the same collection | Not dirty → reloads; dirty → the "changed elsewhere" banner shows |
| E10 | Another tab deletes it | Shows "not found" |
| E11 | Open while dirty | Asks to save first; cancel → nothing opens |
| E12 | Export while dirty | Exports the saved version, with a toast |
| E13 | A stored empty collection (from before empty ones were refused) | It shows; pages can be added, or it can be deleted |

### Prompt (`prompt.js`)

| ID | Scenario | Expected |
|---|---|---|
| R1 | Closed drift with additions, removals or a reorder | Lists match `diffPages`, compared against `baseline` |
| R2 | The highlighted, focused button | `closeDefault: 'keep'` → Restore; `'update'` → Update; a live drift → Update |
| R3 | Update | The collection takes the pages; pending resolved; for a live drift, the window is adopted |
| R4 | Restore | Pending resolved; the collection is unchanged |
| R5 | Save as new | A new collection (default name `… (copy)`); pending resolved |
| R6 | A drift with 0 pages | No Update, no Save as new. Closed drift → Restore only; live drift → Close only |
| R7 | The collection was deleted | "no longer exists"; Save as new and Discard (Discard only with 0 pages) |
| R8 | Unknown pending id | "Nothing to review" |
| R9 | Auto-close | Closes on blur after having focus, and after 5 minutes; not while busy; closes when its pending entry is removed elsewhere |
| R10 | Suspicious growth | Warns; Restore stays the default even with `closeDefault: update`; an open window's Update isn't focused; no warning for ordinary changes |
| R11 | Vivaldi note | Shown when tabs carry `vivExtData`; not otherwise |

## 4. End-to-end tests (Playwright, Chromium)

These load `dist/chromium` into a persistent Chromium context: a fresh profile per test, so each starts with empty storage. They find the extension id through the service worker's URL, and open the pages at `chrome-extension://<id>/…`. The collections' pages come from a local web server started for each test, so nothing goes to the network.

The tests reach the background worker through `context.serviceWorkers()[0].evaluate(...)`. They use it to seed storage and to call `chrome.windows.*` for actions Playwright can't do, such as closing a whole window. Before closing a changed window, a test waits until the worker has recorded the change (`ext.tracked`), never for a fixed time.

| ID | Flow |
|---|---|
| X1 | Create a collection on the Collection page (`?new=1`), add 3 URLs, save; it appears on the Collections page |
| X2 | Open it from the Collections page toggle → a window with exactly 3 tabs; the toggle is on |
| X3 | Close that window unchanged → no prompt; the toggle is off |
| X4 | Open, add a tab, close → the prompt shows the added page; Update → the collection has 4 pages |
| X5 | The same with Restore → 3 pages; the drift is gone |
| X6 | Close the prompt without answering → the drift strip shows on the Collections page; Update, Restore and Details work |
| X7 | **Regression:** seed an 89-page closed drift for a 3-page collection; open it → 3 tabs |
| X8 | **Regression:** seed a stale session for a closed window id; Collections page → shown closed; toggling it doesn't error |
| X9 | Open the popup (`popup.html` as a tab of the window to save) → save the window; the collection exists and is tracked |
| X10 | Import an export file (round trip) → the same collections; a file containing an empty collection → it is skipped and counted |
| X12 | Performance guard: open a 50-page collection; close it → one prompt, no long hang (`onRemoved` handled within 2 s) |

## 5. Manual checklist (each release)

Run it in **Vivaldi**, **Chrome**, **Firefox 140+** (temporary add-on) and **Safari 16.4+**. Use a real profile with many tabs, not a fresh one.

### Every browser
- [ ] Open, change, close, then Update / Restore / Save as new (X4–X6 by hand).
- [ ] The prompt auto-closes when you switch windows, and the drift strip appears.
- [ ] Quit the browser with a changed collection window open. After a restart, the drift is listed without a prompt, and reopening the collection opens only the saved pages.
- [ ] Toggles in the popup and on the Collections page match reality after closing a window from the OS (the red button or Cmd+W).
- [ ] Export downloads a file, and Import reads it back.
- [ ] Favicons show, with the globe fallback for a site without one.
- [ ] Reorder pages by dragging the handle on the Collection page.
- [ ] **X11:** reload the extension (on the extensions page) with a collection window open. The toggle still shows it open, closing it from the toggle works, and nothing is duplicated. Playwright can't automate this: it gets no working service worker back after a reload.
- [ ] Dark mode and light mode; keyboard only (Tab, Enter, the arrows on the drag handle); a screen reader reads the toggle labels and the drift button.

### Vivaldi
- [ ] *From Vivaldi workspaces…* lists the workspaces; created collections skip web panels and empty workspaces.
- [ ] Popup Save in a workspace saves only that workspace's tabs.
- [ ] **The tab explosion follow-up.** Open a collection while other workspaces, tab stacks and session restore are in use. Its window must hold only its own tabs. If it holds more, record what `chrome.tabs.query({ windowId })` returns for that window: this is the open question from PR #19.
- [ ] Close a collection window that holds tabs from more than one workspace.

### Firefox
- [ ] Event page (not a service worker): leave the browser idle until the event page unloads, then close a changed window. The prompt still opens.
- [ ] Collections survive a restart, while the add-on id stays `tab-collections@local`.

### Safari
- [ ] The prompt opens as a normal window when popup windows aren't supported.
- [ ] Favicons come from `/favicon.ico`.
- [ ] Export appears in Downloads.

## Regression list

Each fixed bug gets a test at the lowest level that can reproduce it:

| Bug | Fixed in | Tests |
|---|---|---|
| A collection opened as its undecided drift (89 tabs for 3 pages) | PR #19 | B2, B40, X7 |
| The toggle stayed on after the window closed; "No window with id …" on toggling off | PR #19 | B4, B26, B28, P2, P3, X8 |
| An empty drift recorded for a window closed before its tabs were read | PR #19 | B5, B19 |
| An empty "New collection" stored by the New button | PR #20 | C5, E1, E5, U10 |
| Empty collections created by import or from Vivaldi workspaces | PR #20 | U8, C7, C8 |
| No prompt when a page asked for drift status, or a toggle closed the window, as a changed window closed | PR #21 | B26, B26b, B27b, B30, X4–X6, X12 |
| With unsaved edits, Export named the file after the unsaved name | PR #21 | E12 |

## CI

`.github/workflows/test.yml` runs on every pull request and on pushes to `main`:

1. Node from `mise.toml` (`jdx/mise-action`), then `npm ci`
2. `npm run build` (all three targets, to catch manifest or bundling errors)
3. `npm test`
4. `npx playwright install --with-deps chromium`, then `npx playwright test`, with Playwright's headless Chromium, which runs extensions. On failure, `test-results/` is uploaded.

## Not automated

- **Firefox and Safari:** the manual checklist. Playwright can't load extensions in either.
- **Dragging, favicons, styles, dark mode, screen readers:** the manual checklist.
- **The cause of the Vivaldi tab explosion:** the manual Vivaldi check above.
