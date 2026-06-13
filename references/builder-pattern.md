# Builder Pattern & Binary Output Variant

Regression fingerprinting for projects that use **builder patterns, stateful APIs,
fluent interfaces, or produce binary/non-JSON output**. These patterns are common
in generators, encoders, compilers, and serialization libraries.

## The Problem

The skill's core model assumes:

1. A single **pure function** as the entry point
2. **JSON-serializable** input and output
3. Functions called directly (not via `new`)

But many real-world libraries violate these assumptions:

| Pattern | Example | Why It Breaks |
|---------|---------|---------------|
| Builder pattern | `new Track() → addEvent() → new Writer(track) → buildFile()` | Multi-step workflow, no single entry |
| Binary output | `Writer.buildFile()` returns `Uint8Array` | `JSON.stringify(Uint8Array)` → `{"0":77,"1":84,...}` |
| Constructor entry | `new NoteEvent({pitch:'C4', duration:'4'})` | Ghost Proxy `apply` trap doesn't intercept `new` |
| Fluent API | `track.setTempo(120).addEvent(note)` | Methods return `this`, not data |
| Static methods | `Utils.getTickDuration('4')` | Entry is a method on a sub-object |
| CJS bundling | `import('./build/index.js')` | Exports nested under `mod.default` |

This reference explains how the skill handles each of these cases.

---

## Gap 1: CJS Module Import Resolution

**Problem:** When a CommonJS module (built by rollup, webpack, etc.) is loaded
via dynamic `import()`, Node.js wraps the `module.exports` object under
`mod.default`. The skill's `capture.js` and `validate.js` tried to access
`mod[entry]` directly, which failed.

**Solution:** Both scripts now auto-detect CJS modules and merge `mod.default`
with the top-level module object:

```js
function resolveModuleExports(rawModule) {
  if (rawModule.default && typeof rawModule.default === 'object') {
    if (Object.keys(rawModule.default).length > 0 && !rawModule.default.__esModule) {
      return { ...rawModule.default, ...rawModule }
    }
  }
  return rawModule
}
```

This works for both ESM (where exports are at top level) and CJS (where they're
under `.default`). No manifest changes required.

---

## Gap 2: Constructor Entry Points

**Problem:** The Ghost Proxy's `apply` trap only intercepts regular function
calls (`fn(args)`), not constructor calls (`new fn(args)`). For class-based
libraries, the entry point is often a constructor.

**Solution:** The Ghost Proxy now includes a `construct` trap:

```js
new Proxy(original, {
  apply(target, thisArg, args) { /* ... regular calls ... */ },
  construct(target, args, newTarget) {
    const instance = Reflect.construct(target, args, newTarget)
    recorder.push({ fn: fnName, args: deepClone(args), result: '[instance]', construct: true })
    return instance
  }
})
```

### Manifest: `entryType` Field

Add `"entryType": "constructor"` to the cluster definition when the entry point
is a class that needs to be called with `new`:

```json
{
  "id": "note-event",
  "entry": "NoteEvent",
  "entryType": "constructor",
  "watches": ["NoteEvent"],
  "file": "build/index.js",
  "stack": "js",
  "inputs": [
    {"pitch": "C4", "duration": "4"}
  ]
}
```

When `entryType` is `"constructor"`, capture.js calls `new NoteEvent(input)`
instead of `NoteEvent(input)`.

---

## Gap 3: Binary Output (Uint8Array, Buffer, etc.)

**Problem:** Functions that return `Uint8Array`, `Buffer`, or other typed arrays
produce broken JSON representations. `JSON.stringify(new Uint8Array([77,84]))`
produces `{"0":77,"1":84}` — an indexed object, not an array. This makes
fingerprints brittle and meaningless.

**Solution:** The `fingerprint.js` module now includes `normalizeBinaryOutput()`
which auto-converts binary types to base64 strings before hashing:

```js
// Auto-applied inside stableStringify() and extractSchema()
if (output instanceof Uint8Array) {
  return Buffer.from(output).toString('base64')
}
```

This means **existing clusters continue to work** (binary types are rare in
typical web apps), but any new cluster that returns binary data will
automatically get a stable, compact fingerprint.

### Manifest: `outputMethod` Field

For cases where the entry returns an object with a method that produces the
actual fingerprintable output:

```json
{
  "id": "midi-writer-output",
  "entry": "Writer",
  "entryType": "constructor",
  "outputMethod": "base64",
  "watches": ["Writer"],
  "file": "build/index.js",
  "stack": "js"
}
```

This calls `writer.base64()` on the output before fingerprinting. The result
is a base64 string representing the complete MIDI file — a perfect fingerprint
target.

### Manifest: `outputTransform` Field

For cases where a simple transformation is needed:

| Transform | Input | Output | Use Case |
|-----------|-------|--------|----------|
| `"base64"` | `Uint8Array` / `Buffer` | base64 string | Binary file generators |
| `"hex"` | `Uint8Array` / `Buffer` | hex string | Cryptographic hashes, binary protocols |
| `"array"` | Any typed array | Regular `Array` | When array indices matter |
| `"json"` | Any object | JSON string | Complex objects that don't stringify well |
| `"string"` | Any value | `String(value)` | Simple string conversion |

```json
{
  "id": "binary-encoder",
  "entry": "encode",
  "outputTransform": "hex",
  "watches": ["encode"],
  "file": "src/encoder.js",
  "stack": "js"
}
```

**Priority:** `outputMethod` > `outputTransform` > auto-detection (binary
types are auto-converted to base64 when neither is specified).

---

## Gap 4: Stateful Builder Pattern (setupSteps)

**Problem:** Some libraries require a multi-step setup before the meaningful
output can be produced. For example, a MIDI file generator:

```js
const track = new Track()                    // Step 1: Create track
track.addEvent(new NoteEvent({pitch:'C4'}))  // Step 2: Add event
const writer = new Writer(track)             // Step 3: Create writer
const output = writer.base64()               // Step 4: Get output
```

The skill's "single entry function" model doesn't capture this workflow.

**Solution:** The `setupSteps` manifest field defines a sequence of setup
actions that run before the entry point. Objects created during setup are
available in a `context` that the entry function can access.

### Manifest: `setupSteps` Field

```json
{
  "id": "midi-file-generation",
  "entry": "base64",
  "entryTarget": "writer",
  "watches": ["NoteEvent", "Track.addEvent", "Writer"],
  "file": "build/index.js",
  "stack": "js",
  "outputMethod": "base64",
  "setupSteps": [
    { "action": "new", "target": "Track", "as": "track" },
    { "action": "new", "target": "NoteEvent", "args": [{"pitch": "C4", "duration": "4"}], "as": "note" },
    { "action": "call", "on": "track", "method": "addEvent", "args": [{"$ref": "note"}] },
    { "action": "new", "target": "Writer", "args": [{"$ref": "track"}], "as": "writer" }
  ]
}
```

### Step Actions

| Action | Fields | Description |
|--------|--------|-------------|
| `"new"` | `target`, `args?`, `as` | Create a new instance: `new Target(...args)` |
| `"call"` | `on`, `method`, `args?`, `as?` | Call method on context object: `context[on].method(...args)` |
| `"eval"` | `expr`, `as?` | Evaluate a JS expression with `module` and `context` available |

The `as` field stores the result in the setup context for use in later steps.
The `entryTarget` field specifies which context object the entry method is on.

**Note:** `setupSteps` are executed fresh for each input and each validation run,
ensuring isolation between runs.

---

## Gap 5: Dot-Notation Entry Paths (Static/Nested Methods)

**Problem:** Some libraries organize functions as methods on sub-objects
(e.g., `Utils.getTickDuration()`). The manifest's `entry` field only supported
top-level named exports.

**Solution:** The `entry` and `watches` fields now support dot-notation paths:

```json
{
  "id": "get-tick-duration",
  "entry": "Utils.getTickDuration",
  "watches": ["Utils.getTickDuration"],
  "file": "build/index.js",
  "stack": "js",
  "inputs": ["4", "2", "8", "1"]
}
```

Both capture.js and validate.js resolve these paths by traversing the module
object. The ghost proxy also flattens these into watchable top-level keys.

---

## Gap 6: Fluent API / Methods Returning `this`

**Problem:** Builder-pattern methods like `track.addEvent()` return `this`
(the Track object) for chaining. When the ghost proxy records these calls,
the "result" is a complex object with circular references that doesn't
serialize well for fingerprinting.

**Solution:** Don't fingerprint the return value of builder methods. Instead:

1. Use `setupSteps` to build the object
2. Use `outputMethod` or `outputTransform` to extract the meaningful output
3. Fingerprint the transformed output, not the builder object

Example:
```json
{
  "id": "track-to-midi",
  "entry": "base64",
  "entryTarget": "writer",
  "outputMethod": "base64",
  "setupSteps": [
    { "action": "new", "target": "Track", "as": "track" },
    { "action": "call", "on": "track", "method": "setTempo", "args": [120] },
    { "action": "call", "on": "track", "method": "addEvent", "args": [{"pitch":"C4","duration":"4"}] },
    { "action": "new", "target": "Writer", "args": [{"$ref":"track"}], "as": "writer" }
  ]
}
```

The `addEvent` call returns the Track object, but we don't fingerprint that.
We fingerprint `writer.base64()` — the actual MIDI data.

---

## Complete Manifest Example: MidiWriterJS

```json
{
  "clusters": [
    {
      "id": "midi-note-c4",
      "entry": "Utils.getTickDuration",
      "watches": ["Utils.getTickDuration"],
      "file": "build/index.js",
      "stack": "js",
      "inputs": ["4", "2", "8", "16", "1"]
    },
    {
      "id": "midi-pitch-lookup",
      "entry": "Utils.getPitch",
      "watches": ["Utils.getPitch"],
      "file": "build/index.js",
      "stack": "js",
      "inputs": ["C4", "F7", "A4", "B#4"]
    },
    {
      "id": "midi-single-note",
      "entry": "base64",
      "entryTarget": "writer",
      "watches": ["NoteEvent"],
      "file": "build/index.js",
      "stack": "js",
      "outputMethod": "base64",
      "setupSteps": [
        { "action": "new", "target": "Track", "as": "track" },
        { "action": "new", "target": "NoteEvent", "args": [{"pitch":"C4","duration":"4"}], "as": "note" },
        { "action": "call", "on": "track", "method": "addEvent", "args": [{"$ref":"note"}] },
        { "action": "new", "target": "Writer", "args": [{"$ref":"track"}], "as": "writer" }
      ]
    }
  ]
}
```

---

## Summary of New Manifest Fields

| Field | Type | Description |
|-------|------|-------------|
| `entryType` | `"function"` \| `"constructor"` | How to call the entry: direct call or `new` |
| `outputMethod` | `string` | Method to call on the output object before fingerprinting (e.g., `"base64"`) |
| `outputTransform` | `"base64"` \| `"hex"` \| `"array"` \| `"json"` \| `"string"` | Named transformation for non-JSON outputs |
| `setupSteps` | `array` | Multi-step workflow definition for builder patterns |
| `entryTarget` | `string` | Name of the setup context object the entry method is on |

All new fields are **optional** and backward-compatible. Existing manifests
without these fields work exactly as before.
