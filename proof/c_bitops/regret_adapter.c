// regret_adapter.c — bridges the JSON-in/JSON-out convention used by
// regret_harness.c to the pure functions in bitops.c.
//
// One entry function per cluster. Each function:
//   - receives the cluster's INPUT as a JSON string
//   - parses it (using json-c, available because the harness links it)
//   - calls the corresponding bitops_* function
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
#include "bitops.h"

// regret_count_set_bits — input: integer (uint32)
//                        output: integer
char* regret_count_set_bits(const char* json_input) {
    json_object* o = json_tokener_parse(json_input);
    if (!o) return NULL;
    int64_t v = json_object_get_int64(o);
    json_object_put(o);
    if (v < 0) return NULL;  // trivial guard: negative not representable as uint32

    uint32_t r = bitops_count_set_bits((uint32_t)v);
    char* out = malloc(32);
    snprintf(out, 32, "%u", r);
    return out;
}

// regret_reverse_bits — input: integer (uint32)
//                      output: integer
char* regret_reverse_bits(const char* json_input) {
    json_object* o = json_tokener_parse(json_input);
    if (!o) return NULL;
    int64_t v = json_object_get_int64(o);
    json_object_put(o);
    if (v < 0) return NULL;

    uint32_t r = bitops_reverse_bits((uint32_t)v);
    char* out = malloc(32);
    snprintf(out, 32, "%u", r);
    return out;
}

// regret_rotate_left — input: [n, shift]
//                     output: integer
char* regret_rotate_left(const char* json_input) {
    json_object* arr = json_tokener_parse(json_input);
    if (!arr || !json_object_is_type(arr, json_type_array) ||
        json_object_array_length(arr) < 2) {
        if (arr) json_object_put(arr);
        return NULL;
    }
    int64_t n = json_object_get_int64(json_object_array_get_idx(arr, 0));
    int64_t s = json_object_get_int64(json_object_array_get_idx(arr, 1));
    json_object_put(arr);
    if (n < 0 || s < 0) return NULL;

    uint32_t r = bitops_rotate_left((uint32_t)n, (uint32_t)s);
    char* out = malloc(32);
    snprintf(out, 32, "%u", r);
    return out;
}

// regret_rotate_right — input: [n, shift]
//                      output: integer
char* regret_rotate_right(const char* json_input) {
    json_object* arr = json_tokener_parse(json_input);
    if (!arr || !json_object_is_type(arr, json_type_array) ||
        json_object_array_length(arr) < 2) {
        if (arr) json_object_put(arr);
        return NULL;
    }
    int64_t n = json_object_get_int64(json_object_array_get_idx(arr, 0));
    int64_t s = json_object_get_int64(json_object_array_get_idx(arr, 1));
    json_object_put(arr);
    if (n < 0 || s < 0) return NULL;

    uint32_t r = bitops_rotate_right((uint32_t)n, (uint32_t)s);
    char* out = malloc(32);
    snprintf(out, 32, "%u", r);
    return out;
}

// regret_next_power_of_two — input: integer (uint32)
//                            output: integer
char* regret_next_power_of_two(const char* json_input) {
    json_object* o = json_tokener_parse(json_input);
    if (!o) return NULL;
    int64_t v = json_object_get_int64(o);
    json_object_put(o);
    if (v < 0) return NULL;

    uint32_t r = bitops_next_power_of_two((uint32_t)v);
    char* out = malloc(32);
    snprintf(out, 32, "%u", r);
    return out;
}
