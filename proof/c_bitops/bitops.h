// bitops.h — declarations for the bit-manipulation functions used as the
// regret-capture target in proof/c_bitops/.
//
// All functions operate on uint32_t to keep semantics portable across
// LP32 / LP64 ABIs. The outputs are deterministic for the same inputs,
// which is the contract Regrets fingerprints.
//
// Domain rationale: prior C-stack fixtures (proof/c/, feat/c-stack-verify)
// used math, string-transform, CSV-parsing, slugify, levenshtein, ipv4,
// base64, and crc32 domains. Bit manipulation is a distinct domain that
// exercises unsigned arithmetic, shifts, and lookup-free algorithms —
// avoiding the confirmation-bias trap documented in CONTEXT.md ("Lesson
// Learned": don't verify with patterns that share an implementation
// grammar with the code under test).

#ifndef REGRET_PROOF_BITOPS_H
#define REGRET_PROOF_BITOPS_H

#include <stdint.h>

// Population count — Brian Kernighan's algorithm (clears lowest set bit
// each iteration; loop runs `popcount(n)` times, not 32 times).
uint32_t bitops_count_set_bits(uint32_t n);

// Reverse the 32 bits of n (MSB ↔ LSB).
uint32_t bitops_reverse_bits(uint32_t n);

// Rotate n left by `shift` positions (mod 32).
uint32_t bitops_rotate_left(uint32_t n, uint32_t shift);

// Rotate n right by `shift` positions (mod 32).
uint32_t bitops_rotate_right(uint32_t n, uint32_t shift);

// Smallest power of two ≥ n. Returns n itself if n is already a power of
// two (and n != 0). For n == 0, returns 1 (the smallest power of two).
uint32_t bitops_next_power_of_two(uint32_t n);

#endif // REGRET_PROOF_BITOPS_H
