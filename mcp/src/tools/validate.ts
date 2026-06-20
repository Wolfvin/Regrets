/**
 * Tool handler for regrets_validate — validate captured fingerprints against
 * live code output.
 *
 * Issue #266: this handler DELEGATES to scripts/validate.js via child
 * process spawn (same as the CLI). Previously it imported validate() from
 * regret-testing (scripts/api.js), which reimplemented the validate loop
 * separately from scripts/validate.js and silently skipped Phase 3 callee
 * contract re-validation. Delegating to the CLI script gives us a single
 * source of truth — any future validate-side feature (callee re-validation,
 * drift detection, expect-throw contracts, etc.) is picked up automatically
 * by the MCP tool with no logic drift.
 *
 * The spawned validate.js process is invoked with `--json` so its stdout is
 * a structured object the MCP tool can parse. The JSON output is then
 * reshaped into the existing MCP contract (`verdict`, `passed`, `failed`,
 * `summary`, `results`, `error`) so existing MCP consumers see no breaking
 * change. New fields from validate.js (callees, confidence, drift, etc.)
 * are added additively.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { structuredError } from "./structuredError.js";

const require = createRequire(import.meta.url);
const regretTestingRoot = dirname(require.resolve("regret-testing"));
const VALIDATE_JS = join(regretTestingRoot, "scripts", "validate.js");

/** Zod schema for the regrets_validate tool input. */
export const validateToolSchema = {
  manifestPath: z
    .string()
    .optional()
    .describe(
      "Path to manifest.json relative to cwd. Default: 'regrets/manifest.json'"
    ),
  cluster: z
    .string()
    .optional()
    .describe(
      "Validate only this cluster ID. If omitted, validates all clusters."
    ),
  failFast: z
    .boolean()
    .optional()
    .describe(
      "Stop validation on first failure. Default: false."
    ),
  runs: z
    .number()
    .optional()
    .describe(
      "Number of validation runs per cluster. Default: 1."
    ),
  includeDiff: z
    .boolean()
    .optional()
    .describe(
      "Include diff details for FAIL results. Default: true."
    ),
  skipCallees: z
    .boolean()
    .optional()
    .describe(
      "Skip Phase 3 callee contract re-validation. Default: false " +
      "(callees ARE re-validated, matching the CLI default). Set to true " +
      "to mirror `regret validate --skip-callees`."
    ),
  cwd: z
    .string()
    .optional()
    .describe(
      "Working directory containing the regrets/ folder. Default: process.cwd()"
    ),
};

/**
 * Spawn a Node script and capture its stdout/stderr/exit code without
 * inheriting any stdio — the parent MCP server keeps its own stdio for
 * JSON-RPC traffic.
 */
function runScript(
  scriptPath: string,
  args: string[],
  opts: { cwd: string }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [scriptPath, ...args], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

/**
 * Handle the regrets_validate tool call.
 * Spawns `node scripts/validate.js --json [args]` and reshapes the output
 * into the existing MCP contract:
 *   { verdict, passed, failed, summary, results, error, callees? }
 *
 * `results` preserves the per-cluster fields MCP consumers already depend
 * on (id, pass, expected, actual, diff, error, skipped, sideEffectDiff)
 * and adds richer validate.js metadata (status, confidence, drift, etc.)
 * as additive fields.
 *
 * `callees` (new top-level field) carries Phase 3 callee re-validation
 * results: { passed, failed, skipped, considered, contracts: [...] }.
 */
export async function handleValidate(
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const {
    manifestPath,
    cluster,
    failFast,
    runs,
    includeDiff,
    skipCallees,
    cwd,
  } = args as {
    manifestPath?: string;
    cluster?: string;
    failFast?: boolean;
    runs?: number;
    includeDiff?: boolean;
    skipCallees?: boolean;
    cwd?: string;
  };

  const workCwd = cwd ?? process.cwd();

  try {
    const cliArgs: string[] = ["--json"];
    if (cluster) cliArgs.push("--cluster", cluster);
    if (manifestPath) cliArgs.push("--manifest", manifestPath);
    if (failFast) cliArgs.push("--fail-fast");
    if (typeof runs === "number") cliArgs.push("--runs", String(runs));
    // includeDiff defaults to true; only opt out explicitly.
    if (includeDiff === false) cliArgs.push("--no-diff");
    if (skipCallees) cliArgs.push("--skip-callees");

    const { stdout, stderr, exitCode } = await runScript(VALIDATE_JS, cliArgs, {
      cwd: workCwd,
    });

    let parsed: {
      passed?: number;
      failed?: number;
      clusters?: Array<{
        id: string;
        pass: boolean;
        status?: string;
        confidence?: string;
        skipped?: boolean;
        expected?: string;
        actual?: string;
        diff?: string;
        error?: string;
        sideEffectDiff?: string;
        drift?: boolean;
        updated?: boolean;
        mutationMismatch?: boolean;
        mutationDetected?: boolean;
        expectedError?: { type: string; message: string };
        actualError?: { type: string; message: string };
        expectThrowViolated?: boolean;
        missingCallees?: string[];
      }>;
      callees?: {
        passed: number;
        failed: number;
        skipped: number;
        considered: number;
        contracts: Array<{
          id: string;
          pass: boolean;
          status?: string;
          skipped?: boolean;
          expected?: string;
          actual?: string;
          error?: string;
          liveError?: string;
          expectThrowViolated?: boolean;
        }>;
      };
      error?: string;
    };
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return structuredError({
        type: "VALIDATE_ERROR",
        message:
          `validate.js did not emit valid JSON (exit=${exitCode}). ` +
          `Parse error: ${msg}. stderr: ${stderr.trim() || "(empty)"}`,
        cluster,
      });
    }

    // validate.js --json returns a top-level `error` only for arg-validation
    // failures (e.g. `--update` without `--reason`). Surface those as a
    // structured MCP error so the caller knows the validate didn't run.
    if (parsed.error) {
      return structuredError({
        type: "VALIDATE_ERROR",
        message: parsed.error,
        cluster,
      });
    }

    const clusters = parsed.clusters ?? [];

    // Build the per-cluster summary lines (preserves existing MCP contract):
    //   "<id>: PASS" | "<id>: FAIL" | "<id>: SKIPPED"
    const summary = clusters.map((r) => {
      if (r.skipped) return `${r.id}: SKIPPED`;
      return r.pass ? `${r.id}: PASS` : `${r.id}: FAIL`;
    });

    const output: Record<string, unknown> = {
      verdict:
        parsed.failed === 0 ? "ALL PASS" : `${parsed.failed} FAIL(S)`,
      passed: parsed.passed ?? 0,
      failed: parsed.failed ?? 0,
      summary,
      results: clusters,
      error: parsed.error,
    };

    // Phase 3 callee re-validation results — new additive top-level field.
    if (parsed.callees) {
      output.callees = parsed.callees;
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(output, null, 2),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return structuredError({
      type: "VALIDATE_ERROR",
      message: `Failed to validate clusters: ${message}`,
      cluster,
    });
  }
}
