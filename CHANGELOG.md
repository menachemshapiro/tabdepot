# Changelog

All notable changes to TabDepot (called Tab Stash before 2.1.3). Format based on [Keep a Changelog](https://keepachangelog.com/),
versions follow [Semantic Versioning](https://semver.org/) (MAJOR.MINOR.PATCH).

## [2.1.3] - 2026-11-08
### Changed
- **Renamed to TabDepot.** The old name, Tab Stash, was already used by another extension that does something very similar (the Tab Stash add-on for Firefox by Josh Berry), so the name changed to avoid confusion. New tagline: *Store tabs. Clear space. Find them anytime.* The name changes in the toolbar, popup, stash page, menus and messages.
- New backup and export files are named `tabdepot-…`. Old `tab-stash` backups still import.
### Notes
- Nothing else changes: your stash, settings, extension ID and stash address stay the same. The release zip is still called `tab-stash-X.Y.Z.zip` for now so earlier versions can still update to this one; the updater accepts both names.
- Your extension folder keeps whatever name it has (for example `~/tab-stash`); you can rename it later, but then pick it again once in the update dialog.

## [2.1.2] - 2026-11-07
### Added
- A stash page that is still open after an update now notices that it is running old code and shows a banner with **Reload this page**. If new files are in the folder but the extension has not been reloaded yet, the banner offers **Reload extension** instead. (An old page can otherwise keep behaving like the previous version.)

## [2.1.1] - 2026-11-07
### Fixed
- Dragging several selected cards onto a group moves all of them. Before, only cards from the section you dragged from left their group; selected cards from other sections stayed where they were, so it looked like a copy.
- All "move" actions now share one code path (menu, selection bar, drag). Hold Ctrl/Alt while dragging, or use **Add to…**, to copy instead.

## [2.1.0] - 2026-11-07
### Added
- **Update from inside the extension.** The stash page checks GitHub for a newer release (at most every 6 hours; can be turned off in Settings) and shows a banner. **Update now** downloads the release zip, writes the files into the extension folder and reloads the extension. The first time you pick the Tab Stash folder in a folder dialog (browsers do not let an extension overwrite its own files otherwise); the choice is remembered.
- The previous files are saved in `previous-version/` inside the folder, and Settings → **Restore previous version** puts them back. The "open in every new tab" setting is kept across updates.
- Settings → **Check for updates**.
### Notes
- If your browser cannot write to the folder, or you prefer the terminal, `update.sh` still works exactly as before.

## [2.0.1] - 2026-11-07
### Fixed
- **Move to…** really moves now: the tabs leave their other groups. (In 2.0.0 the menu only added them to the chosen group, so it behaved like a copy.)
### Added
- **Add to…** (selection bar, card menu, key `a`) adds tabs to another group while keeping their current groups. Dragging still moves; hold Ctrl/Alt to add instead.

## [2.0.0] - 2026-11-07
A big release: the stash page was rebuilt. Your existing stash is migrated automatically (take a backup first if you like: ⋯ → Back up stash to a file…).
### Added
- **Subgroups.** Groups can contain groups (Alpha → Alpha One, Alpha Two …), shown as a tree in the side panel and as nested sections in the main panel.
- **A tab can be in several groups.** Cards show an "Also in …" line; **Groups…** (selection bar, card menu, `g`) has tick boxes for adding and removing groups for many tabs at once.
- **Choose per click whether a tab stays in the stash.** Hover buttons *Open and remove* / *Open and keep*, Alt-click does the opposite of your setting, and a new setting can ask every time.
- **Drag and drop.** Drag cards onto a group (hold Ctrl/Alt to add instead of move), drag groups to reorder or nest them, drag cards inside a group to put them in your own order (*Manual* sort).
- **Undo** for moves, group changes, notes, edits, deletes, reordering and duplicate merging (Ctrl+Z or the Undo link). Each undo only reverts its own change.
- **Keyboard navigation:** arrows move between cards, Enter opens, `x`/Space selects, `m` move, `g` groups, `n` note, `e` edit, Delete, `t` triage, `/` search, `?` for the list.
- **Triage mode:** go through tabs one at a time (keep, delete, open, add to group 1–9, note, undo).
- **Filters** by site, age ("more than 30 days ago"), "has a note" and link status; **Select ▾** has *select all matching this search*, *select all shown* and *invert selection*. Notes can be added to many tabs at once.
- **Link checker** (⋯ menu): finds dead pages (404/410, removed YouTube videos) without opening them, marks restricted and unreachable ones, and tells you if you are offline instead of marking everything dead.
- **Automatic safety snapshots:** the stash is copied after changes and before risky actions (bulk delete, import, merge); the list of open tabs is saved every few minutes and when a window closes. *Safety snapshots…* restores or merges them.
- **Automatic backup to a file** you choose (for example on your Desktop), kept up to date while a stash page is open.
- **Smarter duplicates:** tracking parameters, `www.`, trailing slashes, `youtu.be` vs `youtube.com/watch` and similar variants count as the same link; *Merge duplicate links* combines their groups and notes. The tab picker marks tabs that are already stashed.
- **If Tab Stash is open in more than one tab** you now get a notice (with *Go there* / *Close the others*), and the pages stay in sync.
- **Open Tab Stash in every new tab** (opt-in): `bash newtab.sh on` (and `off`); `update.sh` keeps it across updates.
### Changed
- The pencil for renaming a group now sits right next to the group name, in the side panel and in the main panel.
- Group "Delete" keeps the tabs (they stay in the stash and in their other groups); subgroups move up one level.
- Backup files are now version 3 (groups with parents, several groups per tab, manual order). Older backup files still import.
### Fixed
- Thumbnails for YouTube channel pages such as `https://www.youtube.com/@Name/videos` and `/featured`: the channel ID is found with more patterns and from a streamed read of the page, with a fallback that asks YouTube to resolve the address. Use *Diagnose thumbnail…* on a card if one still does not work.

## [1.2.2] - 2026-11-06
### Changed
- The selection bar (Restore / Move to… / Delete …) now sits directly under the header instead of floating at the bottom, so it never covers cards.
### Fixed
- Placeholder tiles for pages without a thumbnail were always grey; they now get a colour per site as intended.

## [1.2.1] - 2026-11-06
### Fixed
- YouTube **channel and playlist pages** now get thumbnails: the page is read from the web, and if it has no usable preview image, YouTube's RSS feed supplies the newest video's thumbnail (and "Latest: …" as the description).
- Preview-image tags remembered from open YouTube tabs are ignored (YouTube is a single-page app, so they are often stale or from another page).
- Pages with very large `<head>` sections (such as YouTube) are read further before giving up.
### Added
- **Diagnose thumbnail…** in a card's ⋯ menu: shows step by step what was fetched and why a thumbnail was or wasn't found.

## [1.2.0] - 2026-11-06
### Added
- **Instant stashing.** Tabs are no longer switched to for screenshots, so stashing 25 tabs takes a fraction of a second and nothing starts playing.
- **Background thumbnails.** After stashing, thumbnails are fetched from the web without touching any tab: YouTube thumbnails (and the real title and channel) come from the video ID, other pages use their own preview image. Thumbnails are stored locally.
- The tab you are looking at gets a real screenshot instantly.
- Progress shown in the stash page header; **Fetch missing thumbnails now** (⋯ menu) and **Refresh thumbnail** (card menu).
### Changed
- Visiting tabs to screenshot them is now an opt-in setting (off by default); it never visits YouTube or playing tabs.
- Tabs that were never loaded (restored but unloaded) are no longer scraped or screenshotted.

## [1.1.0] - 2026-11-06
### Added
- **Choose tabs to stash**: list every open tab across all windows, filter, multi-select, pick a group and stash in one go (toolbar popup and stash page).
- **Back up to a file / restore from a file**: Save and Open dialogs start at your Desktop; backups include groups, notes and thumbnails. Back up a selection or a single group.
- **Home page helper** in Settings: copy the stash address and jump to the browser's start-up / home-button settings.
- **Versioning**: version and "What's new" in Settings, one-click "Reload extension", update notice after an update, `update.sh` / `release.sh` scripts.
- Pinned extension ID, so the stash address (and your saved data) stay the same wherever the folder lives.
### Changed
- Minimum browser version lowered from 121 to 110.
- Selection bar no longer wraps its labels.

## [1.0.0] - 2026-11-06
### Added
- Stash tabs (current, window, all windows, left/right, selected, by site, links via right-click) into a memory-free stash page.
- Thumbnail grid with title and description, groups with colours, search, sorting, notes, drag and drop.
- Restore as tabs, as a Chrome tab group, or in a new window; lazy loading of restored tabs.
- Delete with undo, duplicate removal, Markdown/JSON export and import.
- Optional auto-stash of tabs idle for N days, badge with stash count, keyboard shortcuts.
