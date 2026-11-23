# Store assets

Images for the extension's store listings (Chrome Web Store first).

## Screenshots

`screenshots/` holds the Chrome Web Store screenshots: 1280×800, 24-bit PNG without transparency, in listing order.

1. `1-collections.png`: the Collections page, with a changed window and the sync status
2. `2-collection.png`: a Collection page
3. `3-prompt.png`: the "Update collection?" prompt
4. `4-popup.png`: the toolbar popup, beside a caption
5. `5-sync.png`: the sync settings

## Promo tiles

`promo/` holds the Chrome Web Store promo tiles, also 24-bit PNG without transparency:

- `small-440x280.png`: the small promo tile (needed for the listing to be featured)
- `marquee-1400x560.png`: the marquee promo tile (used if the extension is featured at the top of the store)

## Regenerating

The screenshots and tiles show demo collections, never real data. To regenerate them after a change to the pages:

```
npm run screenshots
```

This builds the extension, loads it in Playwright's Chromium, and writes the screenshots and tiles here (`test/screenshots/store.spec.js`). It visits the demo sites once so their favicons show; without a network, the pages show the globe icon instead.
