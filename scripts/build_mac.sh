#!/bin/bash
# Build "Schema Lineage Studio.app" (universal: Apple Silicon + Intel) plus a .dmg and .zip.
#   ./scripts/build_mac.sh
# Needs only the Xcode Command Line Tools (swiftc, lipo, codesign, hdiutil).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
VERSION="$(cat VERSION)"
NAME="Schema Lineage Studio"
BUNDLE_ID="com.hongxia.schemalineagestudio"
BUILD="$ROOT/build"
DIST="$ROOT/dist"
APP="$DIST/$NAME.app"

rm -rf "$BUILD" "$APP"
mkdir -p "$BUILD/web" "$DIST"

# --- 1. offline web bundle: same page, CDN / Google Fonts swapped for bundled copies
python3 - "$ROOT/web/schema_lineage_studio.html" "$BUILD/web/index.html" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
h = open(src, encoding='utf-8').read()
swaps = {
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n': '',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap">':
        '<link rel="stylesheet" href="vendor/fonts/fonts.css">',
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/dagre/0.8.5/dagre.min.js"></script>':
        '<script src="vendor/dagre.min.js"></script>',
}
for a, b in swaps.items():
    if a not in h:
        sys.exit(f'build: expected tag not found in page, update build_mac.sh: {a[:60]}')
    h = h.replace(a, b)
if 'https://' in h.split('<style>')[0]:
    sys.exit('build: page still loads something from the network before <style>')
# the artifact host normally adds the document skeleton; the app has to add its own
head_end = h.index('<style>')
page = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        + h[:head_end] + '</head>\n<body>\n' + h[head_end:] + '\n</body>\n</html>\n')
open(dst, 'w', encoding='utf-8').write(page)
PY
cp -R "$ROOT/web/vendor" "$BUILD/web/vendor"

# --- 2. compile both architectures, merge into one universal binary
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos12.0" -o "$BUILD/app-$arch" "$ROOT/mac/main.swift"
done
lipo -create -output "$BUILD/app" "$BUILD/app-arm64" "$BUILD/app-x86_64"

# --- 3. assemble the .app bundle
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD/app" "$APP/Contents/MacOS/$NAME"
cp -R "$BUILD/web" "$APP/Contents/Resources/web"
cp "$ROOT/mac/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleExecutable</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>DBML diagrams + data lineage, offline.</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>UTExportedTypeDeclarations</key>
  <array>
    <dict>
      <key>UTTypeIdentifier</key><string>$BUNDLE_ID.dbml</string>
      <key>UTTypeDescription</key><string>DBML schema</string>
      <key>UTTypeConformsTo</key><array><string>public.plain-text</string></array>
      <key>UTTypeTagSpecification</key>
      <dict><key>public.filename-extension</key><array><string>dbml</string></array></dict>
    </dict>
  </array>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>DBML schema</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Owner</string>
      <key>LSItemContentTypes</key><array><string>$BUNDLE_ID.dbml</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST

# --- 4. ad-hoc signature (free; required for Apple Silicon to run it at all)
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

# --- 5. packages: .zip (keeps the signature) and a drag-to-Applications .dmg
rm -f "$DIST"/*.zip "$DIST"/*.dmg
ditto -c -k --keepParent "$APP" "$DIST/SchemaLineageStudio-$VERSION.zip"
STAGE="$BUILD/dmg"; mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "$NAME" -srcfolder "$STAGE" -ov -format UDZO "$DIST/SchemaLineageStudio-$VERSION.dmg"

echo "built: $APP"
lipo -info "$APP/Contents/MacOS/$NAME"
du -sh "$APP" "$DIST"/*.zip "$DIST"/*.dmg
