/**
 * Tool handler for regrets_validate — validate captured fingerprints against
 * live code output. Delegates to regret-testing's validate() function.
 */

import { z } from "zod";
import { validate } from "regret-testing";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

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
  cwd: z
    .string()
    .optional()
    .describe(
      "Working directory containing the regrets/ folder. Default: process.cwd()"
    ),
};

/**
 * Handle the regrets_validate tool call.
 * Calls validate() from regret-testing and returns PASS/FAIL per cluster
 * with diff information for failures.
 */
export async function handleValidate(
  args: Record<string, unknown>
): Promise<CallToolResult> {
  try {
    const {
      manifestPath,
      cluster,
      failFast,
      runs,
      includeDiff,
      cwd,
    } = args as {
      manifestPath?: string;
      cluster?: string;
      failFast?: boolean;
      runs?: number;
      includeDiff?: boolean;
      cwd?: string;
    };

    const result = await validate({
      manifestPath: manifestPath ?? "regrets/manifest.json",
      cluster,
      failFast,
      runs,
      includeDiff,
      cwd,
    });

    // Add human-readable PASS/FAIL summary
    const summary = result.results.map((r) => {
      if (r.skipped) return `${r.id}: SKIPPED`;
      return r.pass ? `${r.id}: PASS` : `${r.id}: FAIL`;
    });

    const output = {
      verdict: result.failed === 0 ? "ALL PASS" : `${result.failed} FAIL(S)`,
      passed: result.passed,
      failed: result.failed,
      summary,
      results: result.results,
      error: result.error,
    };

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
    return {
      content: [
        { type: "text", text: `Error validating clusters: ${message}` },
      ],
      isError: true,
    };
  }
}
