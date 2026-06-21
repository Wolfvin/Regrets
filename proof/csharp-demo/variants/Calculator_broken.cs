// Calculator_broken.cs — intentionally WRONG implementations.
//
// Each method introduces a subtle bug. Running validate_csharp.sh with this
// file in src/ (instead of Calculator.cs) should produce DIFFERENT
// fingerprints → ALL clusters should FAIL with a clear diff.
//
// This file is NOT meant to be compiled alongside Calculator.cs — it would
// conflict (duplicate class). The verify_demo.sh script swaps them.

using System.Text.Json;
using System.Linq;
using System.Text;

namespace RegretDemo;

public static class Calculator
{
    // Breaking: off-by-one — returns a+b+1 instead of a+b
    public static object? Add(JsonElement input)
    {
        int a = input[0].GetInt32();
        int b = input[1].GetInt32();
        return a + b + 1;
    }

    // Breaking: returns a*b + a (off by a)
    public static object? Multiply(JsonElement input)
    {
        long a = input[0].GetInt64();
        long b = input[1].GetInt64();
        return a * b + a;
    }

    // Breaking: uppercases first char before reversing
    public static object? ReverseString(JsonElement input)
    {
        var s = input.GetString() ?? "";
        if (s.Length > 0) s = char.ToUpper(s[0]) + s.Substring(1);
        var chars = s.ToCharArray();
        System.Array.Reverse(chars);
        return new string(chars);
    }

    // Breaking: "FizzBuzz" → "Fizz Buzz" (with space)
    public static object? FizzBuzz(JsonElement input)
    {
        int n = input.GetInt32();
        var parts = new System.Collections.Generic.List<string>();
        for (int i = 1; i <= n; i++)
        {
            if (i % 15 == 0) parts.Add("Fizz Buzz");
            else if (i % 3 == 0) parts.Add("Fizz");
            else if (i % 5 == 0) parts.Add("Buzz");
            else parts.Add(i.ToString());
        }
        return parts;
    }

    // Breaking: parses as int but treats 0 as negative (rejects "0")
    public static object? ParsePositiveInt(JsonElement input)
    {
        var s = input.GetString() ?? "";
        if (!int.TryParse(s, out var n))
        {
            throw new FormatException($"Not an integer: '{s}'");
        }
        if (n <= 0)  // was: n < 0
        {
            throw new ArgumentException($"Non-positive not allowed: {n}");
        }
        return n;
    }
}
