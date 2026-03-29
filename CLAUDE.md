# mcp-http-tools

Generic MCP-to-HTTP proxy. Define any HTTP API as an MCP tool via YAML config. See README.md for full docs.

## Quick ref

- Config: `~/.config/mcp-http-tools/config.yaml` → `./config.yaml` → empty
- Run: `node index.js`
- Test: `pnpm test`
- Each tool = one HTTP request defined in YAML
- GET params → query string, POST params → JSON body
- `{param}` in URL → path substitution
- `${ENV_VAR}` in headers → env var substitution
- `response.path` → dot-path JSON extraction
