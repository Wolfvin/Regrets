/**
 * Type declarations for regret-testing (parent package).
 * These mirror the JSDoc signatures in ../scripts/api.js
 * so that TypeScript can type-check our imports.
 */
declare module "regret-testing" {
  export interface CaptureResult {
    passed: number;
    failed: number;
    clusters: Array<{
      id: string;
      pass: boolean;
      fingerprint?: string;
      error?: string;
      skipped?: boolean;
      note?: string;
    }>;
    error?: string;
  }

  export interface ValidateResult {
    passed: number;
    failed: number;
    results: Array<{
      id: string;
      pass: boolean;
      expected?: string;
      actual?: string;
      diff?: string;
      error?: string;
      skipped?: boolean;
      sideEffectDiff?: string;
    }>;
    error?: string;
  }

  // Issue #289: ScanSuggestion shape mirrors install.js's cluster shape.
  // Previously this type only declared {id, entry, file, stack, watches},
  // which was inconsistent with what `regret install` produces. MCP agents
  // using `regrets_scan` would get suggestions that don't capture cleanly
  // (non-empty watches conflicting with fingerprintLevel: 'entry', no
  // inputs, no path-hint in id). The shape now matches install.js.
  export interface ScanSuggestion {
    id: string;
    entry: string;
    file: string;
    stack: string;
    watches: string[];            // [] (matches install.js default)
    fingerprintLevel: string;     // 'entry' (explicit, matches install.js)
    inputs: Array<unknown>;       // [null, {}] (matches install.js default)
  }

  export interface ScanResult {
    suggestions: ScanSuggestion[];
  }

  export interface CaptureOptions {
    manifestPath?: string;
    cluster?: string;
    cwd?: string;
  }

  export interface ValidateOptions {
    manifestPath?: string;
    cluster?: string;
    failFast?: boolean;
    runs?: number;
    includeDiff?: boolean;
    /** Skip Phase 3 callee contract re-validation. Default: false. */
    skipCallees?: boolean;
    cwd?: string;
  }

  export interface ScanOptions {
    dir?: string;
    stack?: string;
    cwd?: string;
  }

  export function capture(options?: CaptureOptions): Promise<CaptureResult>;
  export function validate(options?: ValidateOptions): Promise<ValidateResult>;
  export function scan(options?: ScanOptions): Promise<ScanResult>;

  export interface ChainOptions {
    mode?: "capture" | "validate";
    chain?: string;
    cwd?: string;
  }

  export interface ChainResult {
    passed: number;
    failed: number;
    chains: Array<{
      id: string;
      status: "passed" | "failed";
      chainHash?: string;
      reason?: string;
      error?: string;
    }>;
  }

  export function chain(options?: ChainOptions): Promise<ChainResult>;
}
