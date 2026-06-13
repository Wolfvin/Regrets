# Stateful Class Testing Pattern

## Overview

When the target library exposes a class with mutable instance state, standard
function-level fingerprinting can produce false negatives. This reference
explains how to use Regrets safely with stateful classes like
`jaraco/inflect`'s `engine`, where methods such as `classical()` and `num()`
mutate the instance and affect the output of subsequent calls.

## The Problem

A stateful class has methods that:
1. **Read instance state** — output depends on `self.some_attribute`
2. **Mutate instance state** — calling `obj.classical(all=True)` changes
   `obj.classical_dict`, which changes how `obj.plural()` behaves

When Regrets captures fingerprints across multiple inputs, the state from
input 1 leaks into input 2. This causes:
- **Non-deterministic fingerprints** if the capture order changes
- **Drift** between runs if the class is re-instantiated differently
- **False negatives** after refactoring if state initialization order changes

### Concrete Example: `jaraco/inflect`

```python
import inflect
p = inflect.engine()

# State mutation: classical() changes internal dict
p.classical(all=True)
# Now plural() behaves differently for certain words
p.plural_noun("brother")  # → "brethren" (classical) instead of "brothers"

# Without state reset, the next input inherits classical mode
p.plural_noun("cow")  # → "kine" (classical) instead of "cows"
```

If we cluster `plural_noun` with inputs `["brother", "cow"]`, the fingerprint
depends on whether `classical()` was called. If state isn't reset between
inputs, the second input's result depends on the first.

## Solution: Fresh Instance Per Input

The manifest should use the `classMethod` pattern, which creates a **fresh
instance** for each input:

```json
{
  "clusters": [
    {
      "id": "plural-noun",
      "entry": "engine",
      "classMethod": "plural_noun",
      "constructor": "engine",
      "stack": "python",
      "module": "inflect",
      "watches": ["plural_noun", "_plnoun"],
      "inputs": [
        "cat",
        "brother",
        "fish",
        "criterion"
      ]
    }
  ]
}
```

With `classMethod`, Regrets creates `new engine()` for each input, ensuring
clean state. But what if you need to test behavior *after* state mutation?

## Solution: Setup Steps for State Mutation

Use the `setup` field to apply state mutations before calling the target
method:

```json
{
  "id": "plural-noun-classical",
  "entry": "engine",
  "classMethod": "plural_noun",
  "constructor": "engine",
  "stack": "python",
  "module": "inflect",
  "setup": [
    { "method": "classical", "args": ["all"] }
  ],
  "watches": ["plural_noun", "_plnoun"],
  "inputs": ["brother", "cow"]
}
```

This tests: "After calling `classical(all=True)`, does `plural_noun()` produce
the correct classical forms?"

## Cluster Design for Stateful Classes

When designing clusters for a stateful class, create **separate clusters**
for each state configuration:

| Cluster | State | What it tests |
|---------|-------|---------------|
| `plural-noun-default` | Fresh instance | Default (modern) pluralization |
| `plural-noun-classical` | `classical(all=True)` | Classical pluralization |
| `singular-noun-default` | Fresh instance | Default singularization |
| `compare-default` | Fresh instance | Default word comparison |
| `indef-article` | Fresh instance | a/an determination |
| `ordinal` | Fresh instance | Ordinal number generation |
| `number-to-words` | Fresh instance | Number → word conversion |

**Rule**: One cluster = one state configuration. Never mix states within a
cluster.

## Python Capture Implementation

The Python capture script (`capture.py`) already supports `classMethod` for JS
stacks. For Python stacks, the capture should:

1. Import the module
2. Get the class constructor
3. For each input:
   a. Create a fresh instance: `instance = ClassName(*constructorArgs)`
   b. Apply setup steps: `instance.setup_method(*args)`
   c. Call the target method: `result = instance.classMethod(input)`
   d. Record (input, result) with the recorder

### Manifest Fields for Stateful Classes

| Field | Purpose | Example |
|-------|---------|---------|
| `constructor` | Class name to instantiate | `"engine"` |
| `classMethod` | Instance method to fingerprint | `"plural_noun"` |
| `constructorArgs` | Args for constructor | `[]` |
| `setup` | Methods to call before the target | `[{"method": "classical", "args": ["all"]}]` |
| `module` | Python module path | `"inflect"` |

## Drift Prevention

Stateful classes are particularly prone to drift because:
1. **Hidden state** — attributes set in `__init__` may depend on module-level
   data that changes between imports
2. **Order sensitivity** — if you reuse an instance across inputs, state leaks
3. **Global state** — some classes modify module-level variables

To prevent drift:
- Always use `classMethod` with fresh instances per input
- Run `regret drift` (5 runs) after initial capture
- If drift is detected, check for hidden global state
- Add `normalize` rules for any non-deterministic output (timestamps, etc.)

## Checklist for Stateful Class Clustering

Before writing a manifest for a stateful class:

1. [ ] Identify which methods mutate instance state
2. [ ] Identify which methods depend on instance state
3. [ ] Group methods by their state dependency (each group = one cluster)
4. [ ] For each cluster, decide on the initial state (constructor args + setup)
5. [ ] Use `classMethod` + `setup` in the manifest
6. [ ] Create separate clusters for different state configurations
7. [ ] Test with `regret drift` — all must be STABLE
8. [ ] Never reuse an instance across different clusters

## Real-World Example: `jaraco/inflect`

The `inflect` library is a 4,000-line Python module with a single `engine`
class containing 66 methods. The key state is:

- `classical_dict` — controls classical vs modern inflection
- `persistent_count` — set by `num()`, affects subsequent `plural()` calls
- `thegender` — set by `gender()`, affects pronoun resolution
- User-defined lists — populated by `defnoun()`, `defverb()`, etc.

This makes it an excellent example of a stateful class where fresh instances
per input are essential for deterministic fingerprinting.
