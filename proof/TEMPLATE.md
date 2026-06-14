# Proof Case Study Template

> Copy this template to a new directory under `proof/` and fill in every section.
> An agent new to the project should be able to fill this in under 10 minutes.

---

## Library/Project

| Field | Value |
|-------|-------|
| **Name** | <!-- e.g. jaconv --> |
| **Repository** | <!-- e.g. https://github.com/ikegami-yukino/jaconv --> |
| **Version/tag tested** | <!-- e.g. v0.3.4 or commit sha --> |
| **Stack** | <!-- e.g. Python, TypeScript, JS (CJS wrapper) --> |
| **Domain** | <!-- e.g. Japanese character encoding, Hebrew calendar, WAF detection --> |

## Challenge

<!-- 2-4 sentences: Why is this library hard to fingerprint? What makes it
     an interesting or non-obvious test case for Regrets?
     Examples: side-effect-heavy functions, plugin architecture, boolean-only
     outputs causing fingerprint collisions, single-file monolith, etc. -->

## Solution

<!-- Describe the approach used to make this library testable with Regrets.
     Common patterns:
     - Pure functions: direct fingerprinting, no adapter needed
     - Side-effect functions: adapter/wrapper pattern (see wafw00f)
     - Class-based APIs: instantiate in manifest or wrapper module
     - Multi-argument functions: use multiArgs: true in manifest
     - Boolean outputs: enrich return value to avoid fingerprint collision
     - Single-file modules: set pythonPath: "." in manifest
     -->

## Key Lessons

<!-- 3-5 actionable insights that apply beyond this specific library.
     Each lesson should be a short heading + 1-3 sentence explanation. -->

1. **<!-- Lesson title -->**
   <!-- Explanation -->

2. **<!-- Lesson title -->**
   <!-- Explanation -->

3. **<!-- Lesson title -->**
   <!-- Explanation -->

4. *(optional)* **<!-- Lesson title -->**
   <!-- Explanation -->

5. *(optional)* **<!-- Lesson title -->**
   <!-- Explanation -->

## How to Reproduce

<!-- Step-by-step commands to re-run this proof from scratch.
     Someone should be able to copy-paste these into a terminal. -->

```bash
# 1. Clone the target library
git clone <REPO_URL> target-project
cd target-project

# 2. Install dependencies
# pip install .   OR   npm install

# 3. Copy the manifest into the project
cp /path/to/Regrets/proof/<THIS_DIR>/manifest.json regrets/manifest.json

# 4. Capture baseline (if not already captured)
# node scripts/capture.js --manifest regrets/manifest.json

# 5. Validate against KEBENARAN baselines
# node scripts/validate.js --manifest regrets/manifest.json

# 6. Verify fingerprints match
# Compare output with proof/<THIS_DIR>/KEBENARAN_1_raw_output.json
# Compare fingerprints with proof/<THIS_DIR>/KEBENARAN_2_fingerprints.json
```

---

## Clusters

<!-- Auto-generated or manually filled. List all clusters with their
     fingerprints for quick reference. -->

| Cluster | Entry | Fingerprint |
|---------|-------|-------------|
| <!-- id --> | <!-- entry function --> | <!-- hash --> |

## Verification

<!-- Summary of verification results. Update status as needed. -->

| # | Method | Result |
|---|--------|--------|
| V1 | Cluster validate (all GREEN) | <!-- PASS / FAIL --> |
| V2 | Raw output vs KEBENARAN 1 | <!-- IDENTICAL / MISMATCH --> |
| V3 | Fingerprint match vs KEBENARAN 2 | <!-- MATCH / MISMATCH --> |
| V4 | Chain hash match (if applicable) | <!-- MATCH / N/A --> |
