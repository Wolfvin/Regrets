# C++ Stack Variant

Regression fingerprinting for C++ projects using a JSON-in/JSON-out
adapter convention and `dlsym` symbol lookup at runtime, with C++
exception safety.

## Status: Working (v1)

Capture + validate are both implemented and verified end-to-end against
`proof/cpp/`. Cross-stack fingerprint parity with JS/Python/C is verified
by `proof/cpp/verify-parity.mjs` — the C++ harness produces byte-identical
7-char base36 hashes to `fingerprint.js` for the same (input, output) pair.

**Scope of v1:**
- ✅ Capture: invoke entry functions via `dlsym(RTLD_DEFAULT, ...)`,
  compute fingerprint, write `.regret` file with standard format.
- ✅ Validate: re-invoke entry with the same INPUT, compare hash, report
  PASS/FAIL with non-zero exit on failure.
- ✅ Cross-stack parity: identical 7-char base36 fingerprint for the same
  (input, output) pair.
- ✅ Trivial-input guard: NULL/null output → skip cluster during capture
  (matches JS behavior).
- ✅ **C++ exception safety**: C++ exceptions thrown by adapter or user
  code are caught by the harness. During capture → SKIP (matching JS
  "throws" guard). During validate → FAIL (regression — function used to
  work, now throws).
- ✅ Class-method support: adapters can instantiate C++ classes and call
  instance methods (demonstrated in `proof/cpp/regret_adapter.cpp`).
- ✅ STL serialization: adapters can return `std::string`, `std::vector`,
  `std::map` etc. by serializing them to JSON via json-c.
- ✅ **Issue #315 multi-input contract**: capture writes an `INPUTS` line
  for multi-input clusters (inputs 1+); validate re-runs every manifest
  input and FAILs the cluster if ANY golden hash mismatches (parity with
  JS / React / Perl / Bash). Single-input clusters have zero overhead
  (INPUTS line omitted).
- ✅ **`regret update` mode**: refreshes HASH + OUTPUT + INPUTS line
  atomically when behavior intentionally changes, and appends a
  chain-hashed audit.log entry (parity with JS / Python / Bash / Perl).
  Requires `--cluster <id> --reason "<≥4 words>"`.
- ❌ Callee wrapping (depth-1 contract chaining) — not implemented.
- ❌ Auto-discovery via `regret install` — manifest must be hand-written.

---

## Quick Start

```bash
# 1. Write your pure C++ functions (free functions or class methods)
# 2. Write a regret_adapter.cpp with one entry function per cluster
#    (signature: extern "C" char* <entry>(const char* json_input))
# 3. Add C++ clusters to regrets/manifest.json with "stack": "cpp"
# 4. Capture
CPP_SOURCES="src/my_math.cpp:regret_adapter.cpp" CPP_INCLUDE="src" \
    bash scripts/capture_cpp.sh
# 5. Validate (after refactoring)
CPP_SOURCES="src/my_math.cpp:regret_adapter.cpp" CPP_INCLUDE="src" \
    bash scripts/validate_cpp.sh
```

Or via the unified CLI (auto-detects `stack: "cpp"` clusters):

```bash
CPP_SOURCES="src/my_math.cpp:regret_adapter.cpp" CPP_INCLUDE="src" regret capture
CPP_SOURCES="src/my_math.cpp:regret_adapter.cpp" CPP_INCLUDE="src" regret validate
# Update (after intentionally changing behavior) — refreshes .regret + appends audit.log entry
CPP_SOURCES="src/my_math.cpp:regret_adapter.cpp" CPP_INCLUDE="src" \
    regret update <cluster-id> --reason "describe what changed and why, at least 4 words"
```

---

## The JSON-in/JSON-out Adapter Convention

C++ has no runtime reflection. Regrets handles this by requiring the user
to provide one **adapter function** per cluster with `extern "C"` linkage:

```cpp
extern "C" char* <entry>(const char* json_input);
```

- **input**: NUL-terminated JSON string. Caller owns the buffer; do not free.
- **output**: malloc'd NUL-terminated JSON string. Caller frees with `free()`.
- Return `NULL` to trigger the trivial-input skip guard during capture.
- **C++ exceptions** thrown by the adapter or called C++ functions are
  caught by the harness (do not let them propagate — but if they do, the
  harness handles them gracefully).
- The `extern "C"` linkage is REQUIRED so that `dlsym` can find the
  symbol without C++ name mangling.

The harness looks up the entry symbol via `dlsym(RTLD_DEFAULT, ...)` at
runtime, so the adapter function must be linked into the same executable
as the harness. The adapter's job is to:
1. Parse the JSON input (using json-c, available because the harness links it)
2. Call the user's pure C++ function (free function or class method)
3. Serialize the result back as a JSON string
4. Return the JSON string (malloc'd)

### Example: free function adapter

```cpp
// my_math.cpp — user's pure functions
#include <string>
#include <algorithm>

std::string reverse(const std::string& s) {
    return std::string(s.rbegin(), s.rend());
}

// regret_adapter.cpp — bridges JSON ↔ C++ function calls
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <json-c/json.h>
#include "regret.hpp"

extern "C" char* regret_reverse(const char* json_input) {
    json_object* o = json_tokener_parse(json_input);
    const char* s = json_object_get_string(o);
    std::string reversed = reverse(std::string(s));
    json_object_put(o);

    json_object* out = json_object_new_string(reversed.c_str());
    const char* json_str = json_object_to_json_string_ext(out, JSON_C_TO_STRING_PLAIN);
    char* result = static_cast<char*>(std::malloc(std::strlen(json_str) + 1));
    std::strcpy(result, json_str);
    json_object_put(out);
    return result;
}
```

### Example: class-method adapter

```cpp
// my_math.cpp
class MathUtils {
public:
    long factorial(int n) const {
        long r = 1;
        for (int i = 2; i <= n; i++) r *= i;
        return r;
    }
};

// regret_adapter.cpp
extern "C" char* regret_factorial(const char* json_input) {
    json_object* o = json_tokener_parse(json_input);
    int n = json_object_get_int(o);
    json_object_put(o);

    MathUtils calc;             // instantiate class
    long r = calc.factorial(n); // call method

    char* out = static_cast<char*>(std::malloc(32));
    std::snprintf(out, 32, "%ld", r);
    return out;
}
```

---

## Manifest Schema for C++ Clusters

```json
{
  "clusters": [
    {
      "id": "reverse",
      "stack": "cpp",
      "entry": "regret_reverse",
      "fingerprintLevel": "entry",
      "watches": ["reverse"],
      "inputs": ["Hello, World!"],
      "description": "Reverse a string via std::string"
    },
    {
      "id": "factorial",
      "stack": "cpp",
      "entry": "regret_factorial",
      "fingerprintLevel": "entry",
      "watches": ["MathUtils::factorial"],
      "inputs": [5],
      "description": "Class-method example: MathUtils.factorial(5) = 120"
    }
  ]
}
```

### C++-Specific Manifest Fields

| Field | Required | Description |
|-------|----------|-------------|
| `stack` | ✅ | Must be `"cpp"` |
| `entry` | ✅ | Symbol name of the adapter function (looked up via `dlsym`). Must have `extern "C"` linkage. |
| `inputs` | ✅ | Array of inputs. v1 uses the FIRST input only. |
| `watches` | ❌ | Informational — lists the user's pure functions/methods. No callee contracts in v1. |
| `fingerprintLevel` | ❌ | Always `"entry"` in v1. |

### C++-Specific Environment Variables

The bash orchestrators read these env vars to determine what to compile
and link:

| Variable | Required | Description |
|----------|----------|-------------|
| `CPP_SOURCES` | ❌ | Colon-separated list of additional `.cpp`/`.cc`/`.cxx` files to compile into the runner. The orchestrator also auto-discovers `regret_adapter.cpp` / `regret_adapter.cc` / `adapter.cpp` / `src/regret_adapter.cpp` in the project root if not already in the list. |
| `CPP_INCLUDE` | ❌ | Colon-separated `-I` include paths. |
| `CPP_LIBS` | ❌ | Colon-separated extra `-l` libraries. |
| `CXX` | ❌ | C++ compiler (default: `g++`). |

---

## How It Works

### Architecture

```
scripts/capture_cpp.sh / scripts/validate_cpp.sh   ← bash orchestrators
scripts/regret_cpp/regret.hpp                       ← public API header
scripts/regret_cpp/regret_harness.cpp               ← single-file C++ harness
```

### Capture Flow

1. `capture_cpp.sh` reads env vars (`CPP_SOURCES`, `CPP_INCLUDE`,
   `CPP_LIBS`, `CXX`) and auto-discovers `regret_adapter.cpp` in the
   project root if not already listed.
2. Compiles `regret_harness.cpp` + user sources + adapter into a single
   executable `./.regret-cpp-build/regret_runner` with `-rdynamic -ldl`
   (so `dlsym(RTLD_DEFAULT, ...)` works for symbol lookup).
3. The runner reads `regrets/manifest.json`, filters clusters with
   `stack: "cpp"`.
4. For each cluster:
   - `dlsym(RTLD_DEFAULT, entry_symbol)` to look up the adapter function.
   - Serialize the cluster's INPUT (from `inputs[0]`) as a JSON string.
   - Call `entry(json_input)` inside a `try`/`catch(...)` block — if the
     adapter throws a C++ exception, treat as a SKIP (matching JS "throws"
     trivial-input guard).
   - Apply trivial-input guard: NULL or `null` output → skip cluster.
   - Compute `fingerprint(input, output)` using the same algorithm as
     `fingerprint.js`:
     `sha256(stableStringify(input) + "|" + stableStringify(output))` →
     `BIGNUM(hex, 16).toString(36).slice(0, 7)` (using OpenSSL BIGNUM).
   - Write `<id>.regret` in the standard format.

### Validate Flow

1. Same compile step as capture.
2. Runner reads manifest + each `.regret` file.
3. For each cluster:
   - Parse `INPUT`, `OUTPUT`, `HASH` from the existing `.regret` file.
   - Re-invoke the entry with the parsed INPUT inside a `try`/`catch(...)`.
   - **If the adapter throws a C++ exception during validate**, treat as a
     FAIL (the function used to work, now it throws — that's a regression).
   - Recompute the fingerprint.
   - Compare to golden `HASH` — report PASS or FAIL with diff.
4. Exit with non-zero status if ANY cluster fails or is missing its
   `.regret` file.

---

## C++ Exception Safety — Key Differentiator from C Stack

The C++ harness wraps every adapter invocation in a `try`/`catch(...)`
block. This means:

- **C++ exceptions are never fatal to the harness** — they're caught and
  reported as either SKIP (capture mode) or FAIL (validate mode).
- **User code can freely use exceptions** for error handling without
  worrying about crashing the regression test runner.
- **Class destructors run normally** when exceptions propagate through
  adapter frames, thanks to RAII.

### Behavior matrix

| Scenario | Capture mode | Validate mode |
|---|---|---|
| Adapter returns valid JSON | ✅ Write .regret | ✅ Compare hash |
| Adapter returns NULL | ⏭️ SKIP (trivial guard) | ❌ FAIL (regression — used to work) |
| Adapter returns invalid JSON | ❌ FAIL | ❌ FAIL |
| Adapter throws C++ exception | ⏭️ SKIP (trivial guard, matches JS) | ❌ FAIL (regression) |
| Adapter returns `null` JSON | ⏭️ SKIP (trivial guard) | ❌ FAIL (regression) |

This is the key difference from the C stack (PR #378) — C has no
exceptions, so a `longjmp`/`setjmp` or signal-based approach would be
needed for analogous safety. C++ gets this for free with `try`/`catch`.

---

## Fingerprint — Cross-Stack Parity

The C++ implementation produces identical fingerprints to the JS/Python/C
implementations for the same (input, output) pair. Verified by
`proof/cpp/verify-parity.mjs`:

```
$ node proof/cpp/verify-parity.mjs
Comparing JS fingerprint() vs C++-produced HASH from .regret files:

✅ add              JS=13mxb0z  C++=13mxb0z
✅ fibonacci        JS=587q30m  C++=587q30m
✅ reverse          JS=1ky49hx  C++=1ky49hx
✅ parse-csv-line   JS=8xifg6f  C++=8xifg6f
✅ format-bytes     JS=4zbjvg6  C++=4zbjvg6
✅ factorial        JS=3hf11ck  C++=3hf11ck
✅ gcd              JS=1ngkurw  C++=1ngkurw
✅ is-palindrome    JS=d45e16p  C++=d45e16p
```

The 5 free-function clusters also match the C and Java stacks'
`proof/c/` and `proof/java/` output byte-for-byte — same algorithm,
same hashes, four independent implementations (JS / Java / C / C++).

---

## `.regret` File Format (Identical to JS/Python/C)

```
cluster: factorial
version: 1
fingerprint: 3hf11ck
captured: 2026-06-21T04:31:25.000000+00:00
watches: [MathUtils::factorial]
entry: regret_factorial
stack: cpp
fingerprintLevel: entry
---
INPUT  5
OUTPUT 120
HASH   3hf11ck
```

All mandatory fields from the user contract are present:
`cluster`, `version`, `fingerprint`, `captured`, `INPUT`, `OUTPUT`, `HASH`.

### Issue #315 — Multi-input `INPUTS` line (parity with JS/React/Perl/Bash)

When a cluster has more than one input in its `inputs` array, the harness
additionally captures an `INPUTS` line containing entries for **inputs 1+**
(the first input is already represented by the top-level `INPUT`/`OUTPUT`/`HASH`
trio — omitting it avoids duplication). Each entry is a JSON object with
`input`, `output`, and `hash` fields:

```
cluster: reverse
version: 1
fingerprint: 5nssd6s
captured: 2026-06-21T08:59:27.000000+00:00
watches: [reverse]
entry: regret_reverse
stack: cpp
fingerprintLevel: entry
---
INPUT  "hello"
OUTPUT "olleh"
HASH   5nssd6s
INPUTS [{"input":"Regrets","output":"stergeR","hash":"h0sx12s"},{"input":"abc123","output":"321cba","hash":"15k5072"}]
```

**Behavior:**
- **Single-input clusters** (`inputs.length === 1`): `INPUTS` line is **OMITTED**
  (no overhead for the common case).
- **Multi-input clusters** (`inputs.length > 1`): `INPUTS` line contains
  `inputs.slice(1)` entries. Inputs that throw or return null are silently
  omitted (preserves the trivial-input guard semantics — re-capture to opt in).
- **Validate**: when an `INPUTS` line is present, the harness re-runs EVERY
  manifest input (matched by VALUE via `stable_stringify`), computes its live
  hash, and compares against the golden hash. If ANY golden input's live hash
  differs from its stored hash, the cluster **FAILs** — even when the first
  input's hash still matches. This catches subtle breaking changes that would
  otherwise be invisible (false GREEN).
- **Backward compatibility**: old `.regret` files without an `INPUTS` line
  still validate (only the top-level hash is checked). Re-capture to opt in
  to the multi-input contract.

---

## Pure Logic Extraction in C++

Same principle as other stacks — extract pure business logic from
functions that have side effects:

```cpp
// ❌ BEFORE — side effects, hard to fingerprint
std::string process_order(const Order& order) {
    save_to_database(order);              // side effect: DB
    send_email(order.email);              // side effect: network
    return format_receipt(order);
}

// ✅ AFTER — pure logic extracted
std::string format_receipt(const Order& order) {
    // pure function — deterministic for the same Order input
    char buf[128];
    std::snprintf(buf, sizeof(buf), "Order #%d: $%.2f",
                  order.id, order.total);
    return std::string(buf);
}

// Thin shell with side effects
std::string process_order(const Order& order) {
    save_to_database(order);
    send_email(order.email);
    return format_receipt(order);  // ← fingerprint this via adapter
}
```

### Rules for C++ Pure Logic Extraction

1. **Never fingerprint functions that do I/O** — `std::cout`, `std::ofstream`,
   `socket`, `recv`, DB calls go in the shell.
2. **Never fingerprint functions that use `std::time()` or `std::rand()`** —
   pass time/randomness as parameters.
3. **Logic modules must have zero includes of**: `<iostream>` (for output),
   `<fstream>`, `<cstdio>` (for output), `<sys/socket.h>`, `<mysql.h>`,
   or any I/O header.
4. **Logic functions take all data as parameters** — no `static` mutable
   state, no globals, no singleton instance state.
5. **For stateful computations** — return the full state as a struct/value,
   don't mutate the input.
6. **Adapter functions are NOT pure** — they do JSON parsing and string
   allocation, but they wrap pure user functions. The fingerprint
   captures the user function's I/O contract, not the adapter's.
7. **C++ exceptions are allowed in pure functions** — the harness catches
   them. But prefer `std::optional`/`std::expected` for expected errors;
   reserve exceptions for truly exceptional cases.

---

## Running the Working Example

```bash
$ cd proof/cpp
$ CPP_SOURCES="$(pwd)/demo_math.cpp:$(pwd)/regret_adapter.cpp" \
    CPP_INCLUDE="$(pwd)" \
    bash ../../scripts/capture_cpp.sh

📡 Capturing C++ cluster: add
   ✅ Fingerprint: 13mxb0z
   📄 Saved: regrets/add.regret
...
Captured: 8  Skipped: 0  Failed: 0

$ CPP_SOURCES="$(pwd)/demo_math.cpp:$(pwd)/regret_adapter.cpp" \
    CPP_INCLUDE="$(pwd)" \
    bash ../../scripts/validate_cpp.sh

🔍 Validating C++ cluster: add
   ✅ PASS  (hash 13mxb0z)
...
Passed: 8  Failed: 0  Missing: 0

$ node ../verify-parity.mjs   # cross-stack parity check
$ bash demo-refactor-flow.sh  # end-to-end PASS/FAIL demo
```

### The 8 demo clusters

| ID | Type | Input | Output | Hash | Notes |
|---|---|---|---|---|---|
| `add` | free fn | `[2, 3]` | `5` | `13mxb0z` | Same hash as C/Java/JS |
| `fibonacci` | free fn | `10` | `55` | `587q30m` | Throws on negative input |
| `reverse` | free fn | `"Hello, World!"` | `"!dlroW ,olleH"` | `1ky49hx` | Uses `std::string` |
| `parse-csv-line` | free fn | CSV string | `["hello, world","42","quoted, field"]` | `8xifg6f` | Returns `std::vector<std::string>` |
| `format-bytes` | free fn | `1073741824` | `"1.00 GiB"` | `4zbjvg6` | Uses `std::snprintf` |
| `factorial` | class method | `5` | `120` | `3hf11ck` | `MathUtils::factorial` |
| `gcd` | class method | `[48, 36]` | `12` | `1ngkurw` | `MathUtils::gcd`, multi-arg |
| `is-palindrome` | class method | `"A man, a plan, a canal: Panama"` | `true` | `d45e16p` | Returns `bool` |

---

## Dependencies

The C++ harness links against the same libraries as the C harness:

- **libcrypto (OpenSSL 3.x)** — for `SHA256()` and `BIGNUM` arithmetic
  (hex → base36 conversion).
- **libjson-c** — for JSON parsing/serialization of manifest and I/O values.
- **libdl (glibc)** — for `dlsym(RTLD_DEFAULT, ...)` symbol lookup.
- **libm** — for `floor`, `fabs` in stable stringify.

Plus the C++ standard library (libstdc++) — automatically linked by g++.

On Debian/Ubuntu:

```bash
sudo apt install g++ libssl-dev libjson-c-dev
```

---

## Comparison with C Stack (PR #378)

| Feature | C stack | C++ stack |
|---|---|---|
| Compiler | gcc | g++ |
| Harness language | C | C++ |
| Exception safety | ❌ (no exceptions in C) | ✅ try/catch in harness |
| Adapter signature | `char* <entry>(const char*)` | `extern "C" char* <entry>(const char*)` |
| Class methods | ❌ (no classes in C) | ✅ (adapter instantiates class) |
| STL containers | ❌ | ✅ (adapter serializes to JSON) |
| RAII | ❌ | ✅ (smart pointers, destructors) |
| Fingerprint parity | ✅ JS / Python / C / C++ | ✅ JS / Python / C / C++ |
| Dependencies | libcrypto + libjson-c + libdl + libm | same + libstdc++ |

The C++ stack is a superset of C functionality — anyone using the C
stack could migrate to C++ by:
1. Renaming source files from `.c` to `.cpp`
2. Adding `extern "C"` to adapter functions
3. Recompiling with `g++` instead of `gcc`

The fingerprint hashes are identical because the algorithm is the same.

---

## Limitations & Non-Goals (v1)

- **Callee wrapping** — there is no Ghost Proxy equivalent in C++ yet.
  The `watches` field is informational only; callee `.regret` files are
  NOT generated. Future work could use LD_PRELOAD / --wrap to intercept
  function calls.
- **Auto-discovery** — `regret install` does not yet detect C++ functions.
  Manifest must be hand-written. Future work could use libclang for AST
  traversal.
- **Multiple inputs** — v1 captures only the first input from `inputs[]`.
  The JS stack supports per-input `.regret` contracts (issue #315); this
  could be added to C++ in a follow-up.
- **`regret update`** — ✅ wired as of the update-mode parity pass
  (mirrors JS / Python / Bash / Perl). See "Update Mode" section below.
- **Template metaprogramming introspection** — templates must be
  instantiated by the user in their adapter; the harness has no way to
  discover template instantiations automatically.
- **Cross-platform** — only tested on Linux. macOS should work (libcrypto
  via brew, json-c via brew). Windows would need porting (no `dlsym`,
  no `open_memstream`).
- **Static linking** — the runner uses `-rdynamic` so `dlsym` can find
  user symbols. Static-only builds would require a different lookup
  mechanism (e.g., a registry of function pointers).

---

## CI Integration

`regret validate` exits non-zero on any failure. For GitHub Actions:

```yaml
- name: Install dependencies
  run: sudo apt install g++ libssl-dev libjson-c-dev
- name: Build
  run: cmake --build build
- name: Capture regret contracts
  env:
    CPP_SOURCES: src/my_math.cpp:regret_adapter.cpp
    CPP_INCLUDE: src
  run: regret capture
- name: Validate after refactor
  env:
    CPP_SOURCES: src/my_math.cpp:regret_adapter.cpp
    CPP_INCLUDE: src
  run: regret validate
```

---

## Update Mode — `regret update` (parity with JS / Python / Bash / Perl)

When you intentionally change a cluster's behavior (e.g., tax-rate update,
rebranding, schema change), run `regret update` to refresh the `.regret`
file's HASH + OUTPUT + INPUTS line atomically AND append a chain-hashed
entry to `regrets/audit.log`.

### Usage

```bash
# Unified CLI (auto-detects stack: "cpp" from manifest):
CPP_SOURCES="src/my_math.cpp:regret_adapter.cpp" CPP_INCLUDE="src" \
    regret update <cluster-id> --reason "describe what changed and why, at least 4 words"

# Direct harness invocation:
bash scripts/validate_cpp.sh update --cluster <id> \
    --reason "describe what changed and why, at least 4 words" \
    --manifest regrets/manifest.json
```

### What it does

1. **Validates `--reason`** — must be ≥4 words (parity with JS validate.js).
   Vague reasons like `"fix bug"` are rejected with an error.
2. **Re-runs the cluster's entry** on `inputs[0]` → new hash + new output
   for the top-level `INPUT/OUTPUT/HASH` lines.
3. **Re-runs `inputs[1+]`** → rebuilds the `INPUTS` line with refreshed
   per-input hashes (Issue #315 contract).
4. **Rewrites the `.regret` file** with the new `fingerprint`, `captured`
   timestamp, `OUTPUT`, `HASH`, and `INPUTS` lines (the meta block
   `cluster/version/watches/entry/stack/fingerprintLevel` is preserved).
5. **Appends an audit.log entry** at `regrets/audit.log` with this format:

   ```
   <ISO-8601 timestamp>  UPDATE  <clusterId>
     old: <oldHash>
     new: <newHash>
     reason: <safeReason>
     by: AI refactor session
     gitAuthor: <name> <<email>>   (best-effort, optional)
     gitSha: <short-sha>           (best-effort, optional)
     ciRunId: <run-id>             (best-effort, optional)
     chain: <7-hex-sha256-prefix>
   ```

6. **Chain hash** = `sha256(prevChain + entryContent)[:7]` where
   `prevChain` is the chain hash of the previous audit.log entry (or
   `"0000000"` for the genesis entry) and `entryContent` is the entry
   lines joined with `\n` (excluding the `chain:` line itself). This
   makes the audit.log tamper-evident: any modification to an entry
   invalidates all subsequent chain hashes.

### After update, `regret validate` PASSES

The `.regret` file now reflects the new behavior, so the next `validate`
run PASSES (no false-positive FAIL on the accepted change).

### Demo

See `proof/cpp_independent/run_update_demo.sh` for a full end-to-end
demonstration (capture → break → update → validate PASS → audit.log
chain-hash verification).

### Known parity gaps (cosmetic, not functional)

- **Timestamp format**: C++ uses `iso_now()` (e.g.,
  `2026-06-21T10:32:49.000000+00:00`); JS uses `new Date().toISOString()`
  (e.g., `2026-06-21T10:32:49.385Z`). The chain hashes will therefore
  differ between stacks for the same conceptual update — this is
  acceptable because the chain hash only needs to be self-consistent
  within a single audit.log file (each entry's chain depends on the
  previous one in the SAME file).

### Test coverage

`tests/cpp-stack-update-mode.test.js` (8 tests) verifies:
- rejects `update` without `--cluster`
- rejects `update` without `--reason`
- rejects `--reason` with fewer than 4 words
- refreshes `HASH` + `OUTPUT` + `INPUTS` + `captured` timestamp atomically
- appends audit.log entry with chain hash
- chain hash is independently verifiable via `node:crypto`'s `sha256`
- second update's chain hash correctly chains from the first entry
- after update, `validate` PASSES for the accepted new behavior
  (including INPUTS line refresh + cross-stack fingerprint parity)

