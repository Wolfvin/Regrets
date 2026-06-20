#!/usr/bin/env bash
# verify_csharp.sh — end-to-end verification of C# capture/validate
#
# This script demonstrates the full Regrets workflow for C#:
#   1. Capture: write .regret files from pre-computed outputs
#   2. Validate (PASS): re-validate with the SAME outputs → all PASS
#   3. Validate (FAIL): re-validate with CHANGED outputs → FAIL detected
#   4. Golden file check: validate without --pre-computed → PASS (format OK)
#
# Run: bash examples/csharp/verify_csharp.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
REGRET_DIR="${PROJECT_DIR}/regrets"

echo "═══════════════════════════════════════════════════════════════"
echo "  C# Capture/Validate Verification"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ─── Setup: copy example manifest to regrets/ ─────────────────────────────────
echo "━━━ Setup: Copying example manifest ━━━━━━━━━━━━━━━━━━━━━━━━━"
mkdir -p "$REGRET_DIR"
cp "$SCRIPT_DIR/manifest.json" "$REGRET_DIR/manifest.json"
echo "  Copied: examples/csharp/manifest.json → regrets/manifest.json"
echo ""

# ─── Step 1: Capture ──────────────────────────────────────────────────────────
echo "━━━ Step 1: Capture ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Running: bash scripts/capture_csharp.sh --pre-computed examples/csharp/pre-computed-outputs.json"
echo ""
cd "$PROJECT_DIR"
bash scripts/capture_csharp.sh --pre-computed examples/csharp/pre-computed-outputs.json 2>&1
echo ""

# ─── Step 2: Validate — should PASS (same outputs) ────────────────────────────
echo "━━━ Step 2: Validate (PASS expected) ━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Running: bash scripts/validate_csharp.sh --pre-computed examples/csharp/pre-computed-outputs.json"
echo ""
bash scripts/validate_csharp.sh --pre-computed examples/csharp/pre-computed-outputs.json 2>&1
echo ""

# ─── Step 3: Validate — should FAIL (breaking change) ─────────────────────────
echo "━━━ Step 3: Validate (FAIL expected — breaking change) ━━━━━━"
echo "Simulating: Add(3,4) returns 8 instead of 7 (regression)"
echo ""

# Create breaking outputs
BREAKING_FILE=$(mktemp)
cat > "$BREAKING_FILE" << 'JSON'
{
  "add": [
    { "input": [3, 4], "output": 8 }
  ],
  "format-greeting": [
    { "input": ["World"], "output": "Hello, World!" }
  ]
}
JSON

echo "Running: bash scripts/validate_csharp.sh --pre-computed $BREAKING_FILE"
echo ""
bash scripts/validate_csharp.sh --pre-computed "$BREAKING_FILE" 2>&1 || true
rm -f "$BREAKING_FILE"
echo ""

# ─── Step 4: Golden file check (no re-invocation) ─────────────────────────────
echo "━━━ Step 4: Golden file check (no --pre-computed) ━━━━━━━━━━━━"
echo "Running: bash scripts/validate_csharp.sh"
echo ""
bash scripts/validate_csharp.sh 2>&1
echo ""

# ─── Show .regret files ───────────────────────────────────────────────────────
echo "━━━ Generated .regret files ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
for f in "$REGRET_DIR"/*.regret; do
  echo ""
  echo "── $(basename "$f") ──"
  cat "$f"
done

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Verification complete."
echo "═══════════════════════════════════════════════════════════════"
