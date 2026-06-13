# PR 2: Refactor ogham.ts — Regret-Validated

## Target Repo

[evanshortiss/ogham](https://github.com/evanshortiss/ogham) — Convert Latin text to Ogham (ancient Celtic tree alphabet)

## What Was Refactored

The `convert()` function and its helpers in `src/ogham.ts`:

### Before
- `replaceCharacters()` — misleading name, used `forEach` with mutation
- `containsInvalidCharacters()` — imperative for-loop
- `replaceInvalidCharactersWithPhonetics()` — `forEach` with string mutation
- `/g` flag on `validateInputRgx` — potential stateful regex issues
- Inline `Object.assign` defaults

### After
- `transliterate()` — accurate name, uses functional `reduce` (no mutation)
- `hasUnsupportedChars()` — clean `some()` predicate
- `applyPhoneticReplacements()` — `reduce` with no mutation
- `VALID_INPUT_PATTERN` — stateless regex without `/g` flag
- `DEFAULT_OPTIONS` constant, `validateInput()` extracted

## 3-Layer Verification Results

### VERIFIKASI 1 — Regrets (all GREEN)

```
✅ convert-default                     fkpu46l                PASS
✅ convert-forfeda                     4it7h6l                PASS
✅ convert-no-boundary                 1qz85pl                PASS
✅ convert-phonetics                   34dtcwq                PASS
```

### VERIFIKASI 2 — Direct Output vs KEBENARAN 1 (all identical)

| Input | KEBENARAN 1 | After Refactor | Match |
|-------|-------------|---------------|-------|
| `"eire"` | `"᚛ᚓᚔᚏᚓ᚜"` | `"᚛ᚓᚔᚏᚓ᚜"` | ✅ |
| `"is maith liom tae"` | `"᚛ᚔᚄ ᚋᚐᚔᚈᚆ ᚂᚔᚑᚋ ᚈᚐᚓ᚜"` | `"᚛ᚔᚄ ᚋᚐᚔᚈᚆ ᚂᚔᚑᚋ ᚈᚐᚓ᚜"` | ✅ |
| `"abc"` | `"᚛ᚐᚁᚉ᚜"` | `"᚛ᚐᚁᚉ᚜"` | ✅ |
| `""` | `"᚛᚜"` | `"᚛᚜"` | ✅ |
| `["eire", {addBoundary:false}]` | `"ᚓᚔᚏᚓ"` | `"ᚓᚔᚏᚓ"` | ✅ |
| `["abc", {addBoundary:false}]` | `"ᚐᚁᚉ"` | `"ᚐᚁᚉ"` | ✅ |
| `["is maith liom tae", {useForfeda:true}]` | `"᚛ᚔᚄ ᚋᚐᚔᚈᚆ ᚂᚔᚑᚋ ᚈᚙ᚜"` | `"᚛ᚔᚄ ᚋᚐᚔᚈᚆ ᚂᚔᚑᚋ ᚈᚙ᚜"` | ✅ |
| `["ae oi ui ia", {useForfeda:true}]` | `"᚛ᚙ ᚖ ᚗ ᚘ᚜"` | `"᚛ᚙ ᚖ ᚗ ᚘ᚜"` | ✅ |
| `["jkvwxy", {usePhonetics:true}]` | `"᚛ᚌᚊᚃᚒᚒᚎᚔ᚜"` | `"᚛ᚌᚊᚃᚒᚒᚎᚔ᚜"` | ✅ |
| `["keys", {usePhonetics:true}]` | `"᚛ᚊᚓᚔᚄ᚜"` | `"᚛ᚊᚓᚔᚄ᚜"` | ✅ |

### VERIFIKASI 3 — Cross-check: New fingerprint vs KEBENARAN 2

| Cluster | KEBENARAN 2 | After Refactor | Match |
|---------|------------|---------------|-------|
| convert-default | fkpu46l | fkpu46l | ✅ |
| convert-no-boundary | 1qz85pl | 1qz85pl | ✅ |
| convert-forfeda | 4it7h6l | 4it7h6l | ✅ |
| convert-phonetics | 34dtcwq | 34dtcwq | ✅ |

### Existing Test Suite: 10/10 pass, 100% coverage

## Files Changed

- `src/ogham.ts` — Refactored (see `ogham.ts.refactored`)
- `src/ogham.js` — Compiled output (see `ogham.js.refactored`)
- `regrets/` — Regrets fingerprint files (manifest.json + 4 .regret files)
