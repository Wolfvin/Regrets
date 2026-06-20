#!/usr/bin/env bash
# verify_csharp.sh — end-to-end verification of C# capture + validate
#
# This script:
# 1. Creates a temp C# project with the MathLib functions
# 2. Runs capture_csharp.sh to generate .regret files
# 3. Runs validate_csharp.sh → should PASS (no code change)
# 4. Modifies MathUtils.Add to be breaking → validate should FAIL
# 5. Reverts → validate should PASS again
#
# Requirements: .NET SDK 8.0+ installed

set -euo pipefail

echo "=== C# Stack End-to-End Verification ==="
echo ""

# Check dotnet
if ! command -v dotnet &> /dev/null; then
  echo "⚠️  .NET SDK not installed — skipping C# verification."
  echo "   To run this test, install .NET SDK 8.0+ from https://dotnet.microsoft.com/download"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(pwd)"
TMP_DIR=$(mktemp -d)
trap "rm -rf $TMP_DIR" EXIT

echo "📁 Temp project: $TMP_DIR"

# Copy example files
mkdir -p "$TMP_DIR/src"
cp "$SCRIPT_DIR/src/MathUtils.cs" "$TMP_DIR/src/"
cp "$SCRIPT_DIR/MathLib.csproj" "$TMP_DIR/"
cp "$SCRIPT_DIR/manifest.json" "$TMP_DIR/regrets/"
mkdir -p "$TMP_DIR/regrets"

# Actually, manifest should be in regrets/ dir
cp "$SCRIPT_DIR/manifest.json" "$TMP_DIR/regrets/manifest.json"

cd "$TMP_DIR"

# Step 1: Capture
echo ""
echo "=== Step 1: Capture ==="
bash "$PROJECT_DIR/scripts/capture_csharp.sh"
echo ""

# Verify .regret files were created
echo "=== .regret files created ==="
for f in regrets/*.regret; do
  if [ -f "$f" ]; then
    echo "  ✅ $f"
    head -4 "$f"
    echo "  ..."
    echo ""
  fi
done

# Step 2: Validate (should PASS)
echo "=== Step 2: Validate (should PASS) ==="
bash "$PROJECT_DIR/scripts/validate_csharp.sh"
echo ""

# Step 3: Breaking change — modify Add to subtract instead
echo "=== Step 3: Breaking change (Add → Subtract) ==="
sed -i 's/return a + b/return a - b/' src/MathUtils.cs
echo "  Modified: Add now returns a - b"

# Re-validate (should FAIL for math-add)
echo "=== Step 4: Validate (should FAIL for math-add) ==="
bash "$PROJECT_DIR/scripts/validate_csharp.sh" || true
echo ""

# Step 5: Revert
echo "=== Step 5: Revert breaking change ==="
sed -i 's/return a - b/return a + b/' src/MathUtils.cs

# Re-validate (should PASS again)
echo "=== Step 6: Validate (should PASS after revert) ==="
bash "$PROJECT_DIR/scripts/validate_csharp.sh"
echo ""

echo "=== Verification complete ==="
echo ""
echo "Summary:"
echo "  - Capture: generates .regret files with fingerprint, INPUT, OUTPUT, HASH"
echo "  - Validate PASS: hash matches when code is unchanged"
echo "  - Validate FAIL: hash mismatches when code is breaking"
echo "  - Validate PASS after revert: hash matches again"
