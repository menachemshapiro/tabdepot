#!/usr/bin/env bash
# Update TabDepot in place from a newer zip.
#   ./update.sh ~/Downloads/tabdepot.zip
# Keeps the folder path (so the extension stays "the same" in the browser), saves a
# backup of the old version first, then tells you to click "Reload extension".
set -euo pipefail

ZIP="${1:-}"
[ -n "$ZIP" ] && [ -f "$ZIP" ] || { echo "Usage: $0 path/to/tabdepot.zip"; exit 1; }
command -v unzip >/dev/null || { echo "Please install unzip (sudo apt install unzip)"; exit 1; }

DEST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d "${HOME:-/tmp}/.tab-stash-update.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

unzip -q "$ZIP" -d "$TMP"
SRC="$(find "$TMP" -maxdepth 2 -name manifest.json -printf '%h\n' | head -n1)"
[ -n "$SRC" ] || { echo "No manifest.json found in that zip."; exit 1; }

ver() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1/manifest.json" | head -n1; }
OLD="$(ver "$DEST")"; NEW="$(ver "$SRC")"
echo "Installed: v$OLD"
echo "In zip:    v$NEW"

newest="$(printf '%s\n%s\n' "$OLD" "$NEW" | sort -V | tail -n1)"
if [ "$OLD" = "$NEW" ]; then echo "Same version already installed; nothing to do."; exit 0; fi
if [ "$newest" != "$NEW" ] && [ "${FORCE:-0}" != 1 ]; then
  echo "The zip is OLDER than what is installed. Re-run with FORCE=1 to downgrade."; exit 1
fi

BK="$DEST/../tab-stash-backups"
mkdir -p "$BK"
tar -czf "$BK/tab-stash-v$OLD.tar.gz" -C "$DEST/.." "$(basename "$DEST")"
echo "Saved previous version to $BK/tab-stash-v$OLD.tar.gz"

NEWTAB=0; [ -f "$DEST/.newtab" ] && NEWTAB=1
if command -v rsync >/dev/null; then
  rsync -a --delete --exclude 'update.sh' --exclude '.newtab' "$SRC"/ "$DEST"/
else
  find "$DEST" -mindepth 1 -maxdepth 1 ! -name update.sh ! -name .newtab -exec rm -rf {} +
  cp -a "$SRC"/. "$DEST"/
fi
chmod +x "$DEST/update.sh" "$DEST/newtab.sh" 2>/dev/null || true
if [ "$NEWTAB" = 1 ] && [ -f "$DEST/newtab.sh" ]; then
  bash "$DEST/newtab.sh" on >/dev/null && echo "Kept your \"open TabDepot in new tabs\" setting."
fi

echo
echo "Updated v$OLD -> v$NEW"
echo "Now apply it: open the stash page > menu > Settings > 'Reload extension'"
echo "(or click the reload arrow on chrome://extensions). Your stash is untouched."
