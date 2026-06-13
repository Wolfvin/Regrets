# Class Method Fingerprinting

## Problem

Many JavaScript/TypeScript libraries export classes, not standalone functions. To fingerprint class behavior, you often need to:

1. Construct an instance with specific arguments
2. Optionally call setup methods (e.g., `addDocument`, `train`)
3. Call the target method whose output you want to protect

Previously, Regrets only supported `entry` — a single module-level exported function. This made it impossible to fingerprint class-based APIs without writing adapter modules.

## Solution: `classMethod` in Manifest

Add the following fields to a cluster definition:

| Field | Required | Description |
|-------|----------|-------------|
| `classMethod` | ✅ (for class mode) | Name of the instance method to fingerprint |
| `constructor` | ❌ | Class name to instantiate (default: uses `entry` value) |
| `constructorArgs` | ❌ | Array of arguments for the constructor |
| `setup` | ❌ | Array of `{ method, args }` objects to call before the target method |

When `classMethod` is present in a cluster, Regrets switches to class-based mode:

1. `new Constructor(...constructorArgs)` → creates an instance
2. For each `{ method, args }` in `setup`: `instance[method](...args)`
3. `instance[classMethod](input)` → output (fingerprint this)
4. Watches are applied to instance methods via ghost proxy

### Example: TfIdf

```json
{
  "id": "tfidf-tfidfs",
  "entry": "TfIdf",
  "classMethod": "tfidfs",
  "watches": ["tfidfs"],
  "file": "lib/natural/tfidf/tfidf.js",
  "stack": "js",
  "constructorArgs": [],
  "setup": [
    { "method": "addDocument", "args": ["this document is about node."] },
    { "method": "addDocument", "args": ["this document is about ruby."] }
  ],
  "inputs": ["document"]
}
```

This creates a `TfIdf` instance, adds two documents via setup, then fingerprints `tfidf.tfidfs("document")`.

### Example: Spellcheck

```json
{
  "id": "spellcheck-corrections",
  "entry": "Spellcheck",
  "classMethod": "getCorrections",
  "watches": ["getCorrections"],
  "file": "lib/natural/spellcheck/spellcheck.js",
  "stack": "js",
  "constructorArgs": [["node", "ruby", "python"]],
  "inputs": ["nod"]
}
```

### Example: Trie

```json
{
  "id": "trie-keys-with-prefix",
  "entry": "Trie",
  "classMethod": "keysWithPrefix",
  "watches": ["keysWithPrefix"],
  "file": "lib/natural/trie/trie.js",
  "stack": "js",
  "constructorArgs": [],
  "setup": [
    { "method": "addStrings", "args": [["node", "notes", "notation", "ruby"]] }
  ],
  "inputs": ["no"]
}
```

## .regret File Format

When `classMethod` is used, the `.regret` file stores `constructor` and `classMethod` instead of `entry`:

```
cluster: tfidf-tfidfs
version: 1
fingerprint: abc1234
captured: 2025-06-14T00:00:00Z
watches: [tfidfs]
constructor: TfIdf
classMethod: tfidfs
stack: js
fingerprintLevel: entry
constructorArgs: []
setup: [{"method":"addDocument","args":["this document is about node."]},...]
---
INPUT  "document"
OUTPUT [1.5,...]
HASH   abc1234
```

## When to Use classMethod vs Adapter

### Use `classMethod` when:
- The class constructor and setup are deterministic
- You want to fingerprint a specific method's output
- The class has no external dependencies (network, DB, filesystem) that need mocking

### Use an adapter module when:
- The class requires complex dependency injection
- You need to transform the output before fingerprinting
- The class depends on browser APIs, `chrome.*`, or `window`

### Use `entry` (function-based) when:
- The library exports pure functions
- No setup is needed before calling the target function

## Validation

The `classMethod` mode works with all existing validation features:
- `regret validate` — compares fingerprints
- `regret drift` — runs multiple times for stability
- `regret health` — tracks cluster health
- `regret update` — safe update with audit trail
- `regret chain` — can chain class-based clusters

The .regret file stores `constructorArgs` and `setup` so that validation can reproduce the exact same instance state.
