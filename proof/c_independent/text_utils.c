// text_utils.c — pure-function implementations for proof/c_independent/.
//
// Designed to exercise C idioms DIFFERENT from those in proof/c/demo_math.c
// (which covers int-add, iterative fibonacci, string reverse, CSV parse,
// bytes formatter). Here we cover:
//
//   - slugify        : char-class transform + run-collapse (ctype.h based)
//   - base64_encode  : bitwise shift + mask + 6-bit grouping + lookup table
//   - crc32          : unsigned arithmetic + 256-entry lookup table
//   - fnv1a_32       : multiply + XOR per byte
//   - is_valid_ipv4  : multi-delimiter parser + numeric range check
//
// Reference outputs are well-known and can be independently verified via
// Python's base64, zlib.crc32, fnvhash, etc.

#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <ctype.h>

#include "text_utils.h"

// ─── slugify ─────────────────────────────────────────────────────────────────
char* slugify(const char* s) {
    if (!s) return NULL;
    size_t len = strlen(s);
    char* out = malloc(len + 1);
    if (!out) return NULL;
    size_t j = 0;
    int prev_was_hyphen = 1;  // suppress leading hyphen
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)s[i];
        if (isalnum(c)) {
            out[j++] = (char)tolower(c);
            prev_was_hyphen = 0;
        } else {
            if (!prev_was_hyphen) {
                out[j++] = '-';
                prev_was_hyphen = 1;
            }
        }
    }
    // Strip trailing hyphen if any
    if (j > 0 && out[j - 1] == '-') j--;
    out[j] = '\0';
    return out;
}

// ─── base64_encode (RFC 4648) ────────────────────────────────────────────────
static const char b64_alphabet[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

char* base64_encode(const char* s) {
    if (!s) return NULL;
    size_t len = strlen(s);
    // Output size: ceil(len/3)*4, plus 1 for NUL.
    size_t out_len = ((len + 2) / 3) * 4;
    char* out = malloc(out_len + 1);
    if (!out) return NULL;
    size_t j = 0;
    for (size_t i = 0; i < len; i += 3) {
        unsigned int b0 = (unsigned char)s[i];
        unsigned int b1 = (i + 1 < len) ? (unsigned char)s[i + 1] : 0u;
        unsigned int b2 = (i + 2 < len) ? (unsigned char)s[i + 2] : 0u;
        unsigned int triple = (b0 << 16) | (b1 << 8) | b2;
        out[j++] = b64_alphabet[(triple >> 18) & 0x3F];
        out[j++] = b64_alphabet[(triple >> 12) & 0x3F];
        out[j++] = (i + 1 < len) ? b64_alphabet[(triple >> 6) & 0x3F] : '=';
        out[j++] = (i + 2 < len) ? b64_alphabet[triple & 0x3F]        : '=';
    }
    out[j] = '\0';
    return out;
}

// ─── crc32 (IEEE 802.3, reflected, init 0xFFFFFFFF, final XOR 0xFFFFFFFF) ────
static unsigned int crc32_table[256];
static int crc32_table_initialized = 0;

static void crc32_init_table(void) {
    for (unsigned int i = 0; i < 256; i++) {
        unsigned int c = i;
        for (int k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
        }
        crc32_table[i] = c;
    }
    crc32_table_initialized = 1;
}

unsigned int crc32(const char* s) {
    if (!s) return 0u;
    if (!crc32_table_initialized) crc32_init_table();
    unsigned int crc = 0xFFFFFFFFu;
    for (const unsigned char* p = (const unsigned char*)s; *p; p++) {
        crc = crc32_table[(crc ^ *p) & 0xFF] ^ (crc >> 8);
    }
    return crc ^ 0xFFFFFFFFu;
}

// ─── fnv1a_32 (32-bit FNV-1a) ────────────────────────────────────────────────
unsigned int fnv1a_32(const char* s) {
    if (!s) return 2166136261u;
    unsigned int h = 2166136261u;  // FNV offset basis
    for (const unsigned char* p = (const unsigned char*)s; *p; p++) {
        h ^= (unsigned int)(*p);
        h *= 16777619u;            // FNV prime
    }
    return h;
}

// ─── is_valid_ipv4 ───────────────────────────────────────────────────────────
// Strict: exactly 4 octets, each 0-255, no leading zeros except "0" itself,
// no extra characters, exactly 3 dots.
int is_valid_ipv4(const char* s) {
    if (!s || !*s) return 0;
    int dots = 0;
    int octet_count = 0;
    const char* p = s;
    while (*p) {
        // Read digits for one octet
        if (!isdigit((unsigned char)*p)) return 0;
        const char* start = p;
        while (isdigit((unsigned char)*p)) p++;
        size_t digits = (size_t)(p - start);
        if (digits == 0 || digits > 3) return 0;
        // Leading-zero check: "0" ok, "0X" not ok.
        if (digits > 1 && *start == '0') return 0;
        // Parse the number
        int val = 0;
        for (const char* q = start; q < p; q++) {
            val = val * 10 + (*q - '0');
        }
        if (val < 0 || val > 255) return 0;
        octet_count++;
        // After an octet: either '.' or end-of-string
        if (*p == '.') {
            dots++;
            if (dots > 3) return 0;
            p++;
            // Must have a digit after the dot
            if (!isdigit((unsigned char)*p)) return 0;
        } else if (*p == '\0') {
            break;
        } else {
            return 0;  // unexpected char
        }
    }
    return (dots == 3 && octet_count == 4) ? 1 : 0;
}
