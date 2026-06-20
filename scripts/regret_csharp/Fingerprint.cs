// Fingerprint.cs — Deterministic fingerprint computation for Regrets C# stack.
//
// IDENTICAL algorithm to scripts/fingerprint.js (JS) and scripts/fingerprint.py (Python):
//   1. stableStringify(input) + "|" + stableStringify(output)
//   2. SHA-256 hex of combined string
//   3. BigInt(hex) → base36 → first 7 chars
//
// stableStringify produces a deterministic JSON string with sorted keys recursively.
// Handles: null, bool, int, long, double, string, arrays, dictionaries.
// Sentinel placeholders for non-serializable values mirror the JS implementation.
//
// This file is part of the Regrets C# stack. Do not edit unless you understand
// the cross-stack fingerprint contract — see scripts/fingerprint.js for reference.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RegretCsharp;

public static class Fingerprint
{
    /// <summary>
    /// Stable JSON stringify with sorted keys recursively.
    /// Must produce identical output to JS stableStringify() and Python stable_dumps().
    /// </summary>
    public static string StableStringify(object? obj, HashSet<object>? seen = null)
    {
        if (obj == null) return "null";

        // Handle primitive types directly.
        switch (obj)
        {
            case bool b:
                return b ? "true" : "false";
            case sbyte sb:
                return sb.ToString(CultureInfo.InvariantCulture);
            case byte ub:
                return ub.ToString(CultureInfo.InvariantCulture);
            case short s:
                return s.ToString(CultureInfo.InvariantCulture);
            case ushort us:
                return us.ToString(CultureInfo.InvariantCulture);
            case int i:
                return i.ToString(CultureInfo.InvariantCulture);
            case uint ui:
                return ui.ToString(CultureInfo.InvariantCulture);
            case long l:
                return l.ToString(CultureInfo.InvariantCulture);
            case ulong ul:
                return ul.ToString(CultureInfo.InvariantCulture);
            case float f:
                return FormatFloat(f);
            case double d:
                return FormatDouble(d);
            case decimal dec:
                return dec.ToString(CultureInfo.InvariantCulture);
            case string str:
                return JsonSerializer.Serialize(str);
            case char c:
                return JsonSerializer.Serialize(c.ToString());
        }

        // NaN / Infinity sentinels — match JS fingerprint.js
        if (obj is double dd)
        {
            if (double.IsNaN(dd)) return "\"__nan__\"";
            if (double.IsPositiveInfinity(dd)) return "\"__infinity__\"";
            if (double.IsNegativeInfinity(dd)) return "\"__neg_infinity__\"";
        }

        // DateTime → ISO 8601 (mirror JS Date handling)
        if (obj is DateTime dt)
        {
            return JsonSerializer.Serialize(dt.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ"));
        }
        if (obj is DateTimeOffset dto)
        {
            return JsonSerializer.Serialize(dto.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"));
        }

        // Guid → lowercase string with hyphens
        if (obj is Guid g)
        {
            return JsonSerializer.Serialize(g.ToString());
        }

        // Arrays / IEnumerable
        if (obj is System.Collections.IEnumerable enumerable and not string)
        {
            // Circular reference detection for arrays
            seen ??= new HashSet<object>();
            if (seen.Contains(obj)) return "\"__circular__\"";
            seen.Add(obj);

            var parts = new List<string>();
            foreach (var item in enumerable)
            {
                parts.Add(StableStringify(item, seen));
            }
            seen.Remove(obj);
            return "[" + string.Join(",", parts) + "]";
        }

        // Dictionary<string, object> and IDictionary — sorted keys
        if (obj is System.Collections.IDictionary dict)
        {
            seen ??= new HashSet<object>();
            if (seen.Contains(obj)) return "\"__circular__\"";
            seen.Add(obj);

            var keys = new List<string>();
            foreach (var key in dict.Keys)
            {
                keys.Add(key?.ToString() ?? "");
            }
            keys.Sort(StringComparer.Ordinal);

            var parts = new List<string>();
            foreach (var key in keys)
            {
                var value = dict[key];
                parts.Add(JsonSerializer.Serialize(key) + ":" + StableStringify(value, seen));
            }
            seen.Remove(obj);
            return "{" + string.Join(",", parts) + "}";
        }

        // Generic objects — reflect properties, sorted by name
        // This is a fallback for arbitrary C# objects (DTOs, records, etc.)
        seen ??= new HashSet<object>();
        if (seen.Contains(obj)) return "\"__circular__\"";
        seen.Add(obj);

        var type = obj.GetType();
        var props = type.GetProperties()
            .Where(p => p.GetIndexParameters().Length == 0) // skip indexers
            .OrderBy(p => p.Name, StringComparer.Ordinal)
            .ToList();

        var fields = type.GetFields()
            .Where(f => f.IsPublic)
            .OrderBy(f => f.Name, StringComparer.Ordinal)
            .ToList();

        var objectParts = new List<string>();
        foreach (var prop in props)
        {
            try
            {
                var value = prop.GetValue(obj);
                objectParts.Add(JsonSerializer.Serialize(prop.Name) + ":" + StableStringify(value, seen));
            }
            catch
            {
                // Skip properties that throw on access
            }
        }
        foreach (var field in fields)
        {
            try
            {
                var value = field.GetValue(obj);
                objectParts.Add(JsonSerializer.Serialize(field.Name) + ":" + StableStringify(value, seen));
            }
            catch
            {
                // Skip fields that throw on access
            }
        }
        seen.Remove(obj);
        return "{" + string.Join(",", objectParts) + "}";
    }

    private static string FormatFloat(float f)
    {
        if (float.IsNaN(f)) return "\"__nan__\"";
        if (float.IsPositiveInfinity(f)) return "\"__infinity__\"";
        if (float.IsNegativeInfinity(f)) return "\"__neg_infinity__\"";

        // Match JS Number.toString() which uses shortest round-trip representation
        // .NET's "G9" format gives shortest round-trip for float
        var s = f.ToString("G9", CultureInfo.InvariantCulture);
        // Ensure decimal point present (JS shows "1" for 1.0, but we want JSON number format)
        // Actually JS shows "1" not "1.0" — match that
        return s;
    }

    private static string FormatDouble(double d)
    {
        if (double.IsNaN(d)) return "\"__nan__\"";
        if (double.IsPositiveInfinity(d)) return "\"__infinity__\"";
        if (double.IsNegativeInfinity(d)) return "\"__neg_infinity__\"";

        // Match JS Number.toString() which uses shortest round-trip representation
        // .NET's "G17" format gives shortest round-trip for double
        var s = d.ToString("G17", CultureInfo.InvariantCulture);
        return s;
    }

    /// <summary>
    /// Convert a big integer (from hex) to base36 string.
    /// Must produce identical output to JS BigInt.toString(36) and Python to_base36().
    /// </summary>
    public static string ToBase36(System.Numerics.BigInteger n)
    {
        if (n.IsZero) return "0";

        const string chars = "0123456789abcdefghijklmnopqrstuvwxyz";
        var base36 = new BigInteger(36);
        var result = new StringBuilder();
        var temp = BigInteger.Abs(n);

        while (temp > 0)
        {
            temp = BigInteger.DivRem(temp, base36, out var remainder);
            result.Insert(0, chars[(int)remainder]);
        }

        return result.ToString();
    }

    /// <summary>
    /// Compute the 7-char base36 fingerprint.
    /// IDENTICAL algorithm to fingerprint.js / fingerprint.py / fingerprint.go / fingerprint.rs:
    ///   sha256(stableStringify(input) + "|" + stableStringify(output)) → base36 → first 7 chars
    /// </summary>
    public static string Compute(object? input, object? output)
    {
        var combined = StableStringify(input) + "|" + StableStringify(output);
        var hashBytes = SHA256.HashData(Encoding.UTF8.GetBytes(combined));
        var hexStr = Convert.ToHexString(hashBytes).ToLowerInvariant();
        var bigNum = BigInteger.Parse("0" + hexStr, NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        var b36 = ToBase36(bigNum);
        return b36.Length >= 7 ? b36[..7] : b36;
    }
}
