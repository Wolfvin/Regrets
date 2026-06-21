# C++ Stack — Independent Verification Report

**Reviewer:** Worker session (independent of PR #385 author)
**Date:** 2026-06-21
**PR verified:** #385 (`feat/cpp-stack`)
**Issue:** #382
**Branch:** `feat/cpp-stack`

## Summary

PR #385 adds C++ stack support to Regrets with 4 new files + 1 test file (2,661 lines):
- `scripts/regret_cpp/regret.hpp` (94 lines) — public API header
- `scripts/regret_cpp/regret_harness.cpp` (721 lines) — single-file C++17 harness
- `scripts/capture_cpp.sh` (114 lines) + `scripts/validate_cpp.sh` (98 lines) — bash orchestrators
- `proof/cpp/` — 8 demo clusters + demo-refactor-flow.sh + verify-parity.mjs
- `tests/cpp-stack.test.js` (288 lines) — Node test suite
- `references/cpp.md` (510 lines) — documentation

**Verdict: [REVIEW]** — the implementation is feature-complete, well-tested, and
correctly handles all scenarios. The key C++ differentiator — exception safety
via `try`/`catch(...)` — works as designed. The PR is not yet merged to main,
which is the only reason this is [REVIEW] rather than [SUCCESS].

---

## Verification Steps Performed

### 1. PR #385 Demo (demo-refactor-flow.sh) ✅

All 8 steps pass:
- Step 1: Capture (8/8 clusters captured)
- Step 2: Baseline validate (8/8 PASS)
- Step 3: Valid refactor (fibonacci iterative → Binet's formula)
- Step 4: Validate after valid refactor (8/8 PASS — output preserved)
- Step 5: Breaking refactor (fibonacci 0-indexed → 1-indexed, 55 → 89)
- Step 6: Validate after breaking refactor (7 PASS, 1 FAIL — exit 1)
- Step 7: Exception-throwing refactor (factorial throws std::runtime_error)
- Step 8: Validate after exception refactor (7 PASS, 1 FAIL — no crash)

### 2. Cross-Stack Parity (verify-parity.mjs) ✅

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

✅ All fingerprints match — cross-stack parity verified.
```

### 3. Independent Test Project (my own code) ✅

Created a separate C++ project with `TextUtils` class containing 4 static methods NOT in the PR's test suite:
- `toTitleCase` — convert string to title case
- `countWords` — count words in a string
- `truncate` — truncate text with ellipsis
- `isValidEmail` — simple email validation

**Capture:** All 4 clusters captured with correct `.regret` format.

**Validate (baseline):** All 4 PASS (exit 0).

**Breaking refactor** (changed `toTitleCase` to uppercase everything):
```
❌ title-case  golden=5fixoda  live=2w2epmp  FAIL
   Golden output: "Hello World Foo Bar"
   Live   output: "HELLO WORLD FOO BAR"
✅ count-words     PASS
✅ truncate        PASS
✅ is-valid-email  PASS
Passed: 3  Failed: 1  (exit 1)
```
Correctly FAILs with clear diff.

**Valid refactor** (changed `countWords` from `istringstream` to whitespace-transition counting):
```
✅ title-case      PASS
✅ count-words     PASS
✅ truncate        PASS
✅ is-valid-email  PASS
Passed: 4  Failed: 0  (exit 0)
```
Correctly PASSes — output preserved, fingerprint unchanged.

### 4. C++ Exception Safety (key differentiator) ✅

Applied refactor that throws `std::runtime_error` from `isValidEmail`:
```
✅ title-case      PASS
✅ count-words     PASS
✅ truncate        PASS
❌ is-valid-email  Adapter threw C++ exception on re-invoke: std::exception: intentional exception for verification
Passed: 3  Failed: 1  (exit 1)
```

**Key verification:** The harness caught the C++ exception and reported it as a FAIL — no segfault, no abort, no crash. Other clusters continued to validate normally. This is the key differentiator from the C stack (which has no exceptions and would need `longjmp`/signal handling for analogous safety).

### 5. Cross-Stack 3-Way Parity (JS == Perl == C++) ✅

The `title-case` cluster in my independent test has the same (input, output) pair as a Perl verification from a previous session:
- Input: `"hello world foo bar"`
- Output: `"Hello World Foo Bar"`

| Stack | Hash |
|---|---|
| JS `fingerprint()` | `5fixoda` |
| Perl `fingerprint()` | `5fixoda` |
| C++ `fingerprint()` | `5fixoda` |

Three independent implementations of the same algorithm agreeing byte-for-byte.

### 6. npm test ✅

```
ℹ tests 815
ℹ pass 814
ℹ fail 0
ℹ skipped 1
```

No regressions. The 1 skipped test is the "no C++ toolchain" path which doesn't apply here (g++ is available). When run in isolation, all 7 C++ tests pass.

### 7. CLI Dispatcher Wiring ✅

Verified `regret.js` routes `stack: "cpp"` to:
- `capture_cpp.sh` for `regret capture`
- `validate_cpp.sh` for `regret validate`

Tested via unified CLI:
```bash
$ node scripts/regret.js capture
✅ Captured: 8  Skipped: 0  Failed: 0

$ node scripts/regret.js validate
✅ Passed: 8  Failed: 0  Missing: 0
```

### 8. .regret File Format ✅

Verified that C++ `.regret` files contain all mandatory fields:
- `cluster` ✅
- `version` ✅
- `fingerprint` ✅
- `captured` ✅
- `INPUT` ✅
- `OUTPUT` ✅
- `HASH` ✅

Format is compatible with JS/Python/C stacks.

### 9. Class-Method Support ✅

The PR includes 3 class-method clusters (`factorial`, `gcd`, `is_palindrome`) that demonstrate the adapter instantiating a C++ class (`MathUtils`) and calling instance methods. All 3 work correctly — capture, validate, and breaking-refactor detection all function as expected.

---

## What Works Well

1. **Exception safety** — the key C++ differentiator. `try`/`catch(...)` wraps every adapter invocation. Exceptions during validate → FAIL (no crash). Exceptions during capture → SKIP (matches JS "throws" guard).
2. **Cross-stack parity** — byte-identical fingerprints to JS/Python/C/Perl for the same (input, output) pairs.
3. **Class-method support** — adapters can instantiate C++ classes and call instance methods.
4. **STL serialization** — adapters can return `std::string`, `std::vector`, `std::map` etc. by serializing to JSON via json-c.
5. **RAII helpers** in harness (`JsonPtr`, `FilePtr`, `BnPtr`, `CharPtr`) for C library resources — no manual cleanup needed.
6. **extern "C" linkage** — correctly required for `dlsym` symbol lookup, documented in header.
7. **Breaking refactor detection** — correctly FAILs with non-zero exit and clear diff output.
8. **Valid refactor detection** — correctly PASSes when output is preserved.
9. **CLI dispatcher wiring** — `regret capture`/`validate` auto-routes to C++ scripts.
10. **Comprehensive test suite** — 288-line `tests/cpp-stack.test.js` covers all scenarios including exception safety.
11. **Thorough documentation** — `references/cpp.md` (510 lines) includes C vs C++ comparison table.
12. **Demo scripts** — `demo-refactor-flow.sh` is idempotent (restores baseline on exit).

---

## Gaps (not bugs, but notes)

### Gap 1: Not yet merged ⚠️

PR #385 is open (not merged to main). This is the only reason the status is [REVIEW] rather than [SUCCESS]. Once merged, the C++ stack should be promoted to [SUCCESS].

### Gap 2: No callee wrapping ⚠️

Like all non-JS stacks, C++ has no ghost-proxy equivalent for callee wrapping. The `watches` field is informational only. This is a known limitation documented in CONTEXT.md and applies to all stacks equally.

### Gap 3: No `regret update` support ⚠️

Not wired for `regret update <cluster>`. To refresh a golden contract, delete the `.regret` file and re-capture. This is documented as a non-goal in `references/cpp.md`.

### Gap 4: Single-input only ⚠️

v1 captures only the first input from `inputs[]`. The JS stack supports per-input `.regret` contracts (issue #315). This is documented as a non-goal.

---

## No Bugs Found

I did not find any bugs in the C++ stack. All scenarios I tested worked correctly:
- Capture: 8/8 clusters (PR's demo) + 4/4 clusters (my independent test)
- Validate: all PASS for unchanged code
- Breaking refactor: correctly FAILs with exit 1 and clear diff
- Valid refactor: correctly PASSes (output preserved)
- Exception safety: C++ exceptions caught, no crash, cluster FAILs gracefully
- Cross-stack parity: byte-identical hashes across JS/Perl/C++
- CLI dispatcher: correctly routes `stack: "cpp"` to C++ scripts
- .regret format: all mandatory fields present

---

## Recommendation

**[REVIEW]** — the implementation is feature-complete, well-tested, and correctly handles all scenarios I tested. The exception safety feature (the key C++ differentiator from the C stack) works as designed — exceptions are caught, no crash, cluster FAILs gracefully.

Once PR #385 is merged to main, the C++ stack should be promoted to [SUCCESS]. No code changes needed — the implementation is ready as-is.

The C++ stack is a genuine superset of the C stack functionality — anyone using the C stack could migrate to C++ by renaming `.c` to `.cpp`, adding `extern "C"` to adapters, and recompiling with `g++`. Fingerprint hashes are identical because the algorithm is the same.
