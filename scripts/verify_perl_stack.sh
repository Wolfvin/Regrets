#!/usr/bin/env bash
# verify_perl_stack.sh — end-to-end verification for Perl stack support
#
# Creates a temporary Perl project, runs capture + validate (PASS for no-change
# and valid-refactor, FAIL for breaking change), and prints the results.
#
# Run from anywhere (the script creates its own temp project):
#   bash scripts/verify_perl_stack.sh
#
# Exit codes:
#   0 — all checks passed (capture works, validate PASSes for valid refactor,
#       FAILs for breaking change)
#   1 — at least one check failed
#
# What this script verifies:
#   1. Perl is installed and has the required core modules (JSON::PP, Digest::SHA, Math::BigInt)
#   2. fingerprint_perl.pl produces hashes that match the JS reference (cross-stack compat)
#   3. capture_perl.pl can read a manifest, invoke Perl subroutines, and write .regret files
#   4. validate_perl.pl can re-invoke and PASS when nothing changed
#   5. validate_perl.pl FAILs (exit 1) when a function is broken
#   6. validate_perl.pl PASSes again after a non-breaking refactor (renamed vars, iterative → recursive)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

pass() { echo -e "${GREEN}✅ PASS${NC}: $1"; }
fail() { echo -e "${RED}❌ FAIL${NC}: $1"; FAILED=1; }
info() { echo -e "${YELLOW}ℹ️ ${NC} $1"; }

FAILED=0

# ─── 1. Check prerequisites ────────────────────────────────────────────────────

info "Checking prerequisites..."

if ! command -v perl &> /dev/null; then
    fail "perl is not installed"
    exit 1
fi

PERL_VERSION=$(perl -e 'print $]')
info "Perl version: $PERL_VERSION"

# Check required modules
for mod in JSON::PP Digest::SHA Math::BigInt; do
    if ! perl -M$mod -e "exit 0" 2>/dev/null; then
        fail "Missing required Perl module: $mod"
        exit 1
    fi
done
pass "All required Perl modules available (JSON::PP, Digest::SHA, Math::BigInt)"

# ─── 2. Verify fingerprint cross-stack consistency ──────────────────────────────

info "Verifying fingerprint_perl.pl cross-stack consistency with fingerprint.js..."

if perl "$SCRIPT_DIR/fingerprint_perl.pl" > /tmp/perl_fp_test.out 2>&1; then
    if grep -q "ALL PASS" /tmp/perl_fp_test.out; then
        pass "fingerprint_perl.pl produces hashes matching JS reference"
    else
        fail "fingerprint_perl.pl self-test did not report ALL PASS"
        cat /tmp/perl_fp_test.out
        exit 1
    fi
else
    fail "fingerprint_perl.pl self-test crashed"
    cat /tmp/perl_fp_test.out
    exit 1
fi

# ─── 3. Create temp Perl project ─────────────────────────────────────────────────

info "Creating temporary Perl project..."

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/lib" "$TMP_DIR/regrets"

cat > "$TMP_DIR/lib/MathUtils.pm" << 'PERLEOF'
package MathUtils;
use strict;
use warnings;
use Exporter qw(import);
our @EXPORT_OK = qw(add factorial reverse_string hash_combine);

# Add two numbers — pure function, easy to fingerprint
sub add {
    my ($a, $b) = @_;
    return $a + $b;
}

# Factorial — recursive, tests integer handling
sub factorial {
    my ($n) = @_;
    return 1 if $n <= 1;
    return $n * factorial($n - 1);
}

# Reverse a string — tests string handling
sub reverse_string {
    my ($s) = @_;
    return scalar reverse $s;
}

# Combine multiple values into a hashref — tests hashref output + key order
sub hash_combine {
    my ($key, $val) = @_;
    return { key => $key, value => $val, upper => uc($key), length => length($val) };
}

1;
PERLEOF

cat > "$TMP_DIR/regrets/manifest.json" << 'JSONEOF'
{
  "clusters": [
    {
      "id": "add-basic",
      "entry": "add",
      "file": "lib/MathUtils.pm",
      "stack": "perl",
      "multiArgs": true,
      "inputs": [[2, 3]],
      "watches": ["add"],
      "description": "Add two numbers (2+3=5)"
    },
    {
      "id": "factorial",
      "entry": "factorial",
      "file": "lib/MathUtils.pm",
      "stack": "perl",
      "inputs": [5, 0, 10],
      "watches": ["factorial"],
      "description": "Factorial (recursive)"
    },
    {
      "id": "reverse-string",
      "entry": "reverse_string",
      "file": "lib/MathUtils.pm",
      "stack": "perl",
      "inputs": ["hello", "Regrets"],
      "watches": ["reverse_string"],
      "description": "Reverse a string"
    },
    {
      "id": "hash-combine",
      "entry": "hash_combine",
      "file": "lib/MathUtils.pm",
      "stack": "perl",
      "multiArgs": true,
      "inputs": [["key1", "value1"]],
      "watches": ["hash_combine"],
      "description": "Combine into hashref (key order test)"
    }
  ]
}
JSONEOF

pass "Temporary Perl project created at $TMP_DIR"

# ─── 4. Capture ──────────────────────────────────────────────────────────────────

info "Running capture_perl.pl..."

cd "$TMP_DIR"
if perl "$SCRIPT_DIR/capture_perl.pl" > /tmp/perl_capture.out 2>&1; then
    pass "capture_perl.pl completed successfully"
else
    fail "capture_perl.pl failed"
    cat /tmp/perl_capture.out
    exit 1
fi

# Verify .regret files were created
REGRET_COUNT=$(ls -1 "$TMP_DIR/regrets/"*.regret 2>/dev/null | wc -l)
if [ "$REGRET_COUNT" -eq 4 ]; then
    pass "Expected number of .regret files created ($REGRET_COUNT)"
else
    fail "Expected 4 .regret files, got $REGRET_COUNT"
    ls -la "$TMP_DIR/regrets/"
    exit 1
fi

# Show a sample .regret file
info "Sample .regret file (add-basic.regret):"
cat "$TMP_DIR/regrets/add-basic.regret"
echo "---"

# ─── 5. Validate (should PASS all) ────────────────────────────────────────────────

info "Running validate_perl.pl (expect all PASS — no changes since capture)..."

if perl "$SCRIPT_DIR/validate_perl.pl" > /tmp/perl_validate1.out 2>&1; then
    pass "validate_perl.pl PASSed (exit 0) — no changes since capture"
else
    fail "validate_perl.pl should have PASSed but exited non-zero"
    cat /tmp/perl_validate1.out
    exit 1
fi

if grep -q "4 passed, 0 failed" /tmp/perl_validate1.out; then
    pass "All 4 clusters PASSed"
else
    fail "Expected '4 passed, 0 failed' in output"
    cat /tmp/perl_validate1.out
    exit 1
fi

# ─── 6. Breaking refactor → validate should FAIL ──────────────────────────────────

info "Mutating add() to multiply() (breaking change)..."

cat > "$TMP_DIR/lib/MathUtils.pm" << 'PERLEOF'
package MathUtils;
use strict;
use warnings;
use Exporter qw(import);
our @EXPORT_OK = qw(add factorial reverse_string hash_combine);

# REFACTORED: now multiplies instead of adds (BREAKING CHANGE)
sub add {
    my ($a, $b) = @_;
    return $a * $b;
}

sub factorial {
    my ($n) = @_;
    return 1 if $n <= 1;
    return $n * factorial($n - 1);
}

sub reverse_string {
    my ($s) = @_;
    return scalar reverse $s;
}

sub hash_combine {
    my ($key, $val) = @_;
    return { key => $key, value => $val, upper => uc($key), length => length($val) };
}

1;
PERLEOF

info "Running validate_perl.pl (expect FAIL for add-basic, PASS for others)..."

set +e
perl "$SCRIPT_DIR/validate_perl.pl" > /tmp/perl_validate2.out 2>&1
VALIDATE_EXIT=$?
set -e

if [ "$VALIDATE_EXIT" -ne 0 ]; then
    pass "validate_perl.pl correctly FAILed (exit 1) after breaking change"
else
    fail "validate_perl.pl should have FAILed (exit 1) but exited 0"
    cat /tmp/perl_validate2.out
    exit 1
fi

# Check that add-basic FAILed but others PASSed
if grep -q "❌ add-basic" /tmp/perl_validate2.out && grep -q "✅ factorial" /tmp/perl_validate2.out; then
    pass "Only the broken cluster (add-basic) FAILed; untouched clusters PASSed"
else
    fail "Expected add-basic to FAIL and factorial to PASS"
    cat /tmp/perl_validate2.out
    exit 1
fi

info "Output after breaking change:"
cat /tmp/perl_validate2.out
echo "---"

# ─── 7. Non-breaking refactor → validate should PASS all ──────────────────────────

info "Applying NON-breaking refactor (rename vars, iterative factorial)..."

cat > "$TMP_DIR/lib/MathUtils.pm" << 'PERLEOF'
package MathUtils;
use strict;
use warnings;
use Exporter qw(import);
our @EXPORT_OK = qw(add factorial reverse_string hash_combine);

# REFACTORED (non-breaking): renamed $a/$b to $first/$second
sub add {
    my ($first, $second) = @_;
    return $first + $second;
}

# REFACTORED (non-breaking): iterative instead of recursive (same result)
sub factorial {
    my ($n) = @_;
    my $result = 1;
    for my $i (2 .. $n) {
        $result *= $i;
    }
    return $result;
}

sub reverse_string {
    my ($s) = @_;
    return scalar reverse $s;
}

sub hash_combine {
    my ($key, $val) = @_;
    return { key => $key, value => $val, upper => uc($key), length => length($val) };
}

1;
PERLEOF

info "Running validate_perl.pl (expect all PASS — non-breaking refactor)..."

if perl "$SCRIPT_DIR/validate_perl.pl" > /tmp/perl_validate3.out 2>&1; then
    pass "validate_perl.pl PASSed (exit 0) after non-breaking refactor"
else
    fail "validate_perl.pl should have PASSed but exited non-zero"
    cat /tmp/perl_validate3.out
    exit 1
fi

if grep -q "4 passed, 0 failed" /tmp/perl_validate3.out; then
    pass "All 4 clusters PASSed after non-breaking refactor"
else
    fail "Expected '4 passed, 0 failed' after non-breaking refactor"
    cat /tmp/perl_validate3.out
    exit 1
fi

info "Output after non-breaking refactor:"
cat /tmp/perl_validate3.out
echo "---"

# ─── Summary ────────────────────────────────────────────────────────────────────

echo ""
echo "=========================================="
echo "  Perl Stack Verification: ALL CHECKS PASS"
echo "=========================================="
echo ""
echo "Verified:"
echo "  ✅ Perl prerequisites (JSON::PP, Digest::SHA, Math::BigInt)"
echo "  ✅ fingerprint_perl.pl cross-stack consistency with JS"
echo "  ✅ capture_perl.pl writes .regret files with correct format"
echo "  ✅ validate_perl.pl PASSes when nothing changed"
echo "  ✅ validate_perl.pl FAILs (exit 1) on breaking change"
echo "  ✅ validate_perl.pl PASSes after non-breaking refactor"
echo ""
echo "Files added:"
echo "  scripts/fingerprint_perl.pl  — shared fingerprint module + self-test"
echo "  scripts/capture_perl.pl      — manifest-driven capture"
echo "  scripts/validate_perl.pl     — .regret re-validation"
echo "  scripts/verify_perl_stack.sh — this end-to-end verification script"
echo ""

exit 0
