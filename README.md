# Magpie Control MCP

Local stdio MCP server for inspecting and managing Magpie routing. It is implemented with Node.js built-ins and has no package dependencies.

## Tools

- Read the current Magpie version, groups, quota, model catalog, and individual group details.
- Test a provider with Magpie's built-in small latency request.
- Probe a listed model through Magpie's local OpenAI-compatible gateway; the response includes elapsed time and token usage. This consumes model quota and is not a quality score.
- Create, update, and remove routing groups. Model IDs must already appear in Magpie's current model catalog. Creation refuses a group ID that already exists.

Use probe tools only when the user asks to test availability or speed. Use routing mutation tools only for changes the user requested. In particular, inspect a group before changing/removing it, because Magpie groups may be referenced by several agents.

## Run directly

```powershell
node .\server.mjs
```

Requirements: Node.js 20 or later, and the Magpie executable available on `PATH`. By default the server runs `magpie-windows-amd64.exe` and connects to `http://127.0.0.1:3425` with the gateway key `magpie`. Set `MAGPIE_BIN`, `MAGPIE_GATEWAY_URL`, or `MAGPIE_GATEWAY_KEY` when your installation uses different values. The server never reads Magpie provider keys, browser profiles, or agent configuration files.

## Magpie Library registration

Magpie can project one stdio MCP entry into supported agents, including Codex, Claude Code, and DSH. After reviewing this README and the exact agent list, register and sync it through Magpie's library:

```powershell
$node = (Get-Command node).Source
$server = (Resolve-Path .\server.mjs).Path
magpie library mcp add magpie-control $node $server agents=codex,claude,dsh
magpie library sync
```

Magpie backs up agent configuration before writing Library entries. Restart agent processes after synchronization so they discover the MCP tools.
