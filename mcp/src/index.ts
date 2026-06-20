/**
 * @regrets/mcp — MCP server that exposes Regrets regression testing
 * capabilities as tools for AI agents.
 *
 * Re-exports the server creation and startup functions so consumers can
 * programmatically start the MCP server or create a configured instance.
 *
 * Also re-exports the individual tool handlers and their Zod input schemas
 * so they can be unit-tested in isolation (issue #266 — tests for callee
 * delegation need to invoke handleCapture / handleValidate directly).
 */

export { createServer, startMcpServer } from "./server.js";
export { handleCapture, captureToolSchema } from "./tools/capture.js";
export { handleValidate, validateToolSchema } from "./tools/validate.js";
export { handleScan, scanToolSchema } from "./tools/scan.js";
export { handleHealth, healthToolSchema } from "./tools/health.js";
export { handleStatus, statusToolSchema } from "./tools/status.js";
export { handleChain, chainToolSchema } from "./tools/chain.js";
