// redteam.zig — red-team fixture for the Zig stack.
//
// Patterns NOT covered by proof/zig/src/example.zig:
//   - i64 → bool            (isEven)  — different return type
//   - []const u8 → i64      (countWords) — different return type
//   - (allocator, []const u8, i64) → []u8  (repeat)  — 3-arg with i64
//   - i64 → i64 with overflow trap (safeMul)  — error path on edge case
//
// The original example.zig uses:
//   - (i64, i64) → i64           (add)
//   - (allocator, []const u8, bool) → []u8  (greet)
//   - (allocator, []const u8) → []u8        (titleCaseWords)
//
// The red-team fixture exercises branches of the @typeInfo dispatch tree
// that the original demo does NOT cover:
//   - callOne with i64 input + i64 output (existing) but with bool output (new)
//   - callOne with []const u8 input + i64 output (new — original only had string output)
//   - callTwo with i64 input + i64 output (existing, same as add)
//   - callTwo with (allocator, []const u8, i64) → []u8 (new — original had bool not i64)
//   - error path (safeMul with i64 + i64 → i64! with overflow check)

const std = @import("std");

/// Is `n` even? i64 → bool.
pub fn isEven(n: i64) bool {
    return @mod(n, 2) == 0;
}

/// Count words (split on whitespace). []const u8 → i64.
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

/// Repeat `s` exactly `n` times. Allocator + []const u8 + i64 → []u8.
/// Errors on negative n.
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

/// Multiply two i64s. Returns error.Overflow on edge case.
/// i64 + i64 → i64 (with error path).
pub fn safeMul(a: i64, b: i64) !i64 {
    return std.math.mul(i64, a, b) catch error.Overflow;
}
