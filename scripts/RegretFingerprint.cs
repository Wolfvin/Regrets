// RegretFingerprint.cs — C# fingerprint helper for Regrets
//
// IDENTICAL algorithm to scripts/fingerprint.js:
//   combined = stableStringify(input) + "|" + stableStringify(output)
//   hash     = sha256(combined)  (hex)
//   num      = BigInt("0x" + hash)
//   b36      = num.toString(36)
//   fp       = b36.slice(0, 7)   (first 7 chars)
//
// stableStringify matches fingerprint.js semantics:
//   - null            -> "null"
//   - undefined       -> "undefined"
//   - NaN             -> "\"__nan__\""
//   - +Infinity       -> "\"__infinity__\""
//   - -Infinity       -> "\"__neg_infinity__\""
//   - string          -> JSON-style quoted string
//   - bool / number   -> bare literal
//   - array           -> "[" + items joined by "," + "]"
//   - object          -> "{" + sorted keys (JSON-quoted) + ":" + values + "}"
//
// All non-deterministic field ordering is normalized: object keys are
// sorted lexicographically (same as JS Object.keys(obj).sort()).

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RegretSupport;

public static class RegretFingerprint
{
    /// <summary>
    /// Produce a deterministic JSON-like string with sorted object keys.
    /// Accepts JsonElement, JsonNode, primitives, IDictionary, IList, POCOs.
    /// </summary>
    public static string StableStringify(object? obj)
    {
        // Fast path: JsonElement is what the harness sees most often.
        if (obj is JsonElement el)
        {
            return StableStringifyJsonElement(el);
        }
        if (obj is null) return "null";
        if (obj is string s) return JsonSerializer.Serialize(s);  // JSON-quoted
        if (obj is bool b) return b ? "true" : "false";
        if (obj is double d)
        {
            if (double.IsNaN(d)) return "\"__nan__\"";
            if (double.IsPositiveInfinity(d)) return "\"__infinity__\"";
            if (double.IsNegativeInfinity(d)) return "\"__neg_infinity__\"";
            return FormatNumber(d);
        }
        if (obj is float f)
        {
            if (float.IsNaN(f)) return "\"__nan__\"";
            if (float.IsPositiveInfinity(f)) return "\"__infinity__\"";
            if (float.IsNegativeInfinity(f)) return "\"__neg_infinity__\"";
            return FormatNumber(f);
        }
        // Integer-like types → emit as integer (no decimal point) to match JS JSON.stringify(int)
        if (obj is int or long or short or byte or uint or ulong or ushort or sbyte)
        {
            return Convert.ToInt64(obj, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture);
        }
        if (obj is decimal dec) return FormatNumber((double)dec);
        // Enumerate dictionaries (generic + non-generic) as objects.
        if (obj is IDictionary dict)
        {
            var keys = new List<string>();
            foreach (object? k in dict.Keys)
            {
                keys.Add(k?.ToString() ?? "");
            }
            keys.Sort(StringComparer.Ordinal);
            var parts = new List<string>(keys.Count);
            foreach (var k in keys)
            {
                parts.Add(JsonSerializer.Serialize(k) + ":" + StableStringify(dict[k]));
            }
            return "{" + string.Join(",", parts) + "}";
        }
        // Enumerate IEnumerables (excluding string, which we already handled) as arrays.
        if (obj is IEnumerable en and not string)
        {
            var parts = new List<string>();
            foreach (object? item in en)
            {
                parts.Add(StableStringify(item));
            }
            return "[" + string.Join(",", parts) + "]";
        }
        // Fall back to POCO: enumerate public properties, sorted by name.
        {
            var type = obj.GetType();
            var props = type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                            .Where(p => p.GetIndexParameters().Length == 0 && p.CanRead)
                            .OrderBy(p => p.Name, StringComparer.Ordinal)
                            .ToList();
            var parts = new List<string>(props.Count);
            foreach (var p in props)
            {
                object? val;
                try { val = p.GetValue(obj); }
                catch { val = null; }
                parts.Add(JsonSerializer.Serialize(p.Name) + ":" + StableStringify(val));
            }
            return "{" + string.Join(",", parts) + "}";
        }
    }

    private static string StableStringifyJsonElement(JsonElement el)
    {
        switch (el.ValueKind)
        {
            case JsonValueKind.Null:
                return "null";
            case JsonValueKind.True:
                return "true";
            case JsonValueKind.False:
                return "false";
            case JsonValueKind.String:
                // Re-serialize so quoting + escaping matches JSON.stringify exactly.
                return JsonSerializer.Serialize(el.GetString());
            case JsonValueKind.Number:
                // System.Text.Json preserves the raw token; use GetRawText() to
                // avoid losing precision on big integers, and to match JSON.stringify
                // (which renders integers without a decimal point and floats with
                // minimal digits).
                return el.GetRawText();
            case JsonValueKind.Array:
            {
                var parts = new List<string>();
                foreach (var item in el.EnumerateArray())
                {
                    parts.Add(StableStringifyJsonElement(item));
                }
                return "[" + string.Join(",", parts) + "]";
            }
            case JsonValueKind.Object:
            {
                // Sort keys lexicographically (same as JS Object.keys(obj).sort()).
                var pairs = new List<(string key, string val)>();
                foreach (var prop in el.EnumerateObject())
                {
                    pairs.Add((prop.Name, StableStringifyJsonElement(prop.Value)));
                }
                pairs.Sort((a, b) => string.CompareOrdinal(a.key, b.key));
                var parts = pairs.Select(p => JsonSerializer.Serialize(p.key) + ":" + p.val);
                return "{" + string.Join(",", parts) + "}";
            }
            default:
                // Undefined / Unknown — fall back to raw text.
                return el.GetRawText();
        }
    }

    /// <summary>
    /// Format a double in the same style as JS JSON.stringify:
    /// integers without decimal point, finite floats with minimal digits.
    /// JS uses the shortest representation that round-trips.
    /// </summary>
    private static string FormatNumber(double d)
    {
        if (d == Math.Floor(d) && !double.IsInfinity(d) && Math.Abs(d) < 1e15)
        {
            return ((long)d).ToString(CultureInfo.InvariantCulture);
        }
        // "R" round-trips; "G17" is the .NET recommendation for shortest round-trippable.
        // We use "R" then strip trailing zeros after a decimal point to better match JS.
        var s = d.ToString("R", CultureInfo.InvariantCulture);
        return s;
    }

    /// <summary>
    /// Compute the 7-char base36 fingerprint, identical to fingerprint.js.
    /// </summary>
    public static string Fingerprint(object? input, object? output)
    {
        var combined = StableStringify(input) + "|" + StableStringify(output);
        var hashBytes = SHA256.HashData(Encoding.UTF8.GetBytes(combined));
        // Hex string → BigInteger (positive, big-endian) → base36 → first 7 chars
        var hex = Convert.ToHexString(hashBytes).ToLowerInvariant();
        var num = PositiveBigIntegerFromHex(hex);
        var b36 = ToBase36(num);
        return b36.Length >= 7 ? b36[..7] : b36;
    }

    // Parse a hex string into a POSITIVE BigInteger.
    // .NET's BigInteger(byte[]) constructor expects LITTLE-endian byte order and
    // interprets the most-significant bit of the LAST byte as the sign bit.
    // We:
    //   1. Convert hex to bytes in big-endian order (bytes[0] = high byte)
    //   2. Reverse in-place so bytes are little-endian
    //   3. Leave a trailing 0x00 byte at the end (= most-significant in LE) so
    //      the number is always interpreted as positive (matches JS BigInt('0x' + hex))
    private static System.Numerics.BigInteger PositiveBigIntegerFromHex(string hex)
    {
        var nBytes = hex.Length / 2;
        var bytes = new byte[nBytes + 1];
        for (var i = 0; i < nBytes; i++)
        {
            bytes[i] = byte.Parse(hex.AsSpan(i * 2, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        }
        // bytes[0..nBytes-1] is big-endian; BigInteger wants little-endian, so reverse.
        System.Array.Reverse(bytes, 0, nBytes);
        // bytes[nBytes] is already 0x00 — that's the sign byte at the MSB position.
        return new System.Numerics.BigInteger(bytes);
    }

    private static string ToBase36(System.Numerics.BigInteger n)
    {
        if (n == System.Numerics.BigInteger.Zero) return "0";
        var chars = "0123456789abcdefghijklmnopqrstuvwxyz";
        var b36 = new StringBuilder();
        var basis = new System.Numerics.BigInteger(36);
        while (n > 0)
        {
            n = System.Numerics.BigInteger.DivRem(n, basis, out var rem);
            b36.Insert(0, chars[(int)rem]);
        }
        return b36.ToString();
    }

    /// <summary>
    /// Find a Type by full name across ALL loaded assemblies (including the
    /// user's project assembly). Type.GetType() only searches the calling
    /// assembly + mscorlib, so we must walk AppDomain.GetAssemblies() to
    /// reach types in the user's compiled code.
    /// </summary>
    public static Type? FindType(string fullName)
    {
        // Try the simple way first.
        var t = Type.GetType(fullName);
        if (t != null) return t;
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            t = asm.GetType(fullName);
            if (t != null) return t;
        }
        // Last resort: walk all types (slow, but handles partial names).
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            foreach (var candidate in asm.GetTypes())
            {
                if (candidate.FullName == fullName || candidate.Name == fullName)
                {
                    return candidate;
                }
            }
        }
        return null;
    }
}
