# C Stack Variant

Regression fingerprinting for C projects using a JSON-in/JSON-out adapter
convention and `dlsym` symbol lookup at runtime.

## Status: Working (v1)

Capture + validate are both implemented and verified end-to-end against
`proof/c/`. Cross-stack fingerprint parity with JS/Python is verified by
`proof/c/verify-parity.mjs` — the C harness produces byte-identical
7-char base36 hashes to `fingerprint.js` for the same (input, output) pair.

**Scope of v1:**
- ✅ Capture: invoke entry functions via `dlsym(RTLD_DEFAULT, ...)`,
  compute fingerprint, write `.regret` file with standard format.
- ✅ Validate: re-invoke entry with the same INPUT, compare hash, report
  PASS/FAIL with non-zero exit on failure.
- ✅ Cross-stack parity: identical 7-char base36 fingerprint for the same
  (input, output) pair.
- ✅ Trivial-input guard: null/NULL output → skip cluster (matches JS behavior).
- ❌ Callee wrapping (depth-1 contract chaining) — not implemented.
- ❌ Auto-discovery via `regret install` — manifest must be hand-written.
- ❌ `regret update` — not wired for C v1.

---

## Quick Start

```bash
# 1. Write your pure C functions
# 2. Write a regret_adapter.c with one entry function per cluster
#    (signature: char* <entry>(const char* json_input))
# 3. Add C clusters to regrets/manifest.json
# 4. Capture
C_SOURCES="src/my_math.c:regret_adapter.c" C_INCLUDE="src" bash scripts/capture_c.sh
# 5. Validate
C_SOURCES="src/my_math.c:regret_adapter.c" C_INCLUDE="src" bash scripts/validate_c.sh
```

Or via the unified CLI (auto-detects `stack: "c"` clusters):

```bash
C_SOURCES="src/my_math.c:regret_adapter.c" C_INCLUDE="src" regret capture
C_SOURCES="src/my_math.c:regret_adapter.c" C_INCLUDE="src" regret validate
```

---

## The JSON-in/JSON-out Adapter Convention

C has no runtime reflection. Regrets handles this by requiring the user to
provide one **adapter function** per cluster with the signature:

```c
char* <entry>(const char* json_input);
```

- **input**: NUL-terminated JSON string. Caller owns the buffer; do not free.
- **output**: malloc'd NUL-terminated JSON string. Caller frees with `free()`.
- Return `NULL` to trigger the trivial-input skip guard.

The harness looks up the entry symbol via `dlsym(RTLD_DEFAULT, ...)` at
runtime, so the adapter function must be linked into the same executable
as the harness. The adapter's job is to:
1. Parse the JSON input (using json-c, available because the harness links it)
2. Call the user's pure C function with the parsed arguments
3. Serialize the result back as a JSON string
4. Return the JSON string (malloc'd)

### Example adapter

```c
// my_math.c — user's pure functions
int add(int a, int b) { return a + b; }

// regret_adapter.c — bridges JSON ↔ C function calls
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <json-c/json.h>
#include "regret.h"

char* regret_add(const char* json_input) {
    json_object* arr = json_tokener_parse(json_input);
    int a = (int)json_object_get_int(json_object_array_get_idx(arr, 0));
    int b = (int)json_object_get_int(json_object_array_get_idx(arr, 1));
    json_object_put(arr);

    int r = add(a, b);
    char* out = malloc(32);
    snprintf(out, 32, "%d", r);
    return out;
}
```

---

## Manifest Schema for C Clusters

```json
{
  "clusters": [
    {
      "id": "add",
      "stack": "c",
      "entry": "regret_add",
      "fingerprintLevel": "entry",
      "watches": ["add"],
      "inputs": [[2, 3]],
      "description": "Integer addition"
    },
    {
      "id": "fibonacci",
      "stack": "c",
      "entry": "regret_fibonacci",
      "fingerprintLevel": "entry",
      "watches": ["fibonacci"],
      "inputs": [10],
      "description": "10th Fibonacci number"
    }
  ]
}
```

### C-Specific Manifest Fields

| Field | Required | Description |
|-------|----------|-------------|
| `stack` | ✅ | Must be `"c"` |
| `entry` | ✅ | Symbol name of the adapter function (looked up via `dlsym`) |
| `inputs` | ✅ | Array of inputs. v1 uses the FIRST input only. |
| `watches` | ❌ | Informational — lists the user's pure functions. No callee contracts in v1. |
| `fingerprintLevel` | ❌ | Always `"entry"` in v1. |

### C-Specific Environment Variables

The bash orchestrators read these env vars to determine what to compile
and link:

| Variable | Required | Description |
|----------|----------|-------------|
| `C_SOURCES` | ❌ | Colon-separated list of additional `.c` files to compile into the runner (e.g., `"src/math.c:regret_adapter.c"`). The orchestrator also auto-discovers `regret_adapter.c` / `adapter.c` / `src/regret_adapter.c` in the project root if not already in the list. |
| `C_INCLUDE` | ❌ | Colon-separated `-I` include paths (e.g., `"src:include"`). |
| `C_LIBS` | ❌ | Colon-separated extra `-l` libraries (e.g., `"m:z"`). |
| `CC` | ❌ | C compiler (default: `gcc`). |

---

## How It Works

### Architecture

```
scripts/capture_c.sh / scripts/validate_c.sh     ← bash orchestrators
scripts/regret_c/regret.h                         ← public API header
scripts/regret_c/regret_harness.c                 ← single-file C harness
```

### Capture Flow

1. `capture_c.sh` reads env vars (`C_SOURCES`, `C_INCLUDE`, `C_LIBS`) and
   auto-discovers `regret_adapter.c` in the project root if not already
   listed.
2. Compiles `regret_harness.c` + user sources + adapter into a single
   executable `./.regret-c-build/regret_runner` with `-rdynamic -ldl`
   (so `dlsym(RTLD_DEFAULT, ...)` works for symbol lookup).
3. The runner reads `regrets/manifest.json`, filters clusters with
   `stack: "c"`.
4. For each cluster:
   - `dlsym(RTLD_DEFAULT, entry_symbol)` to look up the adapter function.
   - Serialize the cluster's INPUT (from `inputs[0]`) as a JSON string.
   - Call `entry(json_input)` → receive malloc'd JSON output string.
   - Apply trivial-input guard: NULL or `null` output → skip cluster.
   - Compute `fingerprint(input, output)` using the same algorithm as
     `fingerprint.js`:
     `sha256(stableStringify(input) + "|" + stableStringify(output))` →
     `BigInt(hex, 16).toString(36).slice(0, 7)`.
   - Write `<id>.regret` in the standard format.

### Validate Flow

1. Same compile step as capture.
2. Runner reads manifest + each `.regret` file.
3. For each cluster:
   - Parse `INPUT`, `OUTPUT`, `HASH` from the existing `.regret` file.
   - Re-invoke the entry with the parsed INPUT.
   - Recompute the fingerprint.
   - Compare to golden `HASH` — report PASS or FAIL with diff.
4. Exit with non-zero status if ANY cluster fails or is missing its
   `.regret` file.

---

## Fingerprint — Cross-Stack Parity

The C implementation produces identical fingerprints to the JS/Python
implementations for the same (input, output) pair. Verified by
`proof/c/verify-parity.mjs`:

```
$ node proof/c/verify-parity.mjs
Comparing JS fingerprint() vs C-produced HASH from .regret files:

✅ add            JS=13mxb0z  C=13mxb0z
✅ fibonacci      JS=587q30m  C=587q30m
✅ reverse        JS=1ky49hx  C=1ky49hx
✅ parse-csv      JS=8xifg6f  C=8xifg6f
✅ format-bytes   JS=4zbjvg6  C=4zbjvg6
```

### stableStringify Parity Notes

- Object keys are sorted lexicographically (via `qsort` over `strcmp`).
- Numbers: integers serialize as their decimal form; whole-valued doubles
  serialize as integers (matching JS `Number.toString()`); non-finite
  values produce sentinels `"__nan__"`, `"__infinity__"`,
  `"__neg_infinity__"` (matches `fingerprint.js` issue #322).
- Strings: standard JSON escaping (`\"`, `\\`, `\n`, etc.).
- Arrays: ordered, no sorting.
- The adapter is responsible for producing JSON-compatible output (numbers,
  strings, booleans, arrays, objects) — raw C structs must be serialized
  by the adapter before being returned.

---

## `.regret` File Format (Identical to JS/Python)

```
cluster: add
version: 1
fingerprint: 13mxb0z
captured: 2026-06-20T18:17:18.000000+00:00
watches: [demo_add]
entry: regret_add
stack: c
fingerprintLevel: entry
---
INPUT  [2,3]
OUTPUT 5
HASH   13mxb0z
```

All mandatory fields from the user contract are present:
`cluster`, `version`, `fingerprint`, `captured`, `INPUT`, `OUTPUT`, `HASH`.

---

## Pure Logic Extraction in C

Same principle as other stacks — extract pure business logic from
functions that have side effects:

```c
// ❌ BEFORE — side effects, hard to fingerprint
char* process_order(const Order* order) {
    save_to_database(order);              // side effect: DB
    send_email(order->email);             // side effect: network
    return format_receipt(order);
}

// ✅ AFTER — pure logic extracted
char* format_receipt(const Order* order) {
    /* pure function — deterministic for the same Order input */
    char* buf = malloc(128);
    snprintf(buf, 128, "Order #%d: $%.2f", order->id, order->total);
    return buf;
}

// Thin shell with side effects
char* process_order(const Order* order) {
    save_to_database(order);
    send_email(order->email);
    return format_receipt(order);  /* ← fingerprint this via adapter */
}
```

### Rules for C Pure Logic Extraction

1. **Never fingerprint functions that do I/O** — `printf`, `fopen`,
   `read`, `write`, `socket`, DB calls go in the shell.
2. **Never fingerprint functions that use `time()` or `rand()`** — pass
   time/randomness as parameters.
3. **Logic modules must have zero includes of**: `stdio.h` (for output),
   `stdlib.h` (for `system`/`getenv`), `unistd.h` (for filesystem/pipe),
   `sys/socket.h`, `mysql.h`, or any I/O header.
4. **Logic functions take all data as parameters** — no `static` mutable
   state, no globals.
5. **For stateful computations** — return the full state as a malloc'd
   struct, don't mutate the input.
6. **Adapter functions are NOT pure** — they do JSON parsing and string
   allocation, but they wrap pure user functions. The fingerprint
   captures the user function's I/O contract, not the adapter's.

---

## Running the Working Example

```bash
$ cd proof/c
$ C_SOURCES="$(pwd)/demo_math.c:$(pwd)/regret_adapter.c" \
    C_INCLUDE="$(pwd)" \
    bash ../../scripts/capture_c.sh

📡 Capturing C cluster: add
   ✅ Fingerprint: 13mxb0z
   📄 Saved: regrets/add.regret
...
Captured: 5  Skipped: 0  Failed: 0

$ C_SOURCES="$(pwd)/demo_math.c:$(pwd)/regret_adapter.c" \
    C_INCLUDE="$(pwd)" \
    bash ../../scripts/validate_c.sh

🔍 Validating C cluster: add
   ✅ PASS  (hash 13mxb0z)
...
Passed: 5  Failed: 0  Missing: 0
```

### Verifying PASS / FAIL behavior

The demo includes `demo_fibonacci(int n)` captured with input `10` →
output `55`. To verify the regression-detection contract, run
`demo-refactor-flow.sh`:

```bash
$ bash demo-refactor-flow.sh
📁 Backed up demo_math.c → /tmp/tmp.xxx

═══ Step 1: Capture ═══
...
═══ Step 2: Validate baseline (expect PASS) ═══
✅ Baseline PASS

═══ Step 3: Apply VALID refactor — fibonacci iterative → Binet's formula ═══
   ✅ fibonacci: iterative → Binet's formula (output preserved for n=10)

═══ Step 4: Validate after valid refactor (expect PASS) ═══
✅ Valid refactor PASS (output preserved, hash unchanged)

═══ Step 5: Apply BREAKING refactor — fibonacci becomes 1-indexed (n=10 → 89) ═══
   ✅ fibonacci: 0-indexed → 1-indexed (output CHANGED for n=10: 55 → 89)

═══ Step 6: Validate after breaking refactor (expect FAIL) ═══
✅ Breaking refactor correctly FAILed (exit 1)
```

---

## Dependencies

The C harness links against:

- **libcrypto (OpenSSL 3.x)** — for `SHA256()` and `BIGNUM` arithmetic
  (hex → base36 conversion).
- **libjson-c** — for JSON parsing/serialization of manifest and I/O values.
- **libdl (glibc)** — for `dlsym(RTLD_DEFAULT, ...)` symbol lookup.
- **libm** — for `floor`, `fabs` in stable stringify.

All are widely available on Linux. On Debian/Ubuntu:

```bash
sudo apt install gcc libssl-dev libjson-c-dev
```

---

## Limitations & Non-Goals (v1)

- **Callee wrapping** — there is no Ghost Proxy equivalent in C yet.
  The `watches` field is informational only; callee `.regret` files are
  NOT generated. Future work could use LD_PRELOAD / --wrap to intercept
  function calls.
- **Instance methods** — C has no classes; this concept doesn't apply.
- **Auto-discovery** — `regret install` does not yet detect C functions.
  Manifest must be hand-written.
- **Multiple inputs** — v1 captures only the first input from `inputs[]`.
  The JS stack supports per-input `.regret` contracts (issue #315); this
  could be added to C in a follow-up.
- **`regret update`** — not yet wired for C. To refresh a golden contract,
  delete the `.regret` file and re-capture.
- **Static linking** — the runner uses `-rdynamic` so `dlsym` can find
  user symbols. Static-only builds would require a different lookup
  mechanism (e.g., a registry of function pointers).
- **Cross-platform** — only tested on Linux. macOS should work (libcrypto
  via brew, json-c via brew). Windows would need porting (no `dlsym`,
  no `open_memstream`).

---

## CI Integration

`regret validate` exits non-zero on any failure. For GitHub Actions:

```yaml
- name: Install dependencies
  run: sudo apt install gcc libssl-dev libjson-c-dev
- name: Build
  run: make
- name: Capture regret contracts
  env:
    C_SOURCES: src/my_math.c:regret_adapter.c
    C_INCLUDE: src
  run: regret capture
- name: Validate after refactor
  env:
    C_SOURCES: src/my_math.c:regret_adapter.c
    C_INCLUDE: src
  run: regret validate
```

---

## Real-World Usage

For a real C project, point the manifest at your adapter's entry symbols:

```json
{
  "clusters": [{
    "id": "normalize-phone",
    "stack": "c",
    "entry": "regret_normalize_phone",
    "inputs": ["+1 (555) 123-4567"]
  }]
}
```

And write the adapter:

```c
// regret_adapter.c
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <json-c/json.h>
#include "regret.h"
#include "phone_utils.h"  /* declares normalize_phone() */

char* regret_normalize_phone(const char* json_input) {
    json_object* o = json_tokener_parse(json_input);
    const char* input = json_object_get_string(o);
    char* normalized = normalize_phone(input);  /* user's pure function */
    json_object_put(o);

    json_object* out = json_object_new_string(normalized);
    free(normalized);
    const char* s = json_object_to_json_string_ext(out, JSON_C_TO_STRING_PLAIN);
    char* result = strdup(s);
    json_object_put(out);
    return result;
}
```

Set the env vars and run:

```bash
C_SOURCES="src/phone_utils.c:regret_adapter.c" C_INCLUDE="src" \
    regret capture
```
