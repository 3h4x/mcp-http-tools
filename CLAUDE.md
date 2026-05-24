# mcp-http-tools

Generic MCP-to-HTTP proxy. Define any HTTP API as an MCP tool via YAML config.

## Architecture / Banned Patterns

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

- GET params → query string, non-GET params → JSON body
- `{param}` in URL → path substitution (excluded from query/body)
- `{+path}` in URL → raw path substitution that preserves `/` separators
- `{+path}` safety → reject empty segments and `.` / `..`; params used by `{+path}` must be `required: true` or have a safe non-empty `default`
- `method` supports `GET`, `POST`, `PUT`, `PATCH`, `DELETE`
- `${ENV_VAR}` in headers → env var substitution
- `response.type: json` + `response.path` → dot-path JSON extraction
- `default` on params → used when LLM omits the param
- `auth.bearer_env: MY_TOKEN` → shorthand for `Authorization: Bearer ${MY_TOKEN}` (value must be a valid env var name)
- `retry.count` + `retry.backoff_ms` → opt-in retries for transient HTTP/network failures with exponential backoff
- `--config /path/to/config.yaml` or `--config=/path/to/config.yaml` → explicit config override that fails fast on missing files or invalid YAML

## Commands

Package manager: `pnpm 11`.
Note: `package.json` is currently pinned to `pnpm@10.33.0`; upgrade it to pnpm 11 when convenient.

```bash
pnpm test        # ~336 tests (count grows; run to verify)
pnpm install     # install deps using the committed pnpm lockfile
pnpm start       # start MCP server (stdio)
```

## Config location

1. `~/.config/mcp-http-tools/config.yaml` (user config, not in repo)
2. `./config.yaml` (example template)
3. Empty `{}` if neither exists

`--config /path/to/config.yaml` or `--config=/path/to/config.yaml` overrides the search path and requires that exact file to exist and parse successfully.

## Docs Reference

| File | Topic | Load when |
|------|-------|-----------|
| `docs/raw-path-placeholders.md` | `{+path}` placeholder semantics, safety rules, and accepted/rejected examples | Read before changing raw path placeholder parsing, validation, request building, or related docs/examples |

## Coding Conventions

- **Runtime**: Node.js ESM (`"type": "module"`). Never use `require()` or CommonJS.
- **Language**: Plain JavaScript — no TypeScript. Do not add a build step.
- **No linter/formatter configured** — match the style of existing code (2-space indent, single quotes, semicolons).
- **Error handling**: `callTool()` never throws — it returns `{ text, isError: true }` on failure. Keep that contract. Other exported functions throw on programmer errors and return values on data errors.
- **Async**: `async/await` only. No callbacks or raw Promises with `.then()`.
- **All domain logic lives in `lib.js`**. `index.js` is a thin MCP server wire-up (~45 lines) — keep it that way. No new source files unless there is a strong reason.
1. Use modern Node built-ins already relied on by the repo (`fetch`, `AbortController`, `URL`, top-level `await`, `import.meta.url`). Do not add compatibility shims or polyfills.
2. Keep imports grouped and explicit: Node built-ins first using the `node:` prefix, then third-party packages, then local relative imports with the `.js` extension required by ESM.
3. Follow existing naming patterns: exported helpers in `lib.js` use camelCase verbs (`loadConfig`, `buildRequest`), internal constants use `UPPER_SNAKE_CASE`, and tool/config field names stay aligned with YAML keys (`response.path`, `timeout`, `params`).
4. Prefer small, synchronous startup helpers for config loading/validation. Do not introduce classes, dependency injection layers, or extra abstraction around the current functional module layout.
5. Preserve the surrounding style of each file you touch. Avoid quote/spacing churn and do not mix in formatting-only rewrites, especially when the worktree already has unrelated edits.
6. Keep exports minimal. Prefer internal helpers inside `lib.js` unless the function is part of the public module surface used by `index.js` or covered directly in `test.js`.

## Testing Rules

1. Run tests after every change: `pnpm test` (wraps `node --test test.js`).
2. All tests live in `test.js` at the project root — do not create separate test files or subdirectories.
3. Use Node.js built-in `node:test` and `node:assert/strict` only. No third-party test libraries.
4. Every new exported function must have test coverage. Every bug fix must add a regression test.
5. Use `beforeEach`/`afterEach` to isolate env-var mutations (see existing pattern). Do not leave `process.env` mutations across tests.
6. `callTool()` is tested with a real local HTTP server (see existing pattern) — do not mock `fetch`. Keep integration tests real.
7. Skip testing trivial wrappers (e.g. `toQueryString` internal helper) unless they have subtle edge-case logic.
8. Mirror the existing structure in `test.js`: one `describe()` block per exported function, with edge cases added close to the related happy-path tests.
9. For filesystem behavior such as `loadConfig()`, use temporary directories/files created inside the test and clean them up in the test lifecycle; do not rely on any real user config path.
10. When validating serialized requests, assert the full URL/body/header shape that `buildRequest()` or `callTool()` produces rather than only checking one field.
11. If a behavior change affects documented config fields or examples, update `README.md` and `config.yaml` in the same change so the docs stay aligned with `lib.js`.

## Dependency Security

1. Always commit `pnpm-lock.yaml`. Never install without it (`pnpm install --frozen-lockfile` in CI).
2. This project has exactly two runtime deps (`@modelcontextprotocol/sdk`, `js-yaml`). Do not add a new dependency without explicit user approval and a justification in the commit message.
3. Before adding any package, check it on the npm registry: download count, publish date, maintainer history. Verify the package name is not a typosquat.
4. Run `pnpm audit` after any dependency change and resolve critical/high findings before committing.
5. Never add packages with `postinstall` or `prepare` scripts without reviewing exactly what they execute.
6. Prefer `pnpm` for install/update commands in both docs and local runs. Do not switch project instructions to `npm` while `packageManager` is pinned to `pnpm@10.33.0` and the repo lockfile is `pnpm-lock.yaml`. Note: consider upgrading to pnpm 11 when convenient.

## Architecture / Banned Patterns

1. Keep `lib.js` as the single implementation module for config parsing, validation, request construction, and response extraction. If behavior changes, start there.
2. Keep `index.js` focused on MCP wiring only: load config, validate once at startup, expose tool schemas, dispatch `callTool()`. Do not move business rules or request-shaping logic into the server entrypoint.
3. Preserve the startup flow documented above: `loadConfig()` chooses one config source, `validateConfig()` reports data errors before boot, and runtime request failures are handled inside `callTool()`.
4. Preserve config-driven behavior over hardcoded presets. New features should be expressed as YAML config fields interpreted by `lib.js`, not as repo-specific API logic.
5. Prefer adding small helpers within `lib.js` over creating new source files. Split modules only when there is clear reuse pressure or explicit approval.
6. Keep example behavior deterministic and order-preserving: `configToTools()` should continue reflecting tool order from the YAML config, and startup should not merge or mutate tool definitions implicitly.
7. Treat raw path placeholder validation as part of the core request-building contract. Changes to `{+path}` behavior must keep validation in `lib.js`, add regression tests in `test.js`, and update `README.md`, `config.yaml`, and `docs/raw-path-placeholders.md` together.

## Safety Rules

1. `~/.config/mcp-http-tools/config.yaml` often contains API keys — never read, log, or commit it. Only `config.yaml` (the example template) belongs in the repo.
2. Do not commit secrets, tokens, or `.env` files. `${ENV_VAR}` substitution exists precisely to keep secrets out of configs.
3. Do not bypass `pnpm-lock.yaml` or run `pnpm install --no-lockfile`.
4. Commit style: conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `chore:`, `docs:`). Match the existing log format.
5. The `main` branch is the only branch — no feature branches are used in this project. Commit directly to `main` after tests pass.
6. Never use the real home-directory config for debugging or tests. Work against the committed `config.yaml` example or explicit temporary paths passed into helpers.
7. Do not rewrite unrelated dirty files or bundle opportunistic cleanup into the same change unless the task explicitly requires it.

## Next steps

### Future
- **Response transforms** — beyond dot-path: templates or formatters for human-readable output
- **Config merging** — load both global and local, merge tools arrays (shared + project-specific)
- **Hot reload** — watch config file, reload tools without restart
- **Publish to npm**
