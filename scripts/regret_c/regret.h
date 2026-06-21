// regret.h — public API for the Regrets C adapter pattern.
//
// User code provides one entry function per cluster, with signature:
//
//     char* <entry>(const char* json_input);
//
// The function receives the cluster's INPUT as a JSON string and must
// return a malloc'd JSON string representing the OUTPUT. The Regrets
// harness handles fingerprinting (SHA-256 → base36 → 7 chars) and
// writes/compares `.regret` files in the standard format.
//
// Example adapter:
//
//     #include "regret.h"
//     #include <stdio.h>
//     #include <stdlib.h>
//     #include <string.h>
//
//     int add(int a, int b) { return a + b; }  // pure function
//
//     char* regret_add(const char* json_input) {
//         int a, b;
//         if (sscanf(json_input, "[%d,%d]", &a, &b) != 2) return NULL;
//         int r = add(a, b);
//         char* out = malloc(32);
//         snprintf(out, 32, "%d", r);
//         return out;
//     }
//
// Link the adapter + harness + user sources into one executable:
//
//     gcc -o regret_runner regret_harness.c user.c adapter.c
//         -lcrypto -ljson-c -ldl -rdynamic
//
// Run:
//     ./regret_runner capture   --manifest regrets/manifest.json
//     ./regret_runner validate  --manifest regrets/manifest.json

#ifndef REGRET_H
#define REGRET_H

#ifdef __cplusplus
extern "C" {
#endif

// Entry function signature. Adapters must implement one per cluster
// with the symbol name matching the cluster's `entry` field.
//
// Contract:
//   - input:  NUL-terminated JSON string (caller owns, do not free).
//   - output: malloc'd NUL-terminated JSON string (caller frees with free()).
//   - return NULL on error or to trigger the trivial-input skip guard.
typedef char* (*regret_entry_fn)(const char* json_input);

#ifdef __cplusplus
}
#endif

#endif // REGRET_H
