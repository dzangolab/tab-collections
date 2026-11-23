# Store assets

The extension's store listing and its images (Chrome Web Store first).

## Listing

`listing.json` holds everything to enter in the Chrome Web Store Developer Dashboard: name, summary, description, category, the images, the privacy answers (single purpose, permission justifications, data usage, certifications) and distribution. The privacy policy is [`PRIVACY.md`](../PRIVACY.md) at the repository root. The homepage, support and privacy policy URLs point to the GitHub repository, which must be public for them to work. The summary must match `description` in the manifest (`build.mjs`).

## Icon

`icon-128.png` is the store icon, following Google's guidelines: 128×128, the artwork 96×96 in the middle with 16 px of transparent space around it. The extension itself keeps the full-size `src/icons/icon128.png`.

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
