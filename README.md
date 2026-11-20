# Tab Collections — cross-browser extension (Manifest V3)

Group web sites into collections; open a collection as its own window; when the
window closes, choose whether to update the collection with the tabs you ended up with.

Ready-built packages are in `dist/`:

| Folder | Browsers |
|---|---|
| `dist/chromium/` | Chrome, Edge, Brave, Vivaldi, Opera, Arc and other Chromium browsers |
| `dist/firefox/` | Firefox 140+ (desktop) |
| `dist/safari/` | Safari 16.4+ on macOS — needs converting with Xcode (see below) |

## Install

### Chromium browsers
1. Open the extensions page: `chrome://extensions`, `edge://extensions`, `brave://extensions`, `vivaldi://extensions`, or `opera://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** → select `dist/chromium`.

### Firefox
- **Quick test:** `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `dist/firefox/manifest.json`. (Temporary add-ons are removed when Firefox restarts — your collections stay in storage as long as the add-on id stays the same.)
- **Permanent:** sign it (free, unlisted) on addons.mozilla.org with `npx web-ext sign --channel=unlisted --source-dir dist/firefox --api-key … --api-secret …`, then install the `.xpi`.

### Safari (macOS, needs full Xcode)
1. Convert the extension into an Xcode project:
   ```sh
   xcrun safari-web-extension-converter dist/safari \
     --project-location ./safari-app \
     --app-name "Tab Collections" \
     --bundle-identifier com.yourcompany.tabcollections \
     --swift --macos-only --no-open
   ```
   (Apple has renamed this tool *Safari web extension packager*; if `safari-web-extension-converter` isn't found, run `xcrun --find safari-web-extension-packager` and use that name with the same options.)
2. Open `safari-app/Tab Collections/Tab Collections.xcodeproj` in Xcode, pick the **macOS** scheme and click **Run**. This installs a small host app that carries the extension.
3. In Safari: **Settings → Extensions** → enable **Tab Collections**, and allow it on all websites when asked (needed to read tab URLs and titles).
4. Signing:
   - **Your own Mac, no signing:** Safari **Settings → Advanced → Show features for web developers**, then **Develop → Allow Unsigned Extensions**. Safari resets this each time it quits.
   - **Signed (persists / share with your team):** in Xcode, select both targets → *Signing & Capabilities* → choose your Apple Developer team. To distribute, archive and upload to App Store Connect (App Store or TestFlight), or export a Developer ID–signed, notarized app.

**What's different in Safari**
- Site icons come from each site's `/favicon.ico` (with a globe fallback) instead of Chrome's icon cache.
- If Safari won't open a popup-style window, the "Update collection?" prompt opens as a normal window.
- Things to check: closing a collection window brings up the prompt; **Export** downloads a file (Safari may show it in the Downloads list rather than saving it straight away).

## Rebuilding from source
```sh
npm install          # installs esbuild
npm run build        # all targets → dist/
node build.mjs safari   # or a single target: chromium | firefox | safari
```
- `src/` is the single shared source. Every file uses `api` (= `browser` in Firefox/Safari, `chrome` in Chromium).
- `build.mjs` writes a manifest for each browser and bundles `background.js` into one classic script. Safari doesn't support module service workers, and Firefox uses event pages instead of service workers.

## Vivaldi workspaces
- **Collections page → From Vivaldi workspaces…** lists the workspaces that have open tabs. Tick the ones you want, name each one, then click **Create collections**.
- **Toolbar popup** in Vivaldi: **Save** captures only the current workspace's tabs (not every tab in the window), when Vivaldi exposes the workspace field described below.
- Vivaldi has no official workspaces API. This uses a hidden per-tab field (`vivExtData.workspaceId`) that Vivaldi has exposed in many versions. Workspace names aren't available, so each collection gets a suggested name (its main sites) that you can edit.
- If your Vivaldi version doesn't expose that field, the button stays hidden, and extensions can't tell which workspace a tab is in. The popup's **Save** then covers the tabs of every workspace in the window, and its tab count includes them all (for example, "Save this window's 44 tabs" when the current workspace shows only 3). To save one workspace, open it, select its tabs (click the first tab, Shift-click the last), then use the popup's **Save**. It saves just the selected tabs. This works in every browser.

## Using it
- **Toolbar popup:** open a collection, go to *Manage*, or save tabs as a collection: the selected tabs if you've selected several, otherwise the whole window.
- **Collections page:** a table of collections with description and page count; create, open, delete, import, export.
- **Collection page:** edit the name, description and pages (add, remove, reorder, edit), then Save (Ctrl/Cmd+S).
- **Open a collection:** a new window with one tab per page. If it's already open, that window is focused instead.
- **Close the window:** if the tabs changed, you're asked to **Update**, **Keep unchanged**, or **Save as new**. Redirects during the first page load and empty new-tab pages don't count as changes. Closing the prompt without choosing, or switching to another window (which closes it), counts as **Keep unchanged**, and so does a window that closes without a prompt, such as when the browser quits.
- **Settings** (on the Collections page, also the extension's Options page): *Default behaviour when closing a window which has drifted from its collection* picks which prompt button is focused and highlighted, **Update** or **Keep unchanged** (the default).
- **Storage:** everything is kept locally in the browser (`storage.local`). Export/Import JSON files to back up or share. Collections are not synced between browsers, but an export from one browser imports into any other.
