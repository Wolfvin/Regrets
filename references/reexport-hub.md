# Re-export Hub Pattern — Regrets Reference Guide

When decomposing a large module into smaller domain-specific files, backward compatibility is critical. Existing imports throughout the codebase must continue to work. The re-export hub pattern solves this.

---

## The Problem

You're refactoring `access-mode.ts` (107 lines, 7 exported functions) into a proper `access/` module:

```
BEFORE:
  src/lib/access-mode.ts → exports getAccessMode, shouldShowAds, etc.

AFTER:
  src/lib/access/
    mode-resolver.ts    → exports resolveAccessMode, shouldShowAds, etc.
    expiry-check.ts     → exports isSubscriptionActive, isCompanyActiveByDate
    index.ts            → re-export hub
```

But 15 other files import from `lib/access-mode`. Changing all imports is risky and noisy. The refactor should be invisible to consumers.

---

## The Pattern

### Step 1: Create new domain-specific files

Move the actual logic to the new files:

```typescript
// src/lib/access/mode-resolver.ts
export function resolveAccessMode(ctx: AccessContext): AccessMode { ... }
export function shouldShowAds(mode: AccessMode): boolean { ... }
// ... other functions

// Backward-compatible alias
export { resolveAccessMode as getAccessMode };
```

### Step 2: Turn the original file into a thin re-export hub

```typescript
// src/lib/access-mode.ts — NOW A RE-EXPORT HUB
/**
 * @deprecated Import from `lib/access` instead.
 * This file exists for backward compatibility only.
 */
export {
  resolveAccessMode,
  getAccessMode,
  shouldShowAds,
  shouldShowSubscriptionPage,
  shouldShowDonationPage,
  isCompanyUser,
  canUseOffline,
  isOfflineBlocked,
} from "./access/mode-resolver";

export type { AccessMode, AccessContext } from "./access/mode-resolver";
```

The original file becomes a single `export { ... } from "..."` statement. Zero logic, zero risk.

### Step 3: Create the module index

```typescript
// src/lib/access/index.ts — canonical entry point
export { isSubscriptionActive, isCompanyActiveByDate } from "./expiry-check";
export { resolveAccessMode, getAccessMode, shouldShowAds, ... } from "./mode-resolver";
export type { AccessMode, AccessContext } from "./mode-resolver";
```

### Step 4: Update manifest to point to NEW files

After transpilation, the manifest `file` field should point to the new compiled output:

```json
{
  "id": "access-mode-gate",
  "entry": "getAccessMode",
  "file": "dist/lib/access-mode.js"
}
```

The compiled `dist/lib/access-mode.js` will contain the re-exports, which resolve to the actual implementation in `mode-resolver.ts` (bundled by esbuild). This means the fingerprint is computed from the REAL function, not the re-export.

---

## Why This Works with Regrets

1. **Fingerprints don't change** — esbuild bundles the re-exported function's actual body into the output file. The function behavior is identical.

2. **Backward compatibility preserved** — All existing imports continue to work. No cascade of changes needed.

3. **Incremental migration** — You can update consumers one at a time to import from the new module, then remove the re-export hub once all consumers are migrated.

4. **The `.regret` files remain valid** — Since the transpiled output produces identical behavior, all cluster fingerprints stay GREEN.

---

## Verification Checklist

After applying the re-export hub pattern:

- [ ] `regret validate` → All GREEN (cluster fingerprints match)
- [ ] Raw output comparison → Identical to pre-refactor Truth 1
- [ ] `regret chain --validate` → All chain hashes match
- [ ] `regret coverage` → Coverage scores unchanged (same inputs, same branches)
- [ ] TypeScript compilation succeeds (no circular dependencies in re-exports)
- [ ] Existing unit tests still pass (backward compatibility verified)

---

## Common Pitfalls

### Circular Re-exports

```
A.ts → re-exports from B.ts
B.ts → imports from A.ts
```

This creates a circular dependency that will fail at runtime. Ensure re-export hubs only point DOWNWARD to implementation files, never sideways or upward.

### Missing Type Exports

If the original file exported types (interfaces, type aliases), the re-export hub MUST also re-export them:

```typescript
export type { AccessMode, AccessContext } from "./mode-resolver";
```

Forgetting this causes TypeScript errors in consumers.

### esbuild Bundle Resolution

When using esbuild with `--bundle`, re-exports are resolved at build time. The output file contains the actual implementation, not `export { X } from '...'`. This is exactly what Regrets needs — importable JS with real function bodies.

If using `--bundle` is not possible (e.g., external dependencies), use `--external` flags to exclude packages that should be resolved at runtime.

---

## When to Remove the Hub

Once ALL consumers have been updated to import from the new module path, the re-export hub can be safely removed. At that point:

1. Delete the hub file (e.g., `access-mode.ts`)
2. Update any remaining references
3. Run `regret validate` → should still be GREEN (the compiled output hasn't changed)
4. Commit the removal as a separate, clean commit
