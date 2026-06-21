#!/usr/bin/env bash
# validate_zig.sh — re-invoke Zig cluster functions and compare hashes
#
# Reads .regret files written by capture_zig.sh, regenerates the same
# shared runner (regret_runner.zig) and per-cluster main, re-runs each
# function with the input recorded in the .regret file, and compares
# the freshly-computed hash against the stored HASH field. Reports
# PASS/FAIL per input and exits non-zero if any input's hash mismatches.
#
# Usage:
#   bash scripts/validate_zig.sh                 # validate all Zig clusters
#   bash scripts/validate_zig.sh --cluster add   # validate one cluster
#   bash scripts/validate_zig.sh --manifest ./regrets/manifest.json
#   bash scripts/validate_zig.sh --quiet
#   bash scripts/validate_zig.sh --verbose
#
# Exit codes:
#   0 — all clusters PASS (all inputs match)
#   1 — at least one cluster FAILed (hash mismatch or runtime error)
#   2 — environment error (zig/node missing, manifest not found)
#
# The validate script shares the runner with capture_zig.sh — the same
# regret_runner.zig is regenerated via --emit-runner. Only the invocation
# mode differs ("validate" vs "capture"), and in validate mode the runner
# also prints RESULT PASS/FAIL lines per input.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"

# ─── Locate zig (same logic as capture_zig.sh) ──────────────────────────────

ZIG_BIN="${ZIG_BIN:-}"
if [[ -z "$ZIG_BIN" ]]; then
  if command -v zig &>/dev/null; then
    ZIG_BIN="$(command -v zig)"
  fi
fi

if [[ -z "$ZIG_BIN" ]]; then
  echo "❌ zig not found. Install Zig 0.13.0+ or set ZIG_BIN." >&2
  exit 2
fi

if ! command -v node &>/dev/null; then
  echo "❌ node not found. Install Node.js 16+ (used for JSON parsing)." >&2
  exit 2
fi

# ─── Parse CLI args ──────────────────────────────────────────────────────────

CLUSTER_FILTER=""
QUIET=0
VERBOSE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster) CLUSTER_FILTER="$2"; shift 2 ;;
    --manifest) MANIFEST="$2"; shift 2 ;;
    --quiet) QUIET=1; shift ;;
    --verbose) VERBOSE=1; shift ;;
    *)
      echo "Unknown arg: $1" >&2
      echo "Usage: bash scripts/validate_zig.sh [--cluster <id>] [--manifest <path>] [--quiet] [--verbose]" >&2
      exit 2
      ;;
  esac
done

[[ $QUIET -eq 1 ]] || echo "🔍 Validating Zig clusters from $MANIFEST"

if [[ ! -f "$MANIFEST" ]]; then
  echo "❌ Manifest not found: $MANIFEST" >&2
  exit 2
fi

# ─── Read Zig clusters from manifest ────────────────────────────────────────

CLUSTERS_JSON=$(node -e "
  const m = JSON.parse(require('fs').readFileSync('$MANIFEST', 'utf8'));
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

# ─── Generate the shared runner (same as capture_zig.sh) ────────────────────

RUNNER_DIR="${PROJECT_DIR}/.regret-zig-build"
mkdir -p "$RUNNER_DIR"

bash "$SCRIPT_DIR/capture_zig.sh" --emit-runner "$RUNNER_DIR/regret_runner.zig" 2>/dev/null

if [[ ! -f "$RUNNER_DIR/regret_runner.zig" ]]; then
  echo "❌ Failed to generate regret_runner.zig via capture_zig.sh --emit-runner" >&2
  exit 2
fi

[[ $VERBOSE -eq 1 ]] && echo "Generated shared runner: $RUNNER_DIR/regret_runner.zig"

# ─── For each cluster: read .regret, re-run function, compare hash ──────────

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

CLUSTER_LINES_FILE="$(mktemp)"
trap 'rm -f "$CLUSTER_LINES_FILE"' EXIT

echo "$CLUSTERS_JSON" | node -e "
  const clusters = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
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
  CLUSTER_ID=$(echo "$cluster_line" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).id)")
  CLUSTER_ENTRY=$(echo "$cluster_line" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).entry)")
  CLUSTER_FILE=$(echo "$cluster_line" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).file)")

  REGRET_PATH="${REGRET_DIR}/${CLUSTER_ID}.regret"
  if [[ ! -f "$REGRET_PATH" ]]; then
    echo "  ⚠️  SKIP $CLUSTER_ID: no .regret file at $REGRET_PATH"
    SKIP_COUNT=$((SKIP_COUNT + 1))
    continue
  fi

  [[ $QUIET -eq 1 ]] || echo "  Validating: $CLUSTER_ID ($CLUSTER_ENTRY)"

  SOURCE_PATH="${PROJECT_DIR}/${CLUSTER_FILE}"
  if [[ ! -f "$SOURCE_PATH" ]]; then
    echo "❌ Source file not found for cluster '$CLUSTER_ID': $SOURCE_PATH" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
    continue
  fi

  # Read expected hash from the .regret file (the first HASH line).
  EXPECTED_HASH=$(grep -m1 '^HASH ' "$REGRET_PATH" | sed 's/^HASH   //')

  # Copy the user source into the runner dir (same as capture).
  COPIED_SOURCE="${RUNNER_DIR}/user_source.zig"
  cp "$SOURCE_PATH" "$COPIED_SOURCE"

  # Generate the per-cluster main.zig (same as capture — but we run it
  # in validate mode by setting mode:"validate" in the spec).
  MAIN_FILE="${RUNNER_DIR}/main_${CLUSTER_ID}.zig"

  cat > "$MAIN_FILE" << ZIG_MAIN_EOF
// AUTO-GENERATED per-cluster main for $CLUSTER_ID ($CLUSTER_ENTRY) — validate mode.
const std = @import("std");
const regret = @import("regret_runner.zig");
const Value = regret.Value;
const user = @import("user_source.zig");

pub fn regret_entry(allocator: std.mem.Allocator, input: Value) !Value {
    return invoke(allocator, input);
}

fn invoke(allocator: std.mem.Allocator, input: Value) !Value {
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
            return callOne(allocator, input);
        },
    }
}

fn callOne(allocator: std.mem.Allocator, a: Value) !Value {
    const FnType = @TypeOf(user.$CLUSTER_ENTRY);
    const fn_info = @typeInfo(FnType).Fn;
    const params = fn_info.params;

    if (params.len == 1) {
        if (params[0].type == []const u8 or params[0].type == []u8) {
            const s = valueToString(allocator, a) catch return error.TypeMismatch;
            defer allocator.free(s);
            const result = try @call(.auto, user.$CLUSTER_ENTRY, .{s});
            return Value{ .string = result };
        }
        if (params[0].type == i64) {
            const a_int = valueToInt(a) orelse return error.TypeMismatch;
            const result = @call(.auto, user.$CLUSTER_ENTRY, .{a_int});
            return Value{ .int_ = result };
        }
    }
    if (params.len == 2) {
        if (params[0].type == std.mem.Allocator) {
            if (params[1].type == []const u8 or params[1].type == []u8) {
                const s = valueToString(allocator, a) catch return error.TypeMismatch;
                defer allocator.free(s);
                const result = try @call(.auto, user.$CLUSTER_ENTRY, .{ allocator, s });
                return Value{ .string = result };
            }
        }
    }
    return error.UnsupportedSignature;
}

fn callTwo(allocator: std.mem.Allocator, a: Value, b: Value) !Value {
    const FnType = @TypeOf(user.$CLUSTER_ENTRY);
    const fn_info = @typeInfo(FnType).Fn;
    const params = fn_info.params;

    if (params.len == 2) {
        if (params[0].type == i64 and params[1].type == i64) {
            const a_int = valueToInt(a) orelse return error.TypeMismatch;
            const b_int = valueToInt(b) orelse return error.TypeMismatch;
            const result = @call(.auto, user.$CLUSTER_ENTRY, .{ a_int, b_int });
            return Value{ .int_ = result };
        }
    }
    if (params.len == 3) {
        if (params[0].type == std.mem.Allocator) {
            if (params[1].type == []const u8 or params[1].type == []u8) {
                if (params[2].type == bool) {
                    const name = valueToString(allocator, a) catch return error.TypeMismatch;
                    defer allocator.free(name);
                    const excited = valueToBool(b) orelse return error.TypeMismatch;
                    const result = try @call(.auto, user.$CLUSTER_ENTRY, .{ allocator, name, excited });
                    return Value{ .string = result };
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

  # Build invocation spec for validate mode: include expected hashes per input.
  # The .regret file's HASH line gives the expected hash for input[0].
  # For inputs 1+, the runner prints INFO (no stored hash to compare).
  INVOCATION_SPEC=$(echo "$cluster_line" | node -e "
    const c = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const expectedHash = '${EXPECTED_HASH}';
    const expected = c.inputs.map((inp, i) => ({
      input: inp,
      hash: i === 0 ? expectedHash : null,
    }));
    console.log(JSON.stringify({
      function: c.entry,
      multiArgs: c.multiArgs,
      mode: 'validate',
      inputs: c.inputs,
      expected: expected,
    }));
  ")

  SPEC_FILE="${RUNNER_DIR}/spec_${CLUSTER_ID}.json"
  echo "$INVOCATION_SPEC" > "$SPEC_FILE"

  [[ $VERBOSE -eq 1 ]] && echo "    Compiling + running validator..."

  set +e
  RUNNER_OUTPUT=$(cat "$SPEC_FILE" | "$ZIG_BIN" run "$MAIN_FILE" 2> "$RUNNER_DIR/zig.err")
  RUNNER_RC=$?
  set -e

  PASS_INPUTS=$(echo "$RUNNER_OUTPUT" | grep -c '^RESULT PASS' || true)
  FAIL_INPUTS=$(echo "$RUNNER_OUTPUT" | grep -c '^RESULT FAIL' || true)

  if [[ $VERBOSE -eq 1 ]]; then
    echo "$RUNNER_OUTPUT" | sed 's/^/    /'
    cat "$RUNNER_DIR/zig.err" | sed 's/^/    [stderr] /' >&2
  fi

  if [[ "$FAIL_INPUTS" -gt 0 || $RUNNER_RC -ne 0 ]]; then
    [[ $QUIET -eq 1 ]] || echo "    ❌ FAIL ($PASS_INPUTS pass, $FAIL_INPUTS fail)"
    if [[ $VERBOSE -eq 1 ]]; then
      echo "$RUNNER_OUTPUT" | grep '^RESULT FAIL' | sed 's/^/      /'
    fi
    FAIL_COUNT=$((FAIL_COUNT + 1))
  else
    [[ $QUIET -eq 1 ]] || echo "    ✓ PASS ($PASS_INPUTS input(s))"
    PASS_COUNT=$((PASS_COUNT + 1))
  fi
done < "$CLUSTER_LINES_FILE"

[[ $QUIET -eq 1 ]] || echo ""
[[ $QUIET -eq 1 ]] || echo "Validate summary: $PASS_COUNT pass, $FAIL_COUNT fail, $SKIP_COUNT skipped"

[[ $VERBOSE -eq 1 ]] || rm -rf "$RUNNER_DIR"

if [[ $FAIL_COUNT -gt 0 ]]; then
  exit 1
fi
exit 0
