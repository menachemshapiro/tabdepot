# Changelog

All notable changes to Tab Stash. Format based on [Keep a Changelog](https://keepachangelog.com/),
versions follow [Semantic Versioning](https://semver.org/) (MAJOR.MINOR.PATCH).

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
