#!/usr/bin/env bash
# run_demo.sh — end-to-end verification for Bash stack support
#
# Creates a temporary bash project, runs capture + validate (PASS for no-change
# and valid-refactor, FAIL for breaking change), and prints the results.
#
# Run from anywhere:
#   bash proof/bash_slugify/run_demo.sh
#
# Exit codes:
#   0 — all checks passed
#   1 — at least one check failed
#
# What this script verifies:
#   1. Bash 4+ is installed (needed for ${var,,} lowercase)
#   2. python3 is available (needed for fingerprint helper)
#   3. fingerprint_bash.sh produces hashes that match JS reference (cross-stack compat)
#   4. capture_bash.sh can read a manifest, invoke bash functions, write .regret files
#   5. validate_bash.sh PASSes when nothing changed
#   6. validate_bash.sh FAILs (exit 1) when a function is broken
#   7. validate_bash.sh PASSes again after a non-breaking refactor (variable rename)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
CAPTURE="${REPO_DIR}/scripts/capture_bash.sh"
VALIDATE="${REPO_DIR}/scripts/validate_bash.sh"

# ANSI colors
RED='\033[31m'
GREEN='\033[32m'
YELLOW='\033[33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✅ PASS${NC}: $1"; }
fail() { echo -e "${RED}❌ FAIL${NC}: $1"; FAILED=1; }
info() { echo -e "${YELLOW}ℹ️ ${NC} $1"; }

FAILED=0

# ─── 1. Check prerequisites ────────────────────────────────────────────────────

info "Checking prerequisites..."

# Bash 4+ for ${var,,} lowercase syntax
BASH_MAJOR="${BASH_VERSINFO[0]}"
if [[ "$BASH_MAJOR" -lt 4 ]]; then
    fail "Bash 4+ is required (current: $BASH_VERSION)"
    exit 1
fi
# Verify lowercase syntax actually works
if ! bash -c 'v="ABC"; [[ "${v,,}" == "abc" ]]' 2>/dev/null; then
    fail "Bash lowercase syntax \${var,,} not supported"
    exit 1
fi
pass "Bash $BASH_VERSION is available (supports \${var,,})"

if ! command -v python3 &> /dev/null; then
    fail "python3 is required for fingerprint helper"
    exit 1
fi
pass "python3 available: $(python3 --version)"

if ! command -v sha256sum &> /dev/null; then
    fail "sha256sum is required"
    exit 1
fi
pass "sha256sum available"

# ─── 2. Verify fingerprint cross-stack consistency ──────────────────────────────

info "Verifying fingerprint_bash.sh cross-stack consistency with fingerprint.js..."

# shellcheck source=../../../scripts/fingerprint_bash.sh
source "${REPO_DIR}/scripts/fingerprint_bash.sh"

# Parity test: 6 cases, compare bash vs JS hash output
# We write test cases to a JSON file to avoid shell-escaping issues
PARITY_FILE=$(mktemp /tmp/regret_parity.XXXXXX.json)
trap 'rm -f "$PARITY_FILE"' EXIT

python3 -c '
import json
cases = [
    {"input": "hello", "output": "world"},
    {"input": "café", "output": "thé"},
    {"input": 123, "output": "456"},
    {"input": ["a","b","c"], "output": "abc"},
    {"input": "emoji 🎉", "output": "party 🎊"},
    {"input": "line1\nline2", "output": "out"},
]
with open("'"$PARITY_FILE"'", "w") as f:
    json.dump(cases, f)
'

# Get JS hashes
JS_HASHES=$(node --input-type=module -e "
import { readFileSync } from 'fs';
import { fingerprint } from './scripts/fingerprint.js';
const cases = JSON.parse(readFileSync('$PARITY_FILE', 'utf8'));
for (const c of cases) {
  console.log(fingerprint(c.input, c.output));
}
" 2>/dev/null)

# Get bash hashes (one per line)
BASH_HASHES=""
while IFS= read -r case_json; do
  input_json=$(python3 -c "import json,sys; c=json.loads(sys.argv[1]); print(json.dumps(c['input']))" "$case_json")
  output_raw=$(python3 -c "import json,sys; c=json.loads(sys.argv[1]); print(c['output'], end='')" "$case_json")
  h=$(fingerprint "$input_json" "$output_raw")
  BASH_HASHES="${BASH_HASHES}${h}"$'\n'
done < <(python3 -c "
import json
with open('$PARITY_FILE') as f:
    cases = json.load(f)
for c in cases:
    print(json.dumps(c))
")

# Compare line-by-line
PARITY_OK=1
i=0
while IFS= read -r jhash; do
  i=$((i + 1))
  bhash=$(echo "$BASH_HASHES" | sed -n "${i}p")
  if [[ "$jhash" == "$bhash" ]]; then
    echo "  Case $i: js=$jhash bash=$bhash ✓"
  else
    echo "  Case $i: js=$jhash bash=$bhash ✗ MISMATCH"
    PARITY_OK=0
  fi
done <<< "$JS_HASHES"

if [[ $PARITY_OK -eq 1 ]]; then
    pass "fingerprint_bash.sh produces hashes matching JS reference ($i cases)"
else
    fail "fingerprint_bash.sh cross-stack parity check failed"
fi

# ─── 3. Create temp bash project ───────────────────────────────────────────────

info "Creating temporary bash project..."

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR" "$PARITY_FILE"' EXIT

mkdir -p "$TMP_DIR/lib" "$TMP_DIR/regrets"

# Copy the slugify.sh source
cp "${SCRIPT_DIR}/lib/slugify.sh" "$TMP_DIR/lib/slugify.sh"

# Write manifest (same as proof/bash_slugify/manifest.json)
cat > "$TMP_DIR/regrets/manifest.json" << 'JSONEOF'
{
  "clusters": [
    {
      "id": "slugify",
      "entry": "slugify",
      "file": "lib/slugify.sh",
      "stack": "bash",
      "fingerprintLevel": "entry",
      "description": "Convert string to URL-safe slug",
      "inputs": [
        "Hello World!",
        "Multi   Spaces Here",
        " leading-trailing ",
        "!!!already-clean!!!"
      ]
    },
    {
      "id": "slugify-join",
      "entry": "slugify_join",
      "file": "lib/slugify.sh",
      "stack": "bash",
      "fingerprintLevel": "entry",
      "multiArgs": true,
      "description": "Slugify each arg and join with hyphens",
      "inputs": [
        ["Hello", "World"],
        ["API", "v2", "Docs"]
      ]
    }
  ]
}
JSONEOF

pass "Temporary bash project created at $TMP_DIR"

# ─── 4. Capture ────────────────────────────────────────────────────────────────

info "Running capture_bash.sh..."

cd "$TMP_DIR"
if bash "$CAPTURE" > /tmp/bash_capture.out 2>&1; then
    pass "capture_bash.sh completed successfully"
    cat /tmp/bash_capture.out
else
    fail "capture_bash.sh failed"
    cat /tmp/bash_capture.out
    exit 1
fi

# Verify .regret files exist
if [[ ! -f "$TMP_DIR/regrets/slugify.regret" ]]; then
    fail "Expected regrets/slugify.regret not found"
    exit 1
fi
if [[ ! -f "$TMP_DIR/regrets/slugify-join.regret" ]]; then
    fail "Expected regrets/slugify-join.regret not found"
    exit 1
fi
pass "Both .regret files written"

# Show contents
info "Contents of slugify.regret:"
cat "$TMP_DIR/regrets/slugify.regret"
echo ""
info "Contents of slugify-join.regret:"
cat "$TMP_DIR/regrets/slugify-join.regret"
echo ""

# ─── 5. Validate (PASS baseline) ───────────────────────────────────────────────

info "Running validate_bash.sh — baseline (expect PASS)..."

cd "$TMP_DIR"
if bash "$VALIDATE" > /tmp/bash_validate_baseline.out 2>&1; then
    pass "validate_bash.sh PASSed for unchanged code"
else
    fail "validate_bash.sh FAILed for unchanged code (should have PASSed)"
    cat /tmp/bash_validate_baseline.out
    exit 1
fi

# ─── 6. Validate (FAIL after breaking change) ──────────────────────────────────

info "Breaking the slugify function (change algorithm — uppercase output)..."

# Create a broken version that uppercases instead of lowercases
cat > "$TMP_DIR/lib/slugify.sh" << 'BASHEOF'
#!/usr/bin/env bash
# BROKEN version — uppercases instead of lowercases

slugify() {
  local input="$1"
  local result
  result="${input^^}"  # BROKEN: uppercase instead of lowercase
  result="${result// /-}"
  result="${result//[^a-zA-Z0-9-]/}"
  while [[ "$result" == *--* ]]; do
    result="${result//--/-}"
  done
  while [[ "$result" == -* ]]; do
    result="${result#-}"
  done
  while [[ "$result" == *- ]]; do
    result="${result%-}"
  done
  printf '%s' "$result"
}

slugify_join() {
  local parts=()
  local arg
  for arg in "$@"; do
    parts+=("$(slugify "$arg")")
  done
  local IFS=-
  printf '%s' "${parts[*]}"
}
BASHEOF

cd "$TMP_DIR"
if bash "$VALIDATE" > /tmp/bash_validate_broken.out 2>&1; then
    fail "validate_bash.sh PASSed after breaking change (should have FAILed)"
    cat /tmp/bash_validate_broken.out
    exit 1
else
    pass "validate_bash.sh FAILed (exit 1) after breaking change — as expected"
    info "validate output:"
    cat /tmp/bash_validate_broken.out
fi

# ─── 7. Validate (PASS after non-breaking refactor) ────────────────────────────

info "Applying non-breaking refactor (rename variables, use tr instead of \${var,,})..."

cat > "$TMP_DIR/lib/slugify.sh" << 'BASHEOF'
#!/usr/bin/env bash
# REFACTORED version — same behavior, different implementation
# Uses tr for lowercase and sed for collapse instead of bash builtins

slugify() {
  local _input="$1"
  local _result

  # Lowercase via tr (refactored from ${_input,,})
  _result=$(printf '%s' "$_input" | tr '[:upper:]' '[:lower:]')

  # Replace spaces with hyphens
  _result="${_result// /-}"

  # Remove non-alphanumeric
  _result=$(printf '%s' "$_result" | sed 's/[^a-z0-9-]//g')

  # Collapse consecutive hyphens via sed (refactored from while loop)
  _result=$(printf '%s' "$_result" | sed 's/--*/-/g')

  # Trim leading hyphens
  _result="${_result#-}"
  # Trim trailing hyphens
  _result="${_result%-}"

  printf '%s' "$_result"
}

slugify_join() {
  local _parts=()
  local _arg
  for _arg in "$@"; do
    _parts+=("$(slugify "$_arg")")
  done
  local IFS=-
  printf '%s' "${_parts[*]}"
}
BASHEOF

cd "$TMP_DIR"
if bash "$VALIDATE" > /tmp/bash_validate_refactor.out 2>&1; then
    pass "validate_bash.sh PASSed after non-breaking refactor (rename + tr/sed)"
    cat /tmp/bash_validate_refactor.out
else
    fail "validate_bash.sh FAILed after non-breaking refactor (should have PASSed)"
    cat /tmp/bash_validate_refactor.out
    exit 1
fi

# ─── 8. Test --cluster filter ──────────────────────────────────────────────────

info "Testing --cluster filter..."

cd "$TMP_DIR"
if bash "$VALIDATE" --cluster slugify > /tmp/bash_validate_filter.out 2>&1; then
    pass "validate_bash.sh --cluster slugify works"
    # Verify only slugify was validated (not slugify-join)
    if grep -q "slugify-join" /tmp/bash_validate_filter.out; then
        fail "  --cluster filter did not exclude other clusters"
    else
        pass "  --cluster filter correctly excluded slugify-join"
    fi
else
    fail "validate_bash.sh --cluster slugify failed"
    cat /tmp/bash_validate_filter.out
fi

# ─── 9. Test --fail-fast ───────────────────────────────────────────────────────

info "Testing --fail-fast..."

# Break slugify-join only (keep slugify working)
cat > "$TMP_DIR/lib/slugify.sh" << 'BASHEOF'
#!/usr/bin/env bash
# slugify works, slugify_join is broken

slugify() {
  local input="$1"
  local result
  result="${input,,}"
  result="${result// /-}"
  result="${result//[^a-zA-Z0-9-]/}"
  while [[ "$result" == *--* ]]; do
    result="${result//--/-}"
  done
  while [[ "$result" == -* ]]; do
    result="${result#-}"
  done
  while [[ "$result" == *- ]]; do
    result="${result%-}"
  done
  printf '%s' "$result"
}

slugify_join() {
  # BROKEN: returns uppercased
  local parts=()
  local arg
  for arg in "$@"; do
    parts+=("$(slugify "$arg" | tr '[:lower:]' '[:upper:]')")
  done
  local IFS=-
  printf '%s' "${parts[*]}"
}
BASHEOF

cd "$TMP_DIR"
# Without --fail-fast, validate should run all clusters and exit 1
if bash "$VALIDATE" > /tmp/bash_validate_nofailfast.out 2>&1; then
    fail "validate_bash.sh without --fail-fast should have exit 1 (slugify-join is broken)"
else
    pass "validate_bash.sh without --fail-fast correctly exits 1 when one cluster fails"
    # Verify it still validated both clusters (didn't stop early)
    if grep -q "slugify-join" /tmp/bash_validate_nofailfast.out && grep -q "Validating cluster: slugify$" /tmp/bash_validate_nofailfast.out; then
        pass "  Both clusters were validated (no early stop)"
    fi
fi

# ─── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════════════"
if [[ $FAILED -eq 0 ]]; then
    echo -e "${GREEN}  ALL CHECKS PASSED — Bash stack is working end-to-end${NC}"
else
    echo -e "${RED}  SOME CHECKS FAILED — review output above${NC}"
fi
echo "════════════════════════════════════════════════════════════════"

exit $FAILED
