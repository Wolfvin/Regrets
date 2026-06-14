# Case Study: pycrate — ASN.1/CSN.1 Telecom Protocol Codec Library

**Repository**: https://github.com/pycrate-org/pycrate
**Description**: A Python library providing full ASN.1 and CSN.1 compilers, plus encoders/decoders for telecom protocols (GERAN, UTRAN, EPC, 5G NAS, etc.)
**Language**: Python (pure, no C extensions)
**Size**: 824 Python files, ~2.15M lines (core ~44K lines, ASN.1 generated files ~2.1M lines)

---

## Why pycrate Is Challenging for Regression Testing

Pycrate is a deeply stateful, mutation-heavy library. Its architecture creates systematic blind spots for fingerprint-based regression testing tools. This case study documents the specific challenges and the Regrets improvements needed to handle them.

---

## Challenge 1: Mutable Object State

Every `ASN1Obj` and `Element` instance is stateful. Calling `obj.from_ber(buf)` mutates `obj._val`, `obj._struct`, and other internal attributes. A fingerprint that only captures the encoded bytes output would miss regressions in the internal state tree (e.g., wrong `Envelope` nesting, missing children, incorrect `_struct` generation in `_ws` variants).

**Regrets improvement**: `outputTransform: "state"` and `outputTransform: "state_private"` — deep object-state serialization with cycle detection and type discriminators. Uses `object_state_serialize()` from `fingerprint.py`.

---

## Challenge 2: Global Mutable Codec State

Encoding/decoding methods mutate class-level globals:
- `ASN1CodecPER.ALIGNED` — toggled between `True`/`False` on every `from_uper`/`from_aper` call
- `ASN1CodecBER.ENC_*` — 8 global flags mutated by `from_cer`/`to_cer`/`from_der`/`to_der`
- `ASN1CodecPER._off` — a class-level list used as a mutable stack

If two Regrets clusters run back-to-back (CER then DER), and the first fails to restore globals (exception mid-encode), the second cluster captures corrupted state.

**Regrets improvement**: `isolateGlobals` manifest field — snapshots and restores module-level globals around each cluster execution.

Example manifest entry:
```json
{
  "id": "ber-bool-decode",
  "entry": "from_ber",
  "isolateGlobals": {
    "pycrate_asn1rt.asnobj": ["ASN1CodecPER", "ASN1CodecBER"]
  }
}
```

---

## Challenge 3: Polymorphic Dispatch

The public `from_ber()`, `to_ber()`, `from_per()` etc. are defined once on `ASN1Obj` and call internal methods overridden in ~20 subclasses. Regrets clusters must be keyed on the concrete class + method, not just the method name.

**Solution**: Create separate clusters for each type, with explicit constructor instantiation:
```json
{
  "id": "ber-int-encode",
  "entry": "to_ber",
  "constructor": "INT",
  "constructorArgs": [],
  "classMethod": "to_ber"
}
```

---

## Challenge 4: Circular References

The object graph has multiple circular reference patterns:
- `Element._env` → parent `Envelope` → child → child._env points back
- `ASN1Obj._parent` → parent `SEQ` → `SEQ._cont[id]` → child._parent points back

Naive serialization will infinite-loop or hit recursion limits.

**Regrets improvement**: `object_state_serialize()` uses `id()`-based cycle detection. Circular references become `<CIRCULAR:ClassName>` markers, which are deterministic and fingerprint-safe.

---

## Challenge 5: Dual Encoding Variants (_ws vs non-_ws)

Every codec has two variants: `_from_per`/`_to_per` (returns raw bytes) and `_from_per_ws`/`_to_per_ws` (returns structured `Envelope` with `_struct`). The existing test suite only asserts bytes equality between variants — it never inspects `_struct`.

**Solution**: Use `outputTransform: "state_private"` for `_ws` variant clusters to capture the full internal state including `_struct`:

```json
{
  "id": "per-bool-decode-ws",
  "entry": "from_aper_ws",
  "outputTransform": "state_private",
  "constructor": "BOOL",
  "constructorArgs": [],
  "classMethod": "from_aper_ws"
}
```

---

## Challenge 6: BER/CER/DER Share Internal Implementation

`from_cer()` and `from_der()` both call `self.from_ber()` with different global codec flags. Without per-variant clusters, a CER-specific regression could be masked by BER/DER passing tests.

**Solution**: Create separate clusters for each public entry point with `isolateGlobals`:

```json
{
  "id": "cer-int-encode",
  "entry": "to_cer",
  "isolateGlobals": {
    "pycrate_asn1rt.asnobj": ["ASN1CodecBER"]
  }
}
```

---

## Challenge 7: Charpy Cursor Mutation

Decoding methods receive a `Charpy` instance and advance its `_cur` cursor. Off-by-one bit consumption errors can silently realign, producing correct-looking output from a wrong decode.

**Solution**: Include cursor position in the fingerprint by using `outputTransform: "state_private"` on the Charpy instance, or capture the consumed bytes count as part of the entry function's output wrapper.

---

## Challenge 8: init_modules() Post-Init Mutation

`init_modules()` performs massive post-hoc mutation on all ASN1Obj instances (setting `_parent` references, `_tagc` tag chains, constraint computation). An object before init is fundamentally different from after init.

**Solution**: Use `setup` manifest field to call `init_modules()` before fingerprinting:

```json
{
  "id": "ber-seq-decode",
  "constructor": "SEQ",
  "constructorArgs": [],
  "setup": [{"method": "init_modules", "args": []}],
  "classMethod": "from_ber"
}
```

---

## Manifest Template for pycrate

```json
{
  "projectName": "pycrate",
  "pythonPath": ".",
  "clusters": [
    {
      "id": "per-bool-decode",
      "module": "pycrate_asn1rt.asnobj_basic",
      "entry": "BOOL",
      "constructor": "BOOL",
      "constructorArgs": [],
      "classMethod": "from_aper",
      "stack": "python",
      "watches": ["BOOL"],
      "outputTransform": "state_private",
      "isolateGlobals": {
        "pycrate_asn1rt.asnobj": ["ASN1CodecPER"]
      },
      "inputs": [
        {"val": true, "buf": "80"},
        {"val": false, "buf": "00"}
      ]
    }
  ]
}
```
