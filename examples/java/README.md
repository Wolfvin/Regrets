# Java Stack — Working Example

This directory contains a runnable end-to-end demo of the Java stack:
capture fingerprints from a real Java class, validate they PASS against
unchanged code, simulate a breaking refactor, watch validate FAIL, then
restore and watch validate PASS again.

## Files

| File | Purpose |
|------|---------|
| `Calculator.java` | Pure functions: `add`, `mul`, `toHex`, `reverse`, `parseKv`, `sumList` |
| `Calculator_breaking.java` | Same API, but 3 methods silently broken (off-by-one, lowercase hex, no-op reverse) |
| `manifest.json` | Declares 6 Java clusters covering different I/O shapes (numbers, strings, maps, lists, multi-arg) |
| `run-demo.sh` | End-to-end script: compile → capture → validate → swap breaking refactor → validate → restore |
| `regrets/*.regret` | Generated golden contracts (checked in for review) |

## Prerequisites

- JDK 21+ (JRE is not enough — `javac` is required)
- Bash

## Run the Demo

From the repo root:

```bash
bash examples/java/run-demo.sh
```

Expected output (abridged):

```
━━━ Step 2: Capture fingerprints ━━━
📡 Capturing: calculator-add
   ✅ Fingerprint: 13mxb0z
   📄 Saved: regrets/calculator-add.regret
...

━━━ Step 3: Validate (unchanged code) ━━━
  ✅ calculator-add                      13mxb0z                PASS
  ✅ calculator-mul                      2ja6uoq                PASS
  ✅ calculator-tohex                    zj2bzm9                PASS
  ✅ calculator-reverse                  5vpf9r6                PASS
  ✅ calculator-parsekv                  l50u27z                PASS
  ✅ calculator-sumlist                  1xumg20                PASS

━━━ Step 5: Validate (broken code — 3 silent breakages) ━━━
  ❌ calculator-add                      13mxb0z → 2gqjkyl      FAIL
  ✅ calculator-mul                      2ja6uoq                PASS
  ❌ calculator-tohex                    zj2bzm9 → 63x3uu8      FAIL
  ❌ calculator-reverse                  5vpf9r6 → 1hgg9kv      FAIL
  ✅ calculator-parsekv                  l50u27z                PASS
  ✅ calculator-sumlist                  1xumg20                PASS

━━━ Step 7: Final validate (restored code) ━━━
  ✅ (all 6 PASS)
```

## What the Demo Proves

1. **Capture works for diverse I/O shapes** — primitive longs, strings,
   `Map<String,String>` (with key-sorting verified), `List<Long>`, multi-arg
   calls.
2. **Validate detects silent breakages** — the three breaking refactors
   (`add` off-by-one, `toHex` lowercase, `reverse` no-op) would pass a naive
   "does it compile?" check. The fingerprint catches them.
3. **Validate does NOT false-positive on unchanged methods** — `mul`,
   `parseKv`, `sumList` continue to PASS while their siblings FAIL, proving
   the contract is per-method, not per-class.
4. **Cross-stack consistency** — the fingerprint `2zkvw4g` produced for the
   jaconv golden fixture (`["abcd","",true,true,true]` → `"ａｂｃｄ"`) matches
   between JS, Python, PHP, and now Java. Verified in
   `references/java.md` → Cross-Stack Fingerprint Verification.

## Inspecting a Generated .regret File

After running the demo, look at `regrets/calculator-parsekv.regret`:

```
cluster: calculator-parsekv
version: 1
fingerprint: l50u27z
captured: 2026-06-20T17:43:55.947957945Z
watches: [parseKv]
entry: Calculator::parseKv
stack: java
fingerprintLevel: entry
---
INPUT  "b=2;a=1;c=3"
OUTPUT {"a":"1","b":"2","c":"3"}
HASH   l50u27z
```

Note the OUTPUT line: even though `parseKv` inserted keys in order `b → a → c`
(matching the input string), the serialized output has keys in alphabetical
order `a → b → c`. This is `stableStringify` at work — the same input/output
pair will produce the same fingerprint regardless of map iteration order,
which is essential for Java where `LinkedHashMap` and `HashMap` iterate
differently.
