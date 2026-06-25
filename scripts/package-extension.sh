#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

VERSION="$(
  node -e "
    const fs = require('fs');
    const path = require('path');
    const rootDir = process.argv[1];
    const manifestPath = path.join(rootDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    process.stdout.write(manifest.version);
  " "$ROOT_DIR"
)"

PACKAGE_NAME="feishu-sheetmate-v${VERSION}"
RELEASE_DIR="${ROOT_DIR}/release"
PACKAGE_DIR="${RELEASE_DIR}/${PACKAGE_NAME}"
ZIP_PATH="${RELEASE_DIR}/${PACKAGE_NAME}.zip"

echo "Packaging extension ${PACKAGE_NAME}..."

rm -rf "$PACKAGE_DIR" "$ZIP_PATH"
mkdir -p "$PACKAGE_DIR"

cp "${ROOT_DIR}/manifest.json" "$PACKAGE_DIR/"
cp -R "${ROOT_DIR}/src" "$PACKAGE_DIR/"
cp -R "${ROOT_DIR}/vendor" "$PACKAGE_DIR/"

(
  cd "$RELEASE_DIR"
  zip -qr "${PACKAGE_NAME}.zip" "${PACKAGE_NAME}"
)

echo "Done."
echo "Folder: ${PACKAGE_DIR}"
echo "Zip: ${ZIP_PATH}"
