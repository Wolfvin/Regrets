// MathUtils.cs — example C# library for regret capture/validate demonstration
// This file contains pure functions that are perfect for fingerprinting:
// same input → same output, no side effects.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace ExampleLib;

public class MathUtils
{
    /// <summary>
    /// Add two integers. Trivial function for basic capture/validate demo.
    /// </summary>
    public static int Add(int a, int b)
    {
        return a + b;
    }

    /// <summary>
    /// Reverse a string. Demonstrates string function fingerprinting.
    /// </summary>
    public static string ReverseString(string input)
    {
        if (string.IsNullOrEmpty(input)) return input;
        var chars = input.ToCharArray();
        Array.Reverse(chars);
        return new string(chars);
    }

    /// <summary>
    /// Count word frequencies in a string. Demonstrates complex object output
    /// (Dictionary<string, int>) — tests stable stringify with sorted keys.
    /// </summary>
    public static Dictionary<string, int> WordFrequency(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return new Dictionary<string, int>();
        var words = text.Split(new[] { ' ', '\t', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries);
        return words.GroupBy(w => w.ToLowerInvariant())
                     .ToDictionary(g => g.Key, g => g.Count());
    }

    /// <summary>
    /// FizzBuzz — classic interview problem. Demonstrates branching logic.
    /// Returns a list of strings for inputs 1..n.
    /// </summary>
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
