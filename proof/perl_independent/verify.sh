#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Independent verification of the Perl stack (PR #427, issue #353)
#
# Uses a COMPLETELY DIFFERENT Perl project than the PR's own test suite
# to avoid confirmation bias (CONTEXT.md "Lesson Learned").
#
# This fixture (TextTransform.pm) tests string manipulation functions,
# NOT the MathUtils.pm used by the PR's bundled verify script.
#
# Run from this directory:
#   cd proof/perl_independent && bash verify.sh
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

# ── Setup: Copy independent fixture ──
mkdir -p "$TMP/regrets" "$TMP/lib"
cp "$SCRIPT_DIR/TextTransform.pm" "$TMP/lib/"
cp "$SCRIPT_DIR/manifest.json" "$TMP/regrets/"

# Fix file path in manifest (lib/ prefix)
cd "$TMP"
sed -i 's|"file": "TextTransform.pm"|"file": "lib/TextTransform.pm"|g' regrets/manifest.json

# ── Step 1: Capture ──
echo "ℹ️  Step 1: Running capture_perl.pl..."
CAP_OUT=$(perl "$PERL_SCRIPTS/capture_perl.pl" 2>&1) || true
if echo "$CAP_OUT" | grep -q "4 captured"; then
    ok "capture_perl.pl completed successfully (4 clusters)"
else
    die "capture_perl.pl failed: $CAP_OUT"
fi

REGRET_COUNT=$(ls regrets/*.regret 2>/dev/null | wc -l)
if [ "$REGRET_COUNT" -ge 4 ]; then
    ok "capture created $REGRET_COUNT .regret files"
else
    die "capture created only $REGRET_COUNT .regret files (expected 4)"
fi

# ── Step 2: Validate format ──
echo "ℹ️  Step 2: Checking .regret file format..."
FORMAT_OK=true
for f in regrets/*.regret; do
    for field in cluster version fingerprint captured INPUT OUTPUT HASH; do
        if ! grep -q "^${field}" "$f" && ! grep -q "^${field} " "$f"; then
            die "Missing field '$field' in $(basename $f)"
            FORMAT_OK=false
        fi
    done
done
if [ "$FORMAT_OK" = true ]; then
    ok "All .regret files have required fields"
fi

# ── Step 3: Multi-input INPUTS line ──
echo "ℹ️  Step 3: Checking multi-input INPUTS line..."
if grep -q "INPUTS" regrets/slugify.regret; then
    ok "slugify (3 inputs) has INPUTS line"
else
    die "slugify (3 inputs) missing INPUTS line"
fi

if ! grep -q "INPUTS" regrets/count-words.regret; then
    ok "count-words (1 input) has NO INPUTS line (correct)"
else
    die "count-words should NOT have INPUTS line"
fi

# ── Step 4: Validate baseline ──
echo "ℹ️  Step 4: Running validate (baseline)..."
VAL_OUT=$(perl "$PERL_SCRIPTS/validate_perl.pl" 2>&1) || true
if echo "$VAL_OUT" | grep -q "4 passed"; then
    ok "validate PASSes on baseline"
else
    die "validate did not PASS on baseline: $VAL_OUT"
fi

# ── Step 5: Breaking change ──
echo "ℹ️  Step 5: Breaking change (slugify uppercases)..."
cp lib/TextTransform.pm lib/TextTransform.pm.bak
sed -i 's/\$str = lc(\$str);/\$str = uc(\$str);/' lib/TextTransform.pm

VAL_OUT=$(perl "$PERL_SCRIPTS/validate_perl.pl" 2>&1) || true
if echo "$VAL_OUT" | grep -q "FAIL"; then
    ok "validate detects breaking change"
else
    die "validate does NOT detect breaking change"
fi

# ── Step 6: Valid refactor ──
echo "ℹ️  Step 6: Valid refactor (variable rename)..."
cp lib/TextTransform.pm.bak lib/TextTransform.pm
sed -i '/sub slugify/,/^}/s/my (\$str)/my ($text)/; /sub slugify/,/^}/s/\$str/\$text/g' lib/TextTransform.pm

VAL_OUT=$(perl "$PERL_SCRIPTS/validate_perl.pl" 2>&1) || true
if echo "$VAL_OUT" | grep -q "4 passed"; then
    ok "validate PASSes after valid refactor"
else
    die "validate FAILs after valid refactor (should PASS): $VAL_OUT"
fi

# ── Step 7: Multi-input contract — break input #3 only ──
echo "ℹ️  Step 7: Multi-input contract — break input #3 only..."
cp lib/TextTransform.pm.bak lib/TextTransform.pm

cat > lib/TextTransform.pm <<'PERL'
package TextTransform;
use strict; use warnings;
use Exporter 'import';
our @EXPORT_OK = qw(slugify title_case count_words reverse_words);

sub slugify {
    my ($str) = @_;
    if ($str =~ /^UPPER/) { return $str; }
    $str = lc($str);
    $str =~ s/[^a-z0-9]+/-/g;
    $str =~ s/^-+|-+$//g;
    return $str;
}

sub title_case { my ($str) = @_; return join(' ', map { ucfirst(lc($_)) } split(/\s+/, $str)); }
sub count_words { my ($str) = @_; return scalar(split(/\s+/, $str)); }
sub reverse_words { my ($str) = @_; return join(' ', reverse split(/\s+/, $str)); }

1;
PERL

VAL_OUT=$(perl "$PERL_SCRIPTS/validate_perl.pl" 2>&1) || true
if echo "$VAL_OUT" | grep -q "INPUTS.*mismatch\|FAIL"; then
    ok "multi-input contract: break on input #3 detected (INPUTS hash mismatch)"
else
    die "multi-input contract: break on input #3 NOT detected (false GREEN): $VAL_OUT"
fi

# ── Step 8: Cross-stack fingerprint parity ──
echo "ℹ️  Step 8: Cross-stack fingerprint parity..."
JS_HASH=$(node -e "
const f = require('$PERL_SCRIPTS/../scripts/fingerprint.js');
console.log(f.fingerprint('Hello World', 'hello-world'));
" 2>&1)

PERL_HASH=$(perl -e "
use lib '$PERL_SCRIPTS';
require 'fingerprint_perl.pl';
print Regrets::Fingerprint::fingerprint('Hello World', 'hello-world');
" 2>&1)

if [ "$PERL_HASH" = "$JS_HASH" ]; then
    ok "Cross-stack parity: Perl ($PERL_HASH) == JS ($JS_HASH)"
else
    die "Cross-stack parity MISMATCH: Perl($PERL_HASH) != JS($JS_HASH)"
fi

# ── Summary ──
echo ""
echo "=========================================="
echo "  Independent Perl Verification Summary"
echo "=========================================="
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo ""

if [ "$FAIL" -eq 0 ]; then
    echo "  ✅ ALL CHECKS PASS"
    exit 0
else
    echo "  ❌ SOME CHECKS FAILED"
    exit 1
fi
