#!/usr/bin/env bash
# validate_csharp.sh — validate regret fingerprints for C# (.NET) clusters
#
# Reads .regret files, re-invokes the entry function with the stored INPUT,
# computes the fingerprint, and compares against the stored HASH.
# Reports PASS/FAIL per cluster.
#
# Usage:
#   bash scripts/validate_csharp.sh                         # validate all C# clusters
#   bash scripts/validate_csharp.sh --cluster my-cluster    # validate one cluster
#   bash scripts/validate_csharp.sh --fail-fast             # exit on first failure
#   bash scripts/validate_csharp.sh --manifest ./custom-manifest.json

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"

# Parse CLI args
CLUSTER_FILTER=""
MANIFEST_PATH="$MANIFEST"
FAIL_FAST=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster) CLUSTER_FILTER="$2"; shift 2 ;;
    --manifest) MANIFEST_PATH="$2"; shift 2 ;;
    --fail-fast) FAIL_FAST=true; shift ;;
    *) shift ;;
  esac
done

# Check if dotnet is available
if ! command -v dotnet &> /dev/null; then
  echo "⚠️  .NET SDK (dotnet) is not installed. Cannot validate C# clusters."
  exit 1
fi

# Read C# clusters from manifest
CLUSTERS_JSON=$(node -e "
  const fs = require('fs');
  const m = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  let clusters = (m.clusters || []).filter(c => c.stack === 'csharp');
  const filter = process.argv[2];
  if (filter) clusters = clusters.filter(c => c.id === filter);
  console.log(JSON.stringify(clusters));
" "$MANIFEST_PATH" "$CLUSTER_FILTER")

if [ "$CLUSTERS_JSON" = "[]" ]; then
  echo "No C# clusters found in manifest."
  exit 0
fi

echo "🔍 Validating C# clusters..."

# Generate the C# validate project
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

VALIDATE_PROJ="$TEMP_DIR/RegretValidate"
mkdir -p "$VALIDATE_PROJ"

cat > "$VALIDATE_PROJ/RegretValidate.csproj" << 'CSPROJ'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
CSPROJ

cat > "$VALIDATE_PROJ/Program.cs" << 'CSEOF'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace RegretValidate;

public class Program
{
    // ─── Stable JSON Stringify (identical to capture_csharp) ──────────────────
    static string StableStringify(object? obj)
    {
        if (obj == null) return "null";
        if (obj is bool b) return b ? "true" : "false";
        if (obj is int i) return i.ToString(CultureInfo.InvariantCulture);
        if (obj is long l) return l.ToString(CultureInfo.InvariantCulture);
        if (obj is double d)
        {
            if (double.IsNaN(d)) return "\"__nan__\"";
            if (double.IsPositiveInfinity(d)) return "\"__infinity__\"";
            if (double.IsNegativeInfinity(d)) return "\"__neg_infinity__\"";
            return d.ToString("R", CultureInfo.InvariantCulture);
        }
        if (obj is string s) return JsonSerializer.Serialize(s);
        if (obj is JsonElement je) return StableStringify(JsonElementToObject(je));
        if (obj is IDictionary<string, object?> dict)
        {
            var keys = dict.Keys.OrderBy(k => k, StringComparer.Ordinal).ToList();
            var parts = keys.Select(k => $"{JsonSerializer.Serialize(k)}:{StableStringify(dict[k])}");
            return "{" + string.Join(",", parts) + "}";
        }
        if (obj is IEnumerable<object?> arr)
        {
            var parts = arr.Select(StableStringify);
            return "[" + string.Join(",", parts) + "]";
        }
        var json = JsonSerializer.Serialize(obj);
        var node = JsonNode.Parse(json);
        return StableStringify(JsonNodeToObject(node));
    }

    static object? JsonElementToObject(JsonElement el)
    {
        return el.ValueKind switch
        {
            JsonValueKind.Null => null,
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.Number => el.TryGetInt64(out long l) ? l : el.GetDouble(),
            JsonValueKind.String => el.GetString()!,
            JsonValueKind.Array => el.EnumerateArray().Select(JsonElementToObject).ToList(),
            JsonValueKind.Object => el.EnumerateObject().ToDictionary(p => p.Name, p => JsonElementToObject(p.Value)),
            _ => el.ToString()
        };
    }

    static object? JsonNodeToObject(JsonNode? node)
    {
        if (node == null) return null;
        return node.GetValue<JsonElement>() switch
        {
            var el when el.ValueKind == JsonValueKind.Null => null,
            var el when el.ValueKind == JsonValueKind.True => true,
            var el when el.ValueKind == JsonValueKind.False => false,
            var el when el.ValueKind == JsonValueKind.Number => el.TryGetInt64(out long l) ? l : el.GetDouble(),
            var el when el.ValueKind == JsonValueKind.String => el.GetString()!,
            var el when el.ValueKind == JsonValueKind.Array => el.EnumerateArray().Select(JsonElementToObject).ToList(),
            var el when el.ValueKind == JsonValueKind.Object => el.EnumerateObject().ToDictionary(p => p.Name, p => JsonElementToObject(p.Value)),
            _ => node.ToString()
        };
    }

    static string Fingerprint(object? input, object? output)
    {
        var combined = StableStringify(input) + "|" + StableStringify(output);
        var hashBytes = SHA256.HashData(Encoding.UTF8.GetBytes(combined));
        var hexStr = Convert.ToHexString(hashBytes).ToLowerInvariant();
        var bigNum = System.Numerics.BigInteger.Parse("0" + hexStr, NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        var base36 = ToBase36(bigNum);
        return base36.Length >= 7 ? base36[..7] : base36;
    }

    static string ToBase36(System.Numerics.BigInteger num)
    {
        if (num.IsZero) return "0";
        const string chars = "0123456789abcdefghijklmnopqrstuvwxyz";
        var result = new StringBuilder();
        var baseVal = new System.Numerics.BigInteger(36);
        while (num > 0)
        {
            num = System.Numerics.BigInteger.DivRem(num, baseVal, out var rem);
            result.Insert(0, chars[(int)rem]);
        }
        return result.ToString();
    }

    // ─── Parse .regret file ───────────────────────────────────────────────────
    static (string cluster, string entry, string assembly, string storedHash,
            object? input, object? output, bool multiArgs) ParseRegret(string content)
    {
        var sections = content.Split("\n---\n", 2);
        var metaLines = sections[0].Split("\n");
        var dataSection = sections.Length > 1 ? sections[1] : "";

        string cluster = "", entry = "", assembly = "", storedHash = "";
        bool multiArgs = false;

        foreach (var line in metaLines)
        {
            var colonIdx = line.IndexOf(": ");
            if (colonIdx < 0) continue;
            var key = line[..colonIdx];
            var val = line[(colonIdx + 2)..];
            switch (key)
            {
                case "cluster": cluster = val; break;
                case "entry": entry = val; break;
                case "assembly": assembly = val; break;
                case "fingerprint": storedHash = val; break;
                case "multiArgs": multiArgs = val == "true"; break;
            }
        }

        // Parse INPUT and OUTPUT from data section
        object? input = null;
        object? output = null;
        foreach (var line in dataSection.Split("\n"))
        {
            if (line.StartsWith("INPUT  "))
            {
                var jsonStr = line["INPUT  ".Length..];
                input = JsonNode.Parse(jsonStr);
            }
            else if (line.StartsWith("OUTPUT "))
            {
                var jsonStr = line["OUTPUT ".Length..];
                output = JsonNode.Parse(jsonStr);
            }
        }

        return (cluster, entry, assembly, storedHash, input, output, multiArgs);
    }

    // ─── Main ─────────────────────────────────────────────────────────────────
    static void Main(string[] args)
    {
        string stdinJson;
        if (Console.IsInputRedirected)
        {
            stdinJson = Console.In.ReadToEnd();
        }
        else
        {
            Console.Error.WriteLine("ERROR: Expected cluster JSON on stdin");
            Environment.Exit(1);
            return;
        }

        var regretDir = args.Length > 0 ? args[0] : "regrets";
        var projectDir = args.Length > 1 ? args[1] : Directory.GetCurrentDirectory();
        var failFast = args.Length > 2 && args[2] == "--fail-fast";

        var clusters = JsonNode.Parse(stdinJson)?.AsArray();
        if (clusters == null || clusters.Count == 0)
        {
            Console.Error.WriteLine("No clusters to validate");
            return;
        }

        int passed = 0;
        int failed = 0;
        int skipped = 0;

        foreach (var clusterNode in clusters)
        {
            var cluster = clusterNode!.AsObject();
            var id = cluster["id"]?.GetValue<string>() ?? "";
            var entry = cluster["entry"]?.GetValue<string>() ?? "";
            var assembly = cluster["assembly"]?.GetValue<string>() ?? cluster["file"]?.GetValue<string>() ?? "";
            var multiArgs = cluster["multiArgs"]?.GetValue<bool>() ?? false;

            var regretPath = Path.Combine(regretDir, $"{id}.regret");
            if (!File.Exists(regretPath))
            {
                Console.WriteLine($"  ⚠️  MISSING: {id}.regret — no golden contract found");
                skipped++;
                continue;
            }

            var regretContent = File.ReadAllText(regretPath);
            var (regCluster, regEntry, regAssembly, storedHash, storedInput, storedOutput, regMultiArgs) = ParseRegret(regretContent);

            Console.WriteLine($"\n🔍 Cluster: {id} (entry: {entry})");

            // Load assembly and find method
            Assembly? asm = null;
            Type? targetType = null;
            MethodInfo? method = null;

            try
            {
                var asmPath = Path.IsPathRooted(assembly) ? assembly : Path.Combine(projectDir, assembly);
                if (File.Exists(asmPath))
                {
                    asm = Assembly.LoadFrom(asmPath);
                }
                else
                {
                    var fileName = Path.GetFileNameWithoutExtension(assembly);
                    var binDebug = Path.Combine(projectDir, "bin", "Debug", "net8.0", fileName + ".dll");
                    var binRelease = Path.Combine(projectDir, "bin", "Release", "net8.0", fileName + ".dll");
                    if (File.Exists(binDebug)) asm = Assembly.LoadFrom(binDebug);
                    else if (File.Exists(binRelease)) asm = Assembly.LoadFrom(binRelease);
                    else
                    {
                        Console.WriteLine($"  ❌ FAIL: Assembly not found: {assembly}");
                        failed++;
                        if (failFast) Environment.Exit(1);
                        continue;
                    }
                }

                foreach (var type in asm.GetTypes())
                {
                    var methodInfo = type.GetMethod(entry, BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance);
                    if (methodInfo != null)
                    {
                        targetType = type;
                        method = methodInfo;
                        break;
                    }
                }

                if (method == null)
                {
                    Console.WriteLine($"  ❌ FAIL: Method '{entry}' not found in assembly");
                    failed++;
                    if (failFast) Environment.Exit(1);
                    continue;
                }

                // Re-invoke with stored input
                object?[]? invokeArgs;
                if (multiArgs && storedInput is List<object?> list)
                {
                    invokeArgs = list.ToArray();
                }
                else
                {
                    invokeArgs = new[] { storedInput };
                }

                object? instance = null;
                if (!method.IsStatic)
                {
                    instance = Activator.CreateInstance(targetType!);
                }

                object? result;
                try
                {
                    result = method.Invoke(instance, invokeArgs);
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"  ❌ FAIL: Invocation threw: {ex.InnerException?.Message ?? ex.Message}");
                    failed++;
                    if (failFast) Environment.Exit(1);
                    continue;
                }

                // Compute fingerprint
                var inputForHash = multiArgs ? invokeArgs : invokeArgs[0];
                var newFp = Fingerprint(inputForHash, result);

                // Compare
                if (newFp == storedHash)
                {
                    Console.WriteLine($"  ✅ PASS: fingerprint {newFp} matches");
                    passed++;
                }
                else
                {
                    Console.WriteLine($"  ❌ FAIL: fingerprint mismatch");
                    Console.WriteLine($"     Expected: {storedHash}");
                    Console.WriteLine($"     Got:      {newFp}");
                    Console.WriteLine($"     Input:    {StableStringify(inputForHash)}");
                    Console.WriteLine($"     Output:   {StableStringify(result)}");
                    failed++;
                    if (failFast) Environment.Exit(1);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"  ❌ FAIL: {ex.Message}");
                failed++;
                if (failFast) Environment.Exit(1);
            }
        }

        Console.WriteLine($"\n{'='}/40");
        Console.WriteLine($"🔍 Validation complete: {passed} passed, {failed} failed, {skipped} skipped");

        if (failed > 0) Environment.Exit(1);
    }
}
CSEOF

# Build the validate project
echo "🔧 Building validate project..."
dotnet build "$VALIDATE_PROJ" -c Release --nologo -v quiet 2>&1 | tail -3

# Run validate, passing clusters JSON via stdin
echo "🧪 Running regret validation..."
FAIL_FAST_FLAG=""
if [ "$FAIL_FAST" = true ]; then
  FAIL_FAST_FLAG="--fail-fast"
fi

echo "$CLUSTERS_JSON" | dotnet run --project "$VALIDATE_PROJ" -c Release --no-build -- "$REGRET_DIR" "$PROJECT_DIR" "$FAIL_FAST_FLAG" 2>&1

EXIT_CODE=$?
if [ $EXIT_CODE -eq 0 ]; then
  echo ""
  echo "✅ All validations passed."
else
  echo ""
  echo "❌ Some validations failed."
fi
exit $EXIT_CODE
