# CSS Stack Independent Re-Verification + Cross-Stack Parity Fix

This directory contains an **independent re-verification** of the CSS stack
support landed in PR #366 (`feat/css-stack`). It is intentionally separate
from PR #366's own demo (`proofs/css_demo/`) so that the verification runs
against fresh CSS code that the PR author did not write or test against.

## Why this exists

PR #366 (issue #356) is the canonical CSS stack implementation. Per the v2
worker protocol, it is in status **[REVIEW]** — PR exists but not yet
independently verified. This directory provides that independent verification
on fresh code, plus a fix for a cross-stack parity bug found during the
verification.

## What this verifies

The `run-verify.sh` script runs the FULL capture → validate workflow and
reports PASS/FAIL at each step. The fixture CSS (`forms.css`) is a different
domain (form styles) than PR #366's demo (animation cues):

| Selector | # of declarations |
|---|---|
| `.form-input` | 18 |
| `.form-input:focus` | 3 |
| `.form-input[aria-invalid="true"]` | 2 |
| `.form-submit` | 14 |
| `.form-submit:hover` | 1 |
| `.form-helper[data-error="true"]` | 1 |

## Cross-stack fingerprint parity bug (FOUND + FIXED)

During verification, I discovered that PR #366's `fingerprint()` function in
both `scripts/capture_css.mjs` and `scripts/validate_css.mjs` used only the
first 16 hex chars (64 bits) of the SHA-256 hash:

```js
// BUG (PR #366 original):
let num = BigInt('0x' + hash.substring(0, 16));  // 64 bits
// ... manual base36 conversion loop ...
return base36.substring(0, 7);
```

The canonical `fingerprint.js` (JS stack) uses the full 64 hex chars (256 bits):

```js
// CORRECT (fingerprint.js):
const num = BigInt('0x' + hash);  // 256 bits
return num.toString(36).slice(0, 7);
```

These produce DIFFERENT 7-char fingerprints for the same input/output:

| Input | Output | JS fingerprint | CSS fingerprint (buggy) | Match |
|---|---|---|---|---|
| `.form-input` | `["color: #1a1a1a","display: block"]` | `1ledks9` | `z0sgkry` | ✗ |
| `test` | `[1,2,3]` | `52h2e8z` | `33c33cl` | ✗ |
| `42` | `true` | `2ozs1gd` | `1n6hqu4` | ✗ |

This breaks the cross-stack `.regret` parity contract: a CSS cluster and a
JS cluster with the same input/output would have different fingerprints,
making it impossible to share `.regret` files across stacks.

### Fix

Both `scripts/capture_css.mjs` and `scripts/validate_css.mjs` now use the
full 256-bit hash, matching `fingerprint.js`:

```js
const num = BigInt('0x' + hash);
return num.toString(36).slice(0, 7);
```

After the fix, all 3 test vectors above produce matching fingerprints between
JS and CSS.

### Re-capture

All existing `.regret` files (PR #366's `proofs/css_demo/regrets/*.regret`
plus this fixture's `proof/css_verify/regrets/*.regret`) have been
re-captured with the corrected algorithm. The hashes changed (because the
algorithm changed), but capture → validate PASS still works end-to-end.

## How to run

Prerequisites:
- Node.js (with `postcss` installed via `npm install`)

```bash
# From repo root:
bash proof/css_verify/run-verify.sh

# Or with verbose output:
bash proof/css_verify/run-verify.sh --verbose
```

## What the script checks (6 steps)

1. **Capture**: writes 6 `.regret` files to `proof/css_verify/regrets/`
2. **Validate (PASS)**: re-runs all 6 clusters; expects 6/6 PASS on original CSS
3. **Cross-stack parity**: verifies that CSS `fingerprint()` produces the same
   hash as JS `fingerprint.js` for 3 test vectors
4. **Validate (FAIL)**: introduces a breaking change (`.form-submit`
   `background-color: #0066cc` → `#cc0000`), re-runs validate, expects
   `css-verify-form-submit` FAIL with exit 1
5. **Validate (PASS for comment-only change)**: adds a comment to the top of
   `forms.css`, re-runs validate, expects 6/6 PASS (comments don't affect
   declarations)
6. **npm test**: runs the existing JS test suite (807 tests) to confirm
   no regressions

Exit code is 0 if all 6 steps pass; non-zero otherwise.

## Latest verification result

```
=== ✅ All CSS stack verifications PASSED ===

Summary:
  1. Capture: 6 .regret files written to proof/css_verify/regrets/
  2. Validate (PASS): 6/6 clusters passed on original CSS
  3. Cross-stack parity: CSS fingerprints match JS for 3 test vectors
  4. Validate (FAIL): correctly detected breaking change in .form-submit
     (expected: 5bpotts, got: 2luoj5x)
  5. Validate (PASS after comment-only change): 6/6 clusters passed
  6. npm test: 0 fail — no regressions
```

## Verdict

PR #366 WORKS as claimed for the core CSS capture+validate workflow (demo
passes end-to-end). The independent verification FOUND + FIXED a cross-stack
fingerprint parity bug that would have made CSS `.regret` files incompatible
with JS/Python/Rust/Go `.regret` files for the same input/output.

Status tag: **[REVIEW]** — first independent verification + bug fix. Per the
rules, `[SUCCESS]` is reserved for revisions after feedback on a prior
`[REVIEW]`. This PR moves the CSS stack from "unverified [REVIEW]" to
"independently verified + bug-fixed [REVIEW]" — one step closer to
`[SUCCESS]` but not there yet (BOS should review the parity fix).
