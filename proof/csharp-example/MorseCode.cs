// MorseCode.cs — example pure function for the C# Regrets stack.
//
// This is the SUT (System Under Test) for the proof/csharp-example/ cluster.
// Used to demonstrate that capture_csharp + validate_csharp work end-to-end:
//   1. capture → produces morse-encode.regret with fingerprint
//   2. validate (with refactor that preserves output) → PASS
//   3. validate (with refactor that changes output) → FAIL
//
// Encode(text) is a pure function: given the same input string, it always
// returns the same Morse code output. No side effects, no global state,
// no non-deterministic dependencies. This is the simplest possible case
// for Regrets fingerprinting.

using System;
using System.Text;

namespace RegretExample;

public static class MorseCode
{
    // International Morse Code mapping for A-Z, 0-9, and space.
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
    };

    /// <summary>
    /// Encode a string into International Morse Code.
    ///
    /// Output format:
    ///   - Letters are separated by single space
    ///   - Words (separated by whitespace in input) are separated by " / "
    ///   - Characters not in A-Z, 0-9, or whitespace are skipped
    ///   - Empty input returns empty string
    /// </summary>
    /// <example>
    ///   Encode("SOS") → "... --- ..."
    ///   Encode("HELLO WORLD") → ".... . .-.. .-.. --- / .-- --- .-. .-.. -.."
    ///   Encode("") → ""
    /// </example>
    public static string Encode(string text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return "";
        }

        var result = new StringBuilder();
        var firstInWord = true;

        foreach (var ch in text)
        {
            if (char.IsWhiteSpace(ch))
            {
                // Word separator — only emit if we have prior content in this word
                if (!firstInWord)
                {
                    result.Append(" / ");
                    firstInWord = true;
                }
                continue;
            }

            var upper = char.ToUpperInvariant(ch);
            var code = Lookup(upper);
            if (code == null)
            {
                // Unknown char — skip silently
                continue;
            }

            if (!firstInWord)
            {
                result.Append(' ');
            }
            result.Append(code);
            firstInWord = false;
        }

        // Trim trailing " / " that might result from input ending with whitespace
        var s = result.ToString();
        if (s.EndsWith(" / ", StringComparison.Ordinal))
        {
            s = s[..^3];
        }
        return s;
    }

    private static string? Lookup(char c)
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
    }
}
