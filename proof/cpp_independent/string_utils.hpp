// string_utils.hpp — Pure C++ string utility functions (INDEPENDENT FIXTURE)
// Different domain from PR's demo_math.cpp to avoid confirmation bias.
// Tests: string transformation, palindrome check, word count, slugify

#ifndef STRING_UTILS_HPP
#define STRING_UTILS_HPP

#include <string>
#include <algorithm>
#include <cctype>
#include <sstream>
#include <vector>

namespace stringutils {

// Reverse a string
inline std::string reverse(const std::string& s) {
    std::string result(s.rbegin(), s.rend());
    return result;
}

// Check if string is a palindrome (ignoring case and non-alphanumeric)
inline bool is_palindrome(const std::string& s) {
    std::string cleaned;
    for (char c : s) {
        if (std::isalnum(static_cast<unsigned char>(c))) {
            cleaned += static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        }
    }
    std::string rev(cleaned.rbegin(), cleaned.rend());
    return cleaned == rev;
}

// Count words in a string
inline int word_count(const std::string& s) {
    std::istringstream iss(s);
    int count = 0;
    std::string word;
    while (iss >> word) {
        count++;
    }
    return count;
}

// Convert string to slug format (lowercase, spaces→hyphens, strip non-alnum)
inline std::string slugify(const std::string& s) {
    std::string result;
    bool last_hyphen = false;
    for (char c : s) {
        if (std::isalnum(static_cast<unsigned char>(c))) {
            result += static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
            last_hyphen = false;
        } else if (std::isspace(static_cast<unsigned char>(c)) || c == '_' || c == '-') {
            if (!last_hyphen && !result.empty()) {
                result += '-';
                last_hyphen = true;
            }
        }
    }
    // Remove trailing hyphen
    if (!result.empty() && result.back() == '-') {
        result.pop_back();
    }
    return result;
}

// Capitalize first letter of each word
inline std::string title_case(const std::string& s) {
    std::string result = s;
    bool new_word = true;
    for (char& c : result) {
        if (std::isspace(static_cast<unsigned char>(c))) {
            new_word = true;
        } else if (new_word) {
            c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
            new_word = false;
        } else {
            c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        }
    }
    return result;
}

} // namespace stringutils

#endif // STRING_UTILS_HPP
