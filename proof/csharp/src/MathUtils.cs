// Simple math utility class for Regrets C# capture/validate demonstration.
namespace MathLib;

public static class MathUtils
{
    /// <summary>
    /// Add two integers and return the sum.
    /// </summary>
    public static int Add(int a, int b) => a + b;

    /// <summary>
    /// Multiply two integers and return the product.
    /// </summary>
    public static int Multiply(int a, int b) => a * b;

    /// <summary>
    /// Reverse a string.
    /// </summary>
    public static string ReverseString(string input)
    {
        if (string.IsNullOrEmpty(input)) return input ?? "";
        var chars = input.ToCharArray();
        Array.Reverse(chars);
        return new string(chars);
    }

    /// <summary>
    /// Check if a number is prime.
    /// </summary>
    public static bool IsPrime(int n)
    {
        if (n < 2) return false;
        if (n == 2) return true;
        if (n % 2 == 0) return false;
        for (int i = 3; i * i <= n; i += 2)
        {
            if (n % i == 0) return false;
        }
        return true;
    }
}
