// demo_math.hpp — declarations for demo_math.cpp

#ifndef DEMO_MATH_HPP
#define DEMO_MATH_HPP

#include <string>
#include <vector>
#include <cstdint>

// Free-function examples (pure)
int demo_add(int a, int b);
long demo_fibonacci(int n);
std::string demo_reverse(const std::string& s);
std::vector<std::string> demo_parse_csv_line(const std::string& line);
std::string demo_format_bytes(long bytes);

// Class-based example (RAII, methods)
class MathUtils {
public:
    // Compute factorial of n (long). Throws std::invalid_argument if n < 0.
    long factorial(int n) const;

    // Compute greatest common divisor (iterative Euclidean).
    long gcd(long a, long b) const;

    // Check if a string is a palindrome (ignoring case + non-alphanumeric).
    bool is_palindrome(const std::string& s) const;
};

#endif  // DEMO_MATH_HPP
