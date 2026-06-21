// Calculator.cs — example C# class with pure static methods.
//
// Each method matches the Regrets C# contract:
//   public static object? Method(JsonElement input)
// The method takes a single JsonElement (whatever was in the manifest's
// "inputs" array for that cluster) and returns any JSON-serializable value.
//
// Methods are intentionally simple so that the capture/validate cycle is
// easy to verify by hand. They are also "pure" — no global state, no I/O —
// so the fingerprint is stable across runs.

using System.Text.Json;
using System.Text.RegularExpressions;

namespace RegretDemo;

public static class Calculator
{
    /// <summary>
    /// Add two integers. Input is a 2-element array: [a, b].
    /// </summary>
    public static object? Add(JsonElement input)
    {
        int a = input[0].GetInt32();
        int b = input[1].GetInt32();
        return a + b;
    }

    /// <summary>
    /// Multiply two integers. Input: [a, b].
    /// </summary>
    public static object? Multiply(JsonElement input)
    {
        long a = input[0].GetInt64();
        long b = input[1].GetInt64();
        return a * b;
    }

    /// <summary>
    /// Reverse a string. Input is a single string.
    /// </summary>
    public static object? ReverseString(JsonElement input)
    {
        var s = input.GetString() ?? "";
        var chars = s.ToCharArray();
        System.Array.Reverse(chars);
        return new string(chars);
    }

    /// <summary>
    /// Classic FizzBuzz. Input is a single int.
    /// </summary>
    public static object? FizzBuzz(JsonElement input)
    {
        int n = input.GetInt32();
        var parts = new System.Collections.Generic.List<string>();
        for (int i = 1; i <= n; i++)
        {
            if (i % 15 == 0) parts.Add("FizzBuzz");
            else if (i % 3 == 0) parts.Add("Fizz");
            else if (i % 5 == 0) parts.Add("Buzz");
            else parts.Add(i.ToString());
        }
        return parts;
    }

    /// <summary>
    /// Throw an exception on certain input — used to verify the
    /// ERROR_CONTRACT branch of the .regret format.
    /// </summary>
    public static object? ParsePositiveInt(JsonElement input)
    {
        var s = input.GetString() ?? "";
        if (!int.TryParse(s, out var n))
        {
            throw new FormatException($"Not an integer: '{s}'");
        }
        if (n < 0)
        {
            throw new ArgumentException($"Negative not allowed: {n}");
        }
        return n;
    }
}
