#!/usr/bin/env bash
# validate_csharp.sh — re-invoke C# functions and compare fingerprints against .regret files
#
# Usage:
#   bash scripts/validate_csharp.sh                # validate all C# clusters
#   bash scripts/validate_csharp.sh --cluster <id> # validate specific cluster
#
# Exit codes:
#   0 — all clusters PASS
#   1 — one or more clusters FAIL
#   2 — no C# clusters found / dotnet not installed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd)"
MANIFEST="${PROJECT_DIR}/regrets/manifest.json"
REGRET_DIR="${PROJECT_DIR}/regrets"

CLUSTER_FLAG=""

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
    exit 2
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

# ─── C# fingerprint code (same as capture) ────────────────────────────────────

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
        return JsonSerializer.Serialize(obj);
    }

    public static string ToBase36(byte[] hashBytes)
    {
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

# ─── Main ─────────────────────────────────────────────────────────────────────

echo "🔍 Validating C# clusters..."

if ! command -v dotnet &> /dev/null; then
  echo "⚠️  .NET SDK is not installed. Cannot validate C# clusters."
  exit 2
fi

CLUSTERS_JSON=$(read_csharp_clusters)

if [ "$CLUSTERS_JSON" = "[]" ]; then
  echo "No C# clusters found in manifest."
  exit 0
fi

# Parse clusters and generate validate program
VALIDATE_DIR="${REGRET_DIR}/csharp_validate"
mkdir -p "$VALIDATE_DIR"

echo "$CLUSTERS_JSON" | node -e "
  const fs = require('fs');
  const clusters = JSON.parse(fs.readFileSync('/dev/stdin', 'utf8'));
  
  const lines = [];
  
  // Add Fingerprint class
  lines.push(\`$(echo "$FINGERPRINT_CSHARP")\`);
  lines.push('');
  
  lines.push('// --- Main ---');
  lines.push('int passCount = 0;');
  lines.push('int failCount = 0;');
  lines.push('');
  
  for (const cluster of clusters) {
    const { id, entry, csharpClass, inputs, multiArgs } = cluster;
    const className = csharpClass || entry.split('.')[0] || 'Program';
    const methodName = entry.split('.').pop() || entry;
    const testInputs = inputs || [null];
    
    // Read the .regret file to get the golden hash
    const regretPath = 'regrets/' + id + '.regret';
    
    for (let i = 0; i < testInputs.length; i++) {
      const input = testInputs[i];
      const inputStr = JSON.stringify(input).replace(/\"/g, '\\\\\"');
      
      lines.push('// --- Cluster: ' + id + ' input[' + i + '] ---');
      lines.push('try {');
      lines.push('  var regretContent = System.IO.File.ReadAllText(@\"' + regretPath + '\");');
      lines.push('  var goldenHash = \"\";');
      lines.push('  foreach (var line in regretContent.Split(\"\\\\n\")) {');
      lines.push('    if (line.StartsWith(\"HASH   \")) goldenHash = line.Substring(7).Trim();');
      lines.push('  }');
      lines.push('  var inputObj = System.Text.Json.JsonSerializer.Deserialize<object>(@\"' + inputStr.replace(/\"/g, '\"\"') + '\");');
      
      if (input === null) {
        lines.push('  var output = ' + className + '.' + methodName + '();');
      } else if (Array.isArray(input) && multiArgs) {
        const args = input.map((v) => 'System.Text.Json.JsonSerializer.Deserialize<object>(@\"' + JSON.stringify(v).replace(/\"/g, '\"\"') + '\")').join(', ');
        lines.push('  var output = ' + className + '.' + methodName + '(' + args + ');');
      } else {
        lines.push('  var output = ' + className + '.' + methodName + '(inputObj);');
      }
      
      lines.push('  var liveFp = Fingerprint.Compute(inputObj, output);');
      lines.push('  if (liveFp == goldenHash) {');
      lines.push('    Console.WriteLine(\"  ✅ PASS ' + id + ': fp=\" + liveFp);');
      lines.push('    passCount++;');
      lines.push('  } else {');
      lines.push('    Console.WriteLine(\"  ❌ FAIL ' + id + ': golden=\" + goldenHash + \" live=\" + liveFp);');
      lines.push('    failCount++;');
      lines.push('  }');
      lines.push('} catch (Exception ex) {');
      lines.push('  Console.Error.WriteLine(\"  ❌ FAIL ' + id + ': \" + ex.Message);');
      lines.push('  failCount++;');
      lines.push('}');
      lines.push('');
    }
  }
  
  lines.push('Console.WriteLine();');
  lines.push('Console.WriteLine($\"{passCount} passed, {failCount} failed\");');
  lines.push('Environment.Exit(failCount > 0 ? 1 : 0);');
  
  console.log(lines.join('\\n'));
" > "$VALIDATE_DIR/Program.cs"

# Create project file if not exists
if [ ! -f "$VALIDATE_DIR/csharp_validate.csproj" ]; then
  cat > "$VALIDATE_DIR/csharp_validate.csproj" << 'PROJEOF'
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

echo "📄 Generated: $VALIDATE_DIR/Program.cs"
echo "🧪 Running C# validation..."

cd "$VALIDATE_DIR"
dotnet run 2>&1 || {
  echo "⚠️  C# validate execution failed."
  cd "$PROJECT_DIR"
  exit 1
}
cd "$PROJECT_DIR"
