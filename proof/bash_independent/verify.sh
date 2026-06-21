#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Independent verification of the Bash stack (PR #414, issue #384)
#
# Uses a COMPLETELY DIFFERENT Bash project than the PR's own slugify demo
# to avoid confirmation bias (CONTEXT.md "Lesson Learned").
#
# Run from this directory:
#   cd proof/bash_independent && bash verify.sh
# ──────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PERL_SCRIPTS="$REPO_DIR/scripts"

PASS=0
FAIL=0
ok()  { echo "✅ PASS: $1"; PASS=$((PASS + 1)); }
die() { echo "❌ FAIL: $1"; FAIL=$((FAIL + 1)); }

TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

# ── Setup: copy fixture ──
mkdir -p "$TMP/regrets"
cp "$SCRIPT_DIR/strutils.sh" "$TMP/"
cp "$SCRIPT_DIR/manifest.json" "$TMP/regrets/"

cd "$TMP"

# ── Step 1: Capture ──
echo "ℹ️  Step 1: Running capture_bash.sh..."
CAP_OUT=$(bash "$REPO_DIR/scripts/capture_bash.sh" 2>&1) || true
echo "$CAP_OUT" | grep -q "4 captured" && ok "capture completed (4 clusters)" || die "capture failed: $CAP_OUT"

REGRET_COUNT=$(ls regrets/*.regret 2>/dev/null | wc -l)
[ "$REGRET_COUNT" -ge 4 ] && ok "$REGRET_COUNT .regret files created" || die "only $REGRET_COUNT .regret files"

# ── Step 2: Format check ──
echo "ℹ️  Step 2: Format check..."
FORMAT_OK=true
for f in regrets/*.regret; do
    for field in cluster version fingerprint captured INPUT OUTPUT HASH; do
        if ! grep -q "^${field}" "$f" 2>/dev/null && ! grep -q "^${field} " "$f" 2>/dev/null; then
            die "Missing '$field' in $(basename $f)"; FORMAT_OK=false
        fi
    done
done
[ "$FORMAT_OK" = true ] && ok "All .regret files have required fields"

# ── Step 3: Multi-input INPUTS line ──
echo "ℹ️  Step 3: Multi-input..."
grep -q "INPUTS" regrets/trim.regret && ok "trim (3 inputs) has INPUTS line" || die "trim missing INPUTS"
grep -q "INPUTS" regrets/is-numeric.regret && ok "is-numeric (3 inputs) has INPUTS line" || die "is-numeric missing INPUTS"

# ── Step 4: Validate baseline ──
echo "ℹ️  Step 4: Validate baseline..."
VAL_OUT=$(bash "$REPO_DIR/scripts/validate_bash.sh" 2>&1) || true
echo "$VAL_OUT" | grep -q "4 passed" && ok "validate PASSes on baseline" || die "baseline FAIL: $VAL_OUT"

# ── Step 5: Breaking change ──
echo "ℹ️  Step 5: Breaking change (trim uppercases)..."
cp strutils.sh strutils.sh.orig
cat > strutils.sh <<'BROKEN'
#!/usr/bin/env bash
trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"; echo "$s" | tr '[:lower:]' '[:upper:]'; }
to_camel() { local s="$1"; local r="" cap=false; for (( i=0; i<${#s}; i++ )); do local c="${s:$i:1}"; if [[ "$c" == "_" ]]; then cap=true; elif $cap; then r+=$(echo "$c" | tr '[:lower:]' '[:upper:]'); cap=false; else r+="$c"; fi; done; echo "$r"; }
repeat_str() { local s="$1"; local n="$2"; local r=""; for (( i=0; i<n; i++ )); do r+="$s"; done; echo "$r"; }
is_numeric() { local s="$1"; [[ "$s" =~ ^-?[0-9]+(\.[0-9]+)?$ ]] && echo "true" || echo "false"; }
BROKEN

VAL_OUT=$(bash "$REPO_DIR/scripts/validate_bash.sh" 2>&1) || true
(echo "$VAL_OUT" | grep -qi "fail" || echo "$VAL_OUT" | grep -q "mismatch") && ok "breaking change detected" || die "breaking change NOT detected: $VAL_OUT"

# ── Step 6: Valid refactor ──
echo "ℹ️  Step 6: Valid refactor (variable rename)..."
cat > strutils.sh <<'REFACTORED'
#!/usr/bin/env bash
trim() { local text="$1"; text="${text#"${text%%[![:space:]]*}"}"; text="${text%"${text##*[![:space:]]}"}"; echo "$text"; }
to_camel() { local s="$1"; local r="" cap=false; for (( i=0; i<${#s}; i++ )); do local c="${s:$i:1}"; if [[ "$c" == "_" ]]; then cap=true; elif $cap; then r+=$(echo "$c" | tr '[:lower:]' '[:upper:]'); cap=false; else r+="$c"; fi; done; echo "$r"; }
repeat_str() { local s="$1"; local n="$2"; local r=""; for (( i=0; i<n; i++ )); do r+="$s"; done; echo "$r"; }
is_numeric() { local s="$1"; [[ "$s" =~ ^-?[0-9]+(\.[0-9]+)?$ ]] && echo "true" || echo "false"; }
REFACTORED

VAL_OUT=$(bash "$REPO_DIR/scripts/validate_bash.sh" 2>&1) || true
echo "$VAL_OUT" | grep -q "4 passed" && ok "valid refactor PASSes" || die "valid refactor FAILs: $VAL_OUT"

# ── Step 7: Multi-input contract ──
echo "ℹ️  Step 7: Multi-input — break input #3 of is_numeric..."
cat > strutils.sh <<'BROKEN2'
#!/usr/bin/env bash
trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"; echo "$s"; }
to_camel() { local s="$1"; local r="" cap=false; for (( i=0; i<${#s}; i++ )); do local c="${s:$i:1}"; if [[ "$c" == "_" ]]; then cap=true; elif $cap; then r+=$(echo "$c" | tr '[:lower:]' '[:upper:]'); cap=false; else r+="$c"; fi; done; echo "$r"; }
repeat_str() { local s="$1"; local n="$2"; local r=""; for (( i=0; i<n; i++ )); do r+="$s"; done; echo "$r"; }
is_numeric() { echo "true"; }
BROKEN2

VAL_OUT=$(bash "$REPO_DIR/scripts/validate_bash.sh" 2>&1) || true
(echo "$VAL_OUT" | grep -qi "fail" || echo "$VAL_OUT" | grep -q "mismatch") && ok "multi-input: break on input #3 detected" || die "multi-input: false GREEN: $VAL_OUT"

# ── Step 8: Cross-stack parity ──
echo "ℹ️  Step 8: Cross-stack fingerprint parity..."
cp strutils.sh.orig strutils.sh
source "$REPO_DIR/scripts/fingerprint_bash.sh"
BASH_FP=$(fingerprint '"  hello  "' '"hello"')
JS_FP=$(node -e "const f = require('$REPO_DIR/scripts/fingerprint.js'); console.log(f.fingerprint('  hello  ', 'hello'));" 2>&1)
[ "$BASH_FP" = "$JS_FP" ] && ok "Parity: Bash($BASH_FP) == JS($JS_FP)" || die "Parity MISMATCH: Bash($BASH_FP) != JS($JS_FP)"

# ── Summary ──
echo ""
echo "=========================================="
echo "  Independent Bash Verification Summary"
echo "=========================================="
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo ""

[ "$FAIL" -eq 0 ] && echo "  ✅ ALL CHECKS PASS" && exit 0 || echo "  ❌ SOME CHECKS FAILED" && exit 1
