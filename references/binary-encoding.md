# Binary Encoding Libraries — TypedArray Inputs

Real-world case study from testing `qntm/braille-encode` — a library that encodes
binary data (Uint8Array) as Braille pattern characters and decodes them back.

---

## The Challenge

Binary encoding libraries often use `Uint8Array` as their primary input/output type.
This creates unique challenges for regret-based regression testing because:

1. **JSON serialization of TypedArrays**: `JSON.stringify(new Uint8Array([1,2,3]))`
   produces `{"0":1,"1":2,"2":3}`, not `[1,2,3]`. If not handled correctly, the
   fingerprint would be wrong.

2. **Manifest inputs are JSON**: You can't put a `Uint8Array` in `manifest.json`.
   You must use regular arrays (`[72, 101, 108, 108, 111]`) as inputs and ensure
   the target function accepts them.

3. **Decode functions return TypedArrays**: The `decode` function returns a
   `Uint8Array`, not a regular array. The fingerprint must handle this correctly.

---

## How Regrets Handles This

Regrets has built-in TypedArray support in its core modules:

### `deepClone` (ghost.js)
Converts TypedArrays to regular arrays before cloning, so the fingerprint
is computed on the array values, not the TypedArray object structure:
```js
if (ArrayBuffer.isView(val) && !(val instanceof DataView)) {
  return Array.from(val)
}
```

### `stableStringify` (fingerprint.js)
Serializes TypedArrays as regular arrays for consistent hashing:
```js
if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
  return '[' + Array.from(obj).map(stableStringify).join(',') + ']'
}
```

### `capture.js` output serialization
Converts TypedArray outputs to regular arrays in the `.regret` file:
```js
const serializableOutput = ArrayBuffer.isView(output) && !(output instanceof DataView)
  ? Array.from(output)
  : output
```

---

## Manifest Configuration for Binary Encoding Libraries

### Example: Encode Function (array input → string output)

```json
{
  "id": "braille-encode",
  "entry": "encode",
  "watches": ["encode"],
  "file": "src/index.js",
  "stack": "js",
  "fingerprintLevel": "entry",
  "description": "Encode binary data as Braille string",
  "inputs": [
    [72, 101, 108, 108, 111],
    [0],
    [255],
    [1, 2, 3, 4, 5],
    [128, 192, 224, 240, 248, 252, 254, 255]
  ]
}
```

Key decisions:
- **Use regular arrays as inputs**, not Uint8Array (JSON doesn't support it)
- **The target function must work with regular arrays** — most do, since
  `Uint8Array.prototype.reduce` and `Array.prototype.reduce` work identically
- **Include boundary values**: `0`, `255`, and multi-byte sequences

### Example: Decode Function (string input → TypedArray output)

```json
{
  "id": "braille-decode",
  "entry": "decode",
  "watches": ["decode"],
  "file": "src/index.js",
  "stack": "js",
  "fingerprintLevel": "entry",
  "description": "Decode Braille string back to binary data",
  "inputs": [
    "\u28FF",
    "\u2800",
    "\u2808\u2810\u2804"
  ]
}
```

Key decisions:
- **String inputs are JSON-safe** — no special handling needed
- **The output (Uint8Array) is automatically converted** to a regular array
  by `deepClone` before fingerprinting
- **Include single-character and multi-character inputs**

---

## Input Selection Strategy for Binary Encoding

When choosing inputs for binary encoding clusters, cover these categories:

| Category | Example | Why |
|----------|---------|-----|
| Zero byte | `[0]` | Boundary: maps to empty Braille pattern (⠀) |
| Max byte | `[255]` | Boundary: maps to full Braille pattern (⣿) |
| ASCII text | `[72, 101, 108, 108, 111]` | Real-world: "Hello" |
| Sequential | `[1, 2, 3, 4, 5]` | Catches ordering bugs |
| High-bit values | `[128, 192, 224, 240, 248, 252, 254, 255]` | Catches bit-7 handling bugs |
| Mixed range | `[0, 1, 127, 128, 255]` | Covers full range with boundary values |

---

## Verifying Cross-Consistency

For encoding libraries, the encode/decode roundtrip is the ultimate test.
After capturing fingerprints, manually verify:

```js
import { fingerprint } from './scripts/fingerprint.js'
import { encode, decode } from './src/index.js'

// Verify encode fingerprint
const input = [72, 101, 108, 108, 111]
const output = encode(input)
const fp = fingerprint(input, output, { normalize: [], ignoreFields: [] })
// fp should match the fingerprint in the .regret file

// Verify decode fingerprint
const decInput = '\u28FF'
const decOutput = Array.from(decode(decInput))
const decFp = fingerprint(decInput, decOutput, { normalize: [], ignoreFields: [] })
// decFp should match the fingerprint in the .regret file
```

---

## Lessons Learned from braille-encode Testing

1. **Small libraries are excellent regret targets** — with only 37 lines of code,
   the entire surface area is captured with just 2 clusters and 10 inputs.

2. **TypedArray handling is seamless** — Regrets' built-in TypedArray support
   in `deepClone`, `stableStringify`, and `capture.js` means no special
   manifest configuration is needed.

3. **Regular arrays as inputs work for Uint8Array-accepting functions** —
   Functions using `reduce`, `map`, or `for...of` work with both `Array`
   and `Uint8Array`. This is the case for most encoding libraries.

4. **Encoding/decoding pairs should be separate clusters** — they have
   different input types and different output types, so separate clusters
   make the fingerprint more precise and error messages clearer.

5. **Boundary values are critical** — byte values 0 and 255 map to visually
   distinct Braille characters and catch edge-case bugs in the lookup table.
