#!/usr/bin/env bash
# Open TabDepot in every new tab (opt-in).
#   bash newtab.sh on       turn it on
#   bash newtab.sh off      turn it off again
#   bash newtab.sh status
# Browsers only allow this through a fixed setting inside the extension's manifest, so this script edits
# manifest.json and leaves a ".newtab" marker; update.sh re-applies it after every update.
# Afterwards, reload the extension (stash page > menu > Settings > Reload extension).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
[ -f manifest.json ] || { echo "manifest.json not found next to this script."; exit 1; }

patch() { # patch on|off
  if command -v python3 >/dev/null; then
    python3 - "$1" <<'PY'
import json, sys
mode = sys.argv[1]
with open('manifest.json') as f:
    m = json.load(f)
if mode == 'on':
    m['chrome_url_overrides'] = {'newtab': 'stash.html'}
else:
    m.pop('chrome_url_overrides', None)
with open('manifest.json', 'w') as f:
    json.dump(m, f, indent=2)
    f.write('\n')
PY
  elif command -v node >/dev/null; then
    node -e "
      const fs=require('fs');const m=JSON.parse(fs.readFileSync('manifest.json','utf8'));
      if(process.argv[1]==='on') m.chrome_url_overrides={newtab:'stash.html'}; else delete m.chrome_url_overrides;
      fs.writeFileSync('manifest.json', JSON.stringify(m,null,2)+'\n');" "$1"
  else
    echo "Needs python3 or node to edit manifest.json."; exit 1
  fi
}

case "${1:-status}" in
  on)  patch on;  touch .newtab; echo "New-tab page: ON. Now reload the extension (Settings > Reload extension)."
       echo "Note: Chrome may show a one-time \"extension changed your new tab page\" notice. Choose Keep it." ;;
  off) patch off; rm -f .newtab;  echo "New-tab page: OFF. Now reload the extension." ;;
  status) if grep -q '"newtab"' manifest.json; then echo "New-tab page: ON"; else echo "New-tab page: OFF"; fi ;;
  *) echo "Usage: bash newtab.sh on|off|status"; exit 1 ;;
esac
