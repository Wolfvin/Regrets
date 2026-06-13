# CommonJS Libraries with Parameterized Modes — Regrets Reference Guide

Regression fingerprinting for CommonJS libraries that expose multiple "modes" or "dialects" of the same operation, where the output depends on a configuration parameter (mode, font, dialect, etc.).

## The Challenge

Some libraries expose a single function name (`transcribe`, `encode`, `convert`) but its output varies based on a **mode parameter** — a configuration object or enum that selects which dialect/variant to use. This creates uncertainty when writing a Regrets manifest:

1. **Which mode to fingerprint?** If you test only one mode, regressions in other modes go undetected
2. **Same function name, different behavior** — A single `entry` in the manifest can only capture one set of inputs
3. **Mode as implicit dependency** — The mode object may be created by a `makeOptions()` factory, and the real behavioral contract depends on what `makeOptions` returns

### Real-World Example: tengwarjs

`kriskowal/tengwarjs` is a Tengwar (Tolkien's Elvish alphabet) transcriber with three modes:

| Mode | File | Key Functions |
|------|------|---------------|
| General Use | `general-use.js` | `transcribe()`, `encode()`, `parse()`, `makeOptions()` |
| Classical | `classical.js` | `transcribe()`, `encode()`, `parse()`, `makeOptions()` |
| Beleriand | `beleriand.js` | `transcribe()`, `encode()`, `parse()`, `makeOptions()` |

Each mode has the same function names but different behavior. Additionally:
- `transcribe()` output depends on `font` (Annatar vs Parmaita)
- `encode()` output is pure notation (font-independent)
- `makeOptions()` creates the options object that controls behavior

---

## Solution: One Cluster Per Mode

Create separate clusters for each mode variant. Each cluster points to the same **file** but uses different **entry functions** or different **inputs** with the mode configuration baked in.

### Strategy A: Wrapper Module (Recommended)

When the library's entry function takes a mode object as parameter, create a thin wrapper module that captures the mode:

```js
// regrets/adapters/general-use-encode.js
"use strict";
var GeneralUse = require("../../general-use");

module.exports = function encode(text) {
    return GeneralUse.encode(text, {});
};
```

```js
// regrets/adapters/general-use-encode-black-speech.js
"use strict";
var GeneralUse = require("../../general-use");

module.exports = function encode(text) {
    return GeneralUse.encode(text, { language: "black-speech" });
};
```

Point the manifest at the wrapper:

```json
{
  "id": "general-use-encode",
  "entry": "module.exports",
  "watches": ["module.exports"],
  "file": "regrets/adapters/general-use-encode.js",
  "stack": "js",
  "inputs": ["hello", "aragorn", "mellon"]
}
```

### Strategy B: Use `encode()` Instead of `transcribe()`

When a library has both a "pure" function and a "rendering" function, always prefer the pure one for fingerprinting:

| Function | Output | Fingerprintable? | Why |
|----------|--------|-------------------|-----|
| `encode()` | `"romen:a;ungwe:a"` | ✅ Yes | Pure notation, font-independent, deterministic |
| `transcribe()` | `"<abbr>1#E</abbr>"` | ⚠️ Maybe | Font-dependent HTML, needs normalization |
| `parse()` | Column objects | ❌ No | Non-serializable objects with methods |

**Rule:** If a library has `encode` and `transcribe`, use `encode` for fingerprinting. Use `transcribe` only if you also need to catch rendering regressions.

---

## CJS Module Handling

### Pure CJS Exports

When a library uses only `exports.xxx = function` (no `module.exports = { ... }` default), Regrets' dynamic `import()` will create a namespace where each export is a named export:

```js
// Source (CJS)
exports.encode = function(text, options) { ... }
exports.transcribe = function(text, options) { ... }
exports.makeOptions = function(options) { ... }
```

```js
// After dynamic import() in capture.js
const mod = await import('./general-use.js')
// mod.encode → the function
// mod.transcribe → the function
// mod.default → { encode, transcribe, makeOptions } (the full exports object)
```

This works correctly with Regrets' existing CJS merge logic because the merge only activates when `mod.default` is a non-null object.

### Exports That Are Functions (Not Objects)

When `module.exports = function` (a single function export), the import behavior differs:

```js
// Source (CJS)
module.exports = function encode(text, options) { ... }
```

```js
// After dynamic import()
const mod = await import('./encode.js')
// mod.default → the function
// mod.encode → undefined
```

In this case, you need a wrapper module that re-exports as a named function, or point the manifest entry to the function via `mod.default`:

```json
{
  "entry": "default",
  "watches": ["default"]
}
```

### CJS `require()` Chaining

When the entry file uses `require()` to load other files in the same project, Regrets' `import()` will correctly resolve these as long as:
1. The required files exist at the relative paths from the entry file
2. The `file` field in the manifest is relative to the project root

---

## Continuation-Passing Style (CPS) Parsers

Some libraries use a continuation-passing style where parser functions return functions that accept characters:

```js
function parseWord(callback, options) {
    return parseColumn(function (column) {
        if (column) {
            return parseWord(callback, options, columns.concat([column]));
        } else {
            return function (character) {
                // continue parsing...
            };
        }
    }, options);
}
```

This is safe for Regrets because:
1. The CPS is internal — the public API (`encode`, `transcribe`) drives the parser to completion
2. `ghost.js` wraps the top-level function, which returns the final result synchronously
3. The intermediate continuation functions are never directly called by the agent

**Pitfall:** If you try to fingerprint the `parse()` function directly, you'll get Column objects with non-enumerable properties. Use `encode()` instead, which produces deterministic strings.

---

## HTML Output Normalization

When fingerprinting `transcribe()` output that includes HTML:

1. Use `normalize: []` if the output is stable
2. If the output contains error messages with dynamic content, use `ignoreFields: ["errors"]`
3. If the HTML includes `class` attributes from CSS modules, add them to the strip list

For tengwarjs specifically, the `transcribe()` output is deterministic given the same text and font — no timestamps, no UUIDs. No normalize rules needed.

---

## Manifest Template for Parameterized CJS Libraries

```json
{
  "clusters": [
    {
      "id": "general-use-encode",
      "entry": "encode",
      "watches": ["encode"],
      "file": "general-use.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "description": "General Use mode encode — Latin text to Tengwar Notation",
      "inputs": ["hello", "aragorn", "mellon", "namarie"]
    },
    {
      "id": "general-use-encode-black-speech",
      "entry": "encode",
      "watches": ["encode"],
      "file": "regrets/adapters/general-use-black-speech.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "description": "General Use Black Speech mode encode",
      "inputs": ["ash nazg", "gimbatul"]
    },
    {
      "id": "classical-encode",
      "entry": "encode",
      "watches": ["encode"],
      "file": "classical.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "description": "Classical mode encode — Latin to Tengwar Notation (Quenya)",
      "inputs": ["namarie", "elbereth"]
    },
    {
      "id": "beleriand-encode",
      "entry": "encode",
      "watches": ["encode"],
      "file": "beleriand.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "description": "Beleriand mode encode — Latin to Tengwar Notation (Sindarin)",
      "inputs": ["mellon", "barad dur"]
    }
  ]
}
```

---

## Key Decision: Wrapper vs Direct

| Scenario | Use Wrapper? | Why |
|----------|-------------|-----|
| Entry function needs mode parameter | ✅ Yes | Capture mode in adapter, expose as zero-arg function |
| Entry function is pure (no params needed) | ❌ No | Point directly to the source file |
| Entry function produces non-serializable output | ✅ Yes | Adapter converts to serializable form |
| Multiple modes, same function name in different files | ❌ No | Use different `file` paths in manifest |

---

## Case Study: tengwarjs

A complete case study applying this reference to `kriskowal/tengwarjs`:

- **4 clusters** covering all 3 modes + Black Speech variant
- **`encode()`** chosen over `transcribe()` for fingerprint stability
- **No normalize rules** needed — Tengwar Notation output is deterministic
- **1 wrapper module** for the Black Speech variant (bakes `{ language: "black-speech" }` into options)
- **All other clusters** point directly to the source files

This demonstrates that Regrets can handle parameterized CJS libraries by combining:
1. One cluster per mode
2. Wrapper modules for variant configurations
3. Pure notation functions (encode) over rendering functions (transcribe)
