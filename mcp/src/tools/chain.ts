/**
 * Tool handler for regrets_chain — run chain testing in capture or validate mode.
 * Delegates to regret-testing's chain() function.
 */

import { z } from "zod";
import { chain } from "regret-testing";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Zod schema for the regrets_chain tool input. */
export const chainToolSchema = {
  mode: z
    .enum(["capture", "validate"])
    .describe(
      "Chain testing mode: 'capture' saves chain fingerprints as baseline, " +
        "'validate' compares current chain output against captured baselines."
    ),
  chain: z
    .string()
    .optional()
    .describe(
      "Run only this chain ID. If omitted, runs all chains defined in chains.json."
    ),
  cwd: z
    .string()
    .optional()
    .describe(
      "Working directory containing the regrets/ folder. Default: process.cwd()"
    ),
};

/**
 * Handle the regrets_chain tool call.
 * Calls chain() from regret-testing and returns the structured result as JSON.
 */
export async function handleChain(
  args: Record<string, unknown>
): Promise<CallToolResult> {
  try {
    const { mode, chain: chainId, cwd } = args as {
      mode: "capture" | "validate";
      chain?: string;
      cwd?: string;
    };

    const result = await chain({
      mode,
      chain: chainId,
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
    return {
      content: [
        { type: "text", text: `Error running chain testing: ${message}` },
      ],
      isError: true,
    };
  }
}
