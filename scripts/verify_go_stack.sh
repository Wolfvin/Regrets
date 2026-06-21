#!/usr/bin/env bash
# verify_go_stack.sh — end-to-end verification of the Go stack support
# Creates a temporary Go project, runs capture, validate PASS, breaking FAIL,
# valid refactor PASS, and cross-stack fingerprint parity.
#
# Usage: bash scripts/verify_go_stack.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

if ! command -v go &> /dev/null; then
  echo "⚠️  Go is not installed. Cannot run Go stack verification."
  exit 0
fi

# Create temporary project
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "╔══════════════════════════════════════════════════════════════════════╗"
echo "║  Go Stack Verification — capture + validate end-to-end              ║"
echo "╚══════════════════════════════════════════════════════════════════════╝"
echo ""

# Set up Go module
mkdir -p "$TMPDIR/math" "$TMPDIR/regrets"
cat > "$TMPDIR/go.mod" << 'EOF'
module github.com/regrets/verify-go

go 1.24
EOF

cat > "$TMPDIR/math/math.go" << 'EOF'
package math

// Add returns the sum of two integers.
func Add(a, b int) int {
	return a + b
}

// ReverseString returns the input string reversed.
func ReverseString(s string) string {
	runes := []rune(s)
	for i, j := 0, len(runes)-1; i < j; i, j = i+1, j-1 {
		runes[i], runes[j] = runes[j], runes[i]
	}
	return string(runes)
}
EOF

cat > "$TMPDIR/regrets/manifest.json" << 'EOF'
{
  "clusters": [
    {
      "id": "add",
      "entry": "Add",
      "file": "math/math.go",
      "stack": "go",
      "goPackage": "github.com/regrets/verify-go/math",
      "fingerprintLevel": "entry",
      "multiArgs": true,
      "inputs": [[1, 2], [10, 20], [-5, 5]]
    },
    {
      "id": "reverse-string",
      "entry": "ReverseString",
      "file": "math/math.go",
      "stack": "go",
      "goPackage": "github.com/regrets/verify-go/math",
      "fingerprintLevel": "entry",
      "inputs": ["hello", "world"]
    }
  ]
}
EOF

cd "$TMPDIR"

# ─── Step 1: Capture ─────────────────────────────────────────────────────────
echo "━━━ Step 1: Capture ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
bash "$SKILL_DIR/scripts/capture_go.sh" capture 2>&1

if [ ! -f "regrets/add.regret" ] || [ ! -f "regrets/reverse-string.regret" ]; then
  echo "❌ Step 1 FAILED — .regret files not created"
  exit 1
fi

ADD_HASH=$(grep '^fingerprint:' regrets/add.regret | awk '{print $2}')
REV_HASH=$(grep '^fingerprint:' regrets/reverse-string.regret | awk '{print $2}')
echo "  ✅ add captured: $ADD_HASH"
echo "  ✅ reverse-string captured: $REV_HASH"
echo ""

# ─── Step 2: Validate (no change — expect PASS) ──────────────────────────────
echo "━━━ Step 2: Validate (no code change — expect PASS) ━━━━━━━━━━━━━━━"
if bash "$SKILL_DIR/scripts/capture_go.sh" validate 2>&1; then
  echo "  ✅ Step 2 passed — no-change validate is GREEN"
else
  echo "❌ Step 2 FAILED — validate should PASS for unchanged code"
  exit 1
fi
echo ""

# ─── Step 3: Breaking change — expect FAIL ───────────────────────────────────
echo "━━━ Step 3: Breaking change (Add now subtracts) — expect FAIL ━━━━━"
cat > math/math.go << 'EOF'
package math

// Add now returns the DIFFERENCE (breaking change).
func Add(a, b int) int {
	return a - b
}

func ReverseString(s string) string {
	runes := []rune(s)
	for i, j := 0, len(runes)-1; i < j; i, j = i+1, j-1 {
		runes[i], runes[j] = runes[j], runes[i]
	}
	return string(runes)
}
EOF

VALIDATE_OUTPUT=$(bash "$SKILL_DIR/scripts/capture_go.sh" validate 2>&1 || true)
if echo "$VALIDATE_OUTPUT" | grep -q "FAIL.*add"; then
  echo "  ✅ Step 3 passed — breaking change detected (add FAIL)"
else
  echo "❌ Step 3 FAILED — validate should FAIL for add after breaking change"
  echo "$VALIDATE_OUTPUT"
  exit 1
fi

if echo "$VALIDATE_OUTPUT" | grep -q "reverse-string.*PASS"; then
  echo "  ✅ Step 3 passed — unaffected cluster still PASSes (reverse-string)"
else
  echo "❌ Step 3 FAILED — reverse-string should still PASS"
  echo "$VALIDATE_OUTPUT"
  exit 1
fi
echo ""

# ─── Step 4: Valid refactor — expect PASS ────────────────────────────────────
echo "━━━ Step 4: Valid refactor (loop-based Add, same output) — expect PASS ━━"
cat > math/math.go << 'EOF'
package math

// Add returns the sum using iterative addition (valid refactor).
func Add(a, b int) int {
	result := a
	for i := 0; i < b; i++ {
		result++
	}
	for i := 0; i > b; i-- {
		result--
	}
	return result
}

func ReverseString(s string) string {
	runes := []rune(s)
	for i, j := 0, len(runes)-1; i < j; i, j = i+1, j-1 {
		runes[i], runes[j] = runes[j], runes[i]
	}
	return string(runes)
}
EOF

if bash "$SKILL_DIR/scripts/capture_go.sh" validate 2>&1; then
  echo "  ✅ Step 4 passed — valid refactor is GREEN"
else
  echo "❌ Step 4 FAILED — validate should PASS for valid refactor"
  exit 1
fi
echo ""

# ─── Step 5: Cross-stack fingerprint parity ──────────────────────────────────
echo "━━━ Step 5: Cross-stack fingerprint parity (Go vs JS) ━━━━━━━━━━━━━━"
JS_FINGERPRINT=$(node -e "
const { fingerprint } = require('$SKILL_DIR/scripts/fingerprint.js');
console.log(fingerprint([1,2], 3));
" 2>/dev/null || node -e "
import { fingerprint } from '$SKILL_DIR/scripts/fingerprint.js';
console.log(fingerprint([1,2], 3));
" 2>/dev/null)

echo "  Go fingerprint for add([1,2])→3:  $ADD_HASH"
echo "  JS fingerprint for add([1,2])→3:  $JS_FINGERPRINT"

if [ "$ADD_HASH" = "$JS_FINGERPRINT" ]; then
  echo "  ✅ Step 5 passed — fingerprints match (cross-stack parity confirmed)"
else
  echo "❌ Step 5 FAILED — fingerprint mismatch"
  exit 1
fi
echo ""

echo "╔══════════════════════════════════════════════════════════════════════╗"
echo "║  ✅ All verification steps passed — Go stack is working             ║"
echo "╚══════════════════════════════════════════════════════════════════════╝"
