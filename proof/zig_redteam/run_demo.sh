#!/usr/bin/env bash
# proof/zig_redteam/run_demo.sh — red-team verification for the Zig stack.
#
# This fixture exercises patterns NOT covered by proof/zig/:
#   - i64 → bool               (isEven)        — different return type
#   - []const u8 → i64         (countWords)    — different return type, no error union
#   - (allocator, []const u8, i64) → []u8  (repeat)  — 3-arg with i64 third param
#   - (i64, i64) → error!i64   (safeMul)       — error path on edge case
#
# Phases:
#   0. Baseline capture + validate — must PASS.
#   1. VALID refactor (rename internal var only, output unchanged) — must PASS.
#   2. BREAKING refactor (change algorithm output) — must FAIL.
#   3. Restore + sanity check — must PASS.
#
# Run: bash proof/zig_redteam/run_demo.sh
# Requires: Zig 0.14+ on PATH (or set ZIG_BIN=/path/to/zig).
#           (Verified on 0.16.0; earlier versions may not work due to stdlib API changes.)

set -eu

PROOF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROOF_DIR"

REGRETS_REPO="$(cd "$PROOF_DIR/../.." && pwd)"
CAPTURE="$REGRETS_REPO/scripts/capture_zig.sh"
VALIDATE="$REGRETS_REPO/scripts/validate_zig.sh"

if ! command -v "${ZIG_BIN:-zig}" >/dev/null 2>&1; then
  echo "❌ zig not found on PATH"
  echo "   Install Zig 0.14+ (https://ziglang.org/download/) or set ZIG_BIN=/path/to/zig"
  exit 1
fi

LIB="src/redteam.zim"
LIB="src/redteam.zig"
BACKUP="/tmp/redteam.zig.bak.$$.orig"
REFACTORED_VALID="/tmp/redteam.zig.bak.$$.valid"
REFACTORED_BREAKING="/tmp/redteam.zig.bak.$$.breaking"

trap 'rm -f "$BACKUP" "$REFACTORED_VALID" "$REFACTORED_BREAKING"' EXIT

run_validate() {
  set +e
  bash "$VALIDATE" >/dev/null 2>&1
  local status=$?
  set -e
  return "$status"
}

cp "$LIB" "$BACKUP"

# ─── Phase 0: baseline capture + validate ────────────────────────────────────
echo "═══ Phase 0: baseline capture + validate (4 clusters) ═══"
bash "$CAPTURE" 2>&1 | tail -8
echo
if run_validate; then
  echo "✅ Phase 0 PASS — baseline green for all 4 clusters"
  echo "   (isEven, countWords, repeat, safeMul — patterns NOT in proof/zig/)"
else
  echo "❌ Phase 0 FAIL: baseline validate should PASS"
  exit 1
fi
echo

# ─── Phase 1: VALID refactor — rename internal vars only ─────────────────────
echo "═══ Phase 1: VALID refactor (rename internal vars: count → tally, in_word → word_start) ═══"
cat > "$REFACTORED_VALID" <<'ZIG'
const std = @import("std");

pub fn isEven(n: i64) bool {
    return @mod(n, 2) == 0;
}

pub fn countWords(input: []const u8) i64 {
    if (input.len == 0) return 0;
    var tally: i64 = 0;
    var word_start = false;
    for (input) |c| {
        if (std.ascii.isWhitespace(c)) {
            word_start = false;
        } else if (!word_start) {
            word_start = true;
            tally += 1;
        }
    }
    return tally;
}

pub fn repeat(allocator: std.mem.Allocator, s: []const u8, n: i64) ![]u8 {
    if (n < 0) return error.NegativeRepeat;
    const n_usize: usize = @intCast(n);
    const buf = try allocator.alloc(u8, s.len * n_usize);
    var i: usize = 0;
    while (i < n_usize) : (i += 1) {
        @memcpy(buf[i * s.len ..][0..s.len], s);
    }
    return buf;
}

pub fn safeMul(a: i64, b: i64) !i64 {
    return std.math.mul(i64, a, b) catch error.Overflow;
}
ZIG

cp "$REFACTORED_VALID" "$LIB"
echo "Refactored src/redteam.zig — diff:"
diff -u "$BACKUP" "$LIB" || true
echo
if run_validate; then
  echo "✅ Phase 1 PASS — valid refactor is green (output unchanged)"
else
  echo "❌ Phase 1 FAIL: valid refactor should still PASS"
  cp "$BACKUP" "$LIB"
  exit 1
fi
echo

# ─── Restore + sanity check ──────────────────────────────────────────────────
cp "$BACKUP" "$LIB"
if ! run_validate; then
  echo "❌ Sanity check FAIL: restoring original should PASS"
  exit 1
fi

# ─── Phase 2: BREAKING refactor — change isEven output ───────────────────────
# Note: input[0] for is-even is 4, where @mod(4, 2) == 0 → true.
# A naive "n > 0" refactor returns true for input 4 (same result) —
# Regrets wouldn't catch it. We use a refactor that flips the output
# for input 4 specifically: @mod(n, 2) == 1 (odd check) returns false for 4.
echo "═══ Phase 2: BREAKING refactor (isEven: parity check → odd check, flips output for input 4) ═══"
cat > "$REFACTORED_BREAKING" <<'ZIG'
const std = @import("std");

pub fn isEven(n: i64) bool {
    // BREAKING: was @mod(n, 2) == 0 (even), now @mod(n, 2) == 1 (odd)
    // For input 4: was true, now false → fingerprint changes
    return @mod(n, 2) == 1;
}

pub fn countWords(input: []const u8) i64 {
    if (input.len == 0) return 0;
    var count: i64 = 0;
    var in_word = false;
    for (input) |c| {
        if (std.ascii.isWhitespace(c)) {
            in_word = false;
        } else if (!in_word) {
            in_word = true;
            count += 1;
        }
    }
    return count;
}

pub fn repeat(allocator: std.mem.Allocator, s: []const u8, n: i64) ![]u8 {
    if (n < 0) return error.NegativeRepeat;
    const n_usize: usize = @intCast(n);
    const buf = try allocator.alloc(u8, s.len * n_usize);
    var i: usize = 0;
    while (i < n_usize) : (i += 1) {
        @memcpy(buf[i * s.len ..][0..s.len], s);
    }
    return buf;
}

pub fn safeMul(a: i64, b: i64) !i64 {
    return std.math.mul(i64, a, b) catch error.Overflow;
}
ZIG

cp "$REFACTORED_BREAKING" "$LIB"
echo "Refactored src/redteam.zig — diff:"
diff -u "$BACKUP" "$LIB" | head -15
echo
bash "$VALIDATE" 2>&1 | tail -10 || true
if run_validate; then
  echo "❌ Phase 2 FAIL: breaking refactor should FAIL validate"
  cp "$BACKUP" "$LIB"
  exit 1
else
  echo "✅ Phase 2 PASS — breaking refactor correctly detected (is-even failed, others still pass)"
fi
echo

# ─── Restore + final sanity check ────────────────────────────────────────────
cp "$BACKUP" "$LIB"
if ! run_validate; then
  echo "❌ Final sanity check FAIL: restoring original should PASS"
  exit 1
fi

echo "═══ All phases passed ═══"
echo "  Phase 0 (baseline)            ✅ PASS — 4 clusters (int→bool, str→int, alloc+str+int→str, int+int→!int)"
echo "  Phase 1 (valid refactor)      ✅ PASS — Regrets stayed green"
echo "  Phase 2 (breaking refactor)   ✅ FAIL — Regrets caught the regression in is-even"
echo
echo "Patterns verified (NOT covered by proof/zig/):"
echo "  - i64 → bool               (isEven)"
echo "  - []const u8 → i64         (countWords, no error union)"
echo "  - (allocator, []const u8, i64) → []u8   (repeat, 3-arg with i64)"
echo "  - (i64, i64) → error!i64   (safeMul, error path on edge case)"
echo
echo "Code is now back to the original — ready for a real refactor."
