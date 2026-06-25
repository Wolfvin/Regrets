#!/usr/bin/env bash
# validate_csharp.sh — re-run C# clusters and compare fingerprints
#
# For each csharp cluster in regrets/manifest.json:
#   1. Read the matching .regret file (regrets/<id>.regret)
#   2. Parse INPUT / HASH (and INPUTS for multi-input clusters, issue #315)
#   3. Re-invoke the entry method with each input
#   4. Compute the live fingerprint and compare to the stored HASH
#   5. Report PASS / FAIL with a clean diff
#
# Modes:
#   default         Validate all clusters. Exit 0 if all PASS, 1 if any FAIL.
#   --update <id>   Update mode: re-capture the live fingerprint for <id>, rewrite
#                   the .regret file, append to regrets/audit.log with reason.
#                   Requires --reason "specific reason" (>= 4 words).
#   --fail-fast     Stop on first failure (CI mode).
#   --runs N        Drift detection: run validate N times, report if any cluster's
#                   fingerprint changes between runs.
#
# Usage:
#   bash scripts/validate_csharp.sh                          # validate all
#   bash scripts/validate_csharp.sh --cluster calc-add       # single cluster
#   bash scripts/validate_csharp.sh --fail-fast              # CI mode
#   bash scripts/validate_csharp.sh --update calc-add --reason "tax rate updated from 11% to 12% per new regulation"
#   bash scripts/validate_csharp.sh --runs 5                 # drift detection
#   bash scripts/validate_csharp.sh --verbose                # keep harness dir + show build log
#
# Exit codes:
#   0  all clusters pass (or update succeeded)
#   1  at least one cluster failed validation
#   2  CLI usage error (missing --reason, unknown flag, etc.)
#
# Requirements:
#   - dotnet SDK 8+ on PATH (or set DOTNET_CMD=/path/to/dotnet)
#   - regrets/manifest.json + regrets/<id>.regret files in the current directory
#   - User source files in src/ (or set REGRET_CSHARP_SRC=/path/to/src)

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
HELPER_CS="${SCRIPT_DIR}/RegretFingerprint.cs"

DOTNET_CMD="${DOTNET_CMD:-dotnet}"
USER_SRC_DIR="${REGRET_CSHARP_SRC:-${PROJECT_DIR}/src}"

CLUSTER_FILTER=""
VERBOSE=false
FAIL_FAST=false
RUNS=1
UPDATE_TARGET=""
UPDATE_REASON=""

# ─── Arg parsing ──────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster)   CLUSTER_FILTER="$2"; shift 2 ;;
    --verbose|-v) VERBOSE=true; shift ;;
    --fail-fast) FAIL_FAST=true; shift ;;
    --runs)      RUNS="$2"; shift 2 ;;
    --update)    UPDATE_TARGET="$2"; shift 2 ;;
    --reason)    UPDATE_REASON="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,/^set -euo/p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done
NODE_MANIFEST="$(node_path "$MANIFEST")"  # recompute after flag parsing (--manifest/--project may have changed MANIFEST)

# ─── Validate --update usage ──────────────────────────────────────────────────
if [[ -n "$UPDATE_TARGET" && -z "$UPDATE_REASON" ]]; then
  echo "❌ --update requires --reason" >&2
  echo "   Example: --update calc-add --reason \"describe why behavior changed\"" >&2
  exit 2
fi
if [[ -n "$UPDATE_REASON" ]]; then
  word_count=$(echo "$UPDATE_REASON" | wc -w)
  if [[ "$word_count" -lt 4 ]]; then
    echo "❌ --reason is too vague: \"$UPDATE_REASON\"" >&2
    echo "   Be specific. e.g. \"tax rate updated from 11% to 12% per new regulation\"" >&2
    exit 2
  fi
fi

mkdir -p "$REGRET_DIR"

# ─── Pre-flight ───────────────────────────────────────────────────────────────
if [ ! -f "$MANIFEST" ]; then
  echo "❌ regrets/manifest.json not found at $MANIFEST" >&2
  exit 1
fi
if [ ! -f "$HELPER_CS" ]; then
  echo "❌ Helper not found: $HELPER_CS" >&2
  exit 1
fi
if ! command -v "$DOTNET_CMD" >/dev/null 2>&1; then
  echo "❌ dotnet SDK not found on PATH. Install .NET 8+ or set DOTNET_CMD=/path/to/dotnet" >&2
  exit 1
fi
if [ ! -d "$USER_SRC_DIR" ]; then
  echo "❌ Source directory not found: $USER_SRC_DIR" >&2
  exit 1
fi

# ─── Read & filter C# clusters ────────────────────────────────────────────────
# When --update is set, force CLUSTER_FILTER to the target id.
if [[ -n "$UPDATE_TARGET" ]]; then
  CLUSTER_FILTER="$UPDATE_TARGET"
fi

CLUSTERS_JSON=$(node -e "
  const fs = require('fs');
  const m = JSON.parse(fs.readFileSync('$NODE_MANIFEST', 'utf8'));
  let clusters = (m.clusters || []).filter(c => c.stack === 'csharp');
  if ('$CLUSTER_FILTER') {
    clusters = clusters.filter(c => c.id === '$CLUSTER_FILTER');
  }
  process.stdout.write(JSON.stringify(clusters));
") || {
  echo "No csharp clusters found in manifest." >&2
  exit 0
}

if [[ "$CLUSTERS_JSON" == "[]" ]]; then
  echo "No csharp clusters found in manifest."
  exit 0
fi

echo "🔍 Validating C# clusters..."

# ─── Generate temporary .NET project ──────────────────────────────────────────
HARNESS_DIR="${REGRET_DIR}/_regret_validate"
rm -rf "$HARNESS_DIR"
mkdir -p "$HARNESS_DIR"

CLUSTERS_FILE="${HARNESS_DIR}/clusters.json"
echo "$CLUSTERS_JSON" > "$CLUSTERS_FILE"

cp "$HELPER_CS" "${HARNESS_DIR}/RegretFingerprint.cs"

USER_CS_FILES=()
shopt -s nullglob
for f in "$USER_SRC_DIR"/*.cs; do
  USER_CS_FILES+=( "$f" )
done
shopt -u nullglob

if [ ${#USER_CS_FILES[@]} -eq 0 ]; then
  echo "❌ No .cs files found in $USER_SRC_DIR" >&2
  exit 1
fi

CSPROJ="${HARNESS_DIR}/RegretValidate.csproj"
{
  echo "<Project Sdk=\"Microsoft.NET.Sdk\">"
  echo "  <PropertyGroup>"
  echo "    <OutputType>Exe</OutputType>"
  echo "    <TargetFramework>net8.0</TargetFramework>"
  echo "    <Nullable>enable</Nullable>"
  echo "    <ImplicitUsings>enable</ImplicitUsings>"
  echo "    <RootNamespace>RegretValidate</RootNamespace>"
  echo "    <AssemblyName>RegretValidate</AssemblyName>"
  echo "  </PropertyGroup>"
  echo "  <ItemGroup>"
  for f in "${USER_CS_FILES[@]}"; do
    echo "    <Compile Include=\"$f\" />"
  done
  echo "    <!-- RegretFingerprint.cs and RegretValidate.cs are auto-included by the SDK -->"
  echo "  </ItemGroup>"
  echo "</Project>"
} > "$CSPROJ"

# ─── Generate RegretValidate.cs ───────────────────────────────────────────────
# Supports three modes via CLI args after the positional ones:
#   (default)          Validate all clusters, print human-readable summary.
#   --json             Emit a JSON array of per-cluster results to stdout
#                      (consumed by --update / --runs in the bash wrapper).
#   --fail-fast        Stop on first failing cluster (still emits JSON if --json).
cat > "${HARNESS_DIR}/RegretValidate.cs" <<'CSHARPEOF'
// RegretValidate.cs — auto-generated by validate_csharp.sh
// DO NOT EDIT — regenerated on every validate run.
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.Json;
using RegretSupport;

namespace RegretValidate;

public static class RegretValidate
{
    public static int Main(string[] args)
    {
        if (args.Length < 3)
        {
            Console.Error.WriteLine("Usage: RegretValidate <clusters.json> <regret-dir> <manifest-path> [--json] [--fail-fast]");
            return 1;
        }
        var clustersPath = args[0];
        var regretDir = args[1];

        bool jsonMode = false;
        bool failFast = false;
        for (int i = 3; i < args.Length; i++)
        {
            if (args[i] == "--json") jsonMode = true;
            else if (args[i] == "--fail-fast") failFast = true;
        }

        var clustersJson = File.ReadAllText(clustersPath);
        using var doc = JsonDocument.Parse(clustersJson);

        int totalPass = 0, totalFail = 0, totalSkip = 0;
        var jsonResults = new List<object>();

        foreach (var cluster in doc.RootElement.EnumerateArray())
        {
            var id = cluster.GetProperty("id").GetString()!;
            var regretPath = Path.Combine(regretDir, $"{id}.regret");

            if (!File.Exists(regretPath))
            {
                Console.WriteLine($"   ⚠️  SKIP {id}: no .regret file at {regretPath}");
                totalSkip++;
                jsonResults.Add(new { id, status = "skip", reason = "no .regret file" });
                continue;
            }

            var (pass, fail, detail, liveHash, goldenHash, liveOutputJson) = ValidateCluster(cluster, regretPath);
            bool ok = pass > 0 && fail == 0;
            if (ok)
            {
                Console.WriteLine($"   ✅ PASS {id}: {pass} input(s) verified");
                totalPass++;
            }
            else
            {
                Console.WriteLine($"   ❌ FAIL {id}: {fail}/{pass + fail} input(s) mismatch");
                foreach (var line in detail) Console.WriteLine($"       {line}");
                totalFail++;
            }
            jsonResults.Add(new {
                id,
                status = ok ? "pass" : "fail",
                pass,
                fail,
                goldenHash,
                liveHash,
                liveOutputJson
            });

            if (!ok && failFast) break;
        }

        Console.WriteLine();
        Console.WriteLine($"   Validate summary: {totalPass} pass, {totalFail} fail, {totalSkip} skip");

        if (jsonMode)
        {
            // Emit a single JSON array to stdout — consumed by the bash wrapper for --update / --runs.
            var opts = new JsonSerializerOptions { WriteIndented = false };
            Console.WriteLine("===REGRET_JSON_BEGIN===");
            Console.WriteLine(JsonSerializer.Serialize(jsonResults, opts));
            Console.WriteLine("===REGRET_JSON_END===");
        }

        return totalFail == 0 ? 0 : 1;
    }

    private static (int pass, int fail, List<string> detail, string liveHash, string goldenHash, string liveOutputJson) ValidateCluster(JsonElement cluster, string regretPath)
    {
        var id = cluster.GetProperty("id").GetString()!;
        var entry = cluster.GetProperty("entry").GetString()!;
        var className = cluster.GetProperty("class").GetString()!;
        var regretRaw = File.ReadAllText(regretPath);

        var parts = regretRaw.Split("\n---\n", 2, StringSplitOptions.None);
        if (parts.Length < 2)
        {
            return (0, 1, new List<string> { $"malformed .regret file: no '---' separator in {regretPath}" }, "", "", "");
        }
        var dataSection = parts[1];

        string? inputJson = null, outputJson = null, errorContractJson = null, hashStr = null, inputsJson = null;
        foreach (var line in dataSection.Split('\n'))
        {
            if (line.StartsWith("INPUT  ")) inputJson = line.Substring("INPUT  ".Length).Trim();
            else if (line.StartsWith("OUTPUT ")) outputJson = line.Substring("OUTPUT ".Length).Trim();
            else if (line.StartsWith("ERROR_CONTRACT ")) errorContractJson = line.Substring("ERROR_CONTRACT ".Length).Trim();
            else if (line.StartsWith("HASH   ")) hashStr = line.Substring("HASH   ".Length).Trim();
            else if (line.StartsWith("INPUTS ")) inputsJson = line.Substring("INPUTS ".Length).Trim();
        }
        if (hashStr == null || inputJson == null)
        {
            return (0, 1, new List<string> { "missing INPUT or HASH line in .regret file" }, "", "", "");
        }

        var type = RegretFingerprint.FindType(className)
            ?? throw new InvalidOperationException($"Type not found: {className}");
        var method = type.GetMethod(entry, BindingFlags.Public | BindingFlags.Static)
            ?? throw new InvalidOperationException($"Method not found: {className}.{entry}");

        int pass = 0, fail = 0;
        var detail = new List<string>();
        string liveHash = "";
        string liveOutputJson = "";

        // Validate input[0] against top-level INPUT/HASH
        var (liveFp, liveOut, threw) = InvokeAndFingerprint(method, inputJson);
        liveHash = liveFp;
        liveOutputJson = RegretFingerprint.StableStringify(liveOut);
        if (liveFp == hashStr)
        {
            pass++;
        }
        else
        {
            fail++;
            detail.Add($"input[0] hash mismatch:");
            detail.Add($"  golden:  {hashStr}");
            detail.Add($"  live:    {liveFp}");
            detail.Add($"  input:   {inputJson}");
            if (outputJson != null && !threw)
            {
                if (outputJson != liveOutputJson)
                {
                    detail.Add($"  golden output: {outputJson}");
                    detail.Add($"  live output:   {liveOutputJson}");
                }
            }
            else if (errorContractJson != null && threw)
            {
                detail.Add($"  golden threw:  {errorContractJson}");
                detail.Add($"  live threw:    {liveOutputJson}");
            }
            else if (errorContractJson != null && !threw)
            {
                detail.Add($"  golden threw:  {errorContractJson}");
                detail.Add($"  live returned: {liveOutputJson}");
            }
            else if (outputJson != null && threw)
            {
                detail.Add($"  golden returned: {outputJson}");
                detail.Add($"  live threw:      {liveOutputJson}");
            }
        }

        // Validate inputs[1+] against INPUTS line (issue #315 pattern)
        if (inputsJson != null)
        {
            using var inputsDoc = JsonDocument.Parse(inputsJson);
            int idx = 1;
            foreach (var itemEl in inputsDoc.RootElement.EnumerateArray())
            {
                var goldenHash = itemEl.GetProperty("hash").GetString()!;
                var itemInputJson = RegretFingerprint.StableStringify(itemEl.GetProperty("input"));
                var (liveFp_i, liveOut_i, threw_i) = InvokeAndFingerprint(method, itemInputJson);
                if (liveFp_i == goldenHash)
                {
                    pass++;
                }
                else
                {
                    fail++;
                    detail.Add($"input[{idx}] hash mismatch:");
                    detail.Add($"  golden:  {goldenHash}");
                    detail.Add($"  live:    {liveFp_i}");
                    detail.Add($"  input:   {itemInputJson}");
                    var goldenOutStr = itemEl.GetProperty("output").GetRawText();
                    var liveOutStr = RegretFingerprint.StableStringify(liveOut_i);
                    if (goldenOutStr != liveOutStr)
                    {
                        detail.Add($"  golden output: {goldenOutStr}");
                        detail.Add($"  live output:   {liveOutStr}");
                    }
                }
                idx++;
            }
        }

        return (pass, fail, detail, liveHash, hashStr, liveOutputJson);
    }

    private static (string fp, object? output, bool threw) InvokeAndFingerprint(MethodInfo method, string inputJson)
    {
        using var inputDoc = JsonDocument.Parse(inputJson);
        var inputEl = inputDoc.RootElement.Clone();
        object? output = null;
        bool threw = false;
        try
        {
            output = method.Invoke(null, new object[] { inputEl });
        }
        catch (TargetInvocationException tie)
        {
            threw = true;
            var inner = tie.InnerException;
            output = new { threw = true, type = inner?.GetType().FullName ?? "Unknown", message = inner?.Message ?? "" };
        }
        var fp = RegretFingerprint.Fingerprint(inputEl, output);
        return (fp, output, threw);
    }
}
CSHARPEOF

# ─── Build ────────────────────────────────────────────────────────────────────
echo "🔧 Building regret validate project..."
export DOTNET_CLI_HOME="${DOTNET_CLI_HOME:-/tmp/dotnet-home-validate}"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_NOLOGO=1

BUILD_LOG="$("$DOTNET_CMD" build "$CSPROJ" -c Release --nologo -clp:NoSummary 2>&1)" || {
  echo "❌ Build failed:" >&2
  echo "$BUILD_LOG" >&2
  exit 1
}
if $VERBOSE; then
  echo "$BUILD_LOG" | sed 's/^/   build: /'
fi

# ─── Helper: run validate, capture JSON if requested ──────────────────────────
run_validate_csharp() {
  local extra_args=()
  extra_args+=("--json")
  if $FAIL_FAST; then extra_args+=("--fail-fast"); fi
  "$DOTNET_CMD" run --project "$CSPROJ" -c Release --no-build --no-launch-profile -- \
    "$CLUSTERS_FILE" "$REGRET_DIR" "$MANIFEST" "${extra_args[@]}"
}

# ─── Mode: --update ───────────────────────────────────────────────────────────
if [[ -n "$UPDATE_TARGET" ]]; then
  echo "🔄 Update mode — cluster: $UPDATE_TARGET"
  echo "   Reason: $UPDATE_REASON"
  echo

  # Run validate; capture stdout (which includes the JSON block)
  UPDATE_OUT="$(run_validate_csharp 2>&1 || true)"
  echo "$UPDATE_OUT" | grep -v '^===REGRET_JSON' | grep -v '^\[' | sed 's/^/  /'

  # Extract the JSON results
  JSON_BLOCK="$(echo "$UPDATE_OUT" | sed -n '/===REGRET_JSON_BEGIN===/,/===REGRET_JSON_END===/p' \
                | grep -v '===REGRET_JSON' )"

  if [ -z "$JSON_BLOCK" ]; then
    echo "❌ Update failed: no JSON output from validate" >&2
    if ! $VERBOSE; then rm -rf "$HARNESS_DIR"; fi
    exit 1
  fi

  # Parse JSON with node — find the target cluster's live hash + output
  UPDATE_INFO=$(node -e "
    const results = JSON.parse(process.argv[1]);
    const target = results.find(r => r.id === process.argv[2]);
    if (!target) {
      console.error('Update target not found in validate results: ' + process.argv[2]);
      process.exit(1);
    }
    if (target.status === 'skip') {
      console.error('Cannot update — cluster skipped: ' + target.reason);
      process.exit(1);
    }
    console.log(JSON.stringify({ liveHash: target.liveHash, liveOutputJson: target.liveOutputJson }));
  " "$JSON_BLOCK" "$UPDATE_TARGET") || {
    echo "❌ Update failed: see error above" >&2
    if ! $VERBOSE; then rm -rf "$HARNESS_DIR"; fi
    exit 1
  }

  LIVE_HASH=$(echo "$UPDATE_INFO" | node -e "let b=''; process.stdin.on('data',d=>b+=d); process.stdin.on('end',()=>console.log(JSON.parse(b).liveHash))")
  LIVE_OUTPUT_JSON=$(echo "$UPDATE_INFO" | node -e "let b=''; process.stdin.on('data',d=>b+=d); process.stdin.on('end',()=>console.log(JSON.parse(b).liveOutputJson))")

  REGRET_PATH="${REGRET_DIR}/${UPDATE_TARGET}.regret"
  OLD_HASH=$(grep '^fingerprint:' "$REGRET_PATH" | awk '{print $2}')
  NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.%6NZ")

  # Rewrite .regret file: update fingerprint, captured, OUTPUT, HASH
  # Use node for in-place regex replacement (more reliable than sed for special chars)
  node -e "
    const fs = require('fs');
    const path = process.argv[1];
    const newHash = process.argv[2];
    const now = process.argv[3];
    const newOutput = process.argv[4];
    let content = fs.readFileSync(path, 'utf8');
    content = content.replace(/^fingerprint: .+\$/m, 'fingerprint: ' + newHash);
    content = content.replace(/^captured: .+\$/m, 'captured: ' + now);
    content = content.replace(/^OUTPUT .+\$/m, 'OUTPUT ' + newOutput);
    content = content.replace(/^HASH   .+\$/m, 'HASH   ' + newHash);
    fs.writeFileSync(path, content);
  " "$REGRET_PATH" "$LIVE_HASH" "$NOW" "$LIVE_OUTPUT_JSON"

  # Append to audit.log (hash chain — mirror PHP/Ruby pattern)
  AUDIT_LOG="${REGRET_DIR}/audit.log"
  PREV_CHAIN="0000000"
  if [ -f "$AUDIT_LOG" ]; then
    PREV_CHAIN=$(grep -E '^\s*chain:' "$AUDIT_LOG" | tail -1 | awk '{print $2}' || echo "0000000")
    PREV_CHAIN="${PREV_CHAIN:-0000000}"
  fi
  SAFE_REASON=$(echo "$UPDATE_REASON" | tr '\r\n' ' ')
  ENTRY="${NOW}  UPDATE  ${UPDATE_TARGET}
  old: ${OLD_HASH}
  new: ${LIVE_HASH}
  reason: ${SAFE_REASON}
  by: AI refactor session"
  CHAIN_HASH=$(printf '%s%s' "$PREV_CHAIN" "$ENTRY" | sha256sum | awk '{print substr($1, 1, 7)}')
  printf '\n%s\n  chain: %s\n' "$ENTRY" "$CHAIN_HASH" >> "$AUDIT_LOG"

  echo
  echo "  ✅ ${UPDATE_TARGET}  ${OLD_HASH} → ${LIVE_HASH}  UPDATED"
  echo "   Audit: regrets/audit.log"

  if ! $VERBOSE; then rm -rf "$HARNESS_DIR"; fi
  exit 0
fi

# ─── Mode: --runs N (drift detection) ─────────────────────────────────────────
if [[ "$RUNS" -gt 1 ]]; then
  echo "🔍 Drift detection — $RUNS runs per cluster..."
  echo

  PREV_HASHES=""
  DRIFT_DETECTED=false
  for run in $(seq 1 "$RUNS"); do
    echo "── Run $run/$RUNS ──"
    RUN_OUT="$(run_validate_csharp 2>&1 || true)"
    echo "$RUN_OUT" | grep -E '  (✅|❌|⚠️)' | sed 's/^/  /'
    # Extract JSON, get hashes per cluster
    RUN_JSON="$(echo "$RUN_OUT" | sed -n '/===REGRET_JSON_BEGIN===/,/===REGRET_JSON_END===/p' | grep -v '===REGRET_JSON')"
    if [ -z "$RUN_JSON" ]; then
      echo "❌ No JSON output from run $run" >&2
      continue
    fi

    CUR_HASHES=$(node -e "
      const r = JSON.parse(process.argv[1]);
      console.log(r.filter(x => x.status !== 'skip')
                   .map(x => x.id + ':' + x.liveHash).join('\n'));
    " "$RUN_JSON")

    if [ -n "$PREV_HASHES" ]; then
      if [ "$CUR_HASHES" != "$PREV_HASHES" ]; then
        DRIFT_DETECTED=true
        echo "  ⚠️  Drift detected between run $((run-1)) and run $run"
        diff <(echo "$PREV_HASHES") <(echo "$CUR_HASHES") | sed 's/^/    /'
      fi
    fi
    PREV_HASHES="$CUR_HASHES"
    echo
  done

  if $DRIFT_DETECTED; then
    echo "❌ Drift detected — at least one cluster's fingerprint changed between runs"
    if ! $VERBOSE; then rm -rf "$HARNESS_DIR"; fi
    exit 1
  else
    echo "✅ All clusters stable across $RUNS runs"
    if ! $VERBOSE; then rm -rf "$HARNESS_DIR"; fi
    exit 0
  fi
fi

# ─── Default mode: single-run validate ────────────────────────────────────────
echo "🧪 Running regret validate..."
FAIL_FAST_ARG=()
if $FAIL_FAST; then FAIL_FAST_ARG=("--fail-fast"); fi

set +e
"$DOTNET_CMD" run --project "$CSPROJ" -c Release --no-build --no-launch-profile -- \
  "$CLUSTERS_FILE" "$REGRET_DIR" "$MANIFEST" "${FAIL_FAST_ARG[@]}"
RC=$?
set -e

# Clean up the harness dir on success unless --verbose
if ! $VERBOSE; then
  rm -rf "$HARNESS_DIR"
fi

if [ $RC -eq 0 ]; then
  echo "✅ Validate finished: ALL clusters PASS"
else
  echo "❌ Validate finished: some clusters FAIL (see output above)"
fi
exit $RC
