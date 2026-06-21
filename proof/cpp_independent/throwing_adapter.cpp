// throwing_adapter.cpp — Test C++ exception safety in the Regrets harness
// One cluster throws std::runtime_error, another throws unknown exception

#include "regret.hpp"
#include <json-c/json.h>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <string>

// This adapter throws std::runtime_error
extern "C" char* regret_throws_runtime(const char* json_input) {
    throw std::runtime_error("intentional error for testing");
}

// This adapter throws an int (unknown exception type)
extern "C" char* regret_throws_int(const char* json_input) {
    throw 42;
}

// This adapter works normally
extern "C" char* regret_normal_entry(const char* json_input) {
    json_object* obj = json_tokener_parse(json_input);
    int val = json_object_get_int(obj);
    json_object_put(obj);

    json_object* out = json_object_new_int(val * 2);
    const char* out_str = json_object_to_json_string_ext(out, JSON_C_TO_STRING_PLAIN);
    char* ret = static_cast<char*>(std::malloc(std::strlen(out_str) + 1));
    std::strcpy(ret, out_str);
    json_object_put(out);
    return ret;
}
