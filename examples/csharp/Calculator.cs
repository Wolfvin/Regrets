// Calculator.cs — example C# code for Regrets capture/validate demonstration.
//
// This file contains two pure functions that we'll fingerprint:
//   - Add(a, b) → int
//   - FormatGreeting(name) → string
//
// The .regret file captures the input→output contract of these functions.
// After a refactor, validate_csharp.sh re-computes the fingerprint and
// compares it against the golden hash. If the function's behavior changed,
// the fingerprint changes and validation FAILs.

using System;

namespace ExampleApp
{
    public class Calculator
    {
        /// <summary>
        /// Add two integers and return the sum.
        /// </summary>
        public static int Add(int a, int b)
        {
            return a + b;
        }

        /// <summary>
        /// Format a greeting message.
        /// </summary>
        public static string FormatGreeting(string name)
        {
            return $"Hello, {name}!";
        }
    }
}
