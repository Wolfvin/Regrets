// demo_math.c — pure functions used as the regret-capture target in proof/c/.
// No I/O, no time, no randomness — all outputs are deterministic for the
// same inputs, which is the contract Regrets fingerprints.
//
// This file is the equivalent of MathUtils.java in proof/java/.

#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <ctype.h>

#include "demo_math.h"

int demo_add(int a, int b) {
    return a + b;
}

long demo_fibonacci(int n) {
    if (n < 0) return -1;  // error sentinel (skipped via trivial guard? no — non-null)
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

char* demo_reverse(const char* s) {
    if (!s) return NULL;
    size_t len = strlen(s);
    char* out = malloc(len + 1);
    for (size_t i = 0; i < len; i++) {
        out[i] = s[len - 1 - i];
    }
    out[len] = '\0';
    return out;
}

// Parse a CSV line with quoted-field support. Returns a malloc'd array of
// malloc'd strings. The caller must free each element then the array.
// *out_count receives the number of fields.
char** demo_parse_csv_line(const char* line, int* out_count) {
    *out_count = 0;
    if (!line || !*line) {
        char** arr = malloc(sizeof(char*));
        return arr;  // empty array
    }
    size_t cap = 8;
    char** out = malloc(cap * sizeof(char*));
    int count = 0;
    size_t cur_cap = 32;
    char* cur = malloc(cur_cap);
    size_t cur_len = 0;
    int in_quotes = 0;

    for (const char* p = line; *p; p++) {
        char c = *p;
        if (cur_len + 1 >= cur_cap) {
            cur_cap *= 2;
            cur = realloc(cur, cur_cap);
        }
        if (in_quotes) {
            if (c == '"') {
                if (p[1] == '"') {
                    cur[cur_len++] = '"';
                    p++;
                } else {
                    in_quotes = 0;
                }
            } else {
                cur[cur_len++] = c;
            }
        } else {
            if (c == ',') {
                cur[cur_len] = '\0';
                if (count >= (int)cap) {
                    cap *= 2;
                    out = realloc(out, cap * sizeof(char*));
                }
                out[count++] = cur;
                cur = malloc(cur_cap = 32);
                cur_len = 0;
            } else if (c == '"') {
                in_quotes = 1;
            } else {
                cur[cur_len++] = c;
            }
        }
    }
    cur[cur_len] = '\0';
    if (count >= (int)cap) {
        cap *= 2;
        out = realloc(out, cap * sizeof(char*));
    }
    out[count++] = cur;
    *out_count = count;
    return out;
}

// Format bytes into human-readable string (binary units).
// Returns malloc'd string. Caller frees.
char* demo_format_bytes(long bytes) {
    static const char* units[] = {"KiB", "MiB", "GiB", "TiB", "PiB"};
    if (bytes < 0) {
        char* neg = demo_format_bytes(-bytes);
        size_t len = strlen(neg) + 2;
        char* out = malloc(len);
        snprintf(out, len, "-%s", neg);
        free(neg);
        return out;
    }
    char* out = malloc(64);
    if (bytes < 1024L) {
        snprintf(out, 64, "%ld B", bytes);
        return out;
    }
    double v = (double)bytes;
    int unit_idx = -1;
    while (v >= 1024.0 && unit_idx < 4) {
        v /= 1024.0;
        unit_idx++;
    }
    snprintf(out, 64, "%.2f %s", v, units[unit_idx]);
    return out;
}
