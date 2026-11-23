# Privacy policy

*Last updated: 23 November 2026*

This policy covers the Tab Collections browser extension ("the extension"), published by Dzango. In short: the extension keeps your data in your browser, and only sends it to a sync server that you set up yourself. We don't collect, receive or see any of it.

## What the extension stores

The extension stores the following in your browser's local extension storage, on your device:

- **Collections:** the name and description of each collection, and the address and title of each of its pages.
- **Window state:** which window shows which collection, and the tab changes you haven't decided on yet.
- **Settings:** your choices in the extension's settings.
- **Sync settings**, if you turn sync on: the server, repository or file location, your user name (WebDAV), your access token or password, the sync mode and, if you turn encryption on, your passphrase. These are never synced.
- **Sync state**, if you turn sync on: the last synced copy of your collections, used to merge changes, and a record of deleted collections and pages, so that deletions sync too.

This data stays on your device until you delete it, disconnect sync, or uninstall the extension, which removes it.

The extension reads the addresses and titles of the tabs in a collection's window, to save them and to notice when they change. It doesn't read the content of web pages, and it doesn't track your browsing outside of collection windows.

## What the extension sends, and to whom

**Nothing is sent to us.** The extension has no analytics, telemetry, advertising or crash reporting, and it doesn't talk to any server run by Dzango.

**Sync (optional, off by default).** If you turn sync on, the extension sends your collections to the one server you enter at setup: your own repository on GitHub, GitLab, Gitea, Forgejo or Codeberg, or a file on your WebDAV server. It sends your access token or password only to that server, to sign in. The extension asks the browser for access to that server only, and never to other sites.

- If you set a passphrase, your collections are encrypted on your device (AES-GCM, with a key derived from the passphrase by PBKDF2) before they are sent, and the server only stores ciphertext. Without a passphrase, the server stores your collections as readable JSON.
- The data you sync is then held by that service, under its own terms and privacy policy, and is visible to anyone you give access to the repository or file. Use a private repository.

**Page icons.** In Chromium browsers (Chrome, Edge, Brave, Vivaldi, Opera), page icons come from the browser's own icon cache, with no network request. In other browsers, the extension loads each saved page's icon from that page's site (`/favicon.ico`), as visiting the site would.

**Export.** If you export your collections, the file is saved where you choose. It isn't encrypted.

## What we don't do

- We don't sell or transfer your data to anyone.
- We don't use your data for anything other than saving, opening and syncing your collections.
- We don't use your data to determine creditworthiness or for lending purposes.
- The extension doesn't load or run remote code.

## Your control over your data

- Edit or delete collections at any time from the Collections page.
- Turn sync off with **Disconnect** in the settings. This deletes the sync settings, including your access token, from your device. The file on your sync server stays there until you delete it.
- Uninstall the extension to delete everything it stored on your device.

## Children

The extension isn't directed at children and doesn't knowingly collect any personal information from anyone.

## Changes to this policy

If this policy changes, the new version is published at the same address with a new date. The history of changes is in this repository's commit log.

## Contact

Questions about this policy: open an issue at <https://github.com/dzangolab/tab-collections/issues>.
