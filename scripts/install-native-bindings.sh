#!/bin/bash
set -e

# Linux builders (Vercel) can miss these platform-specific optional deps when
# the lockfile was generated on macOS, so install them explicitly.
# Locally (macOS/Windows) npm install already fetched the correct native
# bindings for the host platform, so this script is a no-op.
if [ "$(uname -s)" != "Linux" ]; then
  echo "Non-Linux host ($(uname -s)); skipping Linux native bindings install."
  exit 0
fi

# Find the project root (where package-lock.json is)
ROOT_DIR=$(pwd)
while [ "$ROOT_DIR" != "/" ] && [ ! -f "$ROOT_DIR/package-lock.json" ]; do
  ROOT_DIR=$(dirname "$ROOT_DIR")
done

if [ ! -f "$ROOT_DIR/package-lock.json" ]; then
  echo "Error: Could not find package-lock.json in any parent directory."
  exit 1
fi

echo "Found project root at: $ROOT_DIR"

# Extract versions from package-lock.json
RSPACK_VERSION=$(node -e "const lock=require('$ROOT_DIR/package-lock.json'); console.log(lock.packages['node_modules/@rspack/binding']?.version || '')")
SWC_HTML_VERSION=$(node -e "const lock=require('$ROOT_DIR/package-lock.json'); console.log(lock.packages['node_modules/@swc/html']?.version || '')")

PKGS=""
if [ -n "$RSPACK_VERSION" ]; then
  PKGS="$PKGS @rspack/binding-linux-x64-gnu@${RSPACK_VERSION}"
fi
if [ -n "$SWC_HTML_VERSION" ]; then
  PKGS="$PKGS @swc/html-linux-x64-gnu@${SWC_HTML_VERSION}"
fi

if [ -n "$PKGS" ]; then
  echo "Installing native bindings for Linux: $PKGS"
  npm install --no-save $PKGS
else
  echo "No native bindings to install."
fi
