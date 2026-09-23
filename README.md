# Schema Lineage Studio

DBML diagrams — ERD + data lineage — in one tool. Reads standard DBML (the same files work on dbdiagram.io) and covers the features dbdiagram gates behind Pro: table groups, Keys-only view, highlight-all, per-group colors, column-level lineage with hover cards.

Two ways to run the same page:

- **Web**: `web/schema_lineage_studio.html`, published as a Claude artifact — https://claude.ai/artifact/DWR7wNgFgZ86E4ATemqevC
- **Mac app** (offline, opens/saves `.dbml` files): built from the same HTML by `scripts/build_mac.sh`

## Layout

```
web/schema_lineage_studio.html   the tool — single source for web and app
web/vendor/                      dagre 0.8.5 + JetBrains Mono / Inter (latin, OFL) for the offline app
mac/main.swift                   native shell: window, File/Edit/Window menus, open/save per tab, unsaved-changes prompts
mac/AppIcon.icns, mac/icon.svg   app icon (icns rendered from the svg)
scripts/build_mac.sh             -> dist/Schema Lineage Studio.app (universal), .zip, .dmg
scripts/test_mac_app.sh          runs the built app in self-test mode (real WebKit)
tests/e2e_test.mjs               106 real-browser checks of the web page (puppeteer)
tests/check_dbml.mjs             is a .dbml valid for dbdiagram.io, and does our parser read it the same?
examples/dbml_reference.dbml     every DBML feature, tagged — the reference for writing files
VERSION                          app version
```

## Tabs and import

Each tab is one DBML document with its own diagram state. **+** opens an empty tab (named after its `Project` once it has one; double-click to rename). **Import .dbml** (or dropping `.dbml` files on the window) opens each file in a new tab. The example buttons open their example in a tab, or jump to it if it's already open. In the browser, all tabs are kept in that browser's localStorage; closing a tab that has text asks first.

## Mac app

```
./scripts/build_mac.sh && ./scripts/test_mac_app.sh
```

Needs only the Xcode Command Line Tools. Output is ~1 MB, universal (Apple Silicon + Intel), macOS 12+, fully offline.

What the shell adds on top of the page: every file opens in its own tab — File → New Tab / Open / Close Tab / Save / Save As (⌘T or ⌘N, ⌘O with multi-select, ⌘W, ⌘S, ⇧⌘S), Show Previous / Next Tab (⇧⌘[ ⇧⌘]), the active tab's file name in the title bar with the unsaved-changes dot, Save / Don't Save / Cancel when closing a tab, Save All / Don't Save / Cancel on close window / quit, double-click `.dbml` in Finder to open (an already-open file jumps to its tab), recent files in the Dock menu, and the Edit menu (without it ⌘C/⌘V/⌘Z don't work in a web view). The page's **Import .dbml** button uses the native picker, so ⌘S writes back to the imported file. Links in notes open in the default browser. Right-click → Inspect Element for debugging.

The page owns the documents: tabs (text, file path, last-saved text, and each tab's layout — dragged positions, hidden/collapsed groups, zoom) live in the page's localStorage and come back on the next launch. The shell reads and writes them through `window.SLS` (`openDocument`, `activeDoc`, `doc`, `dirtyDocs`, `markSaved`, `closeTab`, `closeActiveTab`, `cycleTab`, `showDoc`, `discardUnsaved`); the page posts `ready`, `state` (title / path / unsaved), `saveTab` and `open` messages. In a browser that bridge is inactive.

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
cd tests && python3 -m http.server 8765 --bind 127.0.0.1 & node e2e_test.mjs /tmp; kill %1   # web: 106 checks
node tests/check_dbml.mjs examples/dbml_reference.dbml                                      # DBML vs official parser
./scripts/test_mac_app.sh                                                                     # app: 18 checks
```

Setup: puppeteer in `~/.datastrata` (shared with the DataStrata pipeline); `@dbml/core` in `~/.schema_lineage_tool` (`mkdir -p ~/.schema_lineage_tool && cd ~/.schema_lineage_tool && npm init -y && npm i @dbml/core`). Both live outside Google Drive so `node_modules` never syncs.

## DBML notes (found by testing against the official parser)

- A long-form `Ref name { ... }` block holds exactly **one** relationship.
- A `Dep` block's edges must all feed the **same downstream table** and be the same level; no edge may repeat anywhere in the file. The docs' own example mixing table- and column-level edges in one block is rejected by the parser.

## License

MIT — see `LICENSE` (covers the code and the DBML reference example). Bundled third-party files keep their own licenses, included next to them: dagre (MIT, `web/vendor/LICENSE-dagre.txt`), JetBrains Mono and Inter (SIL Open Font License 1.1, `web/vendor/fonts/`).
