# @regrets/mcp

MCP server that exposes [Regrets](https://github.com/Wolfvin/Regrets) regression testing capabilities as tools for AI agents like Claude Desktop and Cursor.

## Tools

The server registers **6 tools** via `server.tool(...)` in [`src/server.ts`](src/server.ts). The table below matches that registration list exactly. (`src/tools/structuredError.ts` is a shared error-response helper, not a registered tool.)

| Tool | Description | Status |
|------|-------------|--------|
| `regrets_capture` | Capture fingerprints for all clusters in the manifest | Active |
| `regrets_validate` | Validate clusters — PASS/FAIL per cluster + diff on failure | Active |
| `regrets_health` | Health report: score, label, confidence per cluster | Active |
| `regrets_status` | Quick snapshot: `safeToRefactor` YES/PARTIAL/NO + summary | Active |
| `regrets_scan` | Suggest clusters from a codebase | ⚠️ Deprecated — see [Deprecation note](#regrets_scan-deprecated) |
| `regrets_chain` | Run chain testing in capture or validate mode | Active |

> **Verification:** the names in the table above are the exact first
> arguments to every `server.tool(...)` call in `src/server.ts`. If you add
> or remove a tool, update both the table and `server.ts` in the same PR.

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

After editing the config, restart Claude Desktop. The six `regrets_*` tools will appear in the tools panel.

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
│   ├── server.ts          # MCP server setup + tool registration (6 tools)
│   ├── index.ts           # Re-exports for programmatic use
│   ├── types/
│   │   └── regret-testing.d.ts   # Type declarations for parent package
│   └── tools/
│       ├── capture.ts           # regrets_capture tool
│       ├── validate.ts          # regrets_validate tool
│       ├── health.ts            # regrets_health tool
│       ├── status.ts            # regrets_status tool
│       ├── scan.ts              # regrets_scan tool  (deprecated)
│       ├── chain.ts             # regrets_chain tool
│       └── structuredError.ts   # Shared error-response helper (NOT a registered tool)
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── README.md
```

- Uses `@modelcontextprotocol/sdk` with stdio transport
- Zod schemas for input validation on every tool
- `capture` and `validate` **delegate to `scripts/capture.js` and `scripts/validate.js` via child process spawn** (single source of truth — issue #266). Both scripts are invoked with `--json` so the MCP layer just parses structured output. Any future capture/validate feature (callee wrapping, callee re-validation, drift detection, etc.) is picked up automatically with no logic drift.
- `scan` and `chain` delegate to `regret-testing`'s programmatic API (no equivalent CLI scripts to spawn).
- `health` and `status` read `.regret` files, `audit.log`, and `manifest.json` directly to produce reports
- `structuredError` is a shared helper used by all tool handlers to produce uniform `{ success: false, error: { type, message, ... } }` responses; it is not registered as a tool with `server.tool(...)`.
- Built with `tsup` in ESM format

### Callee contract support (Phase 2 + Phase 3)

When a manifest cluster declares `callees: [...]`, the MCP tools now handle
them end-to-end:

- **`regrets_capture`** spawns `capture.js --json`, which performs Phase 2
  callee wrapping (Ghost Proxy for CJS, ESM source transform for bare-name
  callees) and writes `<parent>.calls.<callee>.regret` files. The MCP
  result's per-cluster entry includes a `callees` array listing each
  callee contract written.
- **`regrets_validate`** spawns `validate.js --json`, which performs
  Phase 3 callee contract re-validation. The MCP result includes a
  top-level `callees` object: `{ passed, failed, skipped, considered,
  contracts: [{ id, pass, expected, actual, ... }] }`.
- Set `skipCallees: true` on `regrets_validate` to disable Phase 3
  (mirrors `regret validate --skip-callees`).

Before issue #266, the MCP tools imported a parallel implementation from
`scripts/api.js` that silently skipped both phases.

## `regrets_chain` — chain testing

`regrets_chain` runs multi-step chains that span several clusters in sequence
and verifies the combined output. It mirrors the `regret chain` CLI command
and delegates to `regret-testing`'s programmatic `chain()` function.

### Input schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `mode` | `"capture"` \| `"validate"` | yes | `capture` saves chain fingerprints as the baseline; `validate` compares current chain output against the captured baselines. |
| `chain` | string | no | Run only this chain ID. If omitted, runs all chains defined in `regrets/chains.json`. |
| `cwd` | string | no | Working directory containing the `regrets/` folder. Default: `process.cwd()`. |

### Output shape

```jsonc
{
  "passed": 2,
  "failed": 0,
  "chains": [
    {
      "id": "checkout-flow",
      "status": "passed",            // "passed" | "failed"
      "chainHash": "a1b2c3d",        // present on pass
      "reason": null,                // present on failure (e.g. "hash mismatch")
      "error": null                  // present on runtime error
    }
  ]
}
```

On a handler-level error (e.g. missing `chains.json`), the tool returns a
structured-error body:

```jsonc
{
  "success": false,
  "error": {
    "type": "CHAIN_ERROR",
    "message": "Failed to run chain testing: ...",
    "chain": "checkout-flow"        // only set when the `chain` input was provided
  }
}
```

### Minimal example

```jsonc
// 1. Capture chain baselines
{
  "mode": "capture",
  "cwd": "/path/to/project"
}

// 2. After refactoring, validate the chains
{
  "mode": "validate",
  "chain": "checkout-flow",         // optional — omit to run all chains
  "cwd": "/path/to/project"
}
```

## `regrets_scan` — deprecated

`regrets_scan` is **deprecated** as of issue #540. The tool still works (it
calls `scan()` from `regret-testing`'s programmatic API), but the underlying
CLI command `regret scan` is itself deprecated in `scripts/regret.js`:

```
⚠️  DEPRECATED: `regret scan` is replaced by `regret install --dry-run`
```

`regret install --dry-run` discovers all exported functions and previews the
manifest without writing or capturing — a strict superset of what
`regret scan` offers.

### What this means for MCP users

- The tool remains registered and callable; no breaking change in this PR.
- AI agents that currently call `regrets_scan` should migrate to running
  `regret install --dry-run` via the host project's shell instead, until a
  `regrets_install` MCP tool is shipped.
- A `regrets_install` MCP tool (wrapping `regret install --dry-run`) is
  planned for a follow-up PR. It is intentionally **not** added in this PR
  because that requires changes to `mcp/src/tools/*.ts`, which are out of
  scope here (this PR only edits `mcp/README.md`).

### Tracking

- Issue: #540
- Follow-up: new `regrets_install` MCP tool (separate PR).
