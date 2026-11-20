#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP="$HERE/build/Invoice Maker.app"

rm -rf "$HERE/build"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web"

SDK="$(xcrun --sdk macosx --show-sdk-path)"
clang -fobjc-arc -O2 -Wall -Wno-deprecated-declarations \
  -mmacosx-version-min=13.0 -isysroot "$SDK" \
  -framework Cocoa -framework WebKit -framework UniformTypeIdentifiers -framework PDFKit \
  -o "$APP/Contents/MacOS/InvoiceMaker" "$HERE/main.m"

cp "$ROOT/index.html" "$ROOT/styles.css" "$ROOT/app.js" "$ROOT/xlsx.js" "$APP/Contents/Resources/web/"
mkdir -p "$APP/Contents/Resources/web/vendor"
cp "$ROOT/vendor/html2canvas.min.js" "$APP/Contents/Resources/web/vendor/"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
cp "$HERE/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

xattr -cr "$APP"
codesign --force --sign - --identifier com.example.invoicemaker "$APP"
echo "Built: $APP"
