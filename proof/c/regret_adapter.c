// regret_adapter.c — bridges the JSON-in/JSON-out convention used by
// regret_harness.c to the pure functions in demo_math.c.
//
// One entry function per cluster. Each function:
//   - receives the cluster's INPUT as a JSON string
//   - parses it (using json-c, available because the harness links it)
//   - calls the corresponding demo_* function
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
#include "demo_math.h"

// regret_add — input: [a, b] (two integers)
//              output: integer
char* regret_add(const char* json_input) {
    json_object* arr = json_tokener_parse(json_input);
    if (!arr || !json_object_is_type(arr, json_type_array) ||
        json_object_array_length(arr) < 2) {
        if (arr) json_object_put(arr);
        return NULL;
    }
    int a = (int)json_object_get_int(json_object_array_get_idx(arr, 0));
    int b = (int)json_object_get_int(json_object_array_get_idx(arr, 1));
    json_object_put(arr);

    int r = demo_add(a, b);
    char* out = malloc(32);
    snprintf(out, 32, "%d", r);
    return out;
}

// regret_fibonacci — input: integer n
//                    output: integer (long)
char* regret_fibonacci(const char* json_input) {
    json_object* o = json_tokener_parse(json_input);
    if (!o) return NULL;
    int n = (int)json_object_get_int(o);
    json_object_put(o);

    long r = demo_fibonacci(n);
    char* out = malloc(32);
    snprintf(out, 32, "%ld", r);
    return out;
}

// regret_reverse — input: string
//                  output: string
char* regret_reverse(const char* json_input) {
    json_object* o = json_tokener_parse(json_input);
    if (!o || !json_object_is_type(o, json_type_string)) {
        if (o) json_object_put(o);
        return NULL;
    }
    const char* s = json_object_get_string(o);
    char* reversed = demo_reverse(s);
    json_object_put(o);
    if (!reversed) return NULL;

    // Wrap in JSON string
    json_object* out_obj = json_object_new_string(reversed);
    free(reversed);
    const char* json_str = json_object_to_json_string_ext(out_obj, JSON_C_TO_STRING_PLAIN);
    char* result = strdup(json_str);
    json_object_put(out_obj);
    return result;
}

// regret_parse_csv_line — input: string (the CSV line)
//                         output: array of strings
char* regret_parse_csv_line(const char* json_input) {
    json_object* o = json_tokener_parse(json_input);
    if (!o || !json_object_is_type(o, json_type_string)) {
        if (o) json_object_put(o);
        return NULL;
    }
    const char* s = json_object_get_string(o);
    int count = 0;
    char** fields = demo_parse_csv_line(s, &count);
    json_object_put(o);

    json_object* arr = json_object_new_array();
    for (int i = 0; i < count; i++) {
        json_object_array_add(arr, json_object_new_string(fields[i]));
        free(fields[i]);
    }
    free(fields);

    const char* json_str = json_object_to_json_string_ext(arr, JSON_C_TO_STRING_PLAIN);
    char* result = strdup(json_str);
    json_object_put(arr);
    return result;
}

// regret_format_bytes — input: integer (long)
//                       output: string
char* regret_format_bytes(const char* json_input) {
    json_object* o = json_tokener_parse(json_input);
    if (!o) return NULL;
    long bytes = (long)json_object_get_int64(o);
    json_object_put(o);

    char* formatted = demo_format_bytes(bytes);
    if (!formatted) return NULL;

    json_object* out_obj = json_object_new_string(formatted);
    free(formatted);
    const char* json_str = json_object_to_json_string_ext(out_obj, JSON_C_TO_STRING_PLAIN);
    char* result = strdup(json_str);
    json_object_put(out_obj);
    return result;
}
