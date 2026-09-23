# Schema Lineage Studio

DBML diagrams — ERD + data lineage — in one tool. Reads standard DBML (the same files work on dbdiagram.io) and covers the features dbdiagram gates behind Pro: table groups, Keys-only view, highlight-all, per-group colors, column-level lineage with hover cards.

Two ways to run the same page:

- **Web**: `web/schema_lineage_studio.html`, published as a Claude artifact — https://claude.ai/artifact/DWR7wNgFgZ86E4ATemqevC
- **Mac app** (offline, opens/saves `.dbml` files): built from the same HTML by `scripts/build_mac.sh`

## Layout

```
web/schema_lineage_studio.html   the tool — single source for web and app
web/vendor/                      dagre 0.8.5 + JetBrains Mono / Inter (latin, OFL) for the offline app
mac/main.swift                   native shell: window, File/Edit menus, open/save, unsaved-changes prompts
mac/AppIcon.icns, mac/icon.svg   app icon (icns rendered from the svg)
scripts/build_mac.sh             -> dist/Schema Lineage Studio.app (universal), .zip, .dmg
scripts/test_mac_app.sh          runs the built app in self-test mode (real WebKit)
tests/e2e_test.mjs               88 real-browser checks of the web page (puppeteer)
tests/check_dbml.mjs             is a .dbml valid for dbdiagram.io, and does our parser read it the same?
examples/dbml_reference.dbml     every DBML feature, tagged — the reference for writing files
VERSION                          app version
```

## Mac app

```
./scripts/build_mac.sh && ./scripts/test_mac_app.sh
```

Needs only the Xcode Command Line Tools. Output is ~1 MB, universal (Apple Silicon + Intel), macOS 12+, fully offline.

What the shell adds on top of the page: File → New / Open / Save / Save As (⌘N ⌘O ⌘S ⇧⌘S), the file name in the title bar with the standard unsaved-changes dot, Save / Don't Save / Cancel on close / quit / open, double-click `.dbml` in Finder to open, recent files in the Dock menu, and the Edit menu (without it ⌘C/⌘V/⌘Z don't work in a web view). Links in notes open in the default browser. Right-click → Inspect Element for debugging.

The page talks to the shell through `window.SLS` (`getSource`, `loadSource`, `markSaved`) and posts `ready` / `dirty` messages; in a browser that bridge is inactive. Opening a file resets layout state (dragged positions, hidden/collapsed groups) — those belong to the previous file.

### Installing on another Mac

The app has a free ad-hoc signature, not an Apple Developer ID, so macOS blocks the first launch of a downloaded copy ("Apple could not verify…"). One-time fix, per Mac:

1. Open the `.dmg`, drag the app to Applications.
2. Double-click it once (it gets blocked), then **System Settings → Privacy & Security → "Open Anyway"**.
   Or in Terminal: `xattr -dr com.apple.quarantine "/Applications/Schema Lineage Studio.app"`

A company-managed Mac may forbid unidentified apps outright; the web version works there regardless. Removing the prompt entirely needs an Apple Developer ID ($99/year) + notarization — not set up.

### Releasing a new version

Bump `VERSION`, run the build + both test scripts, then copy `dist/SchemaLineageStudio-<version>.dmg` to `SecondBrain/01_Projects/schema_lineage_tool/mac_app/` (Google Drive syncs it to the other Macs). Republish the web version from `web/schema_lineage_studio.html` to the artifact URL above.

## Tests

```
cd tests && python3 -m http.server 8765 --bind 127.0.0.1 & node e2e_test.mjs /tmp; kill %1   # web: 88 checks
node tests/check_dbml.mjs examples/dbml_reference.dbml                                      # DBML vs official parser
./scripts/test_mac_app.sh                                                                     # app: 14 checks
```

Setup: puppeteer in `~/.datastrata` (shared with the DataStrata pipeline); `@dbml/core` in `~/.schema_lineage_tool` (`mkdir -p ~/.schema_lineage_tool && cd ~/.schema_lineage_tool && npm init -y && npm i @dbml/core`). Both live outside Google Drive so `node_modules` never syncs.

## DBML notes (found by testing against the official parser)

- A long-form `Ref name { ... }` block holds exactly **one** relationship.
- A `Dep` block's edges must all feed the **same downstream table** and be the same level; no edge may repeat anywhere in the file. The docs' own example mixing table- and column-level edges in one block is rejected by the parser.
