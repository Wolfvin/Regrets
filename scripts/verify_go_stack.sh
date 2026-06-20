#!/usr/bin/env bash
# verify_go_stack.sh — end-to-end verification for Go stack support
#
# Creates a temporary Go project, runs capture + validate (PASS for no-change
# and valid-refactor, FAIL for breaking change), and prints the results.
#
# Run from anywhere (the script creates its own temp project):
#   bash scripts/verify_go_stack.sh
#
# Exit codes:
#   0 — all checks passed (capture works, validate PASSes for valid refactor,
#       FAILs for breaking change)
#   1 — Go not installed, or a check failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAPTURE_GO="$SCRIPT_DIR/capture_go.sh"

# Check Go is available
if ! command -v go &> /dev/null; then
  echo "❌ Go is not installed. Install Go (https://go.dev/dl/) to run this verification."
  exit 1
fi

# Create a temporary project
TMP_DIR=$(mktemp -d)
trap "rm -rf $TMP_DIR" EXIT

cd "$TMP_DIR"
mkdir -p regrets

# ─── Set up Go module + source ────────────────────────────────────────────────
cat > go.mod << 'GOMOD'
module example.com/regrets-demo

go 1.23
GOMOD

cat > math.go << 'GOSRC'
package mathfn

// Add returns the sum of two integers (pure function).
func Add(a, b int) int {
	return a + b
}

// ReverseString returns the reversed version of the input string (pure function).
func ReverseString(s string) string {
	runes := []rune(s)
	for i, j := 0, len(runes)-1; i < j; i, j = i+1, j-1 {
		runes[i], runes[j] = runes[j], runes[i]
	}
	return string(runes)
}
GOSRC

cat > regrets/manifest.json << 'MANIFEST'
{
  "clusters": [
    {
      "id": "add",
      "entry": "Add",
      "file": "math.go",
      "stack": "go",
      "goPackage": "example.com/regrets-demo",
      "fingerprintLevel": "entry",
      "multiArgs": true,
      "inputs": [
        [1, 2],
        [10, 20],
        [-5, 5]
      ]
    },
    {
      "id": "reverse-string",
      "entry": "ReverseString",
      "file": "math.go",
      "stack": "go",
      "goPackage": "example.com/regrets-demo",
      "fingerprintLevel": "entry",
      "inputs": [
        "hello",
        "regrets",
        ""
      ]
    }
  ]
}
MANIFEST

echo "╔══════════════════════════════════════════════════════════════════════╗"
echo "║  Go Stack Verification — capture + validate end-to-end              ║"
echo "╚══════════════════════════════════════════════════════════════════════╝"
echo ""
echo "Project: $TMP_DIR"
echo "Go:      $(go version)"
echo ""

# ─── Step 1: Capture ──────────────────────────────────────────────────────────
echo "━━━ Step 1: Capture ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
bash "$CAPTURE_GO" capture 2>&1 | grep -E "✅|📄|Found" | sed 's/^/  /'
echo ""

# Verify .regret files were written
if [ ! -f regrets/add.regret ] || [ ! -f regrets/reverse-string.regret ]; then
  echo "❌ FAIL: .regret files not written"
  exit 1
fi

echo "  .regret files written:"
echo "    $(head -3 regrets/add.regret | tr '\n' ' ')"
echo "    $(head -3 regrets/reverse-string.regret | tr '\n' ' ')"
echo ""

# ─── Step 2: Validate (no change — should PASS) ───────────────────────────────
echo "━━━ Step 2: Validate (no code change — expect PASS) ━━━━━━━━━━━━━━━"
VALIDATE_OUTPUT=$(bash "$CAPTURE_GO" validate 2>&1 || true)
echo "$VALIDATE_OUTPUT" | grep -E "✅|❌|PASS|FAIL" | sed 's/^/  /'
echo ""

if echo "$VALIDATE_OUTPUT" | grep -q "❌"; then
  echo "❌ FAIL: validate reported failures with no code change"
  exit 1
fi
if ! echo "$VALIDATE_OUTPUT" | grep -q "All 2 Go cluster(s) PASS"; then
  echo "❌ FAIL: validate did not report 'All 2 Go cluster(s) PASS'"
  exit 1
fi
echo "  ✅ Step 2 passed — no-change validate is GREEN"
echo ""

# ─── Step 3: Breaking change (Add subtracts) — should FAIL ────────────────────
echo "━━━ Step 3: Breaking change (Add now subtracts) — expect FAIL ━━━━━"
cat > math.go << 'GOSRC_BREAKING'
package mathfn

func Add(a, b int) int {
	return a - b  // BREAKING: was a + b
}

func ReverseString(s string) string {
	runes := []rune(s)
	for i, j := 0, len(runes)-1; i < j; i, j = i+1, j-1 {
		runes[i], runes[j] = runes[j], runes[i]
	}
	return string(runes)
}
GOSRC_BREAKING

VALIDATE_OUTPUT=$(bash "$CAPTURE_GO" validate 2>&1 || true)
echo "$VALIDATE_OUTPUT" | grep -E "✅|❌|PASS|FAIL" | sed 's/^/  /'
echo ""

if echo "$VALIDATE_OUTPUT" | grep -q "add.*FAIL"; then
  echo "  ✅ Step 3 passed — breaking change detected (add FAIL)"
else
  echo "❌ FAIL: breaking change not detected (add should have FAILED)"
  exit 1
fi

if echo "$VALIDATE_OUTPUT" | grep -q "reverse-string.*PASS"; then
  echo "  ✅ Step 3 passed — unaffected cluster still PASSes (reverse-string)"
else
  echo "❌ FAIL: reverse-string should still PASS (it wasn't changed)"
  exit 1
fi
echo ""

# ─── Step 4: Valid refactor (loop-based, same output) — should PASS ───────────
echo "━━━ Step 4: Valid refactor (loop-based Add, same output) — expect PASS ━━"
cat > math.go << 'GOSRC_REFACTOR'
package mathfn

// Add — refactored to use a loop (same output for all inputs).
func Add(a, b int) int {
	result := a
	for i := 0; i < b; i++ {
		result++
	}
	for i := 0; i < -b; i++ {
		result--
	}
	return result
}

// ReverseString — refactored to use a different loop style (same output).
func ReverseString(s string) string {
	var sb []rune
	for i := len(s) - 1; i >= 0; i-- {
		sb = append(sb, rune(s[i]))
	}
	return string(sb)
}
GOSRC_REFACTOR

VALIDATE_OUTPUT=$(bash "$CAPTURE_GO" validate 2>&1 || true)
echo "$VALIDATE_OUTPUT" | grep -E "✅|❌|PASS|FAIL" | sed 's/^/  /'
echo ""

if echo "$VALIDATE_OUTPUT" | grep -q "All 2 Go cluster(s) PASS"; then
  echo "  ✅ Step 4 passed — valid refactor is GREEN"
else
  echo "❌ FAIL: valid refactor should PASS but didn't"
  exit 1
fi
echo ""

# ─── Step 5: Cross-stack fingerprint parity check ─────────────────────────────
echo "━━━ Step 5: Cross-stack fingerprint parity (Go vs JS) ━━━━━━━━━━━━━━"
# Compute Go fingerprint for add([1,2])→3 from the .regret file
GO_HASH=$(grep "^HASH" regrets/add.regret | awk '{print $2}')
# Compute JS fingerprint for the same input/output
JS_HASH=$(node -e "
import('${SCRIPT_DIR}/fingerprint.js').then(fp => {
  console.log(fp.fingerprint([1,2], 3))
})
" 2>/dev/null)
echo "  Go fingerprint for add([1,2])→3:  $GO_HASH"
echo "  JS fingerprint for add([1,2])→3:  $JS_HASH"
if [ "$GO_HASH" = "$JS_HASH" ]; then
  echo "  ✅ Step 5 passed — fingerprints match (cross-stack parity confirmed)"
else
  echo "❌ FAIL: fingerprints differ — cross-stack parity broken"
  exit 1
fi
echo ""

echo "╔══════════════════════════════════════════════════════════════════════╗"
echo "║  ✅ All verification steps passed — Go stack is working             ║"
echo "╚══════════════════════════════════════════════════════════════════════╝"
