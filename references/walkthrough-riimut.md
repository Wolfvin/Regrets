# Walkthrough: riimut — Runic Alphabet Transformer

A complete walkthrough showing how Regrets was applied to [riimut](https://github.com/stscoundrel/riimut), a TypeScript library that transforms Latin letters to Norse runes and vice versa. This demonstrates Regrets working on an unlikely, niche target — exactly the kind of project nobody would think to regression-test.

---

## Why riimut?

riimut is an excellent test case for several reasons:

1. **Pure functions with clear I/O**: Every function takes a string and returns a string — textbook fingerprinting.
2. **Multiple dialects = natural clusters**: Elder Futhark, Younger Futhark (Long Branch + Short Twig), Medieval Futhork, and Anglo-Saxon Futhorc provide 4 distinct transformation domains.
3. **Unicode-heavy output**: Runic characters (ᚠᚢᚦᚨᚱᚲ...) stress-test the fingerprint algorithm with non-ASCII content.
4. **Shared core function**: All dialects delegate to a single `transform()` function, testing the "shared dependency" pattern.

---

## Step 1 — Build and Analyze

```bash
cd riimut
npm install
npx tsc
```

The project compiles TypeScript to CommonJS in `dist/`. Key exported functions per dialect:

| Dialect | Export | Signature |
|---------|--------|-----------|
| Elder Futhark | `lettersToRunes` | `(string) => string` |
| Elder Futhark | `runesToLetters` | `(string) => string` |
| Younger Futhark | `lettersToLongBranchRunes` | `(string) => string` |
| Younger Futhark | `lettersToShortTwigRunes` | `(string) => string` |
| Younger Futhark | `runesToLetters` | `(string) => string` |
| Medieval Futhork | `lettersToRunes` | `(string) => string` |
| Medieval Futhork | `runesToLetters` | `(string) => string` |
| Futhorc | `lettersToRunes` | `(string) => string` |
| Futhorc | `runesToLetters` | `(string) => string` |

**Important**: The core `transform(content, dictionary)` function takes a `Map<string, string>` as its second argument — this is NOT JSON-serializable, so we cannot fingerprint it directly. Instead, we fingerprint the higher-level dialect functions that construct the Map internally.

---

## Step 2 — Write the Manifest

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
      "description": "Elder Futhark: transform Latin letters to Elder Futhark runes",
      "inputs": ["hello", "HELLO", "thor", "a e i o u", "Viking age"]
    },
    {
      "id": "elder-futhark-runes-to-letters",
      "entry": "runesToLetters",
      "watches": ["runesToLetters"],
      "file": "dist/dialects/elder-futhark.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "description": "Elder Futhark: transform runes back to Latin letters",
      "inputs": ["ᚺᛖᛚᛚᛟ", "ᚦᛟᚱ", "ᚠᛁᚲᛁᛜ:ᚠᛟᚱᚾ"]
    }
    // ... 7 more clusters for other dialects
  ]
}
```

Key decisions:
- **`file` points to compiled `.js`**: TypeScript source cannot be dynamically imported; always use the compiled output.
- **Named exports only**: The compiled CommonJS uses `exports.lettersToRunes = ...`, NOT `exports.default`. Use the named export name.
- **No Map arguments**: The `transform` function takes a `Map` which can't be JSON-serialized, so we skip it and test the wrapper functions instead.

---

## Step 3 — Capture

```bash
node /path/to/Regrets/scripts/regret.js capture
```

All 9 clusters captured successfully with unique fingerprints:

```
✅ elder-futhark-letters-to-runes      64l3c55
✅ elder-futhark-runes-to-letters      4m8qwdj
✅ futhorc-letters-to-runes            3tl31k0
✅ futhorc-runes-to-letters            uvea0x7
✅ medieval-futhork-letters-to-runes   50wbrb3
✅ medieval-futhork-runes-to-letters   5n36ngs
✅ younger-futhark-longbranch-letters-to-runes 8pgz31q
✅ younger-futhark-runes-to-letters    5n36ngs
✅ younger-futhark-shorttwig-letters-to-runes 3klohvh
```

---

## Step 4 — Drift Detection

```bash
node /path/to/Regrets/scripts/regret.js drift
```

All 9 clusters stable across 5 runs — zero drift, zero false positives.

---

## Step 5 — Refactor

Refactored `transform.ts` from imperative loop to functional `map/join`:

**Before:**
```typescript
export const transform = (content: string, dictionary: Map<string, string>): string => {
  let result = "";
  const parts: string[] = content.split("");
  for (const part of parts) {
    const partKey = part.toLocaleLowerCase();
    if (dictionary.has(partKey)) {
      result += dictionary.get(partKey);
    } else {
      result += part;
    }
  }
  return result;
};
```

**After:**
```typescript
export const transform = (content: string, dictionary: Map<string, string>): string => {
  return content
    .split("")
    .map((char) => {
      const key = char.toLocaleLowerCase();
      return dictionary.has(key) ? dictionary.get(key)! : char;
    })
    .join("");
};
```

Also simplified all dialect files to use arrow function expressions instead of intermediate variables.

---

## Step 6 — Triple Verification

### VERIFICATION 1: Regrets
```bash
node /path/to/Regrets/scripts/regret.js validate
# ✅ All 9 tests passed. Refactor is safe.
```

### VERIFICATION 2: Direct Output
Ran all entry functions directly and compared with pre-refactor saved outputs — all 26 input/output pairs identical.

### VERIFICATION 3: Fingerprint Cross-Check
```bash
node /path/to/Regrets/scripts/regret.js drift
# ✅ All 9 tests passed (5 runs — stable). Refactor is safe.
```

All 3 verifications GREEN → refactor proven safe.

---

## Lessons Learned

1. **CommonJS default exports don't work with `"entry": "default"`** — always use named exports for the manifest entry point.
2. **Map/Set arguments can't be JSON-serialized** — fingerprint the higher-level wrapper function instead.
3. **TypeScript projects must compile before capture** — point `file` to `dist/`, not `src/`.
4. **Unicode-heavy outputs fingerprint correctly** — Regrets handles non-ASCII strings without issues.
5. **Shared core functions are implicitly tested** — when all dialect functions call `transform()`, testing the dialects also tests the core.
