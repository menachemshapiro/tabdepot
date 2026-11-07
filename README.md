# Tab Stash

> Chrome plugin. A way to get my tabs out of my browser, saving processing power and memory, while still having them easily accessible and searchable

Move open tabs into a visual stash page. Stashed tabs are **closed**, so they use no memory and no CPU. Come back to the stash to search, group and reopen them.

Works in Chrome, Edge, Brave, Opera, Vivaldi and other Chromium browsers (Chrome 121+).

## Install

1. Unzip this folder somewhere permanent (the browser reads it from there).
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Turn on **Developer mode**, click **Load unpacked**, pick the `tab-stash` folder.
4. Pin the extension to the toolbar. The stash page opens automatically the first time.

## Updating to a newer version

Your stash lives in the browser, not in the folder, so updating never touches it. The extension ID is pinned in the manifest (`ogjhcebbpelgnmhcdipnaknjfmlpfhof`), so it stays the same wherever the folder is, and so does the stash address you use as a home page.

1. Download the new `tab-stash.zip`.
2. In a terminal: `~/tab-stash/update.sh ~/Downloads/tab-stash.zip`
   (shows old → new version, saves the previous version to `~/tab-stash-backups/`, replaces the files; refuses to downgrade unless you set `FORCE=1`).
3. Stash page → ⋯ → Settings → **Reload extension** (or the reload arrow on `chrome://extensions`).

After reloading you get a one-time "updated 1.0.0 → 1.1.0" notice with a **What's new** link. Version and changelog are always available under Settings. Full history: `CHANGELOG.md`.

Maintainers: `./release.sh 1.2.0` (after adding a `## [1.2.0]` entry to `CHANGELOG.md`) bumps the manifest and builds `dist/tab-stash-1.2.0.zip`. Versions follow semantic versioning.

## Stashing tabs

Toolbar button, right-click menus and shortcuts:

| Action | How |
|---|---|
| Stash the current tab | Toolbar → *Stash this tab*, or **Alt+Shift+S**, or right-click page → *Stash this tab* |
| Stash the whole window / everything | Toolbar → *Stash all tabs in this window* / *every tab in every window* |
| Stash all except this one, left, right, selected | Toolbar |
| Stash every tab from one site | Toolbar → *Stash all tabs from …* |
| Stash a link without opening it | Right-click a link → *Stash this link* |
| Send straight into a group | Toolbar → *Send to* dropdown |
| Auto-stash idle tabs | Stash page → ⋯ → Settings → *Auto-stash tabs unused for N days* |
| Open the stash | Toolbar → *Open stash*, or **Alt+Shift+O** |

Pinned tabs are skipped by default (changeable in Settings). Chrome tab groups are carried over as stash groups with the same name and colour.

## Choosing tabs, backups, home page

- **Choose tabs to stash…** (toolbar popup, or *Stash tabs ▾* on the stash page) lists every open tab in every window. Filter, tick any number (Shift-click for a range), pick a group, and stash them in one go.
- **Back up / restore**: stash page → ⋯ → *Back up stash to a file…* opens a Save dialog that starts at your Desktop. The backup includes groups, notes and thumbnails. *Restore from a backup file…* merges a backup back in (links already in your stash are skipped). You can also back up just a selection or one group.
- **Home page**: browsers don't let extensions change this. Settings (⋯ → Settings) shows the address to paste into *On startup → Open a specific page* and *Appearance → Home button*, with shortcuts to those settings pages.
- **Snap Chromium**: keep the extension folder somewhere visible in your home directory (for example `~/tab-stash`); snap-confined browsers can't read hidden folders or `/tmp`.

## The stash page

- **Large thumbnails** with favicon, site, title, description and the time stashed. Drag the slider for card size.
- **Click a card** to reopen it (and remove it from the stash). **Middle-click** opens it in the background. In selection mode, click toggles selection.
- **Select** with the checkbox (Shift-click for a range), Ctrl/⌘+A, or a section's *Select* button, then use the bar at the bottom:
  Restore · Restore as a Chrome tab group · Restore in a new window · Move to… · Copy links · Delete.
- **Groups**: create, rename, recolour, collapse, delete. Drag cards onto a group in the sidebar. *Group by site* builds a group for every site with 2+ tabs.
- **Search** (press `/`) across title, URL, description, your notes and group names. Sort by newest, oldest, title or site.
- **Edit** a card's title, add a note ("why did I keep this?"), or change its group (⋯ menu on the card).
- **Delete** has a 9-second Undo. `Delete` key deletes the selection.
- **Remove duplicates**, **Export** (JSON backup or Markdown), **Import** (JSON backup, or any text with links).
- Light and dark theme follow your system.

## How it keeps memory low

- Stashed tabs don't exist as tabs. They are just rows of text plus a small JPEG (≈30-50 KB).
- Thumbnails load lazily as you scroll, so a 1,000-tab stash page stays light.
- Restoring more than 3 tabs at once loads only the first; the others stay *unloaded* (like Chrome's Memory Saver) until you click them. Turn this off in Settings if you prefer.

## Thumbnails: how they are made

Stashing is instant and never switches tabs (so nothing starts playing). Thumbnails come from, in order:

1. A screenshot of the tab you are looking at when you stash, or one from the small rolling cache the extension keeps as you browse.
2. After stashing, in the background: for **YouTube** the video's official thumbnail (plus its real title and channel); for **other pages** their own preview image (`og:image`), read straight from the web without opening the tab. Images are stored locally.
3. Otherwise a coloured tile with the site's initial. Use ⋯ → *Fetch missing thumbnails now*, or *Refresh thumbnail* on a card, to try again (failed pages are retried automatically after a week).

Settings let you turn off background fetching, or enable the old slow method of visiting tabs to screenshot them.

## Privacy

Everything is stored locally in your browser (`chrome.storage.local` + IndexedDB) and there is no server or account. The one outgoing traffic is thumbnail fetching: after you stash a tab, the extension requests that page (or YouTube's thumbnail and oEmbed endpoints) once, without cookies or a referrer, to read its preview image. Turn it off in Settings if you prefer.

## Permissions

- `tabs`, `tabGroups`: list, close, reopen and group tabs.
- `scripting` + all sites: read each page's description/preview image when stashing, and screenshot tabs.
- `storage`, `unlimitedStorage`: keep your stash.
- `favicon`: show site icons from the browser's own cache.
- `contextMenus`, `alarms`: right-click items, and the idle-tab auto-stash check.
