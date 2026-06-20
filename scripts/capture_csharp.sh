#!/usr/bin/env bash
# capture_csharp.sh — capture regret fingerprints for C# (.NET) clusters
#
# Generates a temporary C# console project that imports the target library,
# invokes the entry function with manifest inputs, computes the SHA-256→base36
# fingerprint (identical algorithm to JS/Python/Go), and writes .regret files.
#
# Usage:
#   bash scripts/capture_csharp.sh                         # capture all C# clusters
#   bash scripts/capture_csharp.sh --cluster my-cluster    # capture one cluster
#   bash scripts/capture_csharp.sh --manifest ./custom-manifest.json
#
# .regret file format (identical to all stacks):
#   cluster: <id>
#   version: 1
#   fingerprint: <7-char base36>
#   captured: <ISO8601 timestamp>
#   entry: <function name>
#   stack: csharp
#   fingerprintLevel: entry
#   assembly: <DLL path or NuGet package>
#   ---
#   INPUT  <JSON>
#   OUTPUT <JSON>
#   HASH   <7-char base36>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"

mkdir -p "$REGRET_DIR"

# Parse CLI args
CLUSTER_FILTER=""
MANIFEST_PATH="$MANIFEST"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster) CLUSTER_FILTER="$2"; shift 2 ;;
    --manifest) MANIFEST_PATH="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Check if dotnet is available
if ! command -v dotnet &> /dev/null; then
  echo "⚠️  .NET SDK (dotnet) is not installed."
  echo "   Install from: https://dotnet.microsoft.com/download"
  echo "   Alternatively, use JS capture as fallback:"
  echo "   node ${SCRIPT_DIR}/capture.js"
  exit 1
fi

# Read C# clusters from manifest
CLUSTERS_JSON=$(node -e "
  const fs = require('fs');
  const path = process.argv[1];
  const m = JSON.parse(fs.readFileSync(path, 'utf8'));
  let clusters = (m.clusters || []).filter(c => c.stack === 'csharp');
  const filter = process.argv[2];
  if (filter) {
    clusters = clusters.filter(c => c.id === filter);
  }
  console.log(JSON.stringify(clusters));
" "$MANIFEST_PATH" "$CLUSTER_FILTER")

if [ "$CLUSTERS_JSON" = "[]" ]; then
  echo "No C# clusters found in manifest."
  exit 0
fi

echo "📡 Capturing C# clusters..."
echo "$CLUSTERS_JSON" | node -e "
  const clusters = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
  clusters.forEach(c => console.log('  - ' + c.id + ' (' + c.entry + ')'));
"

# Generate the C# capture project
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

CAPTURE_PROJ="$TEMP_DIR/RegretCapture"
mkdir -p "$CAPTURE_PROJ"

# Generate .csproj
cat > "$CAPTURE_PROJ/RegretCapture.csproj" << 'CSPROJ'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
CSPROJ

# Generate Program.cs with fingerprint logic + cluster dispatch
# The C# code must produce IDENTICAL fingerprints to JS/Python/Go:
# sha256(stableStringify(input) + "|" + stableStringify(output)) → base36 → first 7 chars
# stableStringify = JSON with sorted keys recursively

cat > "$CAPTURE_PROJ/Program.cs" << 'CSEOF'
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

namespace RegretCapture;

public class Program
{
    // ─── Stable JSON Stringify (sorted keys, identical to JS/Python/Go) ────────
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
        if (obj is IDictionary<string, JsonNode?> jdict)
        {
            var keys = jdict.Keys.OrderBy(k => k, StringComparer.Ordinal).ToList();
            var parts = keys.Select(k => $"{JsonSerializer.Serialize(k)}:{StableStringify(JsonNodeToObject(jdict[k]))}");
            return "{" + string.Join(",", parts) + "}";
        }
        if (obj is IEnumerable<object?> arr)
        {
            var parts = arr.Select(StableStringify);
            return "[" + string.Join(",", parts) + "]";
        }
        if (obj is JsonArray jarr)
        {
            var parts = jarr.Select(e => StableStringify(JsonNodeToObject(e)));
            return "[" + string.Join(",", parts) + "]";
        }
        // Fallback: serialize via JsonSerializer, then re-stabilize
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

    // ─── Fingerprint (SHA-256 → base36 → 7 chars, identical to JS/Python/Go) ──
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

    // ─── Write .regret file ───────────────────────────────────────────────────
    static void WriteRegretFile(string regretDir, string clusterId, string entry, string assembly,
        object? input, object? output, string fingerprint)
    {
        var timestamp = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.ffffffZ");
        var inputJson = JsonSerializer.Serialize(input, new JsonSerializerOptions { WriteIndented = false });
        var outputJson = JsonSerializer.Serialize(output, new JsonSerializerOptions { WriteIndented = false });

        var content = $"""cluster: {clusterId}
version: 1
fingerprint: {fingerprint}
captured: {timestamp}
entry: {entry}
stack: csharp
fingerprintLevel: entry
assembly: {assembly}
---
INPUT  {inputJson}
OUTPUT {outputJson}
HASH   {fingerprint}""";

        var filePath = Path.Combine(regretDir, $"{clusterId}.regret");
        File.WriteAllText(filePath, content);
        Console.WriteLine($"  ✓ Wrote {filePath}");
    }

    // ─── Main: read clusters from stdin (JSON), process each ──────────────────
    static void Main(string[] args)
    {
        // Read cluster JSON from stdin
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

        var clusters = JsonNode.Parse(stdinJson)?.AsArray();
        if (clusters == null || clusters.Count == 0)
        {
            Console.Error.WriteLine("No clusters to process");
            return;
        }

        int captured = 0;
        int skipped = 0;

        foreach (var clusterNode in clusters)
        {
            var cluster = clusterNode!.AsObject();
            var id = cluster["id"]?.GetValue<string>() ?? "";
            var entry = cluster["entry"]?.GetValue<string>() ?? "";
            var assembly = cluster["assembly"]?.GetValue<string>() ?? cluster["file"]?.GetValue<string>() ?? "";
            var className = cluster["className"]?.GetValue<string>() ?? "";
            var inputsNode = cluster["inputs"];
            var multiArgs = cluster["multiArgs"]?.GetValue<bool>() ?? false;

            Console.WriteLine($"\n📡 Cluster: {id} (entry: {entry})");

            // Load assembly
            Assembly? asm = null;
            Type? targetType = null;
            MethodInfo? method = null;

            try
            {
                // Try loading from assembly path
                var asmPath = Path.IsPathRooted(assembly) ? assembly : Path.Combine(projectDir, assembly);
                if (File.Exists(asmPath))
                {
                    asm = Assembly.LoadFrom(asmPath);
                }
                else
                {
                    // Try loading from bin/Debug or bin/Release
                    var fileName = Path.GetFileNameWithoutExtension(assembly);
                    var binDebug = Path.Combine(projectDir, "bin", "Debug", "net8.0", fileName + ".dll");
                    var binRelease = Path.Combine(projectDir, "bin", "Release", "net8.0", fileName + ".dll");
                    if (File.Exists(binDebug)) asm = Assembly.LoadFrom(binDebug);
                    else if (File.Exists(binRelease)) asm = Assembly.LoadFrom(binRelease);
                    else
                    {
                        Console.WriteLine($"  ⚠️  Assembly not found: {assembly}");
                        skipped++;
                        continue;
                    }
                }

                // Find type and method
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
                    Console.WriteLine($"  ⚠️  Method '{entry}' not found in assembly");
                    skipped++;
                    continue;
                }

                // Process each input
                var inputs = inputsNode?.AsArray();
                if (inputs == null || inputs.Count == 0)
                {
                    Console.WriteLine($"  ⚠️  No inputs defined");
                    skipped++;
                    continue;
                }

                foreach (var inputNode in inputs)
                {
                    object?[]? invokeArgs;
                    if (multiArgs && inputNode is JsonArray multiInput)
                    {
                        invokeArgs = multiInput.Select(JsonNodeToObject).ToArray();
                    }
                    else
                    {
                        invokeArgs = new[] { JsonNodeToObject(inputNode) };
                    }

                    // Create instance if instance method
                    object? instance = null;
                    if (!method.IsStatic)
                    {
                        instance = Activator.CreateInstance(targetType!);
                    }

                    // Invoke
                    object? result;
                    try
                    {
                        result = method.Invoke(instance, invokeArgs);
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"  ⚠️  Invocation threw: {ex.InnerException?.Message ?? ex.Message}");
                        skipped++;
                        continue;
                    }

                    // Check trivial output
                    if (result == null)
                    {
                        Console.WriteLine($"  ⚠️  Output is null — trivial guard skip");
                        skipped++;
                        continue;
                    }

                    // Compute fingerprint
                    var inputForHash = multiArgs ? invokeArgs : invokeArgs[0];
                    var fp = Fingerprint(inputForHash, result);

                    // Write .regret file
                    WriteRegretFile(regretDir, id, entry, assembly, inputForHash, result, fp);
                    captured++;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"  ❌ Error: {ex.Message}");
                skipped++;
            }
        }

        Console.WriteLine($"\n{'='}/40");
        Console.WriteLine($"📡 Capture complete: {captured} captured, {skipped} skipped");
    }
}
CSEOF

# Build the capture project
echo "🔧 Building capture project..."
dotnet build "$CAPTURE_PROJ" -c Release --nologo -v quiet 2>&1 | tail -3

# Run capture, passing clusters JSON via stdin
echo "🧪 Running regret capture..."
echo "$CLUSTERS_JSON" | dotnet run --project "$CAPTURE_PROJ" -c Release --no-build -- "$REGRET_DIR" "$PROJECT_DIR" 2>&1

echo ""
echo "✅ Capture complete."
