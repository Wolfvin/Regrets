/**
 * Shared structured error response builder for MCP tool handlers.
 *
 * Every tool error must return JSON in the shape:
 *   { success: false, error: { type: string, message: string, cluster?: string, chain?: string } }
 *
 * This module centralises that contract so all 6 handlers stay consistent.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** The JSON shape returned inside the `text` field when a tool fails. */
export interface StructuredErrorBody {
  success: false;
  error: {
    type: string;
    message: string;
    cluster?: string;
    chain?: string;
  };
}

/**
 * Build a `CallToolResult` whose text payload is a structured error JSON.
 *
 * @param opts.type     – Machine-readable error category (e.g. `"CAPTURE_ERROR"`)
 * @param opts.message  – Human-readable description of what went wrong
 * @param opts.cluster  – Optional cluster ID relevant to the error
 * @param opts.chain    – Optional chain ID relevant to the error
 */
export function structuredError(opts: {
  type: string;
  message: string;
  cluster?: string;
  chain?: string;
}): CallToolResult {
  const body: StructuredErrorBody = {
    success: false,
    error: {
      type: opts.type,
      message: opts.message,
    },
  };

  if (opts.cluster !== undefined) body.error.cluster = opts.cluster;
  if (opts.chain !== undefined) body.error.chain = opts.chain;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(body, null, 2),
      },
    ],
    isError: true,
  };
}
