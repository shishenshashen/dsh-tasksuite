# dsh-tasksuite — MCP bridge wiring (awr-mcp)

`awr-mcp` is the official AWR MCP server (shipped by @originoneai/agent-work-runtime
0.5.0). DSH ships a built-in MCP **client** (`dsh-mcp-client`) that supports both
stdio and shared Streamable HTTP transports, so AWR's whole tool surface becomes
`mcp__<serverName>__<tool>` with **zero adapter code** — no need to hand-wrap
every awr command.

This is the "state layer ↔ execution layer" bridge that lets any DSH agent
read/progress/complete AWR work items and, on restart, run the recovery flow
(`awr recovery`, `awr session resume`) through the same path.

## Two transport options

### 1) stdio (simplest; one process per agent)

```json
{
  "mcpServers": {
    "awr": {
      "command": "awr-mcp",
      "args": ["--project", "/home/wdf-pai/kf"],
      "env": {}
    }
  }
}
```

Tools become `mcp__awr__awr_*`. Because stdio is per-client, each DSH agent gets
its own AWR-MCP child process — clean isolation, slightly higher per-agent cost.

### 2) Shared Streamable HTTP (one server, many clients)

`awr-mcp` can run as a long-lived HTTP server over a **registry** of projects
that the operator owns. Clients (any number of DSH agents) connect over HTTP.

Start the server:

```bash
# One server exposing the operator's registry over Streamable HTTP at /mcp
awr-mcp --registry ~/.awr/registry.toml --listen 127.0.0.1:8080
```

`~/.awr/registry.toml` (operator-owned projects, with bearer credential):

```toml
# awr-mcp registry example — operator-owned projects exposed to clients
[[project]]
id = "kf"
path = "/home/wdf-pai/kf"
[[ project.credentials ]]
kind = "bearer"
token = "PASTE-OPERATOR-TOKEN"
```

Client config (`dsh-mcp-client` streamable-http transport):

```json
{
  "mcpServers": {
    "awr": {
      "transport": "streamable-http",
      "url": "http://127.0.0.1:8080/mcp",
      "headers": { "Authorization": "Bearer PASTE-OPERATOR-TOKEN" }
    }
  }
}
```

## Verification steps (run before shipping)

```bash
awr-mcp --help                    # confirm Streamable HTTP / --registry flags
awr-mcp --registry ~/.awr/registry.toml --listen 127.0.0.1:8080   # start server
# then from DSH: query mcp__awr__* tools (e.g. mcp__awr__awr_status)
```

> Note: Streamable HTTP auth (bearer token in registry vs. client header) and
> the exact flags are **to be confirmed against the installed `awr-mcp --help`**
> before production use. The stdio path above is the verified, zero-config route.

## Relation to the three plugins

| Plugin | Role | Uses MCP bridge? |
| --- | --- | --- |
| awr-goal-supervisor | outer loop, fake-death recover | No (calls `awr` via shell / its own tool path) |
| awr-tools | read-only status Tools | Optional (either shell or mcp__awr__*) |
| awr-task-board | GUI board | Optional (Host half shells `awr`) |
