# Tab Collections (Chrome extension, Manifest V3)

## Install
1. Unzip this folder.
2. Open `chrome://extensions`, turn on **Developer mode**.
3. Click **Load unpacked** and select the `tab-collections` folder.

## Use
- **Toolbar popup**: open any collection with one click, jump to *Manage*, or save the current window's tabs as a new collection.
- **Collections page** (Manage, or the extension's Options): a table with name, description and page count. Open, delete, create, import and export collections here.
- **Collection page** (click a row): edit the name, description and the list of pages (add, remove, reorder, edit titles/URLs), then Save (Ctrl/Cmd+S).
- **Opening a collection** creates a new window with one tab per page. If that collection is already open, its window is focused instead.
- **Closing the window** closes its tabs. The collection stays saved. If the tabs differ from the collection, a small window asks you to **Update collection**, **Keep unchanged**, or **Save as new collection**.
  - Redirects that happen while pages first load (e.g. http→https, login bounces) don't count as changes.
  - Empty New Tab pages are ignored.
  - If you dismiss the prompt, the toolbar badge and a banner on the Collections page let you review it later.

## Storage
Everything is stored in `chrome.storage.local`, in this browser only. **Export all** (or **Export** on one collection) downloads a JSON file you can keep as a backup or share; **Import** loads one (collections with the same id get replaced, after you confirm).

## Files
- `background.js`: service worker. Opens collection windows, tracks their tabs, and detects changes when a window closes.
- `common.js`: storage, URL, diff and import/export helpers.
- `collections.*`: list page · `collection.*`: detail/editor · `popup.*`: toolbar popup · `prompt.*`: "update collection?" dialog.
