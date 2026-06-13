# Zustand Store Testing — Regrets Reference Guide

Zustand stores are a popular state management pattern in React/Tauri apps. They encapsulate both data and logic in a single `create()` call. This guide covers how to extract and fingerprint the pure logic buried inside Zustand store actions.

---

## The Challenge

Zustand store actions are defined as closures inside `create()`. They have access to `set()` and `get()` — making them impure by default. But many actions contain **pure computational logic** sandwiched between state reads and writes.

```typescript
// The store action looks impure...
selectBubblesInRect: (rect, additive) =>
  set((s) => {
    const selected = additive ? new Set(s.selectedBubbles) : new Set<number>();
    // ↓ This is pure logic — axis-aligned bounding box collision detection
    const x1 = Math.min(rect.x1, rect.x2);
    const y1 = Math.min(rect.y1, rect.y2);
    const x2 = Math.max(rect.x1, rect.x2);
    const y2 = Math.max(rect.y1, rect.y2);

    s.words.forEach((word) => {
      const wordCenterX = word.x + word.w / 2;
      const wordCenterY = word.y + word.h / 2;
      if (wordCenterX >= x1 && wordCenterX <= x2 && wordCenterY >= y1 && wordCenterY <= y2) {
        selected.add(word.id);
      }
    });
    return { selectedBubbles: selected };
  }),
```

The collision detection logic (`Math.min`, `Math.max`, center calculation, containment check) is pure — it depends only on its inputs. But it's trapped inside a `set()` callback.

---

## Solution: Extract Pure Logic into Standalone Functions

### Step 1: Identify Extractable Logic

For each store action, ask:
1. Does it contain computation that depends ONLY on its arguments + current state?
2. Can the computation be expressed as a pure function that takes state + args and returns a result?
3. Is the result then simply written back to state via `set()`?

If yes → extract the computation into a standalone pure function.

### Step 2: Extract to a `-logic.ts` File

```
BEFORE (untestable):
  stores/useOcrOverlayStore.ts → selectBubblesInRect is a closure

AFTER (testable):
  stores/ocr-overlay-logic.ts → selectBubblesInRectPure(words, rect, additive) → Set<number>
  stores/useOcrOverlayStore.ts → selectBubblesInRect delegates to pure function
```

```typescript
// stores/ocr-overlay-logic.ts
export function selectBubblesInRectPure(
  words: Array<{id: number; x: number; y: number; w: number; h: number}>,
  rect: {x1: number; y1: number; x2: number; y2: number},
  additive: boolean,
  existingSelection: Set<number>
): Set<number> {
  const selected = additive ? new Set(existingSelection) : new Set<number>();
  const x1 = Math.min(rect.x1, rect.x2);
  const y1 = Math.min(rect.y1, rect.y2);
  const x2 = Math.max(rect.x1, rect.x2);
  const y2 = Math.max(rect.y1, rect.y2);

  for (const word of words) {
    const wordCenterX = word.x + word.w / 2;
    const wordCenterY = word.y + word.h / 2;
    if (wordCenterX >= x1 && wordCenterX <= x2 && wordCenterY >= y1 && wordCenterY <= y2) {
      selected.add(word.id);
    }
  }
  return selected;
}
```

```typescript
// stores/useOcrOverlayStore.ts — updated action
import { selectBubblesInRectPure } from './ocr-overlay-logic';

selectBubblesInRect: (rect, additive) =>
  set((s) => ({
    selectedBubbles: selectBubblesInRectPure(s.words, rect, additive, s.selectedBubbles)
  })),
```

The store action becomes a thin wrapper: read state → call pure function → write result.

### Step 3: Transpile and Create Adapter

For Tauri apps using TypeScript, you need an esbuild step and possibly an adapter module.

```bash
# Transpile the logic file
esbuild src/stores/ocr-overlay-logic.ts \
  --bundle --format=esm \
  --outfile=dist/stores/ocr-overlay-logic.js \
  --platform=neutral
```

For functions with complex type signatures (e.g., `Set<number>` return), create an adapter that serializes the result:

```javascript
// regrets/adapters/select-bubbles-adapter.mjs
import { selectBubblesInRectPure } from '../../dist/stores/ocr-overlay-logic.js';

export function selectBubblesInRectAdapter(input) {
  const { words, rect, additive, existingSelection } = input;
  const existingSet = new Set(existingSelection);
  const result = selectBubblesInRectPure(words, rect, additive, existingSet);
  return [...result]; // Convert Set to Array for JSON serialization
}
```

### Step 4: Define Cluster in Manifest

```json
{
  "id": "ocr-bubble-selection",
  "entry": "selectBubblesInRectAdapter",
  "watches": ["selectBubblesInRectAdapter"],
  "file": "regrets/adapters/select-bubbles-adapter.mjs",
  "stack": "js",
  "fingerprintLevel": "entry",
  "description": "Pure collision detection for OCR bubble selection",
  "inputs": [
    {
      "words": [{"id": 1, "x": 10, "y": 20, "w": 50, "h": 15}, {"id": 2, "x": 100, "y": 200, "w": 50, "h": 15}],
      "rect": {"x1": 0, "y1": 0, "x2": 60, "y2": 40},
      "additive": false,
      "existingSelection": []
    },
    {
      "words": [{"id": 1, "x": 10, "y": 20, "w": 50, "h": 15}],
      "rect": {"x1": 200, "y1": 200, "x2": 300, "y2": 300},
      "additive": false,
      "existingSelection": []
    },
    {
      "words": [{"id": 1, "x": 10, "y": 20, "w": 50, "h": 15}, {"id": 2, "x": 100, "y": 200, "w": 50, "h": 15}],
      "rect": {"x1": 0, "y1": 0, "x2": 60, "y2": 40},
      "additive": true,
      "existingSelection": [2]
    }
  ]
}
```

---

## Common Zustand Patterns and Their Extraction

### Pattern 1: Simple Transformation

```typescript
// BEFORE: logic inside set()
updateWordText: (id, text) =>
  set((s) => ({
    words: s.words.map((w) => (w.id === id ? { ...w, text } : w)),
  })),

// AFTER: pure function
export function updateWordInList(words, id, text) {
  return words.map((w) => (w.id === id ? { ...w, text } : w));
}

// Store delegates
updateWordText: (id, text) =>
  set((s) => ({ words: updateWordInList(s.words, id, text) })),
```

### Pattern 2: Filtering with Side Effects

```typescript
// BEFORE: filter + cleanup in one action
removeWords: (ids) =>
  set((s) => {
    const toDelete = new Set(ids);
    return {
      words: s.words.filter((w) => !toDelete.has(w.id)),
      selectedBubbles: new Set([...s.selectedBubbles].filter((id) => !toDelete.has(id))),
    };
  }),

// AFTER: pure function
export function removeWordsFromState(words, selectedBubbles, ids) {
  const toDelete = new Set(ids);
  return {
    words: words.filter((w) => !toDelete.has(w.id)),
    selectedBubbles: new Set([...selectedBubbles].filter((id) => !toDelete.has(id))),
  };
}
```

### Pattern 3: Grid Construction

```typescript
// BEFORE: array generation inside set()
buildTileGrid: (cols, rows) =>
  set((s) => {
    const total = cols * rows;
    const tiles = Array.from({ length: total }, (_, i) => ({ index: i, done: false }));
    return { tileCount: total, tilesCompleted: 0, tiles, tileGridReady: true, pendingTileDone: new Set() };
  }),

// AFTER: pure function
export function buildTileGridPure(cols, rows) {
  const total = cols * rows;
  const tiles = Array.from({ length: total }, (_, i) => ({ index: i, done: false }));
  return { tileCount: total, tilesCompleted: 0, tiles, tileGridReady: true, pendingTileDone: [] };
}
```

### Pattern 4: Access/Decision Logic (Already Pure)

Some store logic is already pure — it was just placed inside the store for convenience:

```typescript
// This is already pure — extract directly
export function isSubscriptionActive(expiresAt, now) {
  if (!expiresAt) return false;
  return now < expiresAt;
}
```

No adapter needed — point the manifest directly at the extracted file.

---

## What NOT to Extract

- **Network calls** (`proxyFetch`, `getTauriInvoke`) — these are I/O boundaries
- **DOM mutations** (`requestAnimationFrame`, `document.querySelector`)
- **Event listeners** (window.addEventListener)
- **Cross-store reads** that aren't passed as arguments

These should stay in the store action as the thin orchestration layer.

---

## Integration with Tauri Workflow

For Tauri apps, the full workflow is:

```
1. Identify pure logic inside Zustand stores
2. Extract to *-logic.ts files alongside the store
3. Store actions delegate to pure functions
4. Transpile logic files with esbuild
5. Create adapter modules for complex types (Set, Map, etc.)
6. Define clusters in manifest.json
7. Run regret capture → validate → coverage → drift
8. Refactor store actions (now safe — pure logic is fingerprinted)
```

This combines the Zustand extraction pattern from this guide with the Tauri-specific build steps from `references/tauri-apps.md`.

---

## When to Use This vs. Class-Based Adapter

| Situation | Use |
|-----------|-----|
| Logic lives in a Zustand `create()` closure | This guide (extract pure logic) |
| Logic lives in a class method | `references/class-based.md` |
| Logic is a standalone pure function | Direct manifest entry, no adapter needed |
| Logic uses Set/Map/Date return types | Adapter module (serialize for JSON) |

---

## Verifying the Extraction Didn't Break Anything

After extracting pure logic and updating store actions to delegate:

1. Run existing unit tests (if any) — they should still pass
2. Run `regret capture` on the extracted functions
3. Run `regret validate` — all GREEN
4. Run `regret drift` — all STABLE
5. Test the app manually — UI should behave identically

The extraction itself is a refactoring step. If Regrets shows GREEN after extraction, you've proven the extraction is behavior-preserving.
