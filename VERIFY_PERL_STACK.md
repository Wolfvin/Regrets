# Perl Stack — Independent Verification Report

**Reviewer:** Worker session (independent of PR #367 author)
**Date:** 2026-06-21
**PR verified:** #367 (`feat/perl-capture-validate`)
**Issue:** #353
**Branch:** `feat/perl-capture-validate`

## Summary

PR #367 adds Perl stack support to Regrets with 5 new files (1,551 lines):
- `scripts/fingerprint_perl.pl` (253 lines) — shared fingerprint module + self-test
- `scripts/capture_perl.pl` (359 lines) — manifest-driven capture
- `scripts/validate_perl.pl` (296 lines) — .regret re-validation
- `scripts/verify_perl_stack.sh` (366 lines) — end-to-end verification script
- `references/perl.md` (277 lines) — documentation

**Verdict: [REVIEW]** — the core functionality works correctly, but there are
two bugs in the `module` + `libPath` loading path and the unqualified entry
name with nested package paths. The `file` field (the primary loading method)
works correctly in all tested scenarios.

---

## Verification Steps Performed

### 1. Fingerprint Cross-Stack Parity ✅

```
$ perl scripts/fingerprint_perl.pl

=== fingerprint_perl.pl self-test ===
Cross-stack verification against fingerprint.js reference values:

  [PASS] string input/output      expected: 67q5v7m  got: 67q5v7m
  [PASS] numeric input/output     expected: 3gpqqch  got: 3gpqqch
  [PASS] array input, scalar out  expected: 3n4dm45  got: 3n4dm45
  [PASS] hash input, hash output  expected: 5dmn78d  got: 5dmn78d
  [PASS] undef input/output       expected: 3xo774r  got: 3xo774r

ALL PASS — Perl fingerprint matches JS reference
```

All 5 reference values match `fingerprint.js` exactly.

### 2. End-to-End Verify Script ✅

```
$ bash scripts/verify_perl_stack.sh

✅ PASS: All required Perl modules available (JSON::PP, Digest::SHA, Math::BigInt)
✅ PASS: fingerprint_perl.pl produces hashes matching JS reference
✅ PASS: Temporary Perl project created
✅ PASS: capture_perl.pl completed successfully
✅ PASS: Expected number of .regret files created (4)
✅ PASS: validate_perl.pl PASSed (exit 0) — no changes since capture
✅ PASS: All 4 clusters PASSed
✅ PASS: validate_perl.pl correctly FAILed (exit 1) after breaking change
✅ PASS: Only the broken cluster (add-basic) FAILed; untouched clusters PASSed
✅ PASS: validate_perl.pl PASSed (exit 0) after non-breaking refactor
✅ PASS: All 4 clusters PASSed after non-breaking refactor

==========================================
  Perl Stack Verification: ALL CHECKS PASS
==========================================
```

All 6 verification checks pass.

### 3. Independent Test Project (my own code, NOT from PR's test suite) ✅

Created a separate Perl project with `StringUtils.pm` containing 4 functions
NOT in the PR's test suite:
- `capitalize_words` — capitalize first letter of each word
- `count_vowels` — count vowels in a string
- `is_palindrome` — check if string is palindrome (ignore spaces/case)
- `to_camel_case` — convert space-separated to camelCase

**Capture:** All 4 clusters captured with correct `.regret` format.

**Validate (baseline):** All 4 PASS (exit 0).

**Breaking refactor** (changed `capitalize_words` to `uc`):
```
❌ capitalize — golden: 5fixoda, live: 2w2epmp — FAIL
✅ count-vowels — 54e37p0 — PASS
✅ is-palindrome — 1gm4ofy — PASS
✅ to-camel-case — 22zelqk — PASS
Summary: 3 passed, 1 failed
Exit: 1
```
Correctly FAILs with non-zero exit.

**Valid refactor** (changed `count_vowels` from regex to `tr///`):
```
✅ capitalize — 5fixoda — PASS
✅ count-vowels — 54e37p0 — PASS
✅ is-palindrome — 1gm4ofy — PASS
✅ to-camel-case — 22zelqk — PASS
Summary: 4 passed, 0 failed
Exit: 0
```
Correctly PASSes.

### 4. Cross-Stack Parity (JS vs Perl) ✅

Computed JS `fingerprint()` for the same (input, output) pairs:

| Cluster | JS hash | Perl hash | Match |
|---|---|---|---|
| capitalize | 5fixoda | 5fixoda | ✅ |
| count-vowels | 54e37p0 | 54e37p0 | ✅ |
| is-palindrome | 1gm4ofy | 1gm4ofy | ✅ |
| to-camel-case | 22zelqk | 22zelqk | ✅ |

All 4 hashes match byte-for-byte.

### 5. npm test ✅

```
ℹ tests 807
ℹ pass 807
ℹ fail 0
ℹ skipped 0
```

No regressions. PR is purely additive (5 new files, no existing files modified).

### 6. .regret File Format ✅

Verified that Perl `.regret` files contain all mandatory fields:
- `cluster` ✅
- `version` ✅
- `fingerprint` ✅
- `captured` ✅
- `INPUT` ✅
- `OUTPUT` ✅
- `HASH` ✅

Format is compatible with JS/Python stacks.

---

## Bugs Found

### Bug 1: `module` + `libPath` loading is broken ❌

**Severity:** Medium (affects users who use `module` field instead of `file`)

**Root cause:** In both `capture_perl.pl` (line 147) and `validate_perl.pl`
(line 137), when the `module` field is used:

```perl
require $module;           # $module = "TextTools" — FAILS
$module =~ s/::/\//g;
$module .= ".pm";          # Modification happens AFTER require, too late
```

Perl's `require` with a string argument needs the `.pm` extension to search
`@INC`. Without it, `require "TextTools"` fails with "Can't locate TextTools
in @INC".

**Reproduction:**
```json
{
  "clusters": [{
    "id": "test",
    "stack": "perl",
    "module": "TextTools",
    "libPath": "lib",
    "entry": "TextTools::slugify",
    "inputs": ["Hello World"]
  }]
}
```

**Fix:** Convert module name to path BEFORE calling `require`:
```perl
my $module_path = $module;
$module_path =~ s/::/\//g;
$module_path .= ".pm";
require $module_path;
$loaded_module = $module;
```

**Note:** The `file` field (primary loading method) does NOT have this bug
because it correctly appends `.pm` before calling `require`.

### Bug 2: Unqualified entry name fails with nested package paths ❌

**Severity:** Low-Medium (affects users with `lib/Foo/Bar.pm` structure)

**Root cause:** When `file: "lib/Foo/Bar.pm"` is used, the code derives
`$loaded_module` as just the basename `"Bar"`, not the full package name
`"Foo::Bar"`. So when looking up an unqualified entry like `"greet"`, it
searches `Bar::greet` instead of `Foo::Bar::greet`.

```perl
my $module_name = basename($file);  # "Bar" — should be "Foo::Bar"
$module_name =~ s/\.pm$//;
require $module_name . ".pm";
$loaded_module = $module_name;      # "Bar" — wrong!
```

**Reproduction:**
```json
{
  "clusters": [{
    "id": "greet",
    "stack": "perl",
    "file": "lib/Foo/Bar.pm",
    "entry": "greet",
    "inputs": ["World"]
  }]
}
```
Error: `Undefined subroutine &Bar::greet called`

**Workaround:** Use qualified entry name: `"entry": "Foo::Bar::greet"`
(verified to work correctly).

**Fix:** Derive package name from file path, not just basename:
```perl
my $module_name = $file;
$module_name =~ s/^lib\///;       # remove leading lib/
$module_name =~ s/\.pm$//;        # remove .pm
$module_name =~ s/\//::/g;        # Foo/Bar → Foo::Bar
```

Or more robustly, use the file's directory relative to the project root.

---

## Gaps (not bugs, but missing features)

### Gap 1: No CLI dispatcher wiring ⚠️

PR #367 does NOT add Perl to `scripts/regret.js`'s stack dispatch. This
means `regret capture` / `regret validate` won't auto-route to Perl scripts
for clusters with `stack: "perl"`.

Users must invoke directly: `perl scripts/capture_perl.pl` /
`perl scripts/validate_perl.pl`.

The PR description acknowledges this as follow-up work:
> Integration with the main `regret` CLI (`bin/regret.js`) so
> `regret capture --stack perl` dispatches to `capture_perl.pl`.

### Gap 2: No Node test suite ⚠️

No `tests/perl-stack.test.js` file. The `verify_perl_stack.sh` script
provides manual verification but is not integrated into `npm test`.

Other stacks (C, C++, awk) have Node test suites that auto-skip when the
runtime is missing. Perl should follow the same pattern.

### Gap 3: Single-input only ⚠️

v1 captures only the first input from `inputs[]`. The JS stack supports
per-input `.regret` contracts (issue #315). The PR acknowledges this as
follow-up work.

### Gap 4: No `regret update` support ⚠️

Not wired for `regret update <cluster>`. To refresh a golden contract,
delete the `.regret` file and re-capture.

---

## What Works Well

1. **Fingerprint algorithm** — byte-identical to JS/Python across all test cases
2. **`.regret` file format** — matches the standard format exactly
3. **Trivial-input guard** — correctly skips null/undefined output
4. **`file` field loading** — works correctly for top-level `.pm` files
5. **Qualified entry names** — `Package::foo` works correctly
6. **multiArgs** — correctly handles multi-argument function calls
7. **Breaking refactor detection** — correctly FAILs with non-zero exit
8. **Valid refactor detection** — correctly PASSes when output is preserved
9. **`--cluster` filter** — works correctly for both capture and validate
10. **`--manifest` flag** — works correctly for custom manifest paths
11. **Error messages** — clear and actionable
12. **Documentation** — `references/perl.md` is thorough and accurate
13. **Cross-stack compatibility** — Perl `.regret` files can be validated by
    JS/Python validators and vice versa

---

## Recommendation

**[REVIEW]** — the core implementation is solid and the primary use case
(`file` field with top-level or qualified entries) works correctly
end-to-end. The two bugs are in secondary code paths (`module` field and
nested package paths) that have straightforward fixes.

The PR should be mergeable after fixing Bug 1 (the `module` field `require`
issue), as that's the more impactful bug. Bug 2 has a simple workaround
(use qualified entry names).

The CLI dispatcher wiring (Gap 1) and Node test suite (Gap 2) should be
added in a follow-up PR to bring Perl to parity with C/C++/awk stacks.
