<?php declare(strict_types=1);
/**
 * VerifyLib — pure functions for independent verification of the PHP Regrets stack.
 *
 * The functions here are DELIBERATELY DIFFERENT from the ones in
 * PR #347's proof/php-fixture/ (slugify, count_words, Invoice::calculate,
 * format_post) to avoid the confirmation-bias trap documented in
 * CONTEXT.md "Lesson Learned": "test ditulis dengan pattern yang sama
 * dengan implementasi".
 *
 * Each function targets a different PHP idiom:
 *   - crc32        : table-driven checksum (no hash() builtin)
 *   - base64_encode : bitwise ops + lookup table (no base64_encode builtin)
 *   - levenshtein  : 2D DP matrix with nested loops
 *   - is_valid_ipv4 : multi-delimiter parser + range check
 *   - fnv1a        : multiply + XOR per byte
 *
 * Same algorithms as proof/c_verify/, proof/go_verify/, proof/rust_verify/
 * → enables 5-way cross-stack parity verification.
 */

namespace RegretVerify;

/**
 * CRC32 (zlib/zip polynomial 0xEDB88320) of input string's bytes.
 * Returns the standard 32-bit checksum (initial 0xFFFFFFFF, final XOR 0xFFFFFFFF).
 * Implemented from scratch (not using hash('crc32b')) to exercise unsigned
 * arithmetic + table initialization.
 */
function crc32(string $s): int
{
    $data = unpack('C*', $s); // 1-indexed array of bytes
    static $table = null;
    if ($table === null) {
        $table = [];
        for ($i = 0; $i < 256; $i++) {
            $c = $i;
            for ($k = 0; $k < 8; $k++) {
                if ($c & 1) {
                    $c = 0xEDB88320 ^ (($c >> 1) & 0x7FFFFFFF);
                } else {
                    $c = ($c >> 1) & 0x7FFFFFFF;
                }
            }
            $table[$i] = $c;
        }
    }
    $crc = 0xFFFFFFFF;
    foreach ($data as $b) {
        $crc = $table[($crc ^ $b) & 0xFF] ^ (($crc >> 8) & 0x00FFFFFF);
    }
    // PHP ints are signed 64-bit on 64-bit platforms — convert unsigned 32-bit
    return $crc ^ 0xFFFFFFFF;
}

/**
 * Base64-encode a string using standard base64 alphabet with '=' padding.
 * Empty input returns "". Implemented from scratch (not using base64_encode()
 * builtin) to exercise bit manipulation code paths.
 */
function base64_encode(string $s): string
{
    if ($s === '') {
        return '';
    }
    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    $data = unpack('C*', $s); // 1-indexed bytes
    $out = '';
    $n = count($data);
    for ($i = 1; $i <= $n; $i += 3) {
        $b0 = $data[$i];
        $b1 = ($i + 1 <= $n) ? $data[$i + 1] : 0;
        $b2 = ($i + 2 <= $n) ? $data[$i + 2] : 0;
        $triple = ($b0 << 16) | ($b1 << 8) | $b2;
        $out .= $alphabet[($triple >> 18) & 0x3F];
        $out .= $alphabet[($triple >> 12) & 0x3F];
        $out .= ($i + 1 <= $n) ? $alphabet[($triple >> 6) & 0x3F] : '=';
        $out .= ($i + 2 <= $n) ? $alphabet[$triple & 0x3F] : '=';
    }
    return $out;
}

/**
 * Levenshtein edit distance between two strings. Implemented from scratch
 * (not using levenshtein() builtin) to exercise 2D DP matrix code paths.
 */
function levenshtein(string $a, string $b): int
{
    $la = strlen($a);
    $lb = strlen($b);
    if ($la === 0) return $lb;
    if ($lb === 0) return $la;
    // Two rolling rows for O(min($la,$lb)) space
    if ($la < $lb) {
        $tmp = $a; $a = $b; $b = $tmp;
        $tl = $la; $la = $lb; $lb = $tl;
    }
    $prev = range(0, $lb);
    $curr = array_fill(0, $lb + 1, 0);
    for ($i = 1; $i <= $la; $i++) {
        $curr[0] = $i;
        for ($j = 1; $j <= $lb; $j++) {
            $cost = ($a[$i - 1] === $b[$j - 1]) ? 0 : 1;
            $del = $prev[$j] + 1;
            $ins = $curr[$j - 1] + 1;
            $sub = $prev[$j - 1] + $cost;
            $m = min($del, $ins, $sub);
            $curr[$j] = $m;
        }
        $tmp = $prev; $prev = $curr; $curr = $tmp;
    }
    return $prev[$lb];
}

/**
 * Validate an IPv4 dotted-quad. Returns true iff s is a valid dotted-quad:
 * exactly 4 octets 0-255 separated by single '.', no leading zeros (except
 * "0" itself), no trailing junk.
 */
function is_valid_ipv4(string $s): bool
{
    if ($s === '') return false;
    $octets = 0;
    $val = 0;
    $digits = 0;
    $len = strlen($s);
    for ($i = 0; $i < $len; $i++) {
        $c = $s[$i];
        if ($c >= '0' && $c <= '9') {
            if ($digits === 1 && $val === 0) return false; // leading zero
            if ($digits >= 3) return false;
            $val = $val * 10 + (ord($c) - ord('0'));
            $digits++;
            if ($val > 255) return false;
        } elseif ($c === '.') {
            if ($digits === 0) return false; // empty octet
            $octets++;
            if ($octets > 4) return false;
            // Next char must be a digit
            if ($i + 1 >= $len || $s[$i + 1] < '0' || $s[$i + 1] > '9') return false;
            $val = 0;
            $digits = 0;
        } else {
            return false; // invalid char
        }
    }
    if ($digits === 0) return false;
    $octets++;
    return $octets === 4;
}

/**
 * FNV-1a 32-bit hash of input string's bytes. Different algorithm than
 * CRC32 — exercises a different bit-manipulation pattern (multiply + XOR
 * per byte). PHP integers are 64-bit signed, so masking with 0xFFFFFFFF
 * keeps us in unsigned 32-bit territory.
 */
function fnv1a(string $s): int
{
    $offsetBasis = 2166136261;
    $prime = 16777619;
    $h = $offsetBasis;
    $data = unpack('C*', $s);
    foreach ($data as $b) {
        $h = ($h ^ $b) & 0xFFFFFFFF;
        // 64-bit signed multiplication, mask back to 32-bit
        $h = ($h * $prime) & 0xFFFFFFFF;
    }
    // Convert unsigned 32-bit (stored as signed if high bit set) — return as-is
    // PHP will JSON-encode as int; high-bit-set values become negative.
    // For fingerprint parity, what matters is that the value round-trips
    // identically through stableStringify + sha256.
    return $h;
}
