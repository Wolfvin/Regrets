# Browser Extension Variant

Browser extensions run in a non-Node environment. The recommended approach is **Pure Logic Extraction** — refactor extension code so business logic lives in pure JS modules (no browser APIs), then fingerprint those directly with the standard `capture.js`.

## Recommended: Pure Logic Extraction

This is the proven, tested approach. Extract pure business logic into separate modules that have zero browser API dependencies, then fingerprint those modules using the standard JS/TS capture scripts.

```
extension_source/
  background.js          ← thin: only browser API calls
  logic/
    invoice-builder.js   ← pure: fingerprint this ✅
    response-parser.js   ← pure: fingerprint this ✅
    file-saver.js        ← side effect: stub in tests
```

### How It Works

1. Identify pure functions in your extension that don't call `chrome.*` APIs or DOM
2. Extract them into separate `*-logic.ts` modules
3. Original modules delegate to the pure functions after handling side effects
4. Add pure modules to `regrets/manifest.json` with `stack: "js"` or `stack: "ts"`
5. Use standard `capture.js` and `validate.js` to fingerprint

### Example

```
BEFORE (untestable):
  subscription.ts → isSubscribed() → chrome.storage.local.get(...)

AFTER (testable):
  subscription-logic.ts → isSubscriptionActive(sub, now) → boolean  (pure!)
  subscription.ts       → isSubscribed() → chrome.storage.local.get() → isSubscriptionActive(data, Date.now())
```

The pure module `subscription-logic.ts` can be fingerprinted directly. The original `subscription.ts` is a thin shell that only handles side effects.

### Rules for Pure Logic Extraction

1. **Pure modules must have zero imports of**: `chrome`, `document`, `window`, `fetch`, or any browser API
2. **Logic functions take all data as parameters** — no global state, no `chrome.storage`
3. **If a function needs current time** — accept `now: number` as a parameter, let the shell pass `Date.now()`
4. **If a function needs stored data** — accept the data as a parameter, let the shell read from `chrome.storage`

---

## ~~Background Script Injection~~ (Not Implemented)

> **Note:** The "Background Script Injection" approach described in earlier versions of this document was never implemented. The referenced scripts (`capture-bridge.js`, `capture-extension.js`, `validate-extension.js`) do not exist. The Pure Logic Extraction approach above is the only tested and working method for browser extension fingerprinting.
