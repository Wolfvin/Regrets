/**
 * @regrets/mcp — MCP server that exposes Regrets regression testing
 * capabilities as tools for AI agents.
 *
 * Re-exports the server creation and startup functions so consumers can
 * programmatically start the MCP server or create a configured instance.
 */

export { createServer, startMcpServer } from "./server.js";
