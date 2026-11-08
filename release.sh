#!/usr/bin/env bash
# Maintainer script: ./release.sh 1.2.0  -> bumps manifest version, checks the changelog, builds dist/tabdepot-1.2.0.zip
# It also writes dist/tab-stash-1.2.0.zip (same bytes): copies older than 2.1.3 only recognise that name.
set -euo pipefail
V="${1:-}"
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Usage: $0 MAJOR.MINOR.PATCH"; exit 1; }
cd "$(dirname "${BASH_SOURCE[0]}")"
grep -q "^## \[$V\]" CHANGELOG.md || { echo "Add a '## [$V] - $(date +%F)' section to CHANGELOG.md first."; exit 1; }
! grep -q chrome_url_overrides manifest.json || { echo "manifest.json has chrome_url_overrides (newtab.sh on). Run: bash newtab.sh off"; exit 1; }
sed -i -E "s/(\"version\": *\")[^\"]+(\")/\1$V\2/; s/(\"version_name\": *\")[^\"]+(\")/\1$V\2/" manifest.json
mkdir -p dist
rm -f "dist/tabdepot-$V.zip" "dist/tab-stash-$V.zip"
(cd .. && zip -rq "$OLDPWD/dist/tabdepot-$V.zip" "$(basename "$OLDPWD")" -x "*/dist/*" -x "*/.git/*" -x "*/node_modules/*" -x "*/.newtab")
cp "dist/tabdepot-$V.zip" "dist/tab-stash-$V.zip"
echo "Built dist/tabdepot-$V.zip (v$V), plus dist/tab-stash-$V.zip for older updaters"
