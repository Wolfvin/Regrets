#!/usr/bin/env bash
# capture_csharp.sh — compile + run regret capture for C# (.NET) clusters
#
# Reads regrets/manifest.json from the current directory, filters clusters
# with stack:"csharp", generates a temporary .NET project under
# regrets/_regret_capture/, compiles it, runs it, and writes .regret files
# to the regrets/ directory.
#
# The .regret file format is IDENTICAL to capture.js (JS) and capture.py
# (Python): cluster / version / fingerprint / captured / watches / entry /
# stack / fingerprintLevel / --- / INPUT / OUTPUT / HASH, with INPUTS for
# multi-input clusters (issue #315 pattern).
#
# Manifest schema for C# clusters:
#   {
#     "id": "calc-add",
#     "entry": "Add",                     # public static method name
#     "class": "RegretDemo.Calculator",   # fully-qualified type name
#     "stack": "csharp",
#     "fingerprintLevel": "entry",
#     "watches": ["Add"],                 # optional
#     "inputs": [[2, 3], [10, 20]]        # each input is a JSON value
#   }
#
# The entry method MUST have signature:  public static object? Method(JsonElement input)
# (The harness passes the input as a single JsonElement; methods that need
# multiple args should read them out of an array element themselves.)
#
# Usage:
#   bash scripts/capture_csharp.sh                  # capture all csharp clusters
#   bash scripts/capture_csharp.sh --cluster calc-add
#   bash scripts/capture_csharp.sh --verbose
#
# Requirements:
#   - dotnet SDK 8+ on PATH (or set DOTNET_CMD=/path/to/dotnet)
#   - User source files in src/ (or set REGRET_CSHARP_SRC=/path/to/src)
#   - regrets/manifest.json in the current directory

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"
HELPER_CS="${SCRIPT_DIR}/RegretFingerprint.cs"

# Configurable paths
DOTNET_CMD="${DOTNET_CMD:-dotnet}"
USER_SRC_DIR="${REGRET_CSHARP_SRC:-${PROJECT_DIR}/src}"

# Args
MODE="capture"
CLUSTER_FILTER=""
VERBOSE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster)   CLUSTER_FILTER="$2"; shift 2 ;;
    --verbose|-v) VERBOSE=true; shift ;;
    --help|-h)
      sed -n '2,/^set -euo/p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$REGRET_DIR"

# ─── Pre-flight checks ────────────────────────────────────────────────────────
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
  echo "   Put your .cs files there or set REGRET_CSHARP_SRC=/path/to/src" >&2
  exit 1
fi

# ─── Read & filter C# clusters from manifest ──────────────────────────────────
CLUSTERS_JSON=$(node -e "
  const fs = require('fs');
  const m = JSON.parse(fs.readFileSync('$MANIFEST', 'utf8'));
  let clusters = (m.clusters || []).filter(c => c.stack === 'csharp');
  if ('$CLUSTER_FILTER') {
    clusters = clusters.filter(c => c.id === '$CLUSTER_FILTER');
  }
  if (clusters.length === 0) {
    console.error('No csharp clusters found in manifest.');
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(clusters));
") || {
  echo "No csharp clusters found in manifest." >&2
  exit 0
}

echo "📡 Capturing C# clusters..."
echo "$CLUSTERS_JSON" | node -e "
  const clusters = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
  clusters.forEach(c => console.log('  - ' + c.id + ' (' + c.class + '.' + c.entry + ')'));
"

# ─── Generate temporary .NET project under regrets/_regret_capture/ ───────────
HARNESS_DIR="${REGRET_DIR}/_regret_capture"
rm -rf "$HARNESS_DIR"
mkdir -p "$HARNESS_DIR"

# Write clusters JSON to a temp file for the harness to read
CLUSTERS_FILE="${HARNESS_DIR}/clusters.json"
echo "$CLUSTERS_JSON" > "$CLUSTERS_FILE"

# Copy helper into the harness project
cp "$HELPER_CS" "${HARNESS_DIR}/RegretFingerprint.cs"

# Symlink (or copy) user's .cs files into the harness project so the compiler
# can find them. We use symlinks to avoid duplicating source.
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

# Write the csproj — references user .cs files directly via Compile Include
CSPROJ="${HARNESS_DIR}/RegretCapture.csproj"
{
  echo "<Project Sdk=\"Microsoft.NET.Sdk\">"
  echo "  <PropertyGroup>"
  echo "    <OutputType>Exe</OutputType>"
  echo "    <TargetFramework>net8.0</TargetFramework>"
  echo "    <Nullable>enable</Nullable>"
  echo "    <ImplicitUsings>enable</ImplicitUsings>"
  echo "    <RootNamespace>RegretCapture</RootNamespace>"
  echo "    <AssemblyName>RegretCapture</AssemblyName>"
  echo "    <!-- Suppress SDK metadata telemetry to keep output clean -->"
  echo "    <DOTNET_CLI_TELEMETRY_OPTOUT>true</DOTNET_CLI_TELEMETRY_OPTOUT>"
  echo "  </PropertyGroup>"
  echo "  <ItemGroup>"
  for f in "${USER_CS_FILES[@]}"; do
    echo "    <Compile Include=\"$f\" />"
  done
  echo "    <!-- RegretFingerprint.cs and RegretCapture.cs are auto-included by the SDK -->"
  echo "  </ItemGroup>"
  echo "</Project>"
} > "$CSPROJ"

# ─── Generate RegretCapture.cs (the harness) ─────────────────────────────────
# Reads clusters.json (path as argv[1]) and writes .regret files to argv[2].
cat > "${HARNESS_DIR}/RegretCapture.cs" <<'CSHARPEOF'
// RegretCapture.cs — auto-generated by capture_csharp.sh
// DO NOT EDIT — regenerated on every capture run.
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.Json;
using RegretSupport;

namespace RegretCapture;

public static class RegretCapture
{
    public static int Main(string[] args)
    {
        if (args.Length < 2)
        {
            Console.Error.WriteLine("Usage: RegretCapture <clusters.json> <output-dir>");
            return 1;
        }
        var clustersPath = args[0];
        var outputDir = args[1];

        var clustersJson = File.ReadAllText(clustersPath);
        using var doc = JsonDocument.Parse(clustersJson);

        int ok = 0, fail = 0;
        foreach (var cluster in doc.RootElement.EnumerateArray())
        {
            try
            {
                CaptureCluster(cluster, outputDir);
                ok++;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"   ❌ {cluster.GetProperty("id").GetString()}: {ex.Message}");
                fail++;
            }
        }
        Console.WriteLine($"   Capture complete: {ok} ok, {fail} failed");
        return fail == 0 ? 0 : 1;
    }

    private static void CaptureCluster(JsonElement cluster, string outputDir)
    {
        var id = cluster.GetProperty("id").GetString()!;
        var entry = cluster.GetProperty("entry").GetString()!;
        var className = cluster.GetProperty("class").GetString()!;
        var inputsEl = cluster.GetProperty("inputs");

        // Optional fields
        string watchesStr = "";
        if (cluster.TryGetProperty("watches", out var wEl) && wEl.ValueKind == JsonValueKind.Array)
        {
            var names = new List<string>();
            foreach (var w in wEl.EnumerateArray()) names.Add(w.GetString() ?? "");
            watchesStr = string.Join(", ", names);
        }

        // Find the type + method via reflection
        var type = RegretFingerprint.FindType(className)
            ?? throw new InvalidOperationException($"Type not found: {className}. Make sure the class is public and the namespace matches.");
        var method = type.GetMethod(entry, BindingFlags.Public | BindingFlags.Static)
            ?? throw new InvalidOperationException($"Method not found: {className}.{entry}. Method must be public static.");

        // Validate method signature: must accept a single JsonElement.
        var parameters = method.GetParameters();
        if (parameters.Length != 1 || parameters[0].ParameterType != typeof(JsonElement))
        {
            throw new InvalidOperationException(
                $"{className}.{entry} must have signature: public static object? {entry}(JsonElement input). " +
                $"Found: {method.ReturnType.Name} {entry}({string.Join(", ", Array.ConvertAll(parameters, p => p.ParameterType.Name))})");
        }

        // Capture each input → output → fingerprint
        var results = new List<InputResult>();
        foreach (var inputEl in inputsEl.EnumerateArray())
        {
            var inputClone = inputEl.Clone();
            object? output = null;
            bool threw = false;
            string? errorStr = null;
            try
            {
                output = method.Invoke(null, new object[] { inputClone });
            }
            catch (TargetInvocationException tie)
            {
                threw = true;
                var inner = tie.InnerException;
                errorStr = inner?.GetType().FullName + ": " + inner?.Message;
                output = new { threw = true, type = inner?.GetType().FullName ?? "Unknown", message = inner?.Message ?? "" };
            }

            // Trivial guard: skip if output is null AND method didn't throw
            // (matches the JS/Python trivial-input guard).
            // Comment this block out if you want to capture null returns.
            // if (!threw && output == null) continue;

            var fp = RegretFingerprint.Fingerprint(inputClone, output);
            results.Add(new InputResult
            {
                Input = inputClone,
                Output = output,
                Fingerprint = fp,
                Threw = threw,
                ErrorString = errorStr
            });
        }

        if (results.Count == 0)
        {
            throw new InvalidOperationException($"No inputs captured for cluster {id} (all trivial?).");
        }

        var primary = results[0];
        var sb = new StringBuilder();
        sb.AppendLine($"cluster: {id}");
        sb.AppendLine($"version: 1");
        sb.AppendLine($"fingerprint: {primary.Fingerprint}");
        // ISO-8601 with timezone offset, matches JS new Date().toISOString() style
        sb.AppendLine($"captured: {DateTimeOffset.UtcNow:yyyy-MM-ddTHH:mm:ss.ffffffK}");
        sb.AppendLine($"watches: [{watchesStr}]");
        sb.AppendLine($"entry: {entry}");
        sb.AppendLine($"stack: csharp");
        sb.AppendLine($"fingerprintLevel: entry");
        sb.AppendLine($"class: {className}");
        sb.AppendLine($"env: {{\"runtime\":\"dotnet\",\"version\":\"{Environment.Version}\"}}");
        sb.AppendLine("---");
        sb.AppendLine($"INPUT  {RegretFingerprint.StableStringify(primary.Input)}");
        if (primary.Threw)
        {
            sb.AppendLine($"ERROR_CONTRACT {RegretFingerprint.StableStringify(primary.Output)}");
        }
        else
        {
            sb.AppendLine($"OUTPUT {RegretFingerprint.StableStringify(primary.Output)}");
        }
        sb.AppendLine($"HASH   {primary.Fingerprint}");

        // Issue #315 pattern: per-input contracts for inputs 1+
        if (results.Count > 1)
        {
            var entries = new List<string>();
            for (int i = 1; i < results.Count; i++)
            {
                var r = results[i];
                // Each entry: {"input": <json>, "output": <json>, "hash": "<fp>", "threw": <bool>}
                var entry_obj = new StringBuilder();
                entry_obj.Append("{");
                entry_obj.Append("\"input\":" + RegretFingerprint.StableStringify(r.Input) + ",");
                entry_obj.Append("\"output\":" + RegretFingerprint.StableStringify(r.Output) + ",");
                entry_obj.Append("\"hash\":" + JsonSerializer.Serialize(r.Fingerprint) + ",");
                entry_obj.Append("\"threw\":" + (r.Threw ? "true" : "false"));
                entry_obj.Append("}");
                entries.Add(entry_obj.ToString());
            }
            sb.AppendLine($"INPUTS [{string.Join(", ", entries)}]");
        }

        var outPath = Path.Combine(outputDir, $"{id}.regret");
        File.WriteAllText(outPath, sb.ToString());
        Console.WriteLine($"   ✅ {id}: fp={primary.Fingerprint}, inputs={results.Count}, saved → regrets/{id}.regret");
    }

    private class InputResult
    {
        public JsonElement Input { get; set; }
        public object? Output { get; set; }
        public string Fingerprint { get; set; } = "";
        public bool Threw { get; set; }
        public string? ErrorString { get; set; }
    }
}
CSHARPEOF

# ─── Build + run the harness ──────────────────────────────────────────────────
echo "🔧 Building regret harness project..."
export DOTNET_CLI_HOME="${DOTNET_CLI_HOME:-/tmp/dotnet-home-capture}"
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

echo "🧪 Running regret capture..."
"$DOTNET_CMD" run --project "$CSPROJ" -c Release --no-build --no-launch-profile -- \
  "$CLUSTERS_FILE" "$REGRET_DIR" $([ "$VERBOSE" = "true" ] && echo "--verbose")

# Clean up the harness dir on success unless --verbose
if ! $VERBOSE; then
  rm -rf "$HARNESS_DIR"
fi

echo "✅ Capture finished. .regret files written to $REGRET_DIR/"
