// demo_math.cpp — pure C++ functions used as the regret-capture target
// in proof/cpp/. No I/O, no time, no randomness — all outputs are
// deterministic for the same inputs, which is the contract Regrets
// fingerprints.

#include "demo_math.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

// ─── Free-function examples ────────────────────────────────────────────────

int demo_add(int a, int b) {
    return a + b;
}

long demo_fibonacci(int n) {
    if (n < 0) throw std::invalid_argument("n must be >= 0");
    if (n == 0) return 0L;
    if (n == 1) return 1L;
    long a = 0, b = 1;
    for (int i = 2; i <= n; i++) {
        long c = a + b;
        a = b;
        b = c;
    }
    return b;
}

std::string demo_reverse(const std::string& s) {
    return std::string(s.rbegin(), s.rend());
}

// Parse a CSV line with quoted-field support. Returns a vector of fields.
std::vector<std::string> demo_parse_csv_line(const std::string& line) {
    std::vector<std::string> out;
    if (line.empty()) return out;

    std::string cur;
    bool in_quotes = false;
    for (size_t i = 0; i < line.size(); i++) {
        char c = line[i];
        if (in_quotes) {
            if (c == '"') {
                if (i + 1 < line.size() && line[i + 1] == '"') {
                    cur.push_back('"');
                    i++;
                } else {
                    in_quotes = false;
                }
            } else {
                cur.push_back(c);
            }
        } else {
            if (c == ',') {
                out.push_back(cur);
                cur.clear();
            } else if (c == '"') {
                in_quotes = true;
            } else {
                cur.push_back(c);
            }
        }
    }
    out.push_back(cur);
    return out;
}

// Format bytes into human-readable string (binary units).
std::string demo_format_bytes(long bytes) {
    if (bytes < 0) {
        return "-" + demo_format_bytes(-bytes);
    }
    if (bytes < 1024L) {
        char buf[64];
        std::snprintf(buf, sizeof(buf), "%ld B", bytes);
        return std::string(buf);
    }
    static const char* units[] = {"KiB", "MiB", "GiB", "TiB", "PiB"};
    double v = static_cast<double>(bytes);
    int unit_idx = -1;
    while (v >= 1024.0 && unit_idx < 4) {
        v /= 1024.0;
        unit_idx++;
    }
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.2f %s", v, units[unit_idx]);
    return std::string(buf);
}

// ─── Class-based example ───────────────────────────────────────────────────

long MathUtils::factorial(int n) const {
    if (n < 0) throw std::invalid_argument("n must be >= 0");
    long r = 1;
    for (int i = 2; i <= n; i++) r *= i;
    return r;
}

long MathUtils::gcd(long a, long b) const {
    if (a < 0) a = -a;
    if (b < 0) b = -b;
    while (b != 0) {
        long t = b;
        b = a % b;
        a = t;
    }
    return a;
}

bool MathUtils::is_palindrome(const std::string& s) const {
    std::string filtered;
    for (char c : s) {
        if (std::isalnum(static_cast<unsigned char>(c))) {
            filtered.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
        }
    }
    std::string reversed(filtered.rbegin(), filtered.rend());
    return filtered == reversed;
}
