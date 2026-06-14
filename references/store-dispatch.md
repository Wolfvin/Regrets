# Store Dispatch Mode — Reference

## Problem

When applying Regrets to real-world state management codebases like Hoppscotch, many "logically pure" functions are **dispatcher functions** inside stores. They follow the pattern:

```ts
(state: StoreType, payload: PayloadType) => Partial<StoreType>
```

These dispatchers ARE pure — same input always produces same output. But they present three challenges that Regrets couldn't handle before:

1. **Not directly exported** — Dispatchers are defined inside `defineDispatchers()` calls and accessed via `store.dispatch("actionName", payload)`. Regrets' capture mode assumed functions were directly importable.

2. **Module-level singleton stores** — Each store is instantiated at import time as a singleton. You can't create a fresh instance for each test. Between captures, state accumulates, making fingerprints non-reproducible.

3. **Non-serializable state fields** — Stores often hold live objects (WebSocket connections, RxJS subjects) that can't be JSON-serialized for fingerprinting. These need to be selectively excluded.

### Real example from Hoppscotch

```ts
// newstore/DispatchingStore.ts — Custom RxJS-based dispatch architecture
export class DispatchingStore<StoreType, DispatchersType> {
  private subject = new BehaviorSubject<StoreType>(initial)
  private dispatchers: DispatchersType

  dispatch<K extends keyof DispatchersType>(
    action: K,
    payload: Parameters<DispatchersType[K]>[1]
  ) {
    // Pure: new state = assign(clone(current), dispatchers[action](current, payload))
    this.subject.pipe(map(val => dispatchers[action](val, payload))).subscribe(data => {
      this.subject.next(assign(clone(data), val))
    })
  }

  get value() { return this.subject.value }
}

// newstore/settings.ts — Pure dispatchers
const SettingsDispatchers = defineDispatchers({
  setSetting: (currentVal, payload: { key: string; value: any }) => ({
    [payload.key]: payload.value,
  }),
  applySetting: (currentVal, payload) => {
    // @ts-expect-error — type system can't express generic dispatch payload
    return { [payload.key]: payload.value }
  },
})

export const settingsStore = new DispatchingStore(getDefaultSettings(), SettingsDispatchers)
```

To fingerprint `setSetting`, you'd previously need to:
1. Create an adapter module that wraps the store
2. Manually reset the store before each capture
3. Figure out how to exclude non-serializable fields

This was too much friction. Most agents would skip store dispatchers entirely.

## Solution: `storeDispatch` Manifest Mode

A new capture mode built into Regrets that directly supports store dispatch patterns.

### Manifest Configuration

```json
{
  "id": "settings-set-setting",
  "file": "src/newstore/settings.ts",
  "stack": "ts",
  "storeDispatch": {
    "store": "settingsStore",
    "action": "setSetting"
  },
  "initialState": { "THEME": "system", "BG_COLOR": "#111111" },
  "ignorePaths": ["socket"],
  "normalize": ["randomIds"],
  "watches": [],
  "inputs": [
    { "key": "THEME", "value": "dark" },
    { "key": "BG_COLOR", "value": "#ffffff" }
  ]
}
```

### New Manifest Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `storeDispatch` | `{ store: string, action: string }` | No | Store dispatch mode. `store` = export name, `action` = dispatcher name |
| `initialState` | `object` | No | State to reset before each capture. Prevents state accumulation. |
| `ignorePaths` | `string[]` | No | Dot-path selectors for deeply nested field exclusion (e.g., `["socket", "request.connection"]`) |

### Supported Store Types

Regrets auto-detects the store type from its API:

| Store Type | Detection | Dispatch Call | State Access |
|-----------|-----------|---------------|-------------|
| **DispatchingStore** (Hoppscotch) | `store.dispatch` + `store.value` | `store.dispatch("action", payload)` | `store.value` |
| **Redux** | `store.dispatch` + `store.getState` | `store.dispatch({ type, payload })` | `store.getState()` |
| **Zustand** | `store.setState` + `store.getState` | `store.setState(partial)` | `store.getState()` |

### `initialState` Reset Behavior

| Store Type | Reset Method |
|-----------|-------------|
| DispatchingStore | `store.subject.next(deepClone(initialState))` (requires exposed subject) |
| Redux | ⚠️ Not supported (Redux has no standard reset) |
| Zustand | `store.setState(deepClone(initialState), true)` (replace mode) |

If the store's internal subject isn't accessible, Regrets warns: "Cannot reset — state may be dirty."

### Flow

```
1. Import module → find store export by name
2. Auto-detect store type (DispatchingStore / Redux / Zustand)
3. For each input:
   a. Reset to initialState (if provided)
   b. Dispatch(action, input)
   c. Read new state
   d. Apply ignorePaths, normalize, ignoreFields
   e. deepClone → fingerprint
4. Write .regret file with dispatch metadata
```

## `ignorePaths` — Deep Selective Field Stripping

### Problem with `ignoreFields`

`ignoreFields` strips by key name at ALL nesting levels. For example, `ignoreFields: ["socket"]` would remove both `state.socket` (the live WS connection) AND `state.request.socket` (a legitimate data field). You need path-based control.

### Solution

`ignorePaths` uses dot notation to specify the exact path to strip:

```json
{
  "ignorePaths": ["socket", "log"]
}
```

This strips `state.socket` and `state.log` but NOT `state.request.socket`.

Path matching is recursive: `"request.connection"` strips `state.request.connection` but not `state.connection`.

When both `ignoreFields` and `ignorePaths` are specified, both are applied. `ignoreFields` strips by key name at all levels, `ignorePaths` strips at specific paths only.

## `normalize: ["randomIds"]` — Random ID Normalization

### Problem

Many codebases generate random IDs using `Math.random()`, `nanoid`, `crypto.randomUUID()`, or custom `uniqueID()` functions. These make output non-deterministic:

```ts
export const uniqueID = (length = 16) => Math.random().toString(36).substring(2, length)
// Output: "x8j2k9d3p5f1t7h8" — different on every call
```

When a store dispatch creates a new entity (e.g., `createEnvironment`), the resulting state contains a random ID. Fingerprinting this state would produce different hashes on every run.

### Solution

`normalize: ["randomIds"]` detects and replaces random-looking alphanumeric strings with `<RANDOM_ID>`:

- Length 8-24 chars
- Only lowercase alphanumeric (`[a-z0-9]`)
- At least 3 letters AND 2 digits
- At least 6 unique characters (high entropy)
- Not matching common words like CSS class names

Examples:
| Input | Normalized |
|-------|-----------|
| `"x8j2k9d3p5f1t7h8"` | `"<RANDOM_ID>"` |
| `"abc123xyz789"` | `"<RANDOM_ID>"` |
| `"borderleft"` | `"borderleft"` (no digits, not random) |
| `"btn"` | `"btn"` (too short) |
| `"507f1f77bcf86cd799439011"` | `"<RANDOM_ID>"` (MongoDB ObjectId) |

## Discovery

These improvements were found during analysis of the Hoppscotch API development platform (hoppscotch/hoppscotch), a 79k-star Vue 3 + Tailwind CSS monorepo with a custom DispatchingStore state management pattern. The codebase has:

- 12+ newstore modules using DispatchingStore
- `uniqueID()` for generating entity IDs (non-deterministic)
- Live connection objects (WSConnection, SSEConnection, MQTTConnection) stored in state
- Module-level singleton stores that can't be easily reset
- Pure dispatcher functions that are not directly exported

Without `storeDispatch` mode, the only way to fingerprint these dispatchers would be to create adapter modules for each one — a process so tedious that no agent would bother. With this improvement, store dispatchers become first-class fingerprintable units.

## Files Changed

- `scripts/fingerprint.js`: Added `normalize: ["randomIds"]` rule, `ignorePaths` support in `stripFields`, updated `fingerprint()` and `fingerprintSequence()` signatures
- `scripts/capture.js`: Added `storeDispatch` mode, `initialState` support, `ignorePaths` propagation, refactored duplicated transform/iterator code into helpers
- `scripts/validate.js`: Added `storeDispatch` validation mode, `ignorePaths` propagation, `initialState` parsing from `.regret` files
