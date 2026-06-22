// bitops.c — pure functions used as the regret-capture target in
// proof/c_bitops/. No I/O, no time, no randomness — all outputs are
// deterministic for the same inputs.
//
// This file is intentionally NOT a copy of demo_math.c (proof/c/) —
// it implements an entirely different domain (bit manipulation) so
// that running capture_c.sh + validate_c.sh against it constitutes an
// independent verification per CONTEXT.md "Lesson Learned".

#include "bitops.h"

uint32_t bitops_count_set_bits(uint32_t n) {
    // Brian Kernighan's algorithm: each iteration clears the lowest set
    // bit, so the loop body runs exactly popcount(n) times.
    uint32_t count = 0;
    while (n) {
        n &= (n - 1);
        count++;
    }
    return count;
}

uint32_t bitops_reverse_bits(uint32_t n) {
    // Classic byte-by-byte reversal via a 256-entry lookup table would
    // introduce a 1KB static table; instead we use the mask-and-shift
    // dance so the function body is self-contained and easy to refactor.
    n = ((n & 0xFFFF0000u) >> 16) | ((n & 0x0000FFFFu) << 16);
    n = ((n & 0xFF00FF00u) >> 8)  | ((n & 0x00FF00FFu) << 8);
    n = ((n & 0xF0F0F0F0u) >> 4)  | ((n & 0x0F0F0F0Fu) << 4);
    n = ((n & 0xCCCCCCCCu) >> 2)  | ((n & 0x33333333u) << 2);
    n = ((n & 0xAAAAAAAAu) >> 1)  | ((n & 0x55555555u) << 1);
    return n;
}

uint32_t bitops_rotate_left(uint32_t n, uint32_t shift) {
    shift &= 31u;  // mod 32
    if (shift == 0) return n;
    return (n << shift) | (n >> (32u - shift));
}

uint32_t bitops_rotate_right(uint32_t n, uint32_t shift) {
    shift &= 31u;  // mod 32
    if (shift == 0) return n;
    return (n >> shift) | (n << (32u - shift));
}

uint32_t bitops_next_power_of_two(uint32_t n) {
    if (n == 0) return 1u;
    // Decrement so that already-powers-of-two return themselves rather
    // than the next-higher power. Classic "round up to next power of two"
    // idiom (Hacker's Delight §3-2).
    n--;
    n |= n >> 1;
    n |= n >> 2;
    n |= n >> 4;
    n |= n >> 8;
    n |= n >> 16;
    n++;
    return n;
}
