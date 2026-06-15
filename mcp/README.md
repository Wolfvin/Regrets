# @regrets/mcp

MCP server that exposes [Regrets](https://github.com/Wolfvin/Regrets) regression testing capabilities as tools for AI agents like Claude Desktop and Cursor.

## Tools

| Tool | Description |
|------|-------------|
| `regrets_capture` | Capture fingerprints for all clusters in the manifest |
| `regrets_validate` | Validate clusters — PASS/FAIL per cluster + diff on failure |
| `regrets_health` | Health report: score, label, confidence per cluster |
| `regrets_status` | Quick snapshot: `safeToRefactor` YES/PARTIAL/NO + summary |
| `regrets_scan` | Suggest clusters from a codebase |

## Install

From the Regrets repo root:

```bash
cd mcp
npm install
npm run build
```

This produces `dist/server.js` which is the executable MCP server.

## Configure in Claude Desktop

Add this to your Claude Desktop config file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "regrets": {
      "command": "node",
      "args": ["/absolute/path/to/Regrets/mcp/dist/server.js"],
      "env": {}
    }
  }
}
```

Replace `/absolute/path/to/Regrets` with the actual path to your Regrets repo clone.

After editing the config, restart Claude Desktop. The five `regrets_*` tools will appear in the tools panel.

## Configure in Cursor

Add to your `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "regrets": {
      "command": "node",
      "args": ["/absolute/path/to/Regrets/mcp/dist/server.js"]
    }
  }
}
```

## Usage with the `cwd` parameter

All tools accept an optional `cwd` parameter that sets the working directory where the `regrets/` folder is located. If omitted, it defaults to `process.cwd()`. When Claude runs the MCP server from a project directory, the tools will automatically use that project's `regrets/` folder.

## Development

```bash
cd mcp
npm install          # install dependencies
npm run build        # compile TypeScript to dist/
npm run typecheck    # type-check without emitting
npm run start        # start the server (for manual testing)
```

## Architecture

```
mcp/
├── src/
│   ├── server.ts          # MCP server setup + tool registration
│   ├── index.ts           # Re-exports for programmatic use
│   ├── types/
│   │   └── regret-testing.d.ts   # Type declarations for parent package
│   └── tools/
│       ├── capture.ts     # regrets_capture tool
│       ├── validate.ts    # regrets_validate tool
│       ├── health.ts      # regrets_health tool
│       ├── status.ts      # regrets_status tool
│       └── scan.ts        # regrets_scan tool
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── README.md
```

- Uses `@modelcontextprotocol/sdk` with stdio transport
- Zod schemas for input validation on every tool
- `capture`, `validate`, and `scan` delegate to `regret-testing`'s programmatic API
- `health` and `status` read `.regret` files, `audit.log`, and `manifest.json` directly to produce reports
- Built with `tsup` in ESM format
