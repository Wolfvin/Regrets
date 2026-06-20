# CSS Stack Variant

Regression fingerprinting for CSS files using `postcss`-based declaration extraction.

## Status: Working

CSS stack support is **Working** — capture + validate are implemented and tested with real CSS files.

## Fingerprint Model

CSS is a special case for Regrets because CSS doesn't have "function calls" in the traditional sense. The model defined here:

| Element | Value |
|---------|-------|
| **Input** | CSS selector string (e.g., `.cue-enter`) |
| **Output** | Sorted array of `property: value` declaration strings extracted from the CSS file for that selector |
| **Function** | `extractDeclarations(cssContent, selector)` — uses `postcss` to parse CSS and extract all declarations matching the selector |
| **Fingerprint** | `sha256(stableStringify(input) + "|" + stableStringify(output))` → base36 → first 7 chars (identical to JS/Python/Go) |

### What this captures

- ✅ Property value changes (e.g., `opacity: 0` → `opacity: 0.5` = breaking)
- ✅ Property additions/removals (e.g., adding `transform: scale(1.1)` = breaking)
- ✅ Pseudo-class/attribute selector declarations (e.g., `.cue-enter:hover`, `.cue-enter[data-active="true"]`)
- ✅ Comment-only changes (non-breaking — comments are not declarations)

### What this does NOT capture

- ❌ Cascade interactions (how rules combine across selectors)
- ❌ Inheritance
- ❌ Browser-specific computed values
- ❌ `@media` query fingerprinting (deferred to future PR)
- ❌ `@keyframes` content fingerprinting (deferred)

## Quick Start

1. Add `"stack": "css"` clusters to `regrets/manifest.json`:
   ```json
   {
     "clusters": [{
       "id": "my-selector",
       "entry": ".my-class",
       "file": "src/styles.css",
       "stack": "css"
     }]
   }
   ```
2. Run `node scripts/capture_css.mjs --manifest regrets/manifest.json`
3. Refactor your CSS freely (comments, whitespace, property reordering are safe)
4. Run `node scripts/validate_css.mjs --manifest regrets/manifest.json`
5. All `.regret` files use identical format to JS/Python/Go stacks

## Manifest Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | ✅ | Cluster identifier (used as `.regret` filename) |
| `entry` | ✅ | CSS selector to extract (e.g., `.cue-enter`, `.cue-enter:hover`) |
| `file` | ✅ | Path to CSS file (relative to manifest directory) |
| `stack` | ✅ | Must be `"css"` |
| `inputs` | ❌ | Optional array of inputs (stored in .regret metadata, not used for extraction) |

## CLI Usage

```bash
# Capture (fingerprint current CSS declarations)
node scripts/capture_css.mjs --manifest regrets/manifest.json

# Validate (re-extract and compare)
node scripts/validate_css.mjs --manifest regrets/manifest.json

# Single cluster
node scripts/capture_css.mjs --cluster cue-enter --manifest regrets/manifest.json

# Fail fast (stop on first failure)
node scripts/validate_css.mjs --fail-fast --manifest regrets/manifest.json

# Quiet mode (summary only)
node scripts/capture_css.mjs --quiet --manifest regrets/manifest.json
```

## .regret File Format

```text
cluster: cue-enter
version: 1
fingerprint: 5s9hdtr
captured: 2026-06-20T17:55:00.000Z
entry: .cue-enter
stack: css
file: ../demo.css
---
INPUT  {"selector":".cue-enter"}
OUTPUT ["animation: cue-slide-up 300ms cubic-bezier(0.16, 1, 0.3, 1) both","opacity: 0","transform: translateY(16px)"]
HASH   5s9hdtr
```

## Demo

Run the end-to-end demo:

```bash
cd proofs/css_demo
bash run-demo.sh
```

This demonstrates:
1. **Capture** — 4 CSS selectors fingerprinted
2. **Validate PASS** — no changes → all 4 PASS
3. **Breaking refactor** — change `opacity: 0` → `opacity: 0.5` → 1 FAIL + 3 PASS
4. **Valid refactor** — add a comment → all 4 PASS (comments are not declarations)

## Dependencies

- `postcss` (devDependency) — CSS parser for declaration extraction
- No browser runtime needed — pure Node.js

## Known Gaps (future PRs)

- `@media` query fingerprinting (currently ignored — declarations inside @media are not extracted)
- `@keyframes` content fingerprinting (currently ignored)
- Cascade resolution (multiple rules matching the same selector are merged, but specificity is not resolved)
- `--update` mode (re-capture after intentional change)
- Dispatch integration in `scripts/regret.js` (currently standalone scripts)
