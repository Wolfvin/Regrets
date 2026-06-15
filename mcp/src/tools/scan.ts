/**
 * Tool handler for regrets_scan — scan a project directory for cluster
 * suggestions. Delegates to regret-testing's scan() function.
 */

import { z } from "zod";
import { scan } from "regret-testing";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { structuredError } from "./structuredError.js";

/** Zod schema for the regrets_scan tool input. */
export const scanToolSchema = {
  dir: z
    .string()
    .optional()
    .describe(
      "Directory to scan relative to cwd. Default: '.'"
    ),
  stack: z
    .string()
    .optional()
    .describe(
      "Filter by stack (js, ts, python). If omitted, scans js and ts."
    ),
  cwd: z
    .string()
    .optional()
    .describe(
      "Working directory. Default: process.cwd()"
    ),
};

/**
 * Handle the regrets_scan tool call.
 * Calls scan() from regret-testing and returns suggested cluster definitions.
 */
export async function handleScan(
  args: Record<string, unknown>
): Promise<CallToolResult> {
  try {
    const { dir, stack, cwd } = args as {
      dir?: string;
      stack?: string;
      cwd?: string;
    };

    const result = await scan({
      dir: dir ?? ".",
      stack,
      cwd,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return structuredError({
      type: "SCAN_ERROR",
      message: `Failed to scan project: ${message}`,
    });
  }
}
