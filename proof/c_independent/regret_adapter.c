// regret_adapter.c — bridges the JSON-in/JSON-out convention used by
// regret_harness.c to the pure functions in text_utils.c.
//
// One entry function per cluster. Each function:
//   - receives the cluster's INPUT as a JSON string
//   - parses it (using json-c, available because the harness links it)
//   - calls the corresponding text_utils function
//   - serializes the result back to a malloc'd JSON string
//   - returns the JSON string (caller frees)
//
// Returning NULL triggers the trivial-input skip guard in the harness.

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <json-c/json.h>

#include "regret.h"
#include "text_utils.h"

// ─── regret_slugify ──────────────────────────────────────────────────────────
// input: string
// output: string
char* regret_slugify(const char* json_input) {
    json_object* o = json_tokener_parse(json_input);
    if (!o || !json_object_is_type(o, json_type_string)) {
        if (o) json_object_put(o);
        return NULL;
    }
    const char* s = json_object_get_string(o);
    char* result_text = slugify(s);
    json_object_put(o);
    if (!result_text) return NULL;

    json_object* out_obj = json_object_new_string(result_text);
    free(result_text);
    const char* json_str = json_object_to_json_string_ext(out_obj, JSON_C_TO_STRING_PLAIN);
    char* result = strdup(json_str);
    json_object_put(out_obj);
    return result;
}

// ─── regret_base64_encode ────────────────────────────────────────────────────
// input: string
// output: string
char* regret_base64_encode(const char* json_input) {
    json_object* o = json_tokener_parse(json_input);
    if (!o || !json_object_is_type(o, json_type_string)) {
        if (o) json_object_put(o);
        return NULL;
    }
    const char* s = json_object_get_string(o);
    char* result_text = base64_encode(s);
    json_object_put(o);
    if (!result_text) return NULL;

    json_object* out_obj = json_object_new_string(result_text);
    free(result_text);
    const char* json_str = json_object_to_json_string_ext(out_obj, JSON_C_TO_STRING_PLAIN);
    char* result = strdup(json_str);
    json_object_put(out_obj);
    return result;
}

// ─── regret_crc32 ────────────────────────────────────────────────────────────
// input: string
// output: unsigned int (rendered as a bare integer in JSON)
char* regret_crc32(const char* json_input) {
    json_object* o = json_tokener_parse(json_input);
    if (!o || !json_object_is_type(o, json_type_string)) {
        if (o) json_object_put(o);
        return NULL;
    }
    const char* s = json_object_get_string(o);
    unsigned int v = crc32(s);
    json_object_put(o);

    char* out = malloc(32);
    if (!out) return NULL;
    snprintf(out, 32, "%u", v);
    return out;
}

// ─── regret_fnv1a_32 ─────────────────────────────────────────────────────────
// input: string
// output: unsigned int (rendered as a bare integer in JSON)
char* regret_fnv1a_32(const char* json_input) {
    json_object* o = json_tokener_parse(json_input);
    if (!o || !json_object_is_type(o, json_type_string)) {
        if (o) json_object_put(o);
        return NULL;
    }
    const char* s = json_object_get_string(o);
    unsigned int v = fnv1a_32(s);
    json_object_put(o);

    char* out = malloc(32);
    if (!out) return NULL;
    snprintf(out, 32, "%u", v);
    return out;
}

// ─── regret_is_valid_ipv4 ────────────────────────────────────────────────────
// input: string
// output: boolean (rendered as "true"/"false" in JSON)
char* regret_is_valid_ipv4(const char* json_input) {
    json_object* o = json_tokener_parse(json_input);
    if (!o || !json_object_is_type(o, json_type_string)) {
        if (o) json_object_put(o);
        return NULL;
    }
    const char* s = json_object_get_string(o);
    int v = is_valid_ipv4(s);
    json_object_put(o);

    char* out = strdup(v ? "true" : "false");
    return out;
}
