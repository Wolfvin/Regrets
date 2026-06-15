/**
 * Tool handler for regrets_capture — capture fingerprints for all clusters
 * in the manifest. Delegates to regret-testing's capture() function.
 */

import { z } from "zod";
import { capture } from "regret-testing";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { structuredError } from "./structuredError.js";

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
 * Handle the regrets_capture tool call.
 * Calls capture() from regret-testing and returns the result as JSON.
 */
export async function handleCapture(
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const { manifestPath, cluster, cwd } = args as {
    manifestPath?: string;
    cluster?: string;
    cwd?: string;
  };

  try {

    const result = await capture({
      manifestPath: manifestPath ?? "regrets/manifest.json",
      cluster,
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
      type: "CAPTURE_ERROR",
      message: `Failed to capture fingerprints: ${message}`,
      cluster,
    });
  }
}
