// text_utils.h — declarations for the pure functions used as the
// regret-capture target in proof/c_independent/.
//
// These functions are INTENTIONALLY DIFFERENT in idiom from proof/c/
// (which uses add/fibonacci/reverse/parse_csv_line/format_bytes).
// This file exercises:
//   - char-class transforms + collapsing (slugify)
//   - bitwise ops + 6-bit groupings (base64_encode)
//   - unsigned arithmetic + 256-entry table (crc32)
//   - multiply + XOR per byte (fnv1a_32)
//   - multi-delimiter parser + range check (is_valid_ipv4)
//
// All outputs are deterministic for the same inputs.

#ifndef TEXT_UTILS_H
#define TEXT_UTILS_H

#ifdef __cplusplus
extern "C" {
#endif

// slugify: lowercase ASCII alphanumeric preserved; all other chars → '-';
//         runs of '-' collapsed; leading/trailing '-' stripped.
// Returns malloc'd NUL-terminated string. Caller frees.
// Returns NULL if input is NULL.
char* slugify(const char* s);

// base64_encode: RFC 4648 standard base64 of the input bytes (no newlines,
//                standard '+'/'/' alphabet, '=' padding).
// Returns malloc'd NUL-terminated string. Caller frees.
// Returns NULL if input is NULL (but "" returns "").
char* base64_encode(const char* s);

// crc32: IEEE polynomial 0xEDB88320 (reflected), init 0xFFFFFFFF, final XOR
//        0xFFFFFFFF. Returns the CRC as a uint32_t.
// Returns 0 if input is NULL or empty.
unsigned int crc32(const char* s);

// fnv1a_32: FNV-1a 32-bit hash. Offset basis 2166136261, prime 16777619.
// Returns the hash as a uint32_t. Returns the offset basis if input is empty/NULL.
unsigned int fnv1a_32(const char* s);

// is_valid_ipv4: Returns 1 if s is a strict valid IPv4 dotted-quad
//                (4 octets, each 0-255, no leading zeros except "0" itself).
//                Returns 0 otherwise.
int is_valid_ipv4(const char* s);

#ifdef __cplusplus
}
#endif

#endif // TEXT_UTILS_H
