# 1. Sync collections through storage the user owns

- **Status:** Accepted (implemented in PR #28)
- **Date:** 2026-11-23

## Context

All of Tab Collections' data lives in the browser's local extension storage (`api.storage.local`), on one device. Users want two things:

- **Sharing:** their collections are shared between browsers and devices, including Vivaldi on their phone. Vivaldi for Android has supported extensions since version 8.2.
- **Automatic saving:** changes are saved automatically, so a change in one browser shows up in all the others.

Today the only way to move collections is Export and Import: a file has to be carried to each device by hand and kept in sync in both directions.

Our users are privacy-conscious. They know that a service holding their collections can mine that data and sell it. A hosted Tab Collections sync service may come later, but the first answer must not ask users to trust anyone with their data, including us and their browser vendor.

Password managers show the two models:

- **KeePassXC:** your passwords are one encrypted file, kept wherever you choose. KeePassXC doesn't sync anything itself: the file sits in Dropbox, Nextcloud, Syncthing or similar. When the file changes under an open database, KeePassXC merges entry by entry. Mobile apps open the same file through WebDAV or the cloud provider.
- **Bitwarden:** a hosted vault, but encrypted on the device, so the server stores only ciphertext. It can also be self-hosted (Vaultwarden).

## Decision drivers

- **Privacy:** no third party, including us, needs to be able to read the collections.
- **User-owned storage:** the user decides where the data lives.
- **Reach:** works in every browser the extension supports (Chromium browsers, Firefox, Safari), on desktop and on Android.
- **No browser sync service:** not Vivaldi Sync, Chrome Sync or Firefox Sync. Each one only reaches the same browser, and each one hands the data to the browser vendor.
- **Room to grow:** a hosted service of ours can be added later without redesigning sync.
- **Never lose an edit:** a change made on one device is never silently overwritten by a change from another.

## Considered options

### Browser sync (`storage.sync`)
- Good: built in; no setup or server.
- Bad: the data goes to the browser vendor.
- Bad: it only reaches the same browser (Vivaldi never shares with Chrome or Firefox).
- Bad: about 100 KB in total.
- **Rejected** by the privacy and no-browser-sync drivers.

### A hosted Tab Collections service
- Good: the simplest setup for users.
- Bad: we have to run, pay for and secure it.
- Bad: users have to trust us.
- **Deferred.** It can become another storage backend later (see Decision), with the same end-to-end encryption.

### A file on the user's computer (File System Access API)
- Good: the KeePassXC model exactly.
- Bad: an extension can't keep a local file in sync in the background, and the API doesn't exist on Android or in Firefox.
- **Rejected.**

### Raw git over HTTP (isomorphic-git)
- Good: works with any git server.
- Bad: a large library, and cloning and pushing whole repos from an extension, for no gain over the git hosts' APIs.
- **Rejected.**

### Git host APIs (GitHub, GitLab, Gitea/Forgejo)
- Good: one file in a private repo the user owns, reached over HTTPS with a token restricted to that repo.
- Good: every sync is a commit, so there's full history and old versions can be restored.
- Good: a write names the file version it replaces, so a conflicting write is detected.
- Good: GitLab, Gitea and Forgejo can be self-hosted.
- Bad: one implementation per API.
- **Chosen.**

### WebDAV
- Good: Nextcloud, ownCloud, Synology, Fastmail and others; what KeePass users typically use.
- Good: conflicting writes are detected with ETag / If-Match.
- Bad: no history, except on servers that keep file versions (Nextcloud does).
- **Chosen.**

## Decision

### Storage
A storage interface, `read() → { data, version }` and `write(data, version)`, with four backends:

| Backend | Covers | API |
|---|---|---|
| GitHub | github.com, GitHub Enterprise Server | REST, `<host>/api/v3` for Enterprise |
| GitLab | gitlab.com, self-hosted | REST, `<host>/api/v4` |
| Gitea / Forgejo | self-hosted, Codeberg | REST, `<host>/api/v1` (Forgejo keeps Gitea's API) |
| WebDAV | Nextcloud, ownCloud, Synology, Fastmail… | GET / PUT with ETag and If-Match |

A hosted Tab Collections service, if we build one, becomes a fifth backend.

**Self-hosted servers:** the user enters the server address. The manifest declares `optional_host_permissions: ["https://*/*"]`, and at setup the extension asks for access to that one server (`permissions.request`). It never asks for access to all sites.

**Credentials:** a personal access token restricted to the one repo for the git hosts; an app password for WebDAV. They are kept in `storage.local` on each device and never synced.

### The sync file
- One file, in the same format as Export (`buildExport` in `src/common.js`).
- Each collection keeps its `id` and `updatedAt`.
- A deleted collection leaves a tombstone (`deletedAt`), so another device doesn't bring it back.
- Only collections sync. Open windows, undecided drift and settings stay on each device, because they describe that device.

### Merge
A three-way merge, as in git. Each device keeps the last version it synced: the base. On sync, each collection is compared to the base:

- **Changed on one side only:** that side's version is taken.
- **Changed on both sides, in different parts:** both changes are kept. For example, a rename on one device and a page added on the other gives the renamed collection with the new page, whichever device syncs first.
- **Pages merge one by one, not as a block:**
  - A page added on either side is kept, so page A added on one device and page B on another is not a conflict.
  - A page removed on either side is removed.
- **Changed on both sides, in the same part** (both renamed the collection, or both edited the same page's title or URL): a conflict.
  - The device keeps its own version.
  - It shows a strip on the collection, like the drift strip: "This collection was changed on another device", with **Keep mine**, **Keep theirs** and **Keep both**. Keep both saves the local version as a copy.

Local changes are never erased unless the user chooses to. An edit that hasn't synced yet (for example, after a network error) stays in `storage.local`, marked as not synced, until it goes through. When a write is rejected because the remote file has moved on, the device re-reads it, merges and writes again.

### Encryption
Optional, chosen at setup.

- The file is encrypted on the device with a passphrase (WebCrypto: a key derived with PBKDF2, SHA-256 and 600,000 iterations, then AES-GCM), so the storage server only holds ciphertext. WebCrypto has no Argon2.
- Every device that uses the same sync file needs the same passphrase.
- Without encryption, the file is plain JSON, readable and comparable in the repo.

### When it syncs
- **Sync mode:** a per-device setting with two values. The default is Automatic.
  - **Automatic:** every local change is pushed, a few seconds after the edit.
  - **Manual:** local changes stay on the device until the user clicks Sync.
- **Remote checks, in both modes:** at browser start, every few minutes (`chrome.alarms`), and when Sync is clicked.
  - In Automatic mode, remote changes are merged in.
  - In Manual mode, they are only announced. Clicking Sync pulls, merges and pushes in one go.
- **The Sync button**, in both modes:
  - **Where:** in the Collections page's top bar and in the toolbar popup.
  - **Status:** last synced at, local changes not synced yet, or sync failed.
  - **Why it's there in Automatic mode too:** for retrying after a failure, and for reassurance.
- **"Remote has changed" notice:** a strip at the top of the Collections page, plus a dot badge on the toolbar icon.
- **The closing-window setting** ("Default behaviour when closing a window which has drifted from its collection") is unchanged and not synced. It only picks the focused button. The user's decision is what matters: choosing Update changes the collection, and that change syncs like any other edit.

## Consequences

- **Privacy:** no data reaches us or the browser vendor. With encryption on, not even the storage server can read it.
- **Setup:** each device is set up once: server address, credentials, and the passphrase if encryption is on. That's more work than a hosted service, and on a phone, pasting a token is a chore.
- **Losing the passphrase** means losing access to the synced copy, though each device's local data is unaffected.
- **Speed:** changes from other devices arrive at the next remote check (minutes), not instantly. A git host or WebDAV server can't notify the browser.
- **Code:** four storage backends, a merge with tombstones and conflict handling, encryption, settings and status UI. The merge is the part that needs the most testing.
- **Commits:** each sync on a git host is a commit. Automatic mode batches edits made within a few seconds, so a busy session doesn't flood the repo.
- **Extension:** a new optional host permission, and `alarms` for the periodic check.
- **Later:** a hosted service of ours fits in as another backend, with the same encryption and merge.

## Implementation notes

Choices made while building it, where this record left room:

- **Pages are matched by URL** in the merge. Editing a page's URL counts as removing the old page and adding the new one, so the same URL edited differently on two devices keeps both new pages rather than raising a conflict.
- **An edit beats a deletion:** a collection deleted on one device and edited on another is kept, so no edit is lost.
- **Page order:** the device that reordered its pages wins (this device if both did); pages added on the other device go after the page they followed there.
- **An unresolved conflict stays out of the sync file:** it keeps the other device's version there until the user chooses, so two devices never overwrite each other back and forth.
- **Badge:** the dot also shows while a conflict waits for the user.

## Open questions

None at the time of writing.
