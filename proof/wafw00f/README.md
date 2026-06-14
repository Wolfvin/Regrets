# wafw00f — Security/Pentest WAF Detection Tool

**Repo**: [EnableSecurity/wafw00f](https://github.com/EnableSecurity/wafw00f)
**Stack**: Python (security/pentest tooling)
**Domain**: Web Application Firewall detection and fingerprinting

## Why This Tester

wafw00f was chosen because it represents a **security/pentest tooling** domain that had never been tested with Regrets before. Unlike the encoding/transliteration libraries that dominate existing case studies, wafw00f presents unique challenges:

- **Plugin architecture**: 100+ WAF detection plugins loaded dynamically, each with a duck-typed `is_waf(self)` function
- **Side-effect heavy**: Core detection logic depends on HTTP responses (headers, cookies, content, status codes)
- **God function**: `main()` was 200+ lines mixing CLI parsing, business logic, and output formatting
- **Naming issues**: `genericdetect`, `getTextResults`, `calclogginglevel` didn't follow Python conventions
- **Mixed concerns**: Result building, text formatting, CSV/JSON output all inline in main.py

## Adapter Pattern

Because wafw00f's plugin detection functions require HTTP responses, we created a `regrets_adapter.py` module that:
1. Constructs a WAFW00F instance without making real HTTP requests
2. Sets `rq` and `attackres` to `MockResponse` objects with predetermined data
3. Wraps each plugin's `is_waf()` call in a function that returns structured data including `waf_name`, `detected`, and `detection_method`

This adapter pattern avoids fingerprint collision (all True-returning detection functions would produce the same boolean fingerprint) by returning richer output.

## Gaps Found

### 1. manifest-level pythonPath not respected in contest.py

The `contest.py` chain runner only looked for `pythonPath` in individual cluster definitions, ignoring the manifest-level `pythonPath` that `capture.py` and `validate.py` already support.

**Fix**: Added manifest-level `pythonPath` handling to `contest.py`'s `load_manifest()` method, matching the behavior of `capture.py` and `validate.py`.

### 2. manifest-level pythonPath not respected in truth.py

Same gap as contest.py — `truth.py` only handled cluster-level `pythonPath`, not the manifest-level one.

**Fix**: Added manifest-level `pythonPath` handling before the cluster loop.

### 3. Boolean fingerprint collision

When detection functions return only `True`/`False`, all True-returning functions produce identical fingerprints. This is a design consideration for security/pentest tools where boolean detection is the norm.

**Workaround**: Return structured data from adapter functions that includes `waf_name` and `detection_method` alongside the boolean `detected` field. This makes each cluster's fingerprint unique.

## Refactoring Performed

### Decomposition
- Extracted `wafw00f/cli/` module: argument parsing, logging level calculation, header file parsing, target loading from files
- Extracted `wafw00f/output/` module: result record building, text/CSV/JSON formatting, file/stdout writing
- Decomposed 200+ line `main()` into focused functions: `scan_single_target()`, `print_waf_list()`, `main()`

### Naming
- `genericdetect` → `detect_generic_waf` (with backward-compatible alias)
- `calclogginglevel` → `calculate_logging_level` (with alias)
- `getTextResults` → `format_results_as_text` (with alias)
- `buildResultRecord` → `build_result_record` (with alias)
- `getheaders` → `parse_custom_headers` (with alias)

### Single Responsibility
- CLI parsing separated from scanning logic
- Output formatting separated from result collection
- Target loading (JSON/CSV/text) extracted into dedicated function

### Backward Compatibility
All old function names are preserved as aliases in `main.py`, so existing imports continue to work.

## Verification Results

### KEBENARAN 1 — Raw Output (17 clusters)
| Cluster | Output |
|---------|--------|
| build-result-record | 4 test inputs producing result dicts |
| calc-logging-level | 6 verbosity levels producing logging levels |
| get-text-results | 1 input producing formatted text lines |
| detect-cloudflare-server | `{waf_name: 'Cloudflare', detected: True, detection_method: 'server-header'}` |
| detect-cloudflare-cf-ray | `{waf_name: 'Cloudflare', detected: True, detection_method: 'cf-ray-header'}` |
| detect-cloudflare-negative | `{waf_name: 'Cloudflare', detected: False, detection_method: 'negative-nginx'}` |
| detect-modsecurity-header | `{waf_name: 'ModSecurity', detected: True, detection_method: 'server-header'}` |
| detect-modsecurity-content | `{waf_name: 'ModSecurity', detected: True, detection_method: 'content-match'}` |
| detect-incapsula-cookie | `{waf_name: 'Incapsula', detected: True, detection_method: 'cookie-match'}` |
| detect-incapsula-content | `{waf_name: 'Incapsula', detected: True, detection_method: 'content-match'}` |
| detect-sucuri-header | `{waf_name: 'Sucuri', detected: True, detection_method: 'header-match'}` |
| detect-sucuri-content | `{waf_name: 'Sucuri', detected: True, detection_method: 'content-match'}` |
| detect-awswaf-header | `{waf_name: 'AWS WAF', detected: True, detection_method: 'header-match'}` |
| detect-fastly-header | `{waf_name: 'Fastly', detected: True, detection_method: 'header-match'}` |
| detect-barracuda-header | `{waf_name: 'Barracuda', detected: True, detection_method: 'cookie-match'}` |
| detect-wordfence-content | `{waf_name: 'Wordfence', detected: True, detection_method: 'content-match'}` |
| generic-negative | `{cloudflare: False, sucuri: False, incapsula: False}` |

### KEBENARAN 2 — Fingerprints (17) + Chains (3)

| Cluster | Fingerprint |
|---------|-------------|
| build-result-record | 2ikhe24 |
| calc-logging-level | 54y0fdn |
| get-text-results | 4vuuqrd |
| detect-cloudflare-server | 5dq3s2n |
| detect-cloudflare-cf-ray | 4374btf |
| detect-cloudflare-negative | elmjzp4 |
| detect-modsecurity-header | 3051af0 |
| detect-modsecurity-content | 1vzwxaq |
| detect-incapsula-cookie | 1wvsvif |
| detect-incapsula-content | 69aoy6m |
| detect-sucuri-header | 664qzqg |
| detect-sucuri-content | p339jdj |
| detect-awswaf-header | 51a2moz |
| detect-fastly-header | 46n6ldz |
| detect-barracuda-header | 166iywl |
| detect-wordfence-content | 1ddqvrq |
| generic-negative | hao4i97 |

| Chain | Hash |
|-------|------|
| cloudflare-full-detection | 4rzjz9x |
| result-formatting-pipeline | 5flcefz |
| multi-waf-negative-scan | 442df5y |

### 4-Way Verification: ALL GREEN

| Verification | Result |
|-------------|--------|
| V1: Cluster GREEN | ✅ All 17 clusters PASS |
| V2: Output Identical | ✅ All 17 clusters identical to KEBENARAN 1 |
| V3: Fingerprint Match | ✅ All 17 fingerprints match KEBENARAN 2 |
| V4: Chain Hash Match | ✅ All 3 chains match |
