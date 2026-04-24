#!/bin/bash
# ══════════════════════════════════════════════════════════════
# Casca Enterprise Build Script
# Compiles server-v2.js + classifier + path-b into a single binary
# ══════════════════════════════════════════════════════════════

set -e

BUILD_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$(dirname "$BUILD_DIR")"
OUT_DIR="$BUILD_DIR/dist"
STAGE_DIR="$BUILD_DIR/stage"

echo "══════════════════════════════════════"
echo "  Casca Enterprise Build"
echo "══════════════════════════════════════"
echo "  Source:  $SRC_DIR"
echo "  Output:  $OUT_DIR"
echo ""

# ── 1. Clean + Stage ──────────────────────────────────
rm -rf "$STAGE_DIR" "$OUT_DIR"
mkdir -p "$STAGE_DIR" "$OUT_DIR"

echo "[1/5] Staging source files..."
cp "$SRC_DIR/server-v2.js" "$STAGE_DIR/"
cp "$SRC_DIR/casca-classifier.cjs" "$STAGE_DIR/"
cp "$SRC_DIR/casca-path-b.js" "$STAGE_DIR/"
cp "$SRC_DIR/casca-enterprise-api.js" "$STAGE_DIR/"
cp "$SRC_DIR/package.json" "$STAGE_DIR/"

# ── 2. Convert ESM → CJS wrapper ─────────────────────
# pkg requires CommonJS entry point
echo "[2/5] Creating CJS entry point..."
cat > "$STAGE_DIR/entry.cjs" << 'ENTRY'
// CJS entry point for pkg compilation
// Dynamically imports the ESM server-v2.js
async function main() {
  try {
    await import('./server-v2.js');
  } catch (err) {
    console.error('Fatal:', err.message);
    process.exit(1);
  }
}
main();
ENTRY

# ── 3. Install dependencies ──────────────────────────
echo "[3/5] Installing dependencies..."
cd "$STAGE_DIR"
npm install --omit=dev 2>&1 | tail -3

# ── 4. Obfuscate classifier (extra protection) ───────
echo "[4/5] Obfuscating classifier..."
if command -v javascript-obfuscator &> /dev/null; then
  javascript-obfuscator casca-classifier.cjs \
    --output casca-classifier.cjs \
    --compact true \
    --control-flow-flattening true \
    --dead-code-injection true \
    --string-array true \
    --string-array-threshold 0.75 \
    --rename-globals false
  echo "  Obfuscation applied ✓"
else
  echo "  javascript-obfuscator not installed, skipping (install with: npm i -g javascript-obfuscator)"
fi

# ── 5. Compile with pkg ──────────────────────────────
echo "[5/5] Compiling binary..."
pkg entry.cjs \
  --targets node20-linux-x64 \
  --output "$OUT_DIR/casca-engine" \
  --compress GZip \
  2>&1

# ── Results ──────────────────────────────────────────
if [ -f "$OUT_DIR/casca-engine" ]; then
  SIZE=$(du -h "$OUT_DIR/casca-engine" | cut -f1)
  echo ""
  echo "══════════════════════════════════════"
  echo "  ✓ Build successful!"
  echo "  Binary: $OUT_DIR/casca-engine ($SIZE)"
  echo "══════════════════════════════════════"
else
  echo "  ✗ Build failed!"
  exit 1
fi

# ── Cleanup staging ──────────────────────────────────
rm -rf "$STAGE_DIR"
