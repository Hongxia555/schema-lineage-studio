#!/bin/bash
# Run the built app in self-test mode: open the reference example, measure the
# render inside the real WebKit engine, snapshot it, Save As, and check it all.
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
  ('title bar shows the file, not dirty',       r.get('windowTitle') == 'dbml_reference.dbml' and r.get('dirty') is False),
  ('Save As wrote an identical file',           s.get('saved') is True and open(f'{out}/saved copy.dbml', encoding='utf-8').read() == src),
  ('title follows Save As, still clean',        s.get('windowTitle') == 'saved copy.dbml' and s.get('dirty') is False),
  ('typing afterwards shows the unsaved dot',   s.get('dirtyAfterTyping') is True and s.get('editedDotShown') is True),
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
