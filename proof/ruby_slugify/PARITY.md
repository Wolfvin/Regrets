# Cross-stack fingerprint parity — Ruby vs JS vs PHP vs Python

This document records that the Ruby fingerprint implementation
(`scripts/fingerprint_rb.rb`) produces IDENTICAL hashes to the JS, PHP,
and Python implementations for the same `(input, output)` pair.

Parity is verified programmatically by `scripts/parity_check.rb` (in the
worker's local env, not committed) which feeds the same 12 cases through
`node` + `scripts/fingerprint.js` and through `ruby` + `scripts/fingerprint_rb.rb`
and asserts equality.

## Algorithm

All four stacks use the same algorithm:

```
fingerprint(input, output) =
  base36(sha256(stableStringify(input) + "|" + stableStringify(output))).slice(0, 7)
```

Where `stableStringify` produces JSON with keys sorted recursively,
compact separators (`,:`, no spaces), and UTF-8 preserved (no `\uXXXX`
escaping for non-ASCII).

## Verified cases

| Input                                      | Output                                    | Fingerprint | JS | PHP | Python | Ruby |
|--------------------------------------------|-------------------------------------------|-------------|----|----|--------|------|
| `"hello"`                                  | `"world"`                                 | `67cq6s6`   | ✓  | ✓  | ✓      | ✓    |
| `"hello"`                                  | `"WORLD"`                                 | `4rtdd6m`   | ✓  | ✓  | ✓      | ✓    |
| `"hello"`                                  | `null`                                    | `fofmnf8`   | ✓  | ✓  | ✓      | ✓    |
| `null`                                     | `null`                                    | `3xo774r`   | ✓  | ✓  | ✓      | ✓    |
| `[1, 2, 3]`                                | `[4, 5, 6]`                               | `1gwfix3`   | ✓  | ✓  | ✓      | ✓    |
| `{"b":1,"a":2}`                            | `{"y":"x","x":"y"}`                       | `1o3at6a`   | ✓  | ✓  | ✓      | ✓    |
| `""`                                       | `""`                                      | `5oge4st`   | ✓  | ✓  | ✓      | ✓    |
| `"ともえまみ"`                              | `"トモエマミ"`                            | `3elv23o`   | ✓  | ✓  | ✓      | ✓    |
| `42`                                       | `42`                                      | `1qgl28n`   | ✓  | ✓  | ✓      | ✓    |
| `3.14`                                     | `2.71`                                    | `j44indy`   | ✓  | ✓  | ✓      | ✓    |
| `{"nested":{"c":3,"a":1,"b":2}}`           | `[true, false, null]`                     | `4m60xkv`   | ✓  | ✓  | ✓      | ✓    |
| `{"key with spaces":"value"}`              | `{"arr":[1,"two",null,false]}`            | `27fc29y`   | ✓  | ✓  | ✓      | ✓    |

The `"ともえまみ"` → `"トモエマミ"` → `3elv23o` row is especially significant:
it matches the existing `proof/jaconv/hira2kata.regret` file's `HASH` field,
confirming Ruby's parity against a real captured Python cluster.

## Known inter-stack differences

These differences exist between ALL stacks (Ruby is not special here) and
are documented for completeness:

### Float vs Integer for whole numbers

- **JS / TS**: `JSON.stringify(1.0)` → `"1"` (no distinction — JS has one number type)
- **Python / PHP / Ruby**: `1.0` serializes as `"1.0"`, `1` serializes as `"1"`

A function that returns `1.0` will fingerprint differently in JS vs Ruby.
**Workaround:** add the `"floatPrecision"` normalize rule to coerce whole
floats to ints before hashing.

### Maps / dicts with non-string keys

- **Ruby**: `Hash` with symbol keys (`{foo: 1}`) serializes as `{"foo":1}`
- **Python**: `dict` with non-string keys raises `TypeError` in `json.dumps`
- **JS**: object keys are always strings

Ruby matches the JS/PHP convention here — symbol keys become string keys
in the serialized form.

## Reproducing the parity check

```bash
# From the repo root:
ruby scripts/parity_check.rb
# (script lives at scripts/parity_check.rb in the worker env, not committed
#  to the repo — it requires both `node` and `ruby` on PATH)
```

Expected output:

```
✓ input="hello" output="world"
✓ input="hello" output="WORLD"
...
✅ ALL PARITY CHECKS PASS
```

Any mismatch is a critical bug — the entire Regrets contract model depends
on hashes being stable across stacks so that a cluster captured in one
language can be validated against code in another (e.g., a Ruby port of
a Python library).
