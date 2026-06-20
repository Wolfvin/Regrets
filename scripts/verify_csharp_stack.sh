#!/usr/bin/env bash
# verify_csharp_stack.sh — end-to-end verification of C# capture+validate
#
# This script:
# 1. Creates a temp C# project with a pure function
# 2. Captures fingerprints via capture_csharp.sh
# 3. Validates → should PASS (code unchanged)
# 4. Modifies the function (breaking change)
# 5. Validates → should FAIL (fingerprint mismatch)
# 6. Restores original → validates → should PASS again
#
# Usage: bash scripts/verify_csharp_stack.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

echo "═══════════════════════════════════════════════════════════════"
echo "  C# Stack Verification — capture → validate PASS → break → FAIL"
echo "═══════════════════════════════════════════════════════════════"

# Check dotnet
if ! command -v dotnet &> /dev/null; then
  echo "⚠️  .NET SDK not installed. Cannot verify C# stack."
  exit 1
fi

# Create temp project
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

echo ""
echo "📦 Creating temp C# project at $TEMP_DIR"
mkdir -p "$TEMP_DIR"

cat > "$TEMP_DIR/ExampleLib.csproj" << 'EOF'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <AssemblyName>ExampleLib</AssemblyName>
  </PropertyGroup>
</Project>
EOF

cat > "$TEMP_DIR/MathUtils.cs" << 'EOF'
using System;
using System.Collections.Generic;
using System.Linq;

namespace ExampleLib;

public class MathUtils
{
    public static int Add(int a, int b) => a + b;
    public static string ReverseString(string input)
    {
        if (string.IsNullOrEmpty(input)) return input;
        var chars = input.ToCharArray();
        Array.Reverse(chars);
        return new string(chars);
    }
    public static List<string> FizzBuzz(int n)
    {
        var result = new List<string>();
        for (int i = 1; i <= n; i++)
        {
            if (i % 15 == 0) result.Add("FizzBuzz");
            else if (i % 3 == 0) result.Add("Fizz");
            else if (i % 5 == 0) result.Add("Buzz");
            else result.Add(i.ToString());
        }
        return result;
    }
}
EOF

# Create manifest
mkdir -p "$TEMP_DIR/regrets"
cat > "$TEMP_DIR/regrets/manifest.json" << 'EOF'
{
  "clusters": [
    {
      "id": "csharp-add",
      "entry": "Add",
      "file": "ExampleLib.dll",
      "stack": "csharp",
      "fingerprintLevel": "entry",
      "inputs": [[3, 4], [10, 20]],
      "multiArgs": true
    },
    {
      "id": "csharp-reverse",
      "entry": "ReverseString",
      "file": "ExampleLib.dll",
      "stack": "csharp",
      "fingerprintLevel": "entry",
      "inputs": ["hello", "regrets"]
    },
    {
      "id": "csharp-fizzbuzz",
      "entry": "FizzBuzz",
      "file": "ExampleLib.dll",
      "stack": "csharp",
      "fingerprintLevel": "entry",
      "inputs": [5, 15]
    }
  ]
}
EOF

# Build the library
echo "🔧 Building ExampleLib..."
cd "$TEMP_DIR"
dotnet build -c Release --nologo -v quiet 2>&1 | tail -2

# ─── Phase 1: Capture ─────────────────────────────────────────
echo ""
echo "─── Phase 1: Capture ──────────────────────────────────────"
bash "$REPO_DIR/scripts/capture_csharp.sh" 2>&1

# Verify .regret files exist
echo ""
echo "📄 Generated .regret files:"
ls -la regrets/*.regret 2>/dev/null || { echo "❌ No .regret files generated!"; exit 1; }

# Show one .regret file
echo ""
echo "📋 Sample .regret file (csharp-add.regret):"
cat regrets/csharp-add.regret 2>/dev/null || echo "(not found)"

# ─── Phase 2: Validate (should PASS) ──────────────────────────
echo ""
echo "─── Phase 2: Validate (expect PASS — code unchanged) ──────"
if bash "$REPO_DIR/scripts/validate_csharp.sh" 2>&1; then
  echo "✅ Phase 2 PASSED: validation succeeded with unchanged code"
else
  echo "❌ Phase 2 FAILED: validation should have passed"
  exit 1
fi

# ─── Phase 3: Break the code ──────────────────────────────────
echo ""
echo "─── Phase 3: Break the code (change Add to multiply) ──────"
cat > "$TEMP_DIR/MathUtils.cs" << 'EOF'
using System;
using System.Collections.Generic;
using System.Linq;

namespace ExampleLib;

public class MathUtils
{
    public static int Add(int a, int b) => a * b;  // BUG: should be a + b
    public static string ReverseString(string input)
    {
        if (string.IsNullOrEmpty(input)) return input;
        var chars = input.ToCharArray();
        Array.Reverse(chars);
        return new string(chars);
    }
    public static List<string> FizzBuzz(int n)
    {
        var result = new List<string>();
        for (int i = 1; i <= n; i++)
        {
            if (i % 15 == 0) result.Add("FizzBuzz");
            else if (i % 3 == 0) result.Add("Fizz");
            else if (i % 5 == 0) result.Add("Buzz");
            else result.Add(i.ToString());
        }
        return result;
    }
}
EOF

echo "🔧 Rebuilding with broken code..."
dotnet build -c Release --nologo -v quiet 2>&1 | tail -2

echo ""
echo "─── Phase 3: Validate (expect FAIL — code is broken) ──────"
if bash "$REPO_DIR/scripts/validate_csharp.sh" 2>&1; then
  echo "❌ Phase 3 FAILED: validation should have failed (code is broken)"
  exit 1
else
  echo "✅ Phase 3 PASSED: validation correctly failed on broken code"
fi

# ─── Phase 4: Restore and re-validate ─────────────────────────
echo ""
echo "─── Phase 4: Restore original code ────────────────────────"
cat > "$TEMP_DIR/MathUtils.cs" << 'EOF'
using System;
using System.Collections.Generic;
using System.Linq;

namespace ExampleLib;

public class MathUtils
{
    public static int Add(int a, int b) => a + b;
    public static string ReverseString(string input)
    {
        if (string.IsNullOrEmpty(input)) return input;
        var chars = input.ToCharArray();
        Array.Reverse(chars);
        return new string(chars);
    }
    public static List<string> FizzBuzz(int n)
    {
        var result = new List<string>();
        for (int i = 1; i <= n; i++)
        {
            if (i % 15 == 0) result.Add("FizzBuzz");
            else if (i % 3 == 0) result.Add("Fizz");
            else if (i % 5 == 0) result.Add("Buzz");
            else result.Add(i.ToString());
        }
        return result;
    }
}
EOF

echo "🔧 Rebuilding with restored code..."
dotnet build -c Release --nologo -v quiet 2>&1 | tail -2

echo ""
echo "─── Phase 4: Validate (expect PASS — code restored) ───────"
if bash "$REPO_DIR/scripts/validate_csharp.sh" 2>&1; then
  echo "✅ Phase 4 PASSED: validation succeeded after restore"
else
  echo "❌ Phase 4 FAILED: validation should have passed after restore"
  exit 1
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  ✅ C# Stack Verification COMPLETE — all phases passed"
echo "═══════════════════════════════════════════════════════════════"
