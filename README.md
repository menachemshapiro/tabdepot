# TabDepot

**Store tabs. Clear space. Find them anytime.**

Your tabs, organized and ready when you need them.

Move open tabs into a visual stash page. Stashed tabs are **closed**, so they use no memory and no CPU. Come back to the stash to search, group and reopen them.

Works in Chrome, Edge, Brave, Opera, Vivaldi and other Chromium browsers (Chrome 110+).

## Install

1. Unzip this folder somewhere permanent (the browser reads it from there).
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Turn on **Developer mode**, click **Load unpacked**, pick the extension folder (the one containing `manifest.json`).
4. Pin the extension to the toolbar. The stash page opens automatically the first time.

## Updating to a newer version

**From inside the extension (2.1+):** a banner on the stash page announces a new release; click **Update now**. The first time, pick your TabDepot folder in the dialog (the one you loaded in `chrome://extensions`, for example `~/tab-stash`). The files are replaced, the old ones are kept in `previous-version/` (Settings → *Restore previous version* undoes it), and the extension reloads itself. Settings → *Check for updates* checks on demand; the automatic check (at most every 6 hours, only asks GitHub for the latest release number) can be switched off there.

**From the terminal (any version):**

Your stash lives in the browser, not in the folder, so updating never touches it. The extension ID is pinned in the manifest (`ogjhcebbpelgnmhcdipnaknjfmlpfhof`), so it stays the same wherever the folder is, and so does the stash address you use as a home page.

1. Download the new `tabdepot-X.Y.Z.zip`.
2. In a terminal: `~/tab-stash/update.sh ~/Downloads/tabdepot-X.Y.Z.zip`
   (shows old → new version, saves the previous version to `~/tab-stash-backups/`, replaces the files; refuses to downgrade unless you set `FORCE=1`).
3. Stash page → ⋯ → Settings → **Reload extension** (or the reload arrow on `chrome://extensions`).

After reloading you get a one-time "updated 1.0.0 → 1.1.0" notice with a **What's new** link. Version and changelog are always available under Settings. Full history: `CHANGELOG.md`.

Maintainers: `./release.sh 1.2.0` (after adding a `## [1.2.0]` entry to `CHANGELOG.md`) bumps the manifest and builds `dist/tabdepot-1.2.0.zip`. Versions follow semantic versioning. Pushing a new manifest version to `main` publishes the GitHub release automatically (tag `v1.2.0`, zip attached, notes taken from the changelog); see `.github/workflows/release.yml`. Pushing a `v*` tag by hand also still works.

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
- **Groups and subgroups.** The side panel shows a tree (arrow to collapse a branch, pencil next to the name to rename / recolour / move a group, right-click for more). The main panel shows the same groups as nested sections. A tab can be in **several groups at once**; it appears in each, with an "Also in …" line.
- **Opening a card.** Clicking follows *Settings → When I click a card* (open and remove / open and keep / ask). Whatever you choose, each card has two hover buttons, *Open and remove* and *Open and keep*, and **Alt-click** does the opposite of the setting. Middle-click opens in the background.
- **Select** with the checkbox (Shift-click for a range), Ctrl/⌘+A, a section's *Select* button, or **Select ▾** (all shown, *all N matching this search*, invert, none). The bar under the header then offers Open ▾ · Move to… · Groups… · Add note… · Delete · More ▾.
- **Drag and drop:** cards onto a group (Ctrl/Alt = also add instead of move); groups up/down to reorder, onto the middle of another group to nest; cards within a group to set your own order (switches sorting to *Manual*).
- **Filters** under the header: site, age, has a note, link status. **Search** (press `/`) covers title, URL, description, notes and group names.
- **Undo**: Ctrl+Z, or the Undo link after a change. **Keyboard:** arrows, Enter, `x`/Space, Delete, `m`, `g`, `n`, `e`, `t`, `?` (full list in ⋯ → Keyboard shortcuts).
- **Triage** (`t` or the button): one tab at a time. → keep, `d` delete, `o` open and remove, Shift+`O` open and keep, `1`–`9` add to that group, `n` note, `u` undo, Esc leave.
- **Link checker** (⋯ → Check all links): marks dead pages (404/410, removed YouTube videos), restricted pages (login or region blocks) and unreachable ones; filter by link status to review them.
- **Duplicates** are recognised even with tracking parameters, `www.` or `youtu.be` links; ⋯ → *Merge duplicate links* combines them (groups and notes are merged).
- If TabDepot is open in **more than one tab**, a notice says so and the pages stay in sync.
- Light and dark theme follow your system.

## Safety nets

- **Safety snapshots** (⋯ → Safety snapshots…): the stash is copied automatically after changes and before risky actions; the list of open tabs is saved every few minutes and whenever a window closes (so a closed window or a crash is recoverable). Restore by *adding back what is missing* or *replacing the stash*. Kept locally in the browser (last 40 stash / 30 tab snapshots); thumbnails are not copied.
- **Automatic backup file**: Settings → Backups → *Choose backup file…* (for example on your Desktop). Kept up to date about a minute after each change while a stash page is open. After a browser restart the browser may ask permission again; a notice with an *Allow* button appears.
- **Undo** covers moves, group changes, notes, deletes, reordering and merges.

## Import, export, reminders

- **Tools menu → Import links from pasted text…** takes anything with links in it (URL lists, emails, Markdown, OneTab's `URL | title`, HTML) and can drop them into a group. **Import links or bookmarks from a file…** also reads browser bookmark files (`.html`).
- **Export as a bookmarks file (HTML)**, **Export links as plain text**, **Export as Markdown** and **Back up stash to a file…** (full backup with thumbnails).
- **Remind me…** (card menu, selection bar, or **r**): a system notification at the time you choose, with *Open the tab* and *Remind me in 1 hour*. Switch notifications off in Settings if you do not want them.
- **Recently deleted** (Settings, off by default) keeps deleted tabs for 30 days.
- Settings → *When I open several tabs at once* picks plain tabs, a Chrome tab group or a new window.

## Help

Everything on screen is explained, with pictures, in the **[help guide](docs/HELP.md)**: the toolbar popup, every menu and button, group and card actions, keyboard shortcuts, triage mode and every setting.

## Open TabDepot in every new tab

Browsers only allow this as a fixed extension setting, so it is opt-in:

```
bash ~/tab-stash/newtab.sh on     # or: off, status
```

then Settings → *Reload extension*. `update.sh` keeps the setting across updates.

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
