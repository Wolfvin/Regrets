#!/usr/bin/env bash
# demo.sh — end-to-end demo of C# Regrets capture + validate
#
# This script:
#   1. Builds the example C# library
#   2. Runs capture → produces .regret file with fingerprint
#   3. Runs validate (should PASS — no code changed)
#   4. Simulates a valid refactor (internal change, same output)
#   5. Rebuilds + validates (should still PASS)
#   6. Restores original code
#   7. Simulates a breaking change (output changes)
#   8. Rebuilds + validates (should FAIL)
#   9. Restores original code + rebuilds
#
# Usage: bash proof/csharp-example/demo.sh
#
# Required: .NET 8+ SDK (`dotnet` on PATH)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Make sure dotnet is available
if ! command -v dotnet &> /dev/null; then
  echo "❌ .NET SDK not found on PATH. Install from https://dot.net"
  exit 127
fi

echo "════════════════════════════════════════════════════════════════"
echo "  Regrets C# Stack — End-to-End Demo"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "Project: proof/csharp-example/ (MorseCode.Encode pure function)"
echo "Repo:    $REPO_ROOT"
echo ""

# Step 1: Build
echo "─── Step 1: Build the C# library ─────────────────────────────"
dotnet build 2>&1 | tail -5
echo ""

# Step 2: Capture
echo "─── Step 2: Capture (initial fingerprint) ────────────────────"
node "$REPO_ROOT/scripts/regret.js" capture
echo ""
echo "Captured .regret file contents:"
cat regrets/morse-encode.regret
echo ""

# Step 3: Validate (should PASS)
echo "─── Step 3: Validate (no changes — should PASS) ─────────────"
node "$REPO_ROOT/scripts/regret.js" validate
echo ""

# Step 4: Simulate valid refactor (internal change, same output)
echo "─── Step 4: Simulate valid refactor ──────────────────────────"
echo "  (Replacing linear scan Lookup() with Dictionary<char,string> lookup)"
echo "  → Output should remain identical → fingerprint unchanged → PASS"
echo ""
cp MorseCode.cs MorseCode.cs.bak

# Apply refactor using a Python one-liner (more reliable than sed for multi-line)
python3 << 'PYEOF'
import re
with open('MorseCode.cs') as f:
    src = f.read()

# Replace the char[]/string[] arrays with a single Dictionary
old_arrays = '''    // International Morse Code mapping for A-Z, 0-9, and space.
    // Punctuation deliberately omitted to keep the example simple.
    private static readonly char[] Letters =
    {
        'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
        'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'
    };

    private static readonly string[] LetterCodes =
    {
        ".-",    "-...",  "-.-.",  "-..",   ".",     "..-.",  "--.",
        "....",  "..",    ".---",  "-.-",   ".-..",  "--",
        "-.",    "---",   ".--.",  "--.-",  ".-.",   "...",
        "-",     "..-",   "...-",  ".--",   "-..-",  "-.--",  "--.."
    };

    private static readonly char[] Digits =
    {
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'
    };

    private static readonly string[] DigitCodes =
    {
        "-----",  ".----",  "..---",  "...--",  "....-",
        ".....",  "-....",  "--...",  "---..",  "----."
    };'''

new_dict = '''    // REFACTORED: now uses a single Dictionary<char,string> lookup table
    // (internally different, but externally identical behavior).
    private static readonly System.Collections.Generic.Dictionary<char, string> LookupTable =
        new System.Collections.Generic.Dictionary<char, string>
        {
            ['A'] = ".-",    ['B'] = "-...",  ['C'] = "-.-.",  ['D'] = "-..",   ['E'] = ".",
            ['F'] = "..-.",  ['G'] = "--.",   ['H'] = "....",  ['I'] = "..",    ['J'] = ".---",
            ['K'] = "-.-",   ['L'] = ".-..",  ['M'] = "--",    ['N'] = "-.",    ['O'] = "---",
            ['P'] = ".--.",  ['Q'] = "--.-",  ['R'] = ".-.",   ['S'] = "...",   ['T'] = "-",
            ['U'] = "..-",   ['V'] = "...-",  ['W'] = ".--",   ['X'] = "-..-",  ['Y'] = "-.--",
            ['Z'] = "--..",
            ['0'] = "-----", ['1'] = ".----", ['2'] = "..---", ['3'] = "...--", ['4'] = "....-",
            ['5'] = ".....", ['6'] = "-....", ['7'] = "--...", ['8'] = "---..", ['9'] = "----.",
        };'''

src = src.replace(old_arrays, new_dict)

# Replace the Lookup method
old_lookup = '''    private static string? Lookup(char c)
    {
        // Linear search — fine for 36 entries, and keeps the example simple.
        // (Real-world version would use a Dictionary<char,string>, but for a
        // regression-test fixture, simpler is better — fewer things to break.)
        for (int i = 0; i < Letters.Length; i++)
        {
            if (Letters[i] == c) return LetterCodes[i];
        }
        for (int i = 0; i < Digits.Length; i++)
        {
            if (Digits[i] == c) return DigitCodes[i];
        }
        return null;
    }'''

new_lookup = '''    private static string? Lookup(char c)
    {
        // REFACTORED: O(1) dictionary lookup instead of O(36) linear scan.
        // Same external behavior — same output for same input.
        return LookupTable.TryGetValue(c, out var code) ? code : null;
    }'''

src = src.replace(old_lookup, new_lookup)

with open('MorseCode.cs', 'w') as f:
    f.write(src)

print("  ✓ Refactor applied: linear scan → Dictionary lookup")
PYEOF

# Step 5: Rebuild + validate (should still PASS)
echo ""
echo "─── Step 5: Rebuild + validate (should PASS — same output) ───"
dotnet build 2>&1 | tail -3
echo ""
node "$REPO_ROOT/scripts/regret.js" validate
echo ""

# Step 6: Restore original
cp MorseCode.cs.bak MorseCode.cs
rm MorseCode.cs.bak
dotnet build 2>&1 | tail -3
echo ""

# Step 7: Simulate breaking change (output changes)
echo "─── Step 6: Simulate breaking change ─────────────────────────"
echo "  (Change letter separator from ' ' to '/' → output changes → FAIL)"
echo ""
cp MorseCode.cs MorseCode.cs.bak
python3 << 'PYEOF'
with open('MorseCode.cs') as f:
    src = f.read()
# Change letter separator from ' ' to '/'
src = src.replace("result.Append(' ');", "result.Append('/');")
with open('MorseCode.cs', 'w') as f:
    f.write(src)
print("  ✓ Breaking change applied: letter separator ' ' → '/'")
PYEOF

# Step 8: Rebuild + validate (should FAIL)
echo ""
echo "─── Step 7: Rebuild + validate (should FAIL — output changed) ─"
dotnet build 2>&1 | tail -3
echo ""
node "$REPO_ROOT/scripts/regret.js" validate || true
echo ""

# Step 9: Restore original
cp MorseCode.cs.bak MorseCode.cs
rm MorseCode.cs.bak
dotnet build 2>&1 | tail -3
echo ""

echo "─── Demo complete ────────────────────────────────────────────"
echo ""
echo "Summary of what was demonstrated:"
echo "  ✅ Step 3: validate PASSES when code is unchanged"
echo "  ✅ Step 5: validate PASSES for valid refactor (internal change, same output)"
echo "  ✅ Step 7: validate FAILS for breaking change (output differs)"
echo ""
echo "The .regret file in regrets/morse-encode.regret is the golden contract."
echo "On every validate run, the runner re-invokes Encode('SOS') and compares"
echo "the fingerprint against the saved one. Identical → PASS. Different → FAIL."
