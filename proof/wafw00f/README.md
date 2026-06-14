# wafw00f — Security/Pentest WAF Detection Tool

## Library/Project

| Field | Value |
|-------|-------|
| **Name** | wafw00f |
| **Repository** | [EnableSecurity/wafw00f](https://github.com/EnableSecurity/wafw00f) |
| **Version/tag tested** | *(see manifest.json for commit)* |
| **Stack** | Python (security/pentest tooling) |
| **Domain** | Web Application Firewall detection and fingerprinting |

## Challenge

wafw00f presents multiple fingerprinting challenges uncommon in typical Regrets case studies. It uses a plugin architecture with 100+ WAF detection plugins loaded dynamically, each with a duck-typed `is_waf(self)` function. The core detection logic depends on HTTP responses (headers, cookies, content, status codes) — heavy side effects that are incompatible with pure function fingerprinting. A 200+ line `main()` god function mixed CLI parsing, business logic, and output formatting. Additionally, all True-returning detection functions produce identical boolean fingerprints — a fingerprint collision problem.

## Solution

An adapter pattern was used to make wafw00f testable with Regrets. A `regrets_adapter.py` module constructs a WAFW00F instance without making real HTTP requests by setting `rq` and `attackres` to `MockResponse` objects with predetermined data. Each plugin's `is_waf()` call is wrapped to return structured data including `waf_name`, `detected`, and `detection_method` — avoiding the boolean fingerprint collision by making each cluster's output unique. The god function `main()` was decomposed into focused functions with backward-compatible aliases for all renamed functions.

## Key Lessons

1. **Adapter pattern for side-effect-heavy libraries**
   When a library's core functions depend on external state (HTTP responses, databases, file I/O), create an adapter module that constructs objects with mock/predetermined data. The adapter isolates the logic from its dependencies, making it fingerprintable without altering the original codebase.

2. **Boolean fingerprint collision**
   When detection functions return only `True`/`False`, all True-returning functions produce identical fingerprints. Return structured data from adapter functions that includes identifying metadata (e.g., `waf_name`, `detection_method`) alongside the boolean result to make each cluster's fingerprint unique.

3. **Manifest-level pythonPath support gaps**
   When testing libraries where `pythonPath` is needed at the manifest level, verify that ALL Regrets tools (`capture.py`, `validate.py`, `contest.py`, `truth.py`) support the manifest-level setting — not just individual cluster definitions. Inconsistencies here cause silent failures.

4. **Backward-compatible aliases during refactor**
   When renaming functions in a refactoring, preserve old names as aliases in the original module so existing imports continue to work. This is especially important for plugin architectures where other code may reference the old names.

5. **Decomposition of god functions**
   A 200+ line `main()` mixing CLI parsing, business logic, and output formatting can be decomposed by responsibility: extract CLI parsing, extract output formatting, and leave `main()` as a thin orchestrator. Each extracted function becomes independently testable and fingerprintable.

## How to Reproduce

```bash
# 1. Clone the target library
git clone https://github.com/EnableSecurity/wafw00f.git target-wafw00f
cd target-wafw00f

# 2. Install dependencies
pip install .

# 3. Copy the manifest into the project
mkdir -p regrets
cp /path/to/Regrets/proof/wafw00f/manifest.json regrets/manifest.json

# 4. Capture baseline (if not already captured)
# node scripts/capture.js --manifest regrets/manifest.json

# 5. Validate against KEBENARAN baselines
# node scripts/validate.js --manifest regrets/manifest.json

# 6. Verify fingerprints match
# Compare output with proof/wafw00f/KEBENARAN_1_raw_output.json
# Compare fingerprints with proof/wafw00f/KEBENARAN_2_fingerprints.json
```

---

## Clusters

| Cluster | Entry | Fingerprint |
|---------|-------|-------------|
| build-result-record | build_result_record | 2ikhe24 |
| calc-logging-level | calculate_logging_level | 54y0fdn |
| get-text-results | format_results_as_text | 4vuuqrd |
| detect-cloudflare-server | *(adapter)* | 5dq3s2n |
| detect-cloudflare-cf-ray | *(adapter)* | 4374btf |
| detect-cloudflare-negative | *(adapter)* | elmjzp4 |
| detect-modsecurity-header | *(adapter)* | 3051af0 |
| detect-modsecurity-content | *(adapter)* | 1vzwxaq |
| detect-incapsula-cookie | *(adapter)* | 1wvsvif |
| detect-incapsula-content | *(adapter)* | 69aoy6m |
| detect-sucuri-header | *(adapter)* | 664qzqg |
| detect-sucuri-content | *(adapter)* | p339jdj |
| detect-awswaf-header | *(adapter)* | 51a2moz |
| detect-fastly-header | *(adapter)* | 46n6ldz |
| detect-barracuda-header | *(adapter)* | 166iywl |
| detect-wordfence-content | *(adapter)* | 1ddqvrq |
| generic-negative | *(adapter)* | hao4i97 |

### Chains

| Chain | Hash |
|-------|------|
| cloudflare-full-detection | 4rzjz9x |
| result-formatting-pipeline | 5flcefz |
| multi-waf-negative-scan | 442df5y |

### Refactoring Performed

**Decomposition:**
- Extracted `wafw00f/cli/` module: argument parsing, logging level calculation, header file parsing, target loading from files
- Extracted `wafw00f/output/` module: result record building, text/CSV/JSON formatting, file/stdout writing
- Decomposed 200+ line `main()` into focused functions: `scan_single_target()`, `print_waf_list()`, `main()`

**Naming:**
- `genericdetect` → `detect_generic_waf` (with backward-compatible alias)
- `calclogginglevel` → `calculate_logging_level` (with alias)
- `getTextResults` → `format_results_as_text` (with alias)
- `buildResultRecord` → `build_result_record` (with alias)
- `getheaders` → `parse_custom_headers` (with alias)

### Gaps Found in Regrets

1. **manifest-level pythonPath not respected in contest.py** — Fixed by adding manifest-level `pythonPath` handling to `load_manifest()`.
2. **manifest-level pythonPath not respected in truth.py** — Same gap; fixed by adding manifest-level `pythonPath` handling before the cluster loop.
3. **Boolean fingerprint collision** — Workaround: return structured data from adapter functions instead of raw booleans.

## Verification

| # | Method | Result |
|---|--------|--------|
| V1 | Cluster validate (all 17 GREEN) | PASS |
| V2 | Raw output vs KEBENARAN 1 (17 clusters) | IDENTICAL |
| V3 | Fingerprint match vs KEBENARAN 2 (17 clusters) | MATCH |
| V4 | Chain hash match (3 chains) | MATCH |
