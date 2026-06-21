// regret_adapter.cpp — bridges the JSON-in/JSON-out convention used by
// regret_harness.cpp to the pure C++ functions in demo_math.cpp.
//
// Each adapter function:
//   - receives the cluster's INPUT as a JSON string
//   - parses it (using json-c, available because the harness links it)
//   - calls the corresponding demo_* function or MathUtils method
//   - serializes the result back to a malloc'd JSON string
//   - returns the JSON string (caller frees)
//
// The extern "C" linkage is REQUIRED so that dlsym can find the symbol
// without C++ name mangling.
//
// Returning NULL triggers the trivial-input skip guard in the harness.
// C++ exceptions thrown by user code are caught by the harness.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <json-c/json.h>

#include "regret.hpp"
#include "demo_math.hpp"

// strdup is POSIX, not standard C++. Provide a wrapper for portability.
namespace {
inline char* dup_cstr(const char* s) {
    size_t len = std::strlen(s) + 1;
    char* p = static_cast<char*>(std::malloc(len));
    if (p) std::memcpy(p, s, len);
    return p;
}
}  // namespace

// Helper: wrap a C++ std::string in a malloc'd JSON-quoted string.
static char* json_string_from_cpp(const std::string& s) {
    json_object* obj = json_object_new_string(s.c_str());
    const char* json_str = json_object_to_json_string_ext(obj, JSON_C_TO_STRING_PLAIN);
    char* result = dup_cstr(json_str);
    json_object_put(obj);
    return result;
}

// Helper: build a JSON array of strings from a std::vector<std::string>.
static char* json_array_from_vector(const std::vector<std::string>& vec) {
    json_object* arr = json_object_new_array();
    for (const auto& s : vec) {
        json_object_array_add(arr, json_object_new_string(s.c_str()));
    }
    const char* json_str = json_object_to_json_string_ext(arr, JSON_C_TO_STRING_PLAIN);
    char* result = dup_cstr(json_str);
    json_object_put(arr);
    return result;
}

// ─── Free-function adapters ────────────────────────────────────────────────

// regret_add — input: [a, b] (two integers)
//                output: integer
extern "C" char* regret_add(const char* json_input) {
    json_object* arr = json_tokener_parse(json_input);
    if (!arr || !json_object_is_type(arr, json_type_array) ||
        json_object_array_length(arr) < 2) {
        if (arr) json_object_put(arr);
        return nullptr;
    }
    int a = static_cast<int>(json_object_get_int(json_object_array_get_idx(arr, 0)));
    int b = static_cast<int>(json_object_get_int(json_object_array_get_idx(arr, 1)));
    json_object_put(arr);

    int r = demo_add(a, b);
    char* out = static_cast<char*>(std::malloc(32));
    std::snprintf(out, 32, "%d", r);
    return out;
}

// regret_fibonacci — input: integer n
//                    output: integer (long)
// Throws std::invalid_argument if n < 0 (caught by harness as a skip).
extern "C" char* regret_fibonacci(const char* json_input) {
    json_object* o = json_tokener_parse(json_input);
    if (!o) return nullptr;
    int n = static_cast<int>(json_object_get_int(o));
    json_object_put(o);

    // This call may throw — harness will catch.
    long r = demo_fibonacci(n);
    char* out = static_cast<char*>(std::malloc(32));
    std::snprintf(out, 32, "%ld", r);
    return out;
}

// regret_reverse — input: string
//                  output: string
extern "C" char* regret_reverse(const char* json_input) {
    json_object* o = json_tokener_parse(json_input);
    if (!o || !json_object_is_type(o, json_type_string)) {
        if (o) json_object_put(o);
        return nullptr;
    }
    std::string s = json_object_get_string(o);
    json_object_put(o);

    std::string reversed = demo_reverse(s);
    return json_string_from_cpp(reversed);
}

// regret_parse_csv_line — input: string (the CSV line)
//                         output: array of strings
extern "C" char* regret_parse_csv_line(const char* json_input) {
    json_object* o = json_tokener_parse(json_input);
    if (!o || !json_object_is_type(o, json_type_string)) {
        if (o) json_object_put(o);
        return nullptr;
    }
    std::string s = json_object_get_string(o);
    json_object_put(o);

    std::vector<std::string> fields = demo_parse_csv_line(s);
    return json_array_from_vector(fields);
}

// regret_format_bytes — input: integer (long)
//                       output: string
extern "C" char* regret_format_bytes(const char* json_input) {
    json_object* o = json_tokener_parse(json_input);
    if (!o) return nullptr;
    long bytes = static_cast<long>(json_object_get_int64(o));
    json_object_put(o);

    std::string formatted = demo_format_bytes(bytes);
    return json_string_from_cpp(formatted);
}

// ─── Class-method adapters (demonstrate C++ class instantiation in adapter) ─

// regret_factorial — input: integer n
//                    output: integer (long)
// Demonstrates: instantiate MathUtils, call factorial method.
// Throws std::invalid_argument if n < 0.
extern "C" char* regret_factorial(const char* json_input) {
    json_object* o = json_tokener_parse(json_input);
    if (!o) return nullptr;
    int n = static_cast<int>(json_object_get_int(o));
    json_object_put(o);

    MathUtils calc;
    long r = calc.factorial(n);
    char* out = static_cast<char*>(std::malloc(32));
    std::snprintf(out, 32, "%ld", r);
    return out;
}

// regret_gcd — input: [a, b] (two longs)
//              output: integer (long)
// Demonstrates: class method with two-arg input.
extern "C" char* regret_gcd(const char* json_input) {
    json_object* arr = json_tokener_parse(json_input);
    if (!arr || !json_object_is_type(arr, json_type_array) ||
        json_object_array_length(arr) < 2) {
        if (arr) json_object_put(arr);
        return nullptr;
    }
    long a = static_cast<long>(json_object_get_int64(json_object_array_get_idx(arr, 0)));
    long b = static_cast<long>(json_object_get_int64(json_object_array_get_idx(arr, 1)));
    json_object_put(arr);

    MathUtils calc;
    long r = calc.gcd(a, b);
    char* out = static_cast<char*>(std::malloc(32));
    std::snprintf(out, 32, "%ld", r);
    return out;
}

// regret_is_palindrome — input: string
//                       output: boolean
// Demonstrates: class method returning bool, with case-insensitive logic.
extern "C" char* regret_is_palindrome(const char* json_input) {
    json_object* o = json_tokener_parse(json_input);
    if (!o || !json_object_is_type(o, json_type_string)) {
        if (o) json_object_put(o);
        return nullptr;
    }
    std::string s = json_object_get_string(o);
    json_object_put(o);

    MathUtils calc;
    bool result = calc.is_palindrome(s);
    return dup_cstr(result ? "true" : "false");
}
