/**
 * Tool handler for regrets_capture — capture fingerprints for all clusters
 * in the manifest.
 *
 * Issue #266: this handler DELEGATES to scripts/capture.js via child process
 * spawn (same as the CLI). Previously it imported capture() from
 * regret-testing (scripts/api.js), which reimplemented the capture loop
 * separately from scripts/capture.js and silently skipped Phase 2 callee
 * wrapping. Delegating to the CLI script gives us a single source of truth
 * — any future capture-side feature (callees or otherwise) is picked up
 * automatically by the MCP tool with no logic drift.
 *
 * The spawned capture.js process is invoked with `--json` so its stdout is
 * a structured object the MCP tool can parse and pass through to the caller
 * (see `--json` mode in scripts/capture.js for the exact shape).
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { structuredError } from "./structuredError.js";

// Resolve the regret-testing package root from this MCP package. Works in
// both the monorepo dev workspace (where regret-testing is the parent
// package) and when @regrets/mcp is installed alongside regret-testing in
// a user's project (regret-testing is declared as a dependency in
// mcp/package.json).
//
// We resolve to the package's main entry (index.js) and go up one level
// rather than using 'regret-testing/package.json' because the package's
// `exports` field does not expose ./package.json — going through the main
// entry works under strict ESM `exports` resolution.
const require = createRequire(import.meta.url);
const regretTestingRoot = dirname(require.resolve("regret-testing"));
const CAPTURE_JS = join(regretTestingRoot, "scripts", "capture.js");

/** Zod schema for the regrets_capture tool input. */
export const captureToolSchema = {
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
      "Capture only this cluster ID. If omitted, captures all clusters in the manifest."
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
 * Handle the regrets_capture tool call.
 * Spawns `node scripts/capture.js --json [args]` and returns the parsed
 * JSON object as the tool's text content. The JSON shape mirrors the
 * regret-testing programmatic capture() return value, extended with a
 * per-cluster `callees` array (Phase 2 callee contract visibility — #266).
 */
export async function handleCapture(
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const { manifestPath, cluster, cwd } = args as {
    manifestPath?: string;
    cluster?: string;
    cwd?: string;
  };

  const workCwd = cwd ?? process.cwd();

  try {
    const cliArgs: string[] = ["--json"];
    if (cluster) cliArgs.push("--cluster", cluster);
    if (manifestPath) cliArgs.push("--manifest", manifestPath);

    const { stdout, stderr, exitCode } = await runScript(CAPTURE_JS, cliArgs, {
      cwd: workCwd,
    });

    let parsed: {
      passed?: number;
      failed?: number;
      clusters?: Array<{
        id: string;
        pass: boolean;
        fingerprint?: string | null;
        error?: string;
        skipped?: boolean;
        note?: string;
        callees?: Array<{
          id: string;
          pass: boolean;
          fingerprint?: string;
          callee?: string;
          skipped?: boolean;
          error?: string;
        }>;
      }>;
      skippedStack?: number;
      error?: string;
    };
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return structuredError({
        type: "CAPTURE_ERROR",
        message:
          `capture.js did not emit valid JSON (exit=${exitCode}). ` +
          `Parse error: ${msg}. stderr: ${stderr.trim() || "(empty)"}`,
        cluster,
      });
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(parsed, null, 2),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return structuredError({
      type: "CAPTURE_ERROR",
      message: `Failed to capture fingerprints: ${message}`,
      cluster,
    });
  }
}
