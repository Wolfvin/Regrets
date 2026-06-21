// string_adapter.cpp — C++ Regrets adapter for string_utils (INDEPENDENT FIXTURE)
//
// Uses the JSON-in/JSON-out adapter pattern defined in regret.hpp.
// Each cluster entry function has extern "C" linkage for dlsym lookup.
// Input format matches manifest "inputs" array (JSON values).
// Output: malloc'd JSON string.

#include "regret.hpp"
#include "string_utils.hpp"

#include <json-c/json.h>
#include <cstdlib>
#include <cstring>
#include <string>

// ─── reverse ───────────────────────────────────────────────────────────────
// Input: "hello" → Output: "olleh"
extern "C" char* regret_reverse(const char* json_input) {
    json_object* obj = json_tokener_parse(json_input);
    const char* s = json_object_get_string(obj);
    std::string result = stringutils::reverse(std::string(s));
    json_object_put(obj);

    json_object* out = json_object_new_string(result.c_str());
    const char* out_str = json_object_to_json_string_ext(out, JSON_C_TO_STRING_PLAIN);
    char* ret = static_cast<char*>(std::malloc(std::strlen(out_str) + 1));
    std::strcpy(ret, out_str);
    json_object_put(out);
    return ret;
}

// ─── is_palindrome ────────────────────────────────────────────────────────
// Input: "Race Car" → Output: true
extern "C" char* regret_is_palindrome(const char* json_input) {
    json_object* obj = json_tokener_parse(json_input);
    const char* s = json_object_get_string(obj);
    bool result = stringutils::is_palindrome(std::string(s));
    json_object_put(obj);

    json_object* out = json_object_new_boolean(result ? 1 : 0);
    const char* out_str = json_object_to_json_string_ext(out, JSON_C_TO_STRING_PLAIN);
    char* ret = static_cast<char*>(std::malloc(std::strlen(out_str) + 1));
    std::strcpy(ret, out_str);
    json_object_put(out);
    return ret;
}

// ─── word_count ────────────────────────────────────────────────────────────
// Input: "hello world foo" → Output: 3
extern "C" char* regret_word_count(const char* json_input) {
    json_object* obj = json_tokener_parse(json_input);
    const char* s = json_object_get_string(obj);
    int result = stringutils::word_count(std::string(s));
    json_object_put(obj);

    json_object* out = json_object_new_int(result);
    const char* out_str = json_object_to_json_string_ext(out, JSON_C_TO_STRING_PLAIN);
    char* ret = static_cast<char*>(std::malloc(std::strlen(out_str) + 1));
    std::strcpy(ret, out_str);
    json_object_put(out);
    return ret;
}

// ─── slugify ───────────────────────────────────────────────────────────────
// Input: "Hello World! 2024" → Output: "hello-world-2024"
extern "C" char* regret_slugify(const char* json_input) {
    json_object* obj = json_tokener_parse(json_input);
    const char* s = json_object_get_string(obj);
    std::string result = stringutils::slugify(std::string(s));
    json_object_put(obj);

    json_object* out = json_object_new_string(result.c_str());
    const char* out_str = json_object_to_json_string_ext(out, JSON_C_TO_STRING_PLAIN);
    char* ret = static_cast<char*>(std::malloc(std::strlen(out_str) + 1));
    std::strcpy(ret, out_str);
    json_object_put(out);
    return ret;
}

// ─── title_case ────────────────────────────────────────────────────────────
// Input: "hello world" → Output: "Hello World"
extern "C" char* regret_title_case(const char* json_input) {
    json_object* obj = json_tokener_parse(json_input);
    const char* s = json_object_get_string(obj);
    std::string result = stringutils::title_case(std::string(s));
    json_object_put(obj);

    json_object* out = json_object_new_string(result.c_str());
    const char* out_str = json_object_to_json_string_ext(out, JSON_C_TO_STRING_PLAIN);
    char* ret = static_cast<char*>(std::malloc(std::strlen(out_str) + 1));
    std::strcpy(ret, out_str);
    json_object_put(out);
    return ret;
}
