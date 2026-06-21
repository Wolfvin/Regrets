// Calculator_refactored.cs — behavior-preserving refactors of every method.
//
// Each method is rewritten with a different implementation that produces
// IDENTICAL output to Calculator.cs. Running validate_csharp.sh with this
// file in src/ (instead of Calculator.cs) should produce the same
// fingerprints → ALL clusters should still PASS.
//
// This file is NOT meant to be compiled alongside Calculator.cs — it would
// conflict (duplicate class). The verify_demo.sh script swaps them.

using System.Text.Json;
using System.Linq;
using System.Text;

namespace RegretDemo;

public static class Calculator
{
    // Refactor: use long internally instead of int. Same output (5 == 5L when serialized).
    public static object? Add(JsonElement input)
    {
        long a = input[0].GetInt64();
        long b = input[1].GetInt64();
        return a + b;
    }

    // Refactor: multiplication via repeated addition. Same output for these inputs.
    public static object? Multiply(JsonElement input)
    {
        long a = input[0].GetInt64();
        long b = input[1].GetInt64();
        // Repeated addition — slow but correct for the inputs in our manifest.
        long result = 0;
        long absB = b < 0 ? -b : b;
        bool negative = b < 0 ^ a < 0;
        long absA = a < 0 ? -a : a;
        for (long i = 0; i < absB; i++) result += absA;
        return negative ? -result : result;
    }

    // Refactor: use LINQ Reverse instead of Array.Reverse. Same output.
    public static object? ReverseString(JsonElement input)
    {
        var s = input.GetString() ?? "";
        return new string(s.Reverse().ToArray());
    }

    // Refactor: build a single string then split. Same output.
    public static object? FizzBuzz(JsonElement input)
    {
        int n = input.GetInt32();
        var sb = new StringBuilder();
        for (int i = 1; i <= n; i++)
        {
            if (i > 1) sb.Append('\u0001');  // sentinel delimiter
            if (i % 15 == 0) sb.Append("FizzBuzz");
            else if (i % 3 == 0) sb.Append("Fizz");
            else if (i % 5 == 0) sb.Append("Buzz");
            else sb.Append(i.ToString());
        }
        return sb.ToString().Split('\u0001').ToList();
    }

    // Refactor: use int.TryParse with NumberStyles. Same behavior on these inputs.
    public static object? ParsePositiveInt(JsonElement input)
    {
        var s = input.GetString() ?? "";
        if (!int.TryParse(s, System.Globalization.NumberStyles.Integer,
                          System.Globalization.CultureInfo.InvariantCulture, out var n))
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
