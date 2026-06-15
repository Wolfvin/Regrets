// regret-testing — Programmatic API
// Usage:
//   Low-level:  import { fingerprint, createGhost } from 'regret-testing'
//   High-level: import { capture, validate, scan, check } from 'regret-testing'

// ─── Low-level utilities (existing) ───────────────────────────────────────────
export { stableStringify, normalize, stripFields, fingerprint, fingerprintSequence, extractSchema, snapshotOutput, getEnvSnapshot } from './scripts/fingerprint.js'
export { createGhost, deepClone, normalizeHtml } from './scripts/ghost.js'

// ─── High-level programmatic API ──────────────────────────────────────────────
export { capture, validate, scan, check, chain } from './scripts/api.js'

// ─── Re-exported from validate.js (for advanced use) ──────────────────────────
export { parseRegret, runCluster, runReactCluster, formatDiffOutput, jsonDiff, generateJUnitXml } from './scripts/validate.js'
