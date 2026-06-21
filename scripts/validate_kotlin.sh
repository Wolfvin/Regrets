#!/usr/bin/env bash
# validate_kotlin.sh — re-invoke Kotlin cluster functions and compare hashes
#
# Reads .regret files written by capture_kotlin.sh, regenerates the Kotlin
# runner (same algorithm as capture), re-runs each function with the input
# recorded in the .regret file, and compares the freshly-computed hash
# against the stored HASH field. Reports PASS/FAIL per input and exits
# non-zero if any input's hash mismatches.
#
# Usage:
#   bash scripts/validate_kotlin.sh                 # validate all Kotlin clusters
#   bash scripts/validate_kotlin.sh --cluster add   # validate one cluster
#   bash scripts/validate_kotlin.sh --manifest ./regrets/manifest.json
#   bash scripts/validate_kotlin.sh --quiet
#   bash scripts/validate_kotlin.sh --verbose
#
# Exit codes:
#   0 — all clusters PASS (all inputs match)
#   1 — at least one cluster FAILed (hash mismatch or runtime error)
#   2 — environment error (kotlinc/java missing, manifest not found)
#
# The validate script shares the runner with capture_kotlin.sh — the same
# RegretRunner.kt is regenerated and compiled. Only the invocation mode
# differs ("validate" vs "capture"), and in validate mode the runner also
# prints RESULT PASS/FAIL lines per input.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"

# ─── Locate kotlinc (same logic as capture_kotlin.sh) ──────────────────────

KOTLINC_BIN=""
if [[ -n "${KOTLINC_HOME:-}" && -x "${KOTLINC_HOME}/bin/kotlinc" ]]; then
  KOTLINC_BIN="${KOTLINC_HOME}/bin/kotlinc"
elif command -v kotlinc &>/dev/null; then
  KOTLINC_BIN="$(command -v kotlinc)"
fi

if [[ -z "$KOTLINC_BIN" ]]; then
  echo "❌ kotlinc not found. Install Kotlin or set KOTLINC_HOME." >&2
  exit 2
fi

KOTLINC_DIR="$(dirname "$KOTLINC_BIN")"
KOTLIN_HOME_DIR="$(dirname "$KOTLINC_DIR")"
KOTLIN_LIB_DIR="$KOTLIN_HOME_DIR/lib"

if ! command -v java &>/dev/null; then
  echo "❌ java not found. Install JDK 11+." >&2
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
      echo "Usage: bash scripts/validate_kotlin.sh [--cluster <id>] [--manifest <path>] [--quiet] [--verbose]" >&2
      exit 2
      ;;
  esac
done

[[ $QUIET -eq 1 ]] || echo "🔍 Validating Kotlin clusters from $MANIFEST"

if [[ ! -f "$MANIFEST" ]]; then
  echo "❌ Manifest not found: $MANIFEST" >&2
  exit 2
fi

# ─── Read Kotlin clusters from manifest ─────────────────────────────────────

CLUSTERS_JSON=$(node -e "
  const m = JSON.parse(require('fs').readFileSync('$MANIFEST', 'utf8'));
  let cs = (m.clusters || []).filter(c => c.stack === 'kotlin');
  if ('$CLUSTER_FILTER') {
    cs = cs.filter(c => c.id === '$CLUSTER_FILTER');
  }
  console.log(JSON.stringify(cs));
")

if [[ "$CLUSTERS_JSON" == "[]" ]]; then
  [[ $QUIET -eq 1 ]] || echo "No Kotlin clusters found in manifest."
  exit 0
fi

# ─── Generate the runner (same as capture_kotlin.sh) ────────────────────────

RUNNER_DIR="${PROJECT_DIR}/.regret-kotlin-build"
mkdir -p "$RUNNER_DIR"

# We reuse capture_kotlin.sh's runner by sourcing the heredoc. To avoid
# duplicating the runner code, we extract it from capture_kotlin.sh itself.
# Approach: run capture_kotlin.sh in dry-run mode? Simpler: just duplicate
# the heredoc here. The runner is intentionally identical to capture's so
# the fingerprint computation cannot drift.
#
# To keep the two scripts in sync, validate_kotlin.sh delegates the runner
# generation to capture_kotlin.sh by invoking it with a hidden --emit-runner
# flag. This is the simplest way to guarantee the same code path.

bash "$SCRIPT_DIR/capture_kotlin.sh" --emit-runner "$RUNNER_DIR/RegretRunner.kt" 2>/dev/null

if [[ ! -f "$RUNNER_DIR/RegretRunner.kt" ]]; then
  echo "❌ Failed to generate RegretRunner.kt via capture_kotlin.sh --emit-runner" >&2
  exit 2
fi

[[ $VERBOSE -eq 1 ]] && echo "Generated runner: $RUNNER_DIR/RegretRunner.kt"

# ─── For each cluster: read .regret, re-run function, compare hash ─────────

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
      kotlinPackage: c.kotlinPackage || '',
      multiArgs: !!c.multiArgs,
      inputs: c.inputs || [],
    }));
  }
" > "$CLUSTER_LINES_FILE"

while IFS= read -r cluster_line; do
  CLUSTER_ID=$(echo "$cluster_line" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).id)")
  CLUSTER_ENTRY=$(echo "$cluster_line" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).entry)")
  CLUSTER_FILE=$(echo "$cluster_line" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).file)")
  CLUSTER_PKG=$(echo "$cluster_line" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).kotlinPackage)")
  CLUSTER_MULTI=$(echo "$cluster_line" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).multiArgs)")

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

  FILE_BASENAME="$(basename "$CLUSTER_FILE" .kt)"
  FILE_CLASS_NAME="${FILE_BASENAME}Kt"

  # Read expected hashes from the .regret file (one per input).
  # The .regret file's data section has the FIRST input as INPUT/OUTPUT/HASH.
  # For multi-input clusters, we re-derive each input's hash by re-running
  # the function with each input from the manifest.
  # The .regret file only stores the FIRST input's hash as the "golden" —
  # validate re-runs all inputs and compares each against the manifest inputs.

  # Build expected array: one {input, hash?} per input from manifest.
  # The .regret file's HASH line gives us the expected hash for input[0].
  # For inputs 1+, the JS stack uses an INPUTS line (not yet ported here).
  # Issue #358 verification: parse the INPUTS line from the .regret file
  # to get ALL expected hashes (not just the golden). This lets validate
  # re-check every input, catching breaking refactors that only affect
  # input 2+. Falls back to golden-only for old .regret files without INPUTS.
  EXPECTED_HASH=$(grep -m1 '^HASH ' "$REGRET_PATH" | sed 's/^HASH   //')
  INPUTS_LINE=$(grep -m1 '^INPUTS ' "$REGRET_PATH" | sed 's/^INPUTS //')

  # Build the expected array: if INPUTS line exists, use it; else fall back
  # to golden-only (input 0 gets EXPECTED_HASH, inputs 1+ get null).
  if [[ -n "$INPUTS_LINE" ]]; then
    EXPECTED_ARRAY="$INPUTS_LINE"
  else
    EXPECTED_ARRAY=""
  fi

  # Compile source + runner.
  COMPILE_DIR="${RUNNER_DIR}/classes-${CLUSTER_ID}"
  rm -rf "$COMPILE_DIR"
  mkdir -p "$COMPILE_DIR"

  [[ $VERBOSE -eq 1 ]] && echo "    Compiling $SOURCE_PATH + runner..."

  if ! "$KOTLINC_BIN" \
      -cp "$KOTLIN_LIB_DIR/kotlin-stdlib.jar" \
      -no-stdlib -no-reflect \
      -d "$COMPILE_DIR" \
      "$SOURCE_PATH" "$RUNNER_DIR/RegretRunner.kt" 2> "$RUNNER_DIR/kotlinc.err"; then
    echo "❌ kotlinc failed for cluster '$CLUSTER_ID':" >&2
    cat "$RUNNER_DIR/kotlinc.err" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
    continue
  fi

  # Build invocation spec for validate mode: include expected hashes per input.
  # If the .regret file has an INPUTS line, parse it and pass ALL hashes to
  # the runner. Otherwise, fall back to golden-only (input 0 only).
  if [[ -n "$EXPECTED_ARRAY" ]]; then
    INVOCATION_SPEC=$(echo "$cluster_line" | node -e "
      const c = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const inputsArr = JSON.parse('${EXPECTED_ARRAY}');
      // inputsArr is [{hash, input, output}, ...] — extract hashes in order
      const expected = inputsArr.map((e, i) => ({
        input: c.inputs[i] !== undefined ? c.inputs[i] : e.input,
        hash: e.hash || null,
      }));
      console.log(JSON.stringify({
        function: c.entry,
        package: c.kotlinPackage,
        fileClassName: '${FILE_CLASS_NAME}',
        multiArgs: c.multiArgs,
        inputs: c.inputs,
        expected: expected,
      }));
    ")
  else
    # Fallback: old .regret file without INPUTS — only validate input 0
    INVOCATION_SPEC=$(echo "$cluster_line" | node -e "
      const c = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const expectedHash = '${EXPECTED_HASH}';
      const expected = c.inputs.map((inp, i) => ({
        input: inp,
        hash: i === 0 ? expectedHash : null,
      }));
      console.log(JSON.stringify({
        function: c.entry,
        package: c.kotlinPackage,
        fileClassName: '${FILE_CLASS_NAME}',
        multiArgs: c.multiArgs,
        inputs: c.inputs,
        expected: expected,
      }));
    ")
  fi

  RUNNER_CP="${COMPILE_DIR}:${KOTLIN_LIB_DIR}/kotlin-stdlib.jar"

  [[ $VERBOSE -eq 1 ]] && echo "    Running validator for $CLUSTER_ID..."

  # Run the runner in validate mode. Capture stdout (RESULT lines) and stderr (summary).
  # Note: `set -e` would abort the script on java's non-zero exit (which is the
  # normal signal for "validation failed"). Disable -e locally around this call.
  set +e
  RUNNER_OUTPUT=$(echo "$INVOCATION_SPEC" | java -cp "$RUNNER_CP" regrets.runner.RegretRunnerKt validate 2> "$RUNNER_DIR/runner.err")
  RUNNER_RC=$?
  set -e

  # Extract RESULT lines.
  PASS_INPUTS=$(echo "$RUNNER_OUTPUT" | grep -c '^RESULT PASS' || true)
  FAIL_INPUTS=$(echo "$RUNNER_OUTPUT" | grep -c '^RESULT FAIL' || true)

  if [[ $VERBOSE -eq 1 ]]; then
    echo "$RUNNER_OUTPUT" | sed 's/^/    /'
    cat "$RUNNER_DIR/runner.err" | sed 's/^/    [stderr] /' >&2
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
