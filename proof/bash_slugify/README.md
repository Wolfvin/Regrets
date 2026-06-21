# Bash Slugify — Working Example

End-to-end demonstration of Bash stack support in Regrets.

## What's here

```
proof/bash_slugify/
├── README.md              ← this file
├── lib/
│   └── slugify.sh         ← real bash functions (slugify + slugify_join)
├── manifest.json          ← 2 cluster definitions
├── run_demo.sh            ← end-to-end verification script
└── regrets/               ← generated .regret files (after capture)
```

## Functions

### `slugify`

Converts a string to a URL-safe slug.

```bash
source lib/slugify.sh
slugify "Hello World!"           # → "hello-world"
slugify "Multi   Spaces Here"    # → "multi-spaces-here"
slugify "!!!already-clean!!!"    # → "already-clean"
```

Algorithm: lowercase → spaces to hyphens → strip non-alphanumeric → collapse consecutive hyphens → trim leading/trailing hyphens.

### `slugify_join`

Multi-arg variant: slugify each arg, join with hyphens.

```bash
source lib/slugify.sh
slugify_join "Hello" "World"     # → "hello-world"
slugify_join "API" "v2" "Docs"   # → "api-v2-docs"
```

## Manifest

Two clusters, both `stack: "bash"`:

- `slugify` — single-arg, 7 test inputs (only first is canonical for capture)
- `slugify-join` — `multiArgs: true`, 3 test inputs (first is canonical)

## Running the demo

```bash
bash run_demo.sh
```

The demo walks through:

1. **Prerequisites check** — Bash 4+, python3, sha256sum
2. **Fingerprint parity test** — 6 cases compared to JS `fingerprint.js`
3. **Capture** — writes `slugify.regret` and `slugify-join.regret`
4. **Validate baseline** — both clusters PASS (no changes)
5. **Breaking change** — uppercase instead of lowercase → both FAIL
6. **Non-breaking refactor** — rename vars + use `tr`/`sed` → both PASS
7. **`--cluster` filter** — only validates `slugify`, skips `slugify-join`
8. **`--fail-fast` flag** — runs all clusters, exits 1 on first failure (no early stop)

Expected output: `ALL CHECKS PASSED — Bash stack is working end-to-end`.

## .regret file example

After `bash run_demo.sh` (or `regret capture`), `regrets/slugify.regret` contains:

```
cluster: slugify
version: 1
fingerprint: 2o600q3
captured: 2026-06-21T04:51:00.396491+00:00
entry: slugify
stack: bash
file: lib/slugify.sh
fingerprintLevel: entry
---
INPUT  "Hello World!"
OUTPUT hello-world
HASH   2o600q3
```

## Cross-stack fingerprint parity

The hash `2o600q3` for `(input="Hello World!", output="hello-world")` is byte-identical to what JS, Python, PHP, Perl, Ruby, Go, and Rust would produce for the same input→output pair. This is the Regrets cross-stack contract.

Verify with JS directly:

```bash
node --input-type=module -e "
import { fingerprint } from '../../scripts/fingerprint.js';
console.log(fingerprint('Hello World!', 'hello-world'));
"
# Output: 2o600q3
```

## See also

- [`references/bash-stack-guide.md`](../../references/bash-stack-guide.md) — full Bash stack documentation
- [`scripts/fingerprint_bash.sh`](../../scripts/fingerprint_bash.sh) — shared fingerprint module
- [`scripts/capture_bash.sh`](../../scripts/capture_bash.sh) — capture runner
- [`scripts/validate_bash.sh`](../../scripts/validate_bash.sh) — validate runner
