# mcp-http-tools

Generic MCP-to-HTTP proxy. Define any HTTP API as an MCP tool via YAML config.

## Architecture

```
YAML config → configToTools() → MCP tool schemas
                                        ↓
MCP client calls tool → callTool() ┬─► buildRequest() → fetch() (w/ timeout)
                                   └─► extractResponse() → MCP response
```

- `lib.js` — all logic: config loading, schema generation, request building, response extraction
- `index.js` — thin MCP server wiring (~45 lines), no domain logic
- `config.yaml` — example template (committed), real config at `~/.config/mcp-http-tools/config.yaml`

## Key functions (lib.js)

| Function | Purpose |
|----------|---------|
| `loadConfig()` | Loads YAML from global → local → empty fallback |
| `configToTools(config)` | Generates MCP tool schemas from config |
| `validateConfig(config)` | Returns array of config error messages (startup validation) |
| `buildRequest(toolConfig, args)` | Builds `{ url, options }` for fetch |
| `callTool(toolConfig, args)` | End-to-end tool invocation: build → fetch (w/ timeout) → extract. Returns `{ text, isError? }` |
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
pnpm test        # 90 tests
node index.js    # start MCP server (stdio)
```

## Config location

1. `~/.config/mcp-http-tools/config.yaml` (user config, not in repo)
2. `./config.yaml` (example template)
3. Empty `{}` if neither exists

## Coding Conventions

- **Runtime**: Node.js ESM (`"type": "module"`). Never use `require()` or CommonJS.
- **Language**: Plain JavaScript — no TypeScript. Do not add a build step.
- **No linter/formatter configured** — match the style of existing code (2-space indent, single quotes, semicolons).
- **Error handling**: `callTool()` never throws — it returns `{ text, isError: true }` on failure. Keep that contract. Other exported functions throw on programmer errors and return values on data errors.
- **Async**: `async/await` only. No callbacks or raw Promises with `.then()`.
- **All domain logic lives in `lib.js`**. `index.js` is a thin MCP server wire-up (~45 lines) — keep it that way. No new source files unless there is a strong reason.

## Testing Rules

1. Run tests after every change: `pnpm test` (wraps `node --test test.js`).
2. All tests live in `test.js` at the project root — do not create separate test files or subdirectories.
3. Use Node.js built-in `node:test` and `node:assert/strict` only. No third-party test libraries.
4. Every new exported function must have test coverage. Every bug fix must add a regression test.
5. Use `beforeEach`/`afterEach` to isolate env-var mutations (see existing pattern). Do not leave `process.env` mutations across tests.
6. `callTool()` is tested with a real local HTTP server (see existing pattern) — do not mock `fetch`. Keep integration tests real.
7. Skip testing trivial wrappers (e.g. `toQueryString` internal helper) unless they have subtle edge-case logic.

## Dependency Security

1. Always commit `pnpm-lock.yaml`. Never install without it (`pnpm install --frozen-lockfile` in CI).
2. This project has exactly two runtime deps (`@modelcontextprotocol/sdk`, `js-yaml`). Do not add a new dependency without explicit user approval and a justification in the commit message.
3. Before adding any package, check it on the npm registry: download count, publish date, maintainer history. Verify the package name is not a typosquat.
4. Run `pnpm audit` after any dependency change and resolve critical/high findings before committing.
5. Never add packages with `postinstall` or `prepare` scripts without reviewing exactly what they execute.

## Safety Rules

1. `~/.config/mcp-http-tools/config.yaml` often contains API keys — never read, log, or commit it. Only `config.yaml` (the example template) belongs in the repo.
2. Do not commit secrets, tokens, or `.env` files. `${ENV_VAR}` substitution exists precisely to keep secrets out of configs.
3. Do not bypass `pnpm-lock.yaml` or run `pnpm install --no-lockfile`.
4. Commit style: conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `chore:`, `docs:`). Match the existing log format.
5. The `main` branch is the only branch — no feature branches are used in this project. Commit directly to `main` after tests pass.

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
