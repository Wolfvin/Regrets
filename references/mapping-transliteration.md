# Mapping/Transliteration Libraries — Regrets Reference Guide

Libraries that transform text through character mappings (transliteration, rune conversion, phonetic alphabets, braille, etc.) are excellent targets for Regrets. This guide covers how to set up regression testing for these libraries, which typically use `Map<string, string>` dictionaries and pure transformation functions.

---

## Why Mapping Libraries Are Perfect for Regrets

Mapping/transliteration libraries have ideal properties for fingerprint-based regression testing:

1. **Pure functions** — Same input always produces the same output. No randomness, no timestamps, no side effects.
2. **Deterministic** — Character-by-character mapping is inherently stable.
3. **Roundtrip testable** — `decode(encode(x)) === x` validates both directions.
4. **No normalization needed** — No timestamps, UUIDs, or dynamic values to strip.
5. **Entry-level fingerprinting is sufficient** — The output is the contract; internal mapping structure doesn't matter.

---

## Common Patterns in Mapping Libraries

### Pattern 1: Direct Map-Based Transformation

The library creates a `Map<string, string>` and iterates over input characters:

```typescript
export const lettersToRunes = (content: string): string => {
  const mapping = getLetterMapping();
  let result = "";
  for (const char of content.split("")) {
    result += mapping.get(char.toLowerCase()) ?? char;
  }
  return result;
};
```

**Regrets setup**: One cluster for each direction (encode/decode). Use `fingerprintLevel: "entry"`.

### Pattern 2: Multiple Variants

Some libraries support multiple output variants (e.g., Long Branch vs Short Twig runes):

```typescript
export const lettersToRunes = (content: string, variant: Variant): string => {
  if (variant === Variant.ShortTwig) return lettersToShortTwigRunes(content);
  return lettersToLongBranchRunes(content);
}
```

**Regrets setup**: Create separate clusters for each variant function. Don't use the dispatching function as entry — point to the specific variant implementations instead.

### Pattern 3: Shared Core with Different Mappings

A single core function (`transform`/`transliterate`) is used with different mapping dictionaries:

```typescript
export const transliterate = (content: string, dictionary: Map<string, string>): string => {
  // shared logic
};
```

**Regrets setup**: Don't fingerprint the core function directly (it requires a Map argument that's hard to provide via manifest inputs). Instead, fingerprint the dialect-specific wrapper functions that already have the mapping baked in.

---

## Manifest Template

```json
{
  "clusters": [
    {
      "id": "elder-futhark-letters-to-runes",
      "entry": "lettersToRunes",
      "watches": ["lettersToRunes"],
      "file": "dist/dialects/elder-futhark.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "description": "Transform Latin letters to Elder Futhark runes",
      "inputs": ["hello", "WORLD", "", "123"]
    },
    {
      "id": "elder-futhark-runes-to-letters",
      "entry": "runesToLetters",
      "watches": ["runesToLetters"],
      "file": "dist/dialects/elder-futhark.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "description": "Transform Elder Futhark runes to Latin letters",
      "inputs": ["ᚠᚢᚦᚨᚱᚲ"]
    }
  ]
}
```

### Input Selection Strategy

For mapping libraries, choose inputs that cover:

| Input Type | Example | Purpose |
|------------|---------|---------|
| Common word | `"hello"` | Happy path |
| Full alphabet | All mapped characters | Exhaustive coverage |
| Uppercase | `"HELLO"` | Case handling |
| Unmapped chars | `"12345"` | Pass-through behavior |
| Empty string | `""` | Edge case |
| Accented chars | `"áéíóú"` | Diacritics mapping |
| Historical text | Real inscriptions | Domain-specific validation |

---

## Handling CommonJS Compiled TypeScript

Many TypeScript mapping libraries compile to CommonJS with `exports.default = { ... }`. When Regrets imports these via dynamic `import()`:

1. Named exports work directly: `lettersToRunes`, `runesToLetters`
2. The `default` export contains the full API object
3. Regrets' capture.js merges `default` into the namespace automatically

**Tip**: Point the manifest `file` field to individual dialect modules (e.g., `dist/dialects/elder-futhark.js`) rather than the barrel file (`dist/index.js`). This avoids issues with barrel files that import `package.json` or other problematic modules.

---

## Roundtrip Property Testing

For encode/decode libraries, the most powerful regression test is the roundtrip:

```
decode(encode(x)) === x
```

This catches bugs in both directions simultaneously. Create separate clusters for encode and decode, then verify both independently.

**Important**: Some information may be lost in roundtrip (e.g., case: `"HELLO"` → runes → `"hello"`). This is expected and not a bug — document it as a known limitation of the mapping, not a Regrets issue.

---

## Case Study: riimut (Rune Transliteration Library)

**Repository**: https://github.com/stscoundrel/riimut
**Description**: Transform Latin letters to runes and vice versa. Supports Elder Futhark, Younger Futhark, Medieval Futhork, and Anglo-Saxon Futhorc.
**Language**: TypeScript (compiled to CommonJS)
**Dependencies**: Zero

### Clusters Created

| Cluster ID | Entry Function | Direction | Inputs |
|------------|---------------|-----------|--------|
| `elder-futhark-letters-to-runes` | `lettersToRunes` | Latin → Elder Futhark | 5 inputs |
| `elder-futhark-runes-to-letters` | `runesToLetters` | Elder Futhark → Latin | 3 inputs |
| `younger-futhark-letters-to-long-branch` | `lettersToLongBranchRunes` | Latin → Long Branch | 3 inputs |
| `younger-futhark-letters-to-short-twig` | `lettersToShortTwigRunes` | Latin → Short Twig | 3 inputs |
| `younger-futhark-runes-to-letters` | `runesToLetters` | Younger Futhark → Latin | 2 inputs |
| `medieval-futhork-letters-to-runes` | `lettersToRunes` | Latin → Futhork | 2 inputs |
| `medieval-futhork-runes-to-letters` | `runesToLetters` | Futhork → Latin | 1 input |
| `futhorc-letters-to-runes` | `lettersToRunes` | Latin → Futhorc | 2 inputs |
| `futhorc-runes-to-letters` | `runesToLetters` | Futhorc → Latin | 1 input |

### Results

- **Capture**: 9/9 clusters captured successfully
- **Validate**: 9/9 GREEN on first run
- **Drift Detection**: 9/9 STABLE across 5 runs
- **Health**: 9/9 SOLID
- **False Positives**: ZERO — no iteration needed

### Key Insights

1. **Pure mapping functions are trivially stable.** No timestamps, no randomness, no external state. Fingerprints never drift.

2. **Don't fingerprint the core `transform` function.** It requires a `Map` argument that can't be serialized in the manifest inputs. Fingerprint the dialect-specific wrappers instead.

3. **Multiple clusters from the same file work perfectly.** The `elder-futhark.js` module exports both `lettersToRunes` and `runesToLetters`. Each gets its own cluster and ghost proxy instance.

4. **Unicode-heavy output fingerprints correctly.** Rune characters (ᚠᚢᚦᚨᚱ) are handled natively by `stableStringify`. No special Unicode configuration needed.

5. **Case sensitivity is a design choice, not a bug.** The library lowercases input before mapping (uppercase "H" and lowercase "h" produce the same rune). This is intentional behavior that fingerprints consistently.

### Refactoring Performed

1. **Replaced repetitive `Map.set()` calls with object literals** — Each mapping file used 30-45 individual `.set()` calls. Refactored to `Record<string, string>` object literals converted via `createMappingFromObject()` helper.

2. **Renamed `transform` to `transliterate`** — "transform" is too generic. "transliterate" precisely describes the operation: mapping characters from one writing system to another.

3. **Added `createMappingFromObject` utility** — Reduces boilerplate from ~45 lines per mapping to ~25 lines. Plain objects are more readable and maintainable.

4. **Added JSDoc documentation** — Each public function now has a clear description of what it does.

5. **Kept backward compatibility** — `transform` is exported as an alias for `transliterate`, so existing code doesn't break.

All 3 verifications passed after refactoring:
1. ✅ Regrets validate: All 9 clusters GREEN
2. ✅ Direct output comparison: All outputs identical to pre-refactor truth
3. ✅ Fingerprint verification: All fingerprints match pre-refactor truth
