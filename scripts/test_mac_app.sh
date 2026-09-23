#!/bin/bash
# Run the built app in self-test mode: open the reference example, measure the
# render inside the real WebKit engine, snapshot it, then re-open / Save As / type /
# new tab / Don't Save, and check it all.
#   ./scripts/build_mac.sh && ./scripts/test_mac_app.sh
# (a window appears for ~3 seconds and closes itself)
set -euo pipefail
cd "$(dirname "$0")/.."
APP="dist/Schema Lineage Studio.app"
OUT="$(mktemp -d)"
EXAMPLE="$PWD/examples/dbml_reference.dbml"

SLS_SELFTEST_OPEN="$EXAMPLE" SLS_SELFTEST_REPORT="$OUT/report.json" SLS_SELFTEST_SAVEAS="$OUT/saved copy.dbml" \
  "$APP/Contents/MacOS/Schema Lineage Studio" >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 60); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
kill "$PID" 2>/dev/null && { echo "FAIL app did not finish its self-test"; exit 1; }

python3 - "$OUT" "$EXAMPLE" <<'PY'
import json, sys, os
out, example = sys.argv[1], sys.argv[2]
r = json.load(open(f'{out}/report.json'))
s = json.load(open(f'{out}/report.json.save.json'))
src = open(example, encoding='utf-8').read()
checks = [
  ('page runs inside the app (bridge active)',  r.get('inApp') is True),
  ('dagre bundled and loaded offline',          r.get('dagreLoaded') is True),
  ('bundled fonts loaded',                      {'Inter', 'JetBrains Mono'} <= set(r.get('fontsLoaded', []))),
  ('WebKit supports color-mix (group tint)',    r.get('colorMix') is True),
  ('opened file fully in the editor',           r.get('sourceChars') == len(src)),
  ('parsed clean with project in status',       'ecommerce_analytics (PostgreSQL)' in r.get('status', '') and 'warning' not in r.get('status', '')),
  ('20 tables, 1 sticky, 4 group boxes',        (r.get('tables'), r.get('stickies'), r.get('groupBoxes')) == (20, 1, 4)),
  ('15 relationship + 16 lineage lines',        (r.get('refLines'), r.get('depLines')) == (15, 16)),
  ('rows line up with line endpoints (WebKit)', r.get('misaligned') == []),
  ('file opened in its own tab next to the example', r.get('tabNames') == ['Pipeline example', 'dbml_reference.dbml'] and r.get('activeTab') == 'dbml_reference.dbml'),
  ('title bar shows the active tab, not dirty',  r.get('windowTitle') == 'dbml_reference.dbml' and r.get('dirty') is False),
  ('opening the same file again reuses its tab', s.get('reopen', {}).get('count') == 2),
  ('Save As wrote an identical file',           s.get('saved') is True and open(f'{out}/saved copy.dbml', encoding='utf-8').read() == src),
  ('tab + title follow Save As, still clean',   s['afterSave']['windowTitle'] == 'saved copy.dbml' and 'saved copy.dbml' in s['afterSave']['names'] and s['afterSave']['dirtyDocs'] == 0),
  ('typing afterwards shows the unsaved dot',   s['afterTyping']['anyDirty'] is True and s['afterTyping']['editedDotShown'] is True and s['afterTyping']['dirtyDocs'] == 1),
  ('New tab: named after its Project, 2 unsaved', s['newTab']['count'] == 3 and s['newTab']['windowTitle'] == 'scratch_pad' and s['newTab']['dirtyDocs'] == 2),
  ("Don't Save reverts the file tab, drops the new one", s['discarded']['count'] == 2 and s['discarded']['dirtyDocs'] == 0 and s['discarded']['anyDirty'] is False and s.get('revertedToDisk') is True),
  ('snapshot taken',                            os.path.getsize(f'{out}/report.json.png') > 50_000),
]
fails = 0
for name, ok in checks:
    print(('PASS ' if ok else 'FAIL ') + name)
    fails += not ok
if fails: print(json.dumps(r, indent=1)); print(json.dumps(s))
print(f'\n{len(checks) - fails}/{len(checks)} passed   (snapshot: {out}/report.json.png)')
sys.exit(1 if fails else 0)
PY
