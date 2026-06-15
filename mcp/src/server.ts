#!/usr/bin/env node

/**
 * @regrets/mcp — MCP server that exposes Regrets regression testing
 * capabilities as tools for AI agents.
 *
 * Runs on stdio (standard MCP transport) so it can be used directly by
 * Claude Desktop, Cursor, and any other MCP-compatible AI client.
 *
 * Tools provided:
 *   1. regrets_capture  — Capture fingerprints for all clusters in manifest
 *   2. regrets_validate — Validate clusters — PASS/FAIL per cluster + diff
 *   3. regrets_health   — Health report (score, label, drifts) per cluster
 *   4. regrets_status   — safeToRefactor: YES/PARTIAL/NO + summary
 *   5. regrets_scan     — Suggest clusters from codebase
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  captureToolSchema,
  handleCapture,
} from "./tools/capture.js";
import {
  validateToolSchema,
  handleValidate,
} from "./tools/validate.js";
import {
  healthToolSchema,
  handleHealth,
} from "./tools/health.js";
import {
  statusToolSchema,
  handleStatus,
} from "./tools/status.js";
import {
  scanToolSchema,
  handleScan,
} from "./tools/scan.js";

/**
 * Create and configure the MCP server with all Regrets tools registered.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "@regrets/mcp",
    version: "0.1.0",
  });

  // ─── Tool 1: regrets_capture ──────────────────────────────────────────────
  server.tool(
    "regrets_capture",
    "Capture fingerprints for all clusters defined in the manifest. " +
      "Runs the entry function for each cluster with its defined inputs, " +
      "fingerprints the output, and writes .regret files to the regrets/ directory. " +
      "Use this after setting up or modifying your manifest to establish baseline fingerprints.",
    captureToolSchema,
    async (args) => {
      return handleCapture(args as Record<string, unknown>);
    }
  );

  // ─── Tool 2: regrets_validate ─────────────────────────────────────────────
  server.tool(
    "regrets_validate",
    "Validate captured fingerprints against live code output. " +
      "Returns PASS/FAIL per cluster with diff details for failures. " +
      "Use this to check if refactoring has changed any output contracts — " +
      "a FAIL means the code's observable behavior has drifted from the baseline.",
    validateToolSchema,
    async (args) => {
      return handleValidate(args as Record<string, unknown>);
    }
  );

  // ─── Tool 3: regrets_health ───────────────────────────────────────────────
  server.tool(
    "regrets_health",
    "Return health report for all clusters with scores (0-100), labels " +
      "(SOLID/GOOD/UNSTABLE/FRAGILE/NEW), and confidence levels (HIGH/MEDIUM/LOW). " +
      "Health is computed from update/drift history and capture age. " +
      "Use this to identify which clusters need attention before refactoring.",
    healthToolSchema,
    async (args) => {
      return handleHealth(args as Record<string, unknown>);
    }
  );

  // ─── Tool 4: regrets_status ───────────────────────────────────────────────
  server.tool(
    "regrets_status",
    "Quick snapshot of Regrets state: returns safeToRefactor (YES/PARTIAL/NO) " +
      "along with coverage percentage, health counts, and confidence counts. " +
      "YES means all clusters are SOLID with HIGH confidence. " +
      "NO means there are FRAGILE/UNSTABLE or LOW confidence clusters. " +
      "PARTIAL means the project is partially safe. " +
      "Use this as a pre-refactor safety check.",
    statusToolSchema,
    async (args) => {
      return handleStatus(args as Record<string, unknown>);
    }
  );

  // ─── Tool 5: regrets_scan ─────────────────────────────────────────────────
  server.tool(
    "regrets_scan",
    "Scan a project directory and suggest regret cluster definitions " +
      "based on exported functions. Returns a list of suggested clusters " +
      "with id, entry function name, file path, stack, and watch targets. " +
      "Use this when setting up Regrets for a new project to get initial " +
      "cluster suggestions — you still decide which clusters to create.",
    scanToolSchema,
    async (args) => {
      return handleScan(args as Record<string, unknown>);
    }
  );

  return server;
}

/**
 * Start the MCP server using stdio transport.
 * This is the main entry point when running as a CLI tool.
 */
export async function startMcpServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// When executed directly (not imported), start the server
startMcpServer().catch((error: unknown) => {
  console.error("Fatal error starting @regrets/mcp server:", error);
  process.exit(1);
});
