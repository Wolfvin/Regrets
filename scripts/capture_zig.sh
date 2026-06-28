#!/usr/bin/env bash
# capture_zig.sh — compile + run regret capture for Zig clusters
#
# Reads regrets/manifest.json, generates a per-cluster Zig runner that
# @imports the user's source file and calls the named pub fn directly,
# computes the Regrets fingerprint (identical algorithm to
# scripts/fingerprint.js), and writes a .regret file per cluster.
#
# Usage:
#   bash scripts/capture_zig.sh                 # capture all Zig clusters
#   bash scripts/capture_zig.sh --cluster add   # capture one cluster
#   bash scripts/capture_zig.sh --manifest ./regrets/manifest.json
#   bash scripts/capture_zig.sh --quiet
#   bash scripts/capture_zig.sh --verbose
#   bash scripts/capture_zig.sh --emit-runner <path>  # internal: emit shared runner lib
#
# Requirements:
#   - zig (0.16.0+) on PATH or at ZIG_BIN — pinned via `.zigversion` at repo root.
#     Zig 0.16 overhauled the I/O API ("Writergate"): `std.io.getStdOut()` and
#     `std.fs.File` were removed; the runner template uses `std.Io.File.stdout()`
#     / `stderr()` / `stdin()` + `writeStreamingAll(io, bytes)` + `readStreaming`
#     via a `std.Io.Threaded` instance (cross-platform: io_uring on Linux,
#     kqueue on *BSD/macOS, IOCP on Windows). Earlier versions (0.13 and below)
#     are NOT compatible.
#   - node (for manifest JSON parsing)
#
# The .regret file format is identical to the JS/Python/Kotlin/Go/Rust stacks:
#   cluster: <id>
#   version: 1
#   fingerprint: <7-char base36>
#   captured: <ISO timestamp>
#   watches: [...]
#   entry: <function name>
#   stack: zig
#   fingerprintLevel: entry
#   ---
#   INPUT  <json>
#   OUTPUT <json>
#   HASH   <7-char base36>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"

# Node.js (native Windows binary) does not resolve POSIX-style paths the way
# Git Bash does -- /c/Users/... gets misread as a relative path under the
# current drive, producing nonsense like C:\c\Users\.... Convert via cygpath
# when available (Git Bash / MSYS2 / Cygwin) so every `node -e` call below
# gets a path Node actually understands. No-op on Linux/Mac.
node_path() {
  if command -v cygpath &> /dev/null; then
    cygpath -m "$1"
  else
    echo "$1"
  fi
}
NODE_MANIFEST="$(node_path "$MANIFEST")"
REGRET_DIR="${PROJECT_DIR}/regrets"

# ─── Locate zig ─────────────────────────────────────────────────────────────

ZIG_BIN="${ZIG_BIN:-}"
if [[ -z "$ZIG_BIN" ]]; then
  if command -v zig &>/dev/null; then
    ZIG_BIN="$(command -v zig)"
  fi
fi

if [[ -z "$ZIG_BIN" ]]; then
  echo "❌ zig not found. Install Zig 0.16.0+ (https://ziglang.org/download/)"
  echo "   or set ZIG_BIN to the path of the zig executable."
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo "❌ node not found. Install Node.js 16+ (used for JSON parsing)."
  exit 1
fi

# ─── Parse CLI args ──────────────────────────────────────────────────────────

CLUSTER_FILTER=""
QUIET=0
VERBOSE=0
EMIT_RUNNER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster) CLUSTER_FILTER="$2"; shift 2 ;;
    --manifest) MANIFEST="$2"; shift 2 ;;
    --quiet) QUIET=1; shift ;;
    --verbose) VERBOSE=1; shift ;;
    --emit-runner) EMIT_RUNNER="$2"; shift 2 ;;
    *)
      echo "Unknown arg: $1" >&2
      echo "Usage: bash scripts/capture_zig.sh [--cluster <id>] [--manifest <path>] [--quiet] [--verbose] [--emit-runner <path>]" >&2
      exit 1
      ;;
  esac
done
NODE_MANIFEST="$(node_path "$MANIFEST")"  # recompute after flag parsing (--manifest/--project may have changed MANIFEST)

# ─── --emit-runner: write the shared runner lib .zig and exit ────────────────

if [[ -n "$EMIT_RUNNER" ]]; then
  mkdir -p "$(dirname "$EMIT_RUNNER")"
  awk '/^cat > "\$RUNNER_DIR\/regret_runner\.zig" << .REGRET_RUNNER_EOF.$/{flag=1; next} /^REGRET_RUNNER_EOF$/{flag=0} flag' "$0" > "$EMIT_RUNNER"
  exit 0
fi

[[ $QUIET -eq 1 ]] || echo "📡 Capturing Zig clusters from $MANIFEST"

if [[ ! -f "$MANIFEST" ]]; then
  echo "❌ Manifest not found: $MANIFEST"
  exit 1
fi

mkdir -p "$REGRET_DIR"

# ─── Read Zig clusters from manifest ─────────────────────────────────────────

CLUSTERS_JSON=$(node -e "
  const m = JSON.parse(require('fs').readFileSync('$NODE_MANIFEST', 'utf8'));
  let cs = (m.clusters || []).filter(c => c.stack === 'zig');
  if ('$CLUSTER_FILTER') {
    cs = cs.filter(c => c.id === '$CLUSTER_FILTER');
  }
  console.log(JSON.stringify(cs));
")

if [[ "$CLUSTERS_JSON" == "[]" ]]; then
  [[ $QUIET -eq 1 ]] || echo "No Zig clusters found in manifest."
  exit 0
fi

# ─── Generate the shared runner library ─────────────────────────────────────
# The runner library contains the fingerprint, stableStringify, JSON parsing,
# and Value type. It does NOT know the user's function name — that's handled
# by a per-cluster wrapper that imports both the runner lib and the user source.

RUNNER_DIR="${PROJECT_DIR}/.regret-zig-build"
mkdir -p "$RUNNER_DIR"

cat > "$RUNNER_DIR/regret_runner.zig" << 'REGRET_RUNNER_EOF'
// AUTO-GENERATED by capture_zig.sh — shared runner library.
// Do not edit — regenerated on each capture run.
//
// Compatible with: Zig 0.16+ (verified on 0.16.0).
// Earlier versions (0.13 and below) used std.heap.GeneralPurposeAllocator,
// std.StringArrayHashMap (managed), std.ArrayList(T).init(allocator), and
// std.io.getStdOut().writer() — all removed/changed in 0.14+.
// Zig 0.16 in turn removed std.io.getStdOut() entirely (the "Writergate"
// I/O refactor) and replaced it with the std.Io interface, which requires
// an explicit `Io` instance (created via `std.Io.Threaded.init`) and
// cross-platform File methods like `std.Io.File.stdout()` /
// `writeStreamingAll(io, bytes)` / `readStreaming(io, ...)`.
//
// This version uses:
//   - std.heap.DebugAllocator (replaces GeneralPurposeAllocator)
//   - std.StringArrayHashMapUnmanaged (replaces managed StringArrayHashMap)
//   - std.ArrayList(T) = .empty + allocator-passing methods (replaces .init(allocator))
//   - std.Io.Threaded + std.Io.File.stdout/stderr/stdin + writeStreamingAll
//     + readStreaming for stdout/stderr/stdin (replaces both
//     std.io.getStdOut().writer() and the Linux-only std.os.linux.write/read
//     used in earlier attempts — fixes issue #531, cross-platform Windows
//     + Linux + macOS).
//
// Contains: Value type, stableStringify, fingerprint, JSON parsing,
// invocation spec, and the main loop that reads stdin, invokes the
// per-cluster `regret_entry` function, and emits INPUT/OUTPUT/HASH lines.

const std = @import("std");
const Sha256 = std.crypto.hash.sha2.Sha256;

// ─── Value: JSON-like sum type ─────────────────────────────────────────────
// Note: fields use trailing underscores (null_, bool_, int_, float_) because
// `null`, `bool`, `int`, `float` are reserved keywords in Zig.

pub const Value = union(enum) {
    null_,
    bool_: bool,
    int_: i64,
    float_: f64,
    string: []const u8,
    array: std.ArrayList(Value),
    object: std.StringArrayHashMapUnmanaged(Value),

    pub fn deinit(self: Value, allocator: std.mem.Allocator) void {
        switch (self) {
            .null_, .bool_, .int_, .float_, .string => {},
            .array => |a| {
                for (a.items) |item| item.deinit(allocator);
                var mut = a;
                mut.deinit(allocator);
            },
            .object => |o| {
                var it = o.iterator();
                while (it.next()) |entry| {
                    entry.value_ptr.deinit(allocator);
                }
                var mut = o;
                mut.deinit(allocator);
            },
        }
    }
};

// ─── stdout/stdin/stderr helpers (Zig 0.16 std.Io API — cross-platform) ───
// All file I/O in Zig 0.16 goes through the new std.Io interface, which
// requires an `Io` instance (created via `std.Io.Threaded.init`). The
// Threaded backend selects the optimal platform implementation at runtime
// (io_uring on Linux, kqueue on macOS/BSDs, IOCP on Windows), so the same
// code path works on every OS — fixing issue #531 where the previous
// `std.os.linux.read/write` syscalls broke Zig capture on Windows.

fn writeOut(io: std.Io, s: []const u8) void {
    std.Io.File.stdout().writeStreamingAll(io, s) catch {};
}

fn writeOutOwned(allocator: std.mem.Allocator, io: std.Io, s: []u8) void {
    defer allocator.free(s);
    std.Io.File.stdout().writeStreamingAll(io, s) catch {};
}

fn writeOutFmt(allocator: std.mem.Allocator, io: std.Io, comptime fmt: []const u8, args: anytype) !void {
    const s = try std.fmt.allocPrint(allocator, fmt, args);
    defer allocator.free(s);
    std.Io.File.stdout().writeStreamingAll(io, s) catch {};
}

fn writeErr(io: std.Io, s: []const u8) void {
    std.Io.File.stderr().writeStreamingAll(io, s) catch {};
}

fn writeErrFmt(allocator: std.mem.Allocator, io: std.Io, comptime fmt: []const u8, args: anytype) !void {
    const s = try std.fmt.allocPrint(allocator, fmt, args);
    defer allocator.free(s);
    std.Io.File.stderr().writeStreamingAll(io, s) catch {};
}

fn readAllStdin(allocator: std.mem.Allocator, io: std.Io, max_size: usize) ![]u8 {
    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(allocator);
    var chunk: [4096]u8 = undefined;
    const stdin_file = std.Io.File.stdin();
    while (true) {
        // Zig 0.16 std.Io signals EOF via error.EndOfStream (not by
        // returning 0 like the old std.os.linux.read did). Catch it and
        // treat it as the loop terminator.
        const n = stdin_file.readStreaming(io, &.{&chunk}) catch |err| switch (err) {
            error.EndOfStream => 0,
            else => return err,
        };
        if (n == 0) break;
        if (buf.items.len + n > max_size) return error.StreamTooLong;
        try buf.appendSlice(allocator, chunk[0..n]);
    }
    return buf.toOwnedSlice(allocator);
}

// ─── stableStringify (port of scripts/fingerprint.js) ──────────────────────

pub fn stableStringify(allocator: std.mem.Allocator, v: Value) ![]u8 {
    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(allocator);
    try writeStable(allocator, &buf, v);
    return buf.toOwnedSlice(allocator);
}

fn writeStable(allocator: std.mem.Allocator, buf: *std.ArrayList(u8), v: Value) !void {
    switch (v) {
        .null_ => try buf.appendSlice(allocator, "null"),
        .bool_ => |b| try buf.appendSlice(allocator, if (b) "true" else "false"),
        .int_ => |i| {
            const s = try std.fmt.allocPrint(allocator, "{d}", .{i});
            defer allocator.free(s);
            try buf.appendSlice(allocator, s);
        },
        .float_ => |f| {
            if (std.math.isNan(f)) {
                try buf.appendSlice(allocator, "\"__nan__\"");
            } else if (std.math.isInf(f)) {
                if (f > 0) try buf.appendSlice(allocator, "\"__infinity__\"") else try buf.appendSlice(allocator, "\"__neg_infinity__\"");
            } else {
                const s = try std.fmt.allocPrint(allocator, "{d}", .{f});
                defer allocator.free(s);
                try buf.appendSlice(allocator, s);
            }
        },
        .string => |s| {
            try writeJsonString(allocator, buf, s);
        },
        .array => |arr| {
            try buf.append(allocator, '[');
            for (arr.items, 0..) |item, i| {
                if (i > 0) try buf.append(allocator, ',');
                try writeStable(allocator, buf, item);
            }
            try buf.append(allocator, ']');
        },
        .object => |obj| {
            try buf.append(allocator, '{');
            const keys = try allocator.alloc([]const u8, obj.count());
            defer allocator.free(keys);
            var it = obj.iterator();
            var i: usize = 0;
            while (it.next()) |entry| : (i += 1) {
                keys[i] = entry.key_ptr.*;
            }
            std.mem.sort([]const u8, keys, {}, struct {
                fn lt(_: void, a: []const u8, b: []const u8) bool {
                    return std.mem.lessThan(u8, a, b);
                }
            }.lt);
            for (keys, 0..) |key, j| {
                if (j > 0) try buf.append(allocator, ',');
                try writeJsonString(allocator, buf, key);
                try buf.append(allocator, ':');
                try writeStable(allocator, buf, obj.get(key).?);
            }
            try buf.append(allocator, '}');
        },
    }
}

fn writeJsonString(allocator: std.mem.Allocator, buf: *std.ArrayList(u8), s: []const u8) !void {
    try buf.append(allocator, '"');
    for (s) |c| {
        switch (c) {
            '"' => try buf.appendSlice(allocator, "\\\""),
            '\\' => try buf.appendSlice(allocator, "\\\\"),
            '\n' => try buf.appendSlice(allocator, "\\n"),
            '\r' => try buf.appendSlice(allocator, "\\r"),
            '\t' => try buf.appendSlice(allocator, "\\t"),
            '\x08' => try buf.appendSlice(allocator, "\\b"),
            '\x0C' => try buf.appendSlice(allocator, "\\f"),
            else => {
                if (c < 0x20) {
                    const esc = try std.fmt.allocPrint(allocator, "\\u{x:0>4}", .{c});
                    defer allocator.free(esc);
                    try buf.appendSlice(allocator, esc);
                } else {
                    try buf.append(allocator, c);
                }
            },
        }
    }
    try buf.append(allocator, '"');
}

// ─── fingerprint (port of scripts/fingerprint.js) ──────────────────────────
// sha256(stableStringify(input) + "|" + stableStringify(output)) → base36 → first 7 chars

pub fn fingerprint(allocator: std.mem.Allocator, input: Value, output: Value) ![]u8 {
    const input_str = try stableStringify(allocator, input);
    defer allocator.free(input_str);
    const output_str = try stableStringify(allocator, output);
    defer allocator.free(output_str);

    const combined = try allocator.alloc(u8, input_str.len + 1 + output_str.len);
    defer allocator.free(combined);
    @memcpy(combined[0..input_str.len], input_str);
    combined[input_str.len] = '|';
    @memcpy(combined[input_str.len + 1 ..], output_str);

    var hasher = Sha256.init(.{});
    hasher.update(combined);
    var hash_bytes: [32]u8 = undefined;
    hasher.final(&hash_bytes);

    // Convert 32-byte big-endian hash → base36 string.
    return base36FromBytes(allocator, &hash_bytes);
}

fn base36FromBytes(allocator: std.mem.Allocator, bytes: []const u8) ![]u8 {
    // Convert 32-byte big-endian hash → hex string → big int → base36.
    // std.math.big.int.toStringAlloc only supports bases up to 16, so we
    // implement base36 conversion manually via repeated division.
    var big = try std.math.big.int.Managed.init(allocator);
    defer big.deinit();

    // Build the hex string (64 chars for 32 bytes).
    const hex = try allocator.alloc(u8, bytes.len * 2);
    defer allocator.free(hex);
    const hex_chars = "0123456789abcdef";
    for (bytes, 0..) |b, i| {
        hex[i * 2] = hex_chars[b >> 4];
        hex[i * 2 + 1] = hex_chars[b & 0x0F];
    }

    try big.setString(16, hex);

    // Manual base36 conversion: repeatedly divmod by 36, collect digits.
    const base36_chars = "0123456789abcdefghijklmnopqrstuvwxyz";
    var result: std.ArrayList(u8) = .empty;
    errdefer result.deinit(allocator);

    var quotient = try std.math.big.int.Managed.init(allocator);
    defer quotient.deinit();
    var remainder = try std.math.big.int.Managed.init(allocator);
    defer remainder.deinit();
    var base_big = try std.math.big.int.Managed.initSet(allocator, @as(u8, 36));
    defer base_big.deinit();

    // Handle zero specially.
    if (big.toConst().eqlZero()) {
        try result.append(allocator, '0');
    } else {
        while (!big.toConst().eqlZero()) {
            // Managed.divFloor signature: (q, r, a, b) — all *Managed.
            try std.math.big.int.Managed.divFloor(
                &quotient,
                &remainder,
                &big,
                &base_big,
            );
            // Append the digit (remainder is in [0, 35]).
            const digit_idx: usize = @intCast(remainder.toConst().limbs[0]);
            try result.append(allocator, base36_chars[digit_idx]);
            // big = quotient
            try big.copy(quotient.toConst());
        }
    }

    // Reverse the digit list (we appended least-significant first).
    std.mem.reverse(u8, result.items);

    const b36 = try result.toOwnedSlice(allocator);
    defer allocator.free(b36);

    // Take first 7 chars.
    if (b36.len <= 7) {
        return allocator.dupe(u8, b36);
    }
    return allocator.dupe(u8, b36[0..7]);
}

// ─── JSON spec parser ──────────────────────────────────────────────────────

const ExpectedEntry = struct {
    hash: []const u8,
};

pub const Spec = struct {
    function: []const u8,
    multi_args: bool,
    inputs: std.ArrayList(Value),
    mode: []const u8,
    expected: std.ArrayList(ExpectedEntry),
    arena: std.heap.ArenaAllocator,

    pub fn deinit(self: *Spec) void {
        // Arena owns all the strings + ArrayLists.
        self.arena.deinit();
    }
};

pub fn parseSpec(allocator: std.mem.Allocator, raw: []const u8) !Spec {
    var arena = std.heap.ArenaAllocator.init(allocator);
    errdefer arena.deinit();
    const a = arena.allocator();

    // Zig 0.13+ API: parseFromSliceLeaky allocates into `a` and returns
    // std.json.Value directly (no Parsed wrapper to deinit).
    const root = try std.json.parseFromSliceLeaky(std.json.Value, a, raw, .{});
    if (root != .object) return error.InvalidSpec;

    var spec = Spec{
        .function = "",
        .multi_args = false,
        .inputs = .empty,
        .mode = "capture",
        .expected = .empty,
        .arena = arena,
    };

    if (root.object.get("function")) |v| {
        if (v == .string) spec.function = v.string;
    }
    if (root.object.get("multiArgs")) |v| {
        if (v == .bool) spec.multi_args = v.bool;
    }
    if (root.object.get("mode")) |v| {
        if (v == .string) spec.mode = v.string;
    }
    if (root.object.get("inputs")) |v| {
        if (v == .array) {
            for (v.array.items) |item| {
                const val = try jsonToValue(a, item);
                try spec.inputs.append(a, val);
            }
        }
    }
    if (root.object.get("expected")) |v| {
        if (v == .array) {
            for (v.array.items) |item| {
                if (item == .object) {
                    if (item.object.get("hash")) |h| {
                        if (h == .string and h.string.len > 0) {
                            try spec.expected.append(a, .{ .hash = h.string });
                        } else {
                            // null or empty string → no expected hash (INFO).
                            try spec.expected.append(a, .{ .hash = "" });
                        }
                    } else {
                        try spec.expected.append(a, .{ .hash = "" });
                    }
                }
            }
        }
    }
    return spec;
}

fn jsonToValue(allocator: std.mem.Allocator, jv: std.json.Value) anyerror!Value {
    return switch (jv) {
        .null => Value{ .null_ = {} },
        .bool => |b| Value{ .bool_ = b },
        .integer => |i| Value{ .int_ = i },
        .float => |f| Value{ .float_ = f },
        .number_string => |s| blk: {
            if (std.fmt.parseInt(i64, s, 10)) |i| {
                break :blk Value{ .int_ = i };
            } else |_| {
                const f = try std.fmt.parseFloat(f64, s);
                break :blk Value{ .float_ = f };
            }
        },
        .string => |s| Value{ .string = try allocator.dupe(u8, s) },
        .array => |arr| blk: {
            var list: std.ArrayList(Value) = .empty;
            errdefer {
                for (list.items) |item| item.deinit(allocator);
                list.deinit(allocator);
            }
            for (arr.items) |item| {
                try list.append(allocator, try jsonToValue(allocator, item));
            }
            break :blk Value{ .array = list };
        },
        .object => |obj| blk: {
            var map = std.StringArrayHashMapUnmanaged(Value){};
            errdefer {
                var it = map.iterator();
                while (it.next()) |entry| entry.value_ptr.deinit(allocator);
                map.deinit(allocator);
            }
            var it = obj.iterator();
            while (it.next()) |entry| {
                const key = try allocator.dupe(u8, entry.key_ptr.*);
                const val = try jsonToValue(allocator, entry.value_ptr.*);
                try map.put(allocator, key, val);
            }
            break :blk Value{ .object = map };
        },
    };
}

// ─── main loop ─────────────────────────────────────────────────────────────
// The per-cluster wrapper imports this module as `regret` and calls
// `regret.run(UserSource)` where UserSource exposes `regret_entry`.
//
// We use a comptime type parameter so the wrapper can pass its own
// user-source module.

pub fn run(comptime UserSource: type) !void {
    var gpa = std.heap.DebugAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    // Zig 0.16 std.Io requires an `Io` instance for all file I/O. The
    // Threaded backend is the cross-platform implementation (io_uring on
    // Linux, kqueue on *BSD/macOS, IOCP on Windows). Passing it through
    // every read/write call is the cost of the Writergate refactor — but
    // it's what makes the same binary work on Windows + Linux without
    // platform-specific syscall branches.
    var threaded = std.Io.Threaded.init(allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();

    const raw = try readAllStdin(allocator, io, 16 * 1024 * 1024);
    defer allocator.free(raw);

    var spec = try parseSpec(allocator, raw);
    defer spec.deinit();

    var pass_count: u32 = 0;
    var fail_count: u32 = 0;
    var info_count: u32 = 0;

    for (spec.inputs.items, 0..) |input_val, idx| {
        // Invoke the per-cluster wrapper's regret_entry.
        const result = UserSource.regret_entry(allocator, input_val) catch |err| {
            try writeOutFmt(allocator, io, "INPUT  {s}\n", .{try stableStringify(allocator, input_val)});
            try writeOutFmt(allocator, io, "ERROR  \"{s}\"\n", .{@errorName(err)});
            const fp = try fingerprint(allocator, input_val, .{ .string = "__threw__" });
            try writeOutFmt(allocator, io, "HASH   {s}\n", .{fp});
            if (std.mem.eql(u8, spec.mode, "validate")) {
                const expected_hash = if (idx < spec.expected.items.len) spec.expected.items[idx].hash else "";
                if (expected_hash.len > 0) {
                    if (std.mem.eql(u8, expected_hash, fp)) {
                        writeOut(io, "RESULT PASS\n");
                        pass_count += 1;
                    } else {
                        try writeOutFmt(allocator, io, "RESULT FAIL hash_mismatch expected={s} actual={s}\n", .{ expected_hash, fp });
                        fail_count += 1;
                    }
                } else {
                    writeOut(io, "RESULT INFO no_expected_hash\n");
                    info_count += 1;
                }
            }
            writeOut(io, "---\n");
            continue;
        };
        defer result.deinit(allocator);

        try writeOutFmt(allocator, io, "INPUT  {s}\n", .{try stableStringify(allocator, input_val)});
        try writeOutFmt(allocator, io, "OUTPUT {s}\n", .{try stableStringify(allocator, result)});
        const fp = try fingerprint(allocator, input_val, result);
        try writeOutFmt(allocator, io, "HASH   {s}\n", .{fp});

        if (std.mem.eql(u8, spec.mode, "validate")) {
            const expected_hash = if (idx < spec.expected.items.len) spec.expected.items[idx].hash else "";
            if (expected_hash.len > 0) {
                if (std.mem.eql(u8, expected_hash, fp)) {
                    writeOut(io, "RESULT PASS\n");
                    pass_count += 1;
                } else {
                    try writeOutFmt(allocator, io, "RESULT FAIL hash_mismatch expected={s} actual={s}\n", .{ expected_hash, fp });
                    fail_count += 1;
                }
            } else {
                writeOut(io, "RESULT INFO no_expected_hash\n");
                info_count += 1;
            }
        }
        writeOut(io, "---\n");
    }

    if (std.mem.eql(u8, spec.mode, "validate")) {
        try writeErrFmt(allocator, io, "VALIDATE SUMMARY: {} pass, {} fail, {} info\n", .{ pass_count, fail_count, info_count });
        if (fail_count > 0) std.process.exit(1);
    }
}
REGRET_RUNNER_EOF

[[ $VERBOSE -eq 1 ]] && echo "Generated shared runner: $RUNNER_DIR/regret_runner.zig"

# ─── For each cluster: generate per-cluster wrapper, compile, run, write .regret ─

CAPTURED_COUNT=0
FAILED_COUNT=0

CLUSTER_LINES_FILE="$(mktemp)"
trap 'rm -f "$CLUSTER_LINES_FILE"' EXIT

echo "$CLUSTERS_JSON" | node -e "
  const clusters = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  for (const c of clusters) {
    console.log(JSON.stringify({
      id: c.id,
      entry: c.entry,
      file: c.file,
      multiArgs: !!c.multiArgs,
      inputs: c.inputs || [],
    }));
  }
" > "$CLUSTER_LINES_FILE"

while IFS= read -r cluster_line; do
  CLUSTER_ID=$(echo "$cluster_line" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).id)")
  CLUSTER_ENTRY=$(echo "$cluster_line" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).entry)")
  CLUSTER_FILE=$(echo "$cluster_line" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).file)")
  CLUSTER_MULTI=$(echo "$cluster_line" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).multiArgs)")

  [[ $QUIET -eq 1 ]] || echo "  Capturing: $CLUSTER_ID ($CLUSTER_ENTRY)"

  SOURCE_PATH="${PROJECT_DIR}/${CLUSTER_FILE}"
  if [[ ! -f "$SOURCE_PATH" ]]; then
    echo "❌ Source file not found for cluster '$CLUSTER_ID': $SOURCE_PATH" >&2
    FAILED_COUNT=$((FAILED_COUNT + 1))
    continue
  fi

  # Zig 0.13's @import does not allow paths outside the main module's
  # directory tree (no `..` allowed). We copy the user's source file
  # into the runner dir under a fixed name `user_source.zig` so the
  # per-cluster main can @import it via a relative path.
  # The copy is regenerated each capture run, so edits to the original
  # source are picked up.
  COPIED_SOURCE="${RUNNER_DIR}/user_source.zig"
  cp "$SOURCE_PATH" "$COPIED_SOURCE"

  # Generate the per-cluster main.zig that wires everything together.
  # This file:
  #   1. @imports the shared runner lib (regret_runner.zig, same dir).
  #   2. @imports the user's source file (relative path).
  #   3. Defines a regret_entry(allocator, input) !Value wrapper that
  #      coerces the runtime Value → native Zig args, calls the user's
  #      pub fn (by comptime-known name), and packs the return back to Value.
  #   4. Calls regret.run(MainModule) where MainModule is this file.

  MAIN_FILE="${RUNNER_DIR}/main_${CLUSTER_ID}.zig"

  cat > "$MAIN_FILE" << ZIG_MAIN_EOF
// AUTO-GENERATED per-cluster main for $CLUSTER_ID ($CLUSTER_ENTRY).
const std = @import("std");
const regret = @import("regret_runner.zig");
const Value = regret.Value;
const user = @import("user_source.zig");

pub fn regret_entry(allocator: std.mem.Allocator, input: Value) !Value {
    return invoke(allocator, input);
}

fn invoke(allocator: std.mem.Allocator, input: Value) !Value {
    // Dispatch based on input shape.
    switch (input) {
        .array => |arr| {
            if (arr.items.len == 0) {
                return error.UnsupportedArity;
            } else if (arr.items.len == 1) {
                return callOne(allocator, arr.items[0]);
            } else if (arr.items.len == 2) {
                return callTwo(allocator, arr.items[0], arr.items[1]);
            } else {
                return error.UnsupportedArity;
            }
        },
        else => {
            // Single-arg call (input is a non-array value).
            return callOne(allocator, input);
        },
    }
}

fn callOne(allocator: std.mem.Allocator, a: Value) !Value {
    // Zig 0.14+: @typeInfo(T).@"fn" (was .Fn in 0.13 and earlier)
    const FnType = @TypeOf(user.$CLUSTER_ENTRY);
    const fn_info = @typeInfo(FnType).@"fn";
    const params = fn_info.params;
    const ReturnTy = fn_info.return_type orelse return error.UnsupportedSignature;

    // Detect error union return — strip it to get the payload type.
    const return_info = @typeInfo(ReturnTy);
    const PayloadTy = switch (return_info) {
        .error_union => |eu| eu.payload,
        else => ReturnTy,
    };
    const is_error_union = return_info == .error_union;

    if (params.len == 1) {
        // (input: []const u8) → T
        if (params[0].type == []const u8 or params[0].type == []u8) {
            const s = valueToString(allocator, a) catch return error.TypeMismatch;
            defer allocator.free(s);
            // Dispatch on return type
            switch (@typeInfo(PayloadTy)) {
                .pointer => |p| {
                    if (p.size == .slice and p.child == u8) {
                        // → []u8 / []const u8
                        const result = if (is_error_union)
                            try @call(.auto, user.$CLUSTER_ENTRY, .{s})
                        else
                            @call(.auto, user.$CLUSTER_ENTRY, .{s});
                        return Value{ .string = result };
                    }
                    return error.UnsupportedSignature;
                },
                .int => {
                    // → i64
                    const result = if (is_error_union)
                        try @call(.auto, user.$CLUSTER_ENTRY, .{s})
                    else
                        @call(.auto, user.$CLUSTER_ENTRY, .{s});
                    return Value{ .int_ = result };
                },
                .bool => {
                    // → bool
                    const result = if (is_error_union)
                        try @call(.auto, user.$CLUSTER_ENTRY, .{s})
                    else
                        @call(.auto, user.$CLUSTER_ENTRY, .{s});
                    return Value{ .bool_ = result };
                },
                else => return error.UnsupportedSignature,
            }
        }
        // (a: i64) → T
        if (params[0].type == i64) {
            const a_int = valueToInt(a) orelse return error.TypeMismatch;
            switch (@typeInfo(PayloadTy)) {
                .int => {
                    const result = if (is_error_union)
                        try @call(.auto, user.$CLUSTER_ENTRY, .{a_int})
                    else
                        @call(.auto, user.$CLUSTER_ENTRY, .{a_int});
                    return Value{ .int_ = result };
                },
                .bool => {
                    // (i64) → bool — e.g. isEven
                    const result = if (is_error_union)
                        try @call(.auto, user.$CLUSTER_ENTRY, .{a_int})
                    else
                        @call(.auto, user.$CLUSTER_ENTRY, .{a_int});
                    return Value{ .bool_ = result };
                },
                else => return error.UnsupportedSignature,
            }
        }
    }
    if (params.len == 2) {
        // (allocator, input: []const u8) → T
        if (params[0].type == std.mem.Allocator) {
            if (params[1].type == []const u8 or params[1].type == []u8) {
                const s = valueToString(allocator, a) catch return error.TypeMismatch;
                defer allocator.free(s);
                switch (@typeInfo(PayloadTy)) {
                    .pointer => |p| {
                        if (p.size == .slice and p.child == u8) {
                            const result = if (is_error_union)
                                try @call(.auto, user.$CLUSTER_ENTRY, .{ allocator, s })
                            else
                                @call(.auto, user.$CLUSTER_ENTRY, .{ allocator, s });
                            return Value{ .string = result };
                        }
                        return error.UnsupportedSignature;
                    },
                    else => return error.UnsupportedSignature,
                }
            }
        }
    }
    return error.UnsupportedSignature;
}

fn callTwo(allocator: std.mem.Allocator, a: Value, b: Value) !Value {
    const FnType = @TypeOf(user.$CLUSTER_ENTRY);
    const fn_info = @typeInfo(FnType).@"fn";
    const params = fn_info.params;
    const ReturnTy = fn_info.return_type orelse return error.UnsupportedSignature;
    const return_info = @typeInfo(ReturnTy);
    const PayloadTy = switch (return_info) {
        .error_union => |eu| eu.payload,
        else => ReturnTy,
    };
    const is_error_union = return_info == .error_union;

    if (params.len == 2) {
        // (a: i64, b: i64) → T
        if (params[0].type == i64 and params[1].type == i64) {
            const a_int = valueToInt(a) orelse return error.TypeMismatch;
            const b_int = valueToInt(b) orelse return error.TypeMismatch;
            switch (@typeInfo(PayloadTy)) {
                .int => {
                    const result = if (is_error_union)
                        try @call(.auto, user.$CLUSTER_ENTRY, .{ a_int, b_int })
                    else
                        @call(.auto, user.$CLUSTER_ENTRY, .{ a_int, b_int });
                    return Value{ .int_ = result };
                },
                .bool => {
                    const result = if (is_error_union)
                        try @call(.auto, user.$CLUSTER_ENTRY, .{ a_int, b_int })
                    else
                        @call(.auto, user.$CLUSTER_ENTRY, .{ a_int, b_int });
                    return Value{ .bool_ = result };
                },
                else => return error.UnsupportedSignature,
            }
        }
    }
    if (params.len == 3) {
        // (allocator, T_in, T_aux) → []u8
        if (params[0].type == std.mem.Allocator) {
            if (params[1].type == []const u8 or params[1].type == []u8) {
                const name = valueToString(allocator, a) catch return error.TypeMismatch;
                defer allocator.free(name);
                // Dispatch on the third param type
                if (params[2].type == bool) {
                    const excited = valueToBool(b) orelse return error.TypeMismatch;
                    switch (@typeInfo(PayloadTy)) {
                        .pointer => |p| {
                            if (p.size == .slice and p.child == u8) {
                                const result = if (is_error_union)
                                    try @call(.auto, user.$CLUSTER_ENTRY, .{ allocator, name, excited })
                                else
                                    @call(.auto, user.$CLUSTER_ENTRY, .{ allocator, name, excited });
                                return Value{ .string = result };
                            }
                            return error.UnsupportedSignature;
                        },
                        else => return error.UnsupportedSignature,
                    }
                }
                if (params[2].type == i64) {
                    // (allocator, []const u8, i64) → []u8 — e.g. repeat
                    const n = valueToInt(b) orelse return error.TypeMismatch;
                    switch (@typeInfo(PayloadTy)) {
                        .pointer => |p| {
                            if (p.size == .slice and p.child == u8) {
                                const result = if (is_error_union)
                                    try @call(.auto, user.$CLUSTER_ENTRY, .{ allocator, name, n })
                                else
                                    @call(.auto, user.$CLUSTER_ENTRY, .{ allocator, name, n });
                                return Value{ .string = result };
                            }
                            return error.UnsupportedSignature;
                        },
                        else => return error.UnsupportedSignature,
                    }
                }
            }
        }
    }
    return error.UnsupportedSignature;
}

fn valueToInt(v: Value) ?i64 {
    return switch (v) {
        .int_ => |i| i,
        .float_ => |f| @as(i64, @intFromFloat(f)),
        else => null,
    };
}

fn valueToBool(v: Value) ?bool {
    return switch (v) {
        .bool_ => |b| b,
        else => null,
    };
}

fn valueToString(allocator: std.mem.Allocator, v: Value) ![]u8 {
    return switch (v) {
        .string => |s| try allocator.dupe(u8, s),
        else => return error.TypeMismatch,
    };
}

pub fn main() !void {
    try regret.run(@This());
}
ZIG_MAIN_EOF

  [[ $VERBOSE -eq 1 ]] && echo "    Generated main: $MAIN_FILE"

  # Build the invocation spec JSON.
  INVOCATION_SPEC=$(echo "$cluster_line" | node -e "
    const c = JSON.parse(require('fs').readFileSync(0,'utf8'));
    console.log(JSON.stringify({
      function: c.entry,
      multiArgs: c.multiArgs,
      mode: 'capture',
      inputs: c.inputs,
    }));
  ")

  SPEC_FILE="${RUNNER_DIR}/spec_${CLUSTER_ID}.json"
  echo "$INVOCATION_SPEC" > "$SPEC_FILE"

  [[ $VERBOSE -eq 1 ]] && echo "    Compiling + running..."

  # Run with zig run. The main file is in $RUNNER_DIR, so @import("regret_runner.zig")
  # resolves to $RUNNER_DIR/regret_runner.zig (same dir).
  set +e
  RUNNER_OUTPUT=$(cat "$SPEC_FILE" | "$ZIG_BIN" run "$MAIN_FILE" 2> "$RUNNER_DIR/zig.err")
  RUNNER_RC=$?
  set -e

  if [[ $RUNNER_RC -ne 0 ]]; then
    echo "❌ Zig runner failed for cluster '$CLUSTER_ID' (rc=$RUNNER_RC):" >&2
    cat "$RUNNER_DIR/zig.err" >&2
    FAILED_COUNT=$((FAILED_COUNT + 1))
    continue
  fi

  # Parse runner output: extract first INPUT/OUTPUT/HASH triplet as golden.
  GOLDEN_INPUT=$(echo "$RUNNER_OUTPUT" | grep -m1 '^INPUT ' | sed 's/^INPUT  //')
  GOLDEN_OUTPUT=$(echo "$RUNNER_OUTPUT" | grep -m1 '^OUTPUT ' | sed 's/^OUTPUT //')
  GOLDEN_HASH=$(echo "$RUNNER_OUTPUT" | grep -m1 '^HASH ' | sed 's/^HASH   //')

  if [[ -z "$GOLDEN_INPUT" || -z "$GOLDEN_HASH" ]]; then
    echo "❌ Runner output missing INPUT/HASH for cluster '$CLUSTER_ID':" >&2
    echo "$RUNNER_OUTPUT" >&2
    FAILED_COUNT=$((FAILED_COUNT + 1))
    continue
  fi

  # Write the .regret file.
  REGRET_PATH="${REGRET_DIR}/${CLUSTER_ID}.regret"
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")

  {
    echo "cluster: ${CLUSTER_ID}"
    echo "version: 1"
    echo "fingerprint: ${GOLDEN_HASH}"
    echo "captured: ${TIMESTAMP}"
    echo "watches: [${CLUSTER_ENTRY}]"
    echo "entry: ${CLUSTER_ENTRY}"
    echo "stack: zig"
    echo "fingerprintLevel: entry"
    echo "multiArgs: ${CLUSTER_MULTI}"
    echo "env: {\"zig_version\":\"$("${ZIG_BIN}" version 2>&1 | head -1)\"}"
    echo "---"
    echo "INPUT  ${GOLDEN_INPUT}"
    echo "OUTPUT ${GOLDEN_OUTPUT}"
    echo "HASH   ${GOLDEN_HASH}"
  } > "$REGRET_PATH"

  [[ $QUIET -eq 1 ]] || echo "    ✓ ${REGRET_PATH#${PROJECT_DIR}/}"
  CAPTURED_COUNT=$((CAPTURED_COUNT + 1))
done < "$CLUSTER_LINES_FILE"

[[ $QUIET -eq 1 ]] || echo ""
[[ $QUIET -eq 1 ]] || echo "Done. Captured: ${CAPTURED_COUNT}, Failed: ${FAILED_COUNT}"

[[ $VERBOSE -eq 1 ]] || rm -rf "$RUNNER_DIR"

exit 0
