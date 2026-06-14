# CJS Singleton Method Support

## The Problem

Many older Node.js projects (like `natural`, `underscore`, `lodash`) use CommonJS patterns that export **singleton objects with methods** rather than ES6 classes or plain functions.

```js
// stemmer.js — mixin constructor
module.exports = function Stemmer() {
  this.stem = function(token) { /* ... */ }
  this.tokenizeAndStem = function(text) { /* ... */ }
}

// porter_stemmer.js — singleton export
const Stemmer = require('./stemmer')
module.exports = new Stemmer()
```

The exported `PorterStemmer` is an **object** with a `.stem()` method, not a class you instantiate, and not a function you call directly.

Regrets' existing `classMethod` mode won't work because:
1. There's no class to instantiate with `new` — it's already an object
2. The Ghost Proxy's `construct` trap never fires
3. The entry function resolver expects a `function`, not an `object`

## The Solution: `singletonMethod` Mode

Add these fields to your cluster manifest:

```json
{
  "id": "porter-stemmer-stem",
  "entry": "PorterStemmer",
  "singletonMethod": "stem",
  "watches": ["PorterStemmer"],
  "file": "lib/natural/stemmers/porter_stemmer.js",
  "stack": "js",
  "fingerprintLevel": "entry",
  "inputs": ["running", "jumps", "easily"]
}
```

Or with an explicit `singletonName` (when `entry` is used for something else):

```json
{
  "id": "lancaster-stem",
  "entry": "LancasterStemmer",
  "singletonName": "LancasterStemmer",
  "singletonMethod": "stem",
  "watches": ["LancasterStemmer"],
  "file": "lib/natural/stemmers/lancaster_stemmer.js",
  "stack": "js",
  "inputs": ["running", "jumps"]
}
```

### Manifest Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `singletonMethod` | string | Yes* | The method name to call on the singleton object |
| `singletonName` | string | No | The exported name of the singleton (default: `entry`) |
| `entry` | string | Yes | Used to locate the singleton in the module (fallback for `singletonName`) |

*Required when the cluster target is a singleton object with methods.

### Flow

1. Import the module
2. Look up `singletonName ?? entry` in the module exports
3. Call `singleton[singletonMethod](input)` → output
4. Fingerprint the output
5. Watches are applied to the module (not the singleton)

### When to Use Each Mode

| Pattern | Mode | Example |
|---------|------|---------|
| `module.exports = function` | Function entry (default) | `TransliterateJa(str)` |
| `module.exports = Class` + `new Class()` | `classMethod` | `new SoundEx().process(str)` |
| `module.exports = new Constructor()` | `singletonMethod` | `PorterStemmer.stem(str)` |
| `module.exports = { fn1, fn2 }` | Function entry | `JaroWinklerDistance(s1, s2)` |

## Scanner Enhancements

`regret scan` now detects CJS patterns:

| Pattern | Detection |
|---------|-----------|
| `module.exports.Name = ...` | ✅ Detected |
| `exports.Name = ...` | ✅ Detected |
| `module.exports = function Name()` | ✅ Detected |
| `module.exports = ClassName` | ✅ Detected |
| `Name.prototype.method = function()` | ✅ Detected |
| `this.method = function()` | ✅ Detected (mixin pattern) |

These patterns are common in CJS-heavy projects and were previously invisible to the scanner.

## Validation

The `.regret` file stores `singletonMethod` and `singletonName` in metadata:

```
cluster: porter-stemmer-stem
fingerprint: abc1234
singletonName: PorterStemmer
singletonMethod: stem
---
INPUT  "running"
OUTPUT "run"
HASH   abc1234
```

During validation, if `singletonMethod` is present in the `.regret` file (from a previous capture), it takes precedence even if the manifest doesn't explicitly set it. This ensures backward compatibility — old captures continue to validate correctly.
