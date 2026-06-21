// regret.hpp — public API for the Regrets C++ adapter pattern.
//
// User code provides one entry function per cluster, with signature:
//
//     extern "C" char* <entry>(const char* json_input);
//
// The function receives the cluster's INPUT as a JSON string and must
// return a malloc'd JSON string representing the OUTPUT. The Regrets
// harness handles fingerprinting (SHA-256 → BIGNUM → base36 → 7 chars)
// and writes/compares `.regret` files in the standard format.
//
// The `extern "C"` linkage is REQUIRED so that `dlsym` can look up the
// symbol without C++ name mangling.
//
// C++ adapter example (uses json-c for JSON, available because the
// harness links it):
//
//     #include "regret.hpp"
//     #include <json-c/json.h>
//     #include <cstdlib>
//     #include <cstring>
//     #include <string>
//
//     // Pure C++ function
//     int add(int a, int b) { return a + b; }
//
//     extern "C" char* regret_add(const char* json_input) {
//         json_object* arr = json_tokener_parse(json_input);
//         int a = json_object_get_int(json_object_array_get_idx(arr, 0));
//         int b = json_object_get_int(json_object_array_get_idx(arr, 1));
//         json_object_put(arr);
//         int r = add(a, b);
//         char* out = (char*)std::malloc(32);
//         std::snprintf(out, 32, "%d", r);
//         return out;
//     }
//
// Class-method example (instantiates an object, calls a method):
//
//     class Calculator {
//     public:
//         long factorial(int n) {
//             long r = 1;
//             for (int i = 2; i <= n; i++) r *= i;
//             return r;
//         }
//     };
//
//     extern "C" char* regret_factorial(const char* json_input) {
//         json_object* o = json_tokener_parse(json_input);
//         int n = json_object_get_int(o);
//         json_object_put(o);
//         Calculator calc;
//         long r = calc.factorial(n);
//         char* out = (char*)std::malloc(32);
//         std::snprintf(out, 32, "%ld", r);
//         return out;
//     }
//
// Compile:
//     g++ -std=c++17 -O2 -rdynamic -o regret_runner
//         regret_harness.cpp user.cpp adapter.cpp
//         -lcrypto -ljson-c -ldl -lm
//
// Run:
//     ./regret_runner capture   --manifest regrets/manifest.json
//     ./regret_runner validate  --manifest regrets/manifest.json

#ifndef REGRET_HPP
#define REGRET_HPP

// C++ adapters must use extern "C" linkage so dlsym can find them.
// The function pointer typedef is in C linkage for portability.
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
//   - C++ exceptions thrown by the adapter or the called function
//     will be caught by the harness and treated as a skip (matching
//     the JS "throws" trivial-input guard behavior).
typedef char* (*regret_entry_fn)(const char* json_input);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // REGRET_HPP
