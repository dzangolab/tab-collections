# Store assets

Images for the extension's store listings (Chrome Web Store first).

## Screenshots

`screenshots/` holds the Chrome Web Store screenshots: 1280×800, 24-bit PNG without transparency, in listing order.

1. `1-collections.png`: the Collections page, with a changed window and the sync status
2. `2-collection.png`: a Collection page
3. `3-prompt.png`: the "Update collection?" prompt
4. `4-popup.png`: the toolbar popup, beside a caption
5. `5-sync.png`: the sync settings

They show demo collections, never real data. To regenerate them after a change to the pages:

```
npm run screenshots
```

This builds the extension, loads it in Playwright's Chromium, and writes the files here (`test/screenshots/store.spec.js`). It visits the demo sites once so their favicons show; without a network, the pages show the globe icon instead.
