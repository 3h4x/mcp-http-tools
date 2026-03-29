# mcp-http-tools

Generic MCP-to-HTTP proxy. Define any HTTP API as an MCP tool via YAML config.

## Architecture

```
YAML config → configToTools() → MCP tool schemas
                                        ↓
MCP client calls tool → buildRequest() → fetch() → extractResponse() → MCP response
```

- `lib.js` — all logic: config loading, schema generation, request building, response extraction
- `index.js` — thin MCP server wiring (~45 lines), no domain logic
- `config.yaml` — example template (committed), real config at `~/.config/mcp-http-tools/config.yaml`

## Key functions (lib.js)

| Function | Purpose |
|----------|---------|
| `loadConfig()` | Loads YAML from global → local → empty fallback |
| `configToTools(config)` | Generates MCP tool schemas from config |
| `buildRequest(toolConfig, args)` | Builds `{ url, options }` for fetch |
| `extractResponse(raw, responseConfig)` | Formats response (text passthrough or JSON path extraction) |
| `resolvePath(obj, path)` | Dot-notation object traversal |
| `substituteEnvVars(str)` | `${VAR}` → `process.env.VAR` replacement |

## Config features

- GET params → query string, POST params → JSON body
- `{param}` in URL → path substitution (excluded from query/body)
- `${ENV_VAR}` in headers → env var substitution
- `response.type: json` + `response.path` → dot-path JSON extraction
- `default` on params → used when LLM omits the param

## Commands

```bash
pnpm test        # 53 tests
node index.js    # start MCP server (stdio)
```

## Config location

1. `~/.config/mcp-http-tools/config.yaml` (user config, not in repo)
2. `./config.yaml` (example template)
3. Empty `{}` if neither exists

## Next steps

### Before publishing
- **Config validation** — `validateConfig()` on startup: check required fields (`name`, `url`), valid `method`, clear error messages for typos
- **Request timeouts** — per-tool `timeout` field (default 30s), so a hanging API doesn't block the server
- **`npx` support** — add `"bin"` to package.json so `npx mcp-http-tools` works without cloning
- **GitHub Actions** — CI workflow to run tests on push/PR, release workflow for npm publish on tag (reuse patterns from existing repos)

### Future
- **All HTTP methods** — PUT/PATCH/DELETE body handling (currently only POST builds a body)
- **Response transforms** — beyond dot-path: templates or formatters for human-readable output
- **Config merging** — load both global and local, merge tools arrays (shared + project-specific)
- **Auth presets** — `auth: bearer_env: MY_TOKEN` shorthand instead of full headers
- **Config via CLI flag** — `--config /path/to/config.yaml` override
- **Hot reload** — watch config file, reload tools without restart
- **Retry/backoff** — configurable retry for flaky endpoints
- **Publish to npm**
