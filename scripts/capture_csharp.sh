#!/usr/bin/env bash
# capture_csharp.sh — compile + run regret capture for C# clusters
# Generates a C# Program.cs from manifest.json, runs `dotnet run`, and writes .regret files.
#
# Usage:
#   bash scripts/capture_csharp.sh                # capture all C# clusters
#   bash scripts/capture_csharp.sh --cluster <id> # capture specific cluster
#
# Requirements:
#   - .NET SDK 8.0+ installed (dotnet command available)
#   - C# project with the target functions accessible
#   - regrets/manifest.json with clusters where stack="csharp"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"

mkdir -p "$REGRET_DIR"

CLUSTER_FLAG=""

# Parse --cluster flag
for arg in "$@"; do
  if [[ "$arg" == "--cluster" ]]; then
    shift
    CLUSTER_FLAG="$1"
    break
  fi
done

# ─── Helper: Read C# clusters from manifest ───────────────────────────────────

read_csharp_clusters() {
  if [ ! -f "$MANIFEST" ]; then
    echo "❌ regrets/manifest.json not found"
    exit 1
  fi
  node -e "
    const m = JSON.parse(require('fs').readFileSync('$MANIFEST', 'utf8'));
    let clusters = m.clusters.filter(c => c.stack === 'csharp');
    const filter = '$CLUSTER_FLAG'.trim();
    if (filter) {
      clusters = clusters.filter(c => c.id === filter);
    }
    console.log(JSON.stringify(clusters));
  "
}

# ─── C# fingerprint code (embedded in generated Program.cs) ───────────────────
# Must produce IDENTICAL results to fingerprint.js / fingerprint.py / fingerprint_go:
#   sha256(stableStringify(input) + "|" + stableStringify(output)) → base36 → first 7 chars

read -r -d '' FINGERPRINT_CSHARP << 'CSEOF' || true
using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RegretTest;

public static class Fingerprint
{
    public static string StableStringify(object? obj)
    {
        if (obj == null) return "null";
        if (obj is bool b) return b ? "true" : "false";
        if (obj is int i) return i.ToString();
        if (obj is long l) return l.ToString();
        if (obj is double d)
        {
            if (double.IsNaN(d)) return "\"__nan__\"";
            if (double.IsPositiveInfinity(d)) return "\"__infinity__\"";
            if (double.IsNegativeInfinity(d)) return "\"__neg_infinity__\"";
            return d.ToString("G");
        }
        if (obj is string s) return JsonSerializer.Serialize(s);
        if (obj is IList<object> list)
        {
            var parts = list.Select(item => StableStringify(item));
            return "[" + string.Join(",", parts) + "]";
        }
        if (obj is IDictionary<string, object> dict)
        {
            var sortedKeys = dict.Keys.OrderBy(k => k, StringComparer.Ordinal).ToList();
            var parts = sortedKeys.Select(k => JsonSerializer.Serialize(k) + ":" + StableStringify(dict[k]));
            return "{" + string.Join(",", parts) + "}";
        }
        // Fallback: serialize via System.Text.Json
        return JsonSerializer.Serialize(obj);
    }

    public static string ToBase36(byte[] hashBytes)
    {
        // Convert hash bytes to a big integer (positive)
        // Prepend 0x00 byte to ensure unsigned interpretation
        byte[] unsigned = new byte[hashBytes.Length + 1];
        Array.Copy(hashBytes, 0, unsigned, 1, hashBytes.Length);
        var bigInt = new System.Numerics.BigInteger(unsigned);

        if (bigInt.Sign == 0) return "0";

        const string chars = "0123456789abcdefghijklmnopqrstuvwxyz";
        var absVal = System.Numerics.BigInteger.Abs(bigInt);
        var result = new StringBuilder();
        while (absVal > 0)
        {
            absVal = System.Numerics.BigInteger.DivRem(absVal, 36, out var remainder);
            result.Insert(0, chars[(int)remainder]);
        }
        return result.ToString();
    }

    public static string Compute(object? input, object? output)
    {
        string combined = StableStringify(input) + "|" + StableStringify(output);
        using var sha256 = SHA256.Create();
        byte[] hashBytes = sha256.ComputeHash(Encoding.UTF8.GetBytes(combined));
        string b36 = ToBase36(hashBytes);
        return b36.Length >= 7 ? b36.Substring(0, 7) : b36;
    }
}
CSEOF

# ─── Helper: Generate C# capture program ──────────────────────────────────────

generate_capture_program() {
  local clusters_json="$1"
  local output_dir="${REGRET_DIR}/csharp_capture"
  mkdir -p "$output_dir"

  # Generate the capture Program.cs
  echo "$clusters_json" | node -e "
    const clusters = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));

    // Emit the capture program
    const lines = [];
    lines.push('using System;');
    lines.push('using System.Collections.Generic;');
    lines.push('System.IO.File.WriteAllText(\"regrets/csharp_capture_log.txt\", \"\");');
    lines.push('');
    lines.push('var fp = typeof(Fingerprint);');
    lines.push('');

    for (const cluster of clusters) {
      const { id, entry, file, csharpProject, csharpClass, inputs, multiArgs } = cluster;
      const testInputs = inputs || [null];
      const className = csharpClass || entry.split('.')[0] || 'Program';
      const methodName = entry.split('.').pop() || entry;
      const projectPath = csharpProject || file || '';

      for (let i = 0; i < testInputs.length; i++) {
        const input = testInputs[i];
        const inputJSON = JSON.stringify(input);
        const inputStr = JSON.stringify(input).replace(/\\\\/g, '\\\\\\\\').replace(/\"/g, '\\\\\"');

        lines.push('// --- Cluster: ' + id + ' input[' + i + '] ---');
        lines.push('try {');
        lines.push('  var inputObj = System.Text.Json.JsonSerializer.Deserialize<object>(@\"' + inputStr.replace(/\"/g, '\"\"') + '\");');

        // Build the method call
        if (input === null) {
          lines.push('  var output = ' + className + '.' + methodName + '();');
        } else if (Array.isArray(input) && multiArgs) {
          // Multi-arg: spread array as individual args
          const args = input.map((v, idx) => 'System.Text.Json.JsonSerializer.Deserialize<object>(@\"' + JSON.stringify(v).replace(/\"/g, '\"\"') + '\")').join(', ');
          lines.push('  var output = ' + className + '.' + methodName + '(' + args + ');');
        } else {
          lines.push('  var output = ' + className + '.' + methodName + '(inputObj);');
        }

        lines.push('  var fp = Fingerprint.Compute(inputObj, output);');
        lines.push('  var timestamp = DateTime.UtcNow.ToString(\"yyyy-MM-ddTHH:mm:ssZ\");');
        lines.push('  var outputJson = System.Text.Json.JsonSerializer.Serialize(output);');
        lines.push('  var content = \"cluster: ' + id + '\\\\n\" +');
        lines.push('    \"version: 1\\\\n\" +');
        lines.push('    \"fingerprint: \" + fp + \"\\\\n\" +');
        lines.push('    \"captured: \" + timestamp + \"\\\\n\" +');
        lines.push('    \"stack: csharp\\\\n\" +');
        lines.push('    \"fingerprintLevel: entry\\\\n\" +');
        lines.push('    \"---\\\\n\" +');
        lines.push('    \"INPUT  \" + System.Text.Json.JsonSerializer.Serialize(inputObj) + \"\\\\n\" +');
        lines.push('    \"OUTPUT \" + outputJson + \"\\\\n\" +');
        lines.push('    \"HASH   \" + fp;');
        lines.push('  System.IO.File.WriteAllText(\"regrets/' + id + '.regret\", content);');
        lines.push('  Console.WriteLine(\"  ✅ ' + id + ': fp=\" + fp);');
        lines.push('} catch (Exception ex) {');
        lines.push('  Console.Error.WriteLine(\"  ❌ ' + id + ': \" + ex.Message);');
        lines.push('}');
        lines.push('');
      }
    }

    // Add the Fingerprint class at the top
    const fingerprintClass = \`$(echo "$FINGERPRINT_CSHARP")\`;
    console.log(fingerprintClass);
    console.log('');
    console.log('// --- Main ---');
    console.log(lines.join('\\n'));
    console.log('Console.WriteLine(\"Capture complete.\");');
  " > "$output_dir/Program.cs"

  echo "$output_dir/Program.cs"
}

# ─── Main ─────────────────────────────────────────────────────────────────────

echo "📡 Capturing C# clusters..."

# Check if dotnet is available
if ! command -v dotnet &> /dev/null; then
  echo "⚠️  .NET SDK is not installed."
  echo "   Install .NET SDK 8.0+ to use the C# stack."
  echo "   https://dotnet.microsoft.com/download"
  exit 1
fi

# Read clusters from manifest
CLUSTERS_JSON=$(read_csharp_clusters)

if [ "$CLUSTERS_JSON" = "[]" ]; then
  echo "No C# clusters found in manifest."
  exit 0
fi

echo "Found C# clusters:"
echo "$CLUSTERS_JSON" | node -e "
  const clusters = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
  clusters.forEach(c => console.log('  - ' + c.id + ' (' + c.entry + ')'));
"

# Generate capture program
PROGRAM_FILE=$(generate_capture_program "$CLUSTERS_JSON")
echo "📄 Generated: $PROGRAM_FILE"

# Create a temporary project if not in a .NET project
CAPTURE_DIR="${REGRET_DIR}/csharp_capture"
if [ ! -f "$CAPTURE_DIR/csharp_capture.csproj" ]; then
  cat > "$CAPTURE_DIR/csharp_capture.csproj" << 'PROJEOF'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
PROJEOF
fi

# Run capture
echo "🔧 Running C# capture..."
cd "$CAPTURE_DIR"
dotnet run 2>&1 || {
  echo "⚠️  C# capture execution failed."
  echo "   Check that the target functions are accessible from the capture project."
  exit 1
}
cd "$PROJECT_DIR"

echo "✅ Capture complete."
