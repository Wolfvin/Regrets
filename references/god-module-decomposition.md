# God Module Decomposition with Regrets

## The Problem

A "god module" is a single source file that contains too many functions, classes, and data
tables mixing multiple domains. Typical symptoms:

- File exceeds 300 lines
- Contains 15+ functions
- Multiple distinct functional domains coexist in one file
- Functions from different domains call each other in complex ways
- The file is difficult to navigate and maintain

Examples: `inflect/__init__.py` (4003 lines, 73 functions), many legacy Python modules.

## Why Regrets Is Essential for God Module Decomposition

Decomposing a god module is the **highest-risk refactoring** because:

1. **Cross-domain coupling**: Functions in one domain may call functions in another
2. **Hidden state**: Mutable class variables or module-level state may create invisible dependencies
3. **Data table dependencies**: Module-level lookup tables may be shared across domains
4. **Import chain breaks**: Moving functions to new modules can break existing imports

Regrets makes this safe by capturing behavioral fingerprints BEFORE the decomposition,
then validating that all outputs remain identical AFTER.

## Step-by-Step Decomposition Workflow

### Step 1: Analyze the God Module

```bash
# Use scan with --decompose to identify domains
python scripts/scan.py path/to/god_module.py --decompose
```

This analyzes the call graph and groups functions into connected domains.
Each domain represents a candidate for extraction into its own module.

### Step 2: Create Clusters for Every Domain's Entry Functions

For each domain identified by `--decompose`, create a cluster in `regrets/manifest.json`.

Key considerations for god modules:

- **Use `constructor` + `classMethod`** if the module has a main class with many methods
- **Set `fingerprintLevel: "entry"`** to fingerprint the final output, not intermediate calls
- **Use `kwargs: true`** if methods accept keyword arguments
- **Add `setup` steps** if the class has mutable state that affects output
  (e.g., `classical()`, `num()`, `gender()` in inflect)

### Step 3: Capture and Validate

```bash
regret capture
regret validate
```

All clusters must be GREEN before proceeding.

### Step 4: Run Drift Detection

```bash
regret drift
```

God modules often have stateful methods that produce different outputs depending
on mutable state. Run drift detection 5x to catch any non-determinism.

If drift is detected:
- Add `normalize` rules for timestamps/UUIDs if present
- Check for hidden mutable state (like `persistent_count` in inflect)
- If the state affects output legitimately, use `setup` steps to ensure
  consistent initial state before each capture

### Step 5: Save Truths

```bash
regret truth
```

Both KEBENARAN 1 (raw output) and KEBENARAN 2 (fingerprints) must agree.

### Step 6: Define Chains for Cross-Domain Flows

God modules often have flows that span multiple domains. Define chains
in `regrets/chains.json` to test these:

```json
{
  "chains": [
    {
      "id": "stateful-plural-flow",
      "steps": [
        {
          "cluster": "num-set-count",
          "input": 2,
          "setupSteps": [{"method": "classical", "args": [{"names": true}]}]
        },
        {
          "cluster": "plural-noun",
          "input": "cat"
        }
      ]
    }
  ]
}
```

The `setupSteps` field allows calling methods on the instance before the
entry function — critical for testing stateful interactions.

### Step 7: Decompose

Move each domain to its own module file. Key rules:

1. **Preserve the public API**: Add re-exports in `__init__.py`
   ```python
   from .plurals import _plnoun, _pl_special_verb
   from .articles import _indef_article
   # etc.
   ```
2. **Move data tables with their domain**: If `_plnoun` uses `pl_sb_irregular`,
   both must go to the same module
3. **Fix cross-domain imports**: If domain A calls domain B's functions,
   domain A must import from domain B's new module
4. **One domain, one file**: Each domain gets its own module

### Step 8: Validate After Each Move

After moving each domain:
```bash
regret validate
```

If RED:
- Fix the CODE, not the .regret files
- Check for missing imports
- Check for data tables that were left behind
- Check for `self.` references that need updating

### Step 9: Verify All Four Truths

```bash
# Verification 1: All clusters GREEN
regret validate

# Verification 2: Raw output matches KEBENARAN 1
# (run entry functions directly and compare)

# Verification 3: Fingerprints match KEBENARAN 2
regret verify-kebenaran

# Verification 4: Chain hashes match
regret chain --validate
```

## Special Considerations for Stateful Classes

When the god module contains a class with mutable state (like inflect's `engine`):

1. **`persistent_count` pattern**: Methods like `num()` set state that `plural()` reads.
   This means calling `num(2)` before `plural("cat")` changes the output.
   Test this with chains that include `setupSteps`.

2. **`classical_dict` pattern**: Configuration state that affects multiple methods.
   Test with separate clusters for different configurations.

3. **`mill_count` pattern**: Counter that's mutated as a side effect during computation.
   This makes `number_to_words()` non-reentrant — each cluster run must create
   a fresh instance.

4. **`_number_args` pattern**: Hidden state set on `self` and read by nested closures.
   This is invisible to Regrets but affects behavior. Test by verifying raw output
   (KEBENARAN 1), not just fingerprints.

## Manifest Example for a God Module Class

```json
{
  "projectName": "inflect",
  "clusters": [
    {
      "id": "plural-noun",
      "entry": "engine",
      "constructor": "engine",
      "constructorArgs": [],
      "classMethod": "plural_noun",
      "watches": ["_plnoun"],
      "module": "inflect",
      "stack": "python",
      "fingerprintLevel": "entry",
      "inputs": ["cat", "mouse", "goose", "ox", "person"]
    },
    {
      "id": "number-to-words",
      "entry": "engine",
      "constructor": "engine",
      "constructorArgs": [],
      "classMethod": "number_to_words",
      "watches": ["enword"],
      "module": "inflect",
      "stack": "python",
      "fingerprintLevel": "entry",
      "kwargs": true,
      "inputs": [
        {"num": 1},
        {"num": 42},
        {"num": 1234}
      ]
    }
  ]
}
```

Note: Each cluster creates a FRESH instance of `engine()` to avoid state leakage.
