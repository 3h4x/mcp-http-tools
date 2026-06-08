# mcp-http-tools

Turn any HTTP API into MCP tools via YAML config. No code required.

Define your tools in a YAML file — each one maps to an HTTP request. The MCP server reads the config, exposes the tools, and proxies requests to your APIs.

## Quick start

### From source

```bash
pnpm install
```

### From GitHub Packages

Releases are published to [GitHub Packages](https://docs.github.com/en/packages) as `@3h4x/mcp-http-tools`. To install, tell your package manager to fetch the `@3h4x` scope from GitHub's registry by adding an `.npmrc`:

```
@3h4x:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

`GITHUB_TOKEN` must be a [personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) with the `read:packages` scope. Then:

```bash
pnpm add @3h4x/mcp-http-tools
```

Create `~/.config/mcp-http-tools/config.yaml`:

```yaml
tools:
  - name: check_health
    description: Check if the API is healthy
    url: http://localhost:3000/health
    response:
      type: text

  - name: query_metrics
    description: Run a PromQL query
    url: http://localhost:9090/api/v1/query
    params:
      - name: query
        description: PromQL expression
        required: true
    response:
      type: json
      path: data.result
```

Run the server:

```bash
node index.js
```

To use a different config file for one run:

```bash
node index.js --config /path/to/config.yaml
```

If the explicit config file is missing or invalid YAML, startup fails instead of falling back to an empty tool list.

## Config reference

Each tool supports:

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | yes | | MCP tool name |
| `description` | no | `""` | Shown to the LLM |
| `url` | yes | | Target HTTP endpoint. Supports `{param}` placeholders and `{+path}` raw path placeholders, including hyphenated names like `{user-id}` |
| `method` | no | `GET` | HTTP method (`GET`, `POST`, `PUT`, `PATCH`, or `DELETE`) |
| `auth.bearer_env` | no | | Shorthand for `Authorization: Bearer ${ENV_VAR}`. The value must be an environment variable name containing only letters, digits, and underscores |
| `headers` | no | | Static headers. Supports `${ENV_VAR}` substitution |
| `params` | no | `[]` | Tool input parameters (see below) |
| `response.type` | no | `text` | `text` (raw) or `json` (parsed) |
| `response.path` | no | | Dot-path to extract from JSON (e.g. `data.result`) |
| `response.template` | no | | JSON-only output template using `{dot.path}` placeholders (e.g. `Status: {status}`) |
| `timeout` | no | `30000` | Request timeout in milliseconds |
| `retry.count` | no | `2` when `retry` is set | Number of retry attempts after the first request. Retries are disabled unless a `retry` object is present |
| `retry.backoff_ms` | no | `250` when `retry` is set | Initial exponential backoff delay in milliseconds. The delay doubles after each failed attempt |

When a tool entry is present, it must be an object using only the documented fields above. Unsupported top-level tool keys are rejected at startup.

### Retry

Retries are opt-in per tool. Add a `retry` object to retry transient failures:

```yaml
retry:
  count: 2
  backoff_ms: 250
```

`count` is the number of retry attempts after the first request. `backoff_ms` is the initial delay, so `250` waits 250ms before the first retry and 500ms before the second. Each request attempt gets the configured `timeout`; the timeout is not shared across all attempts.

Retried failures are HTTP `408`, `429`, `500`, `502`, `503`, and `504`, request timeouts, and network errors reported by `fetch`.

### Params

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | yes | | Parameter name |
| `description` | no | | Shown to the LLM |
| `type` | no | `string` | JSON Schema type (`string`, `number`, `integer`, `boolean`, `array`, or `object`) |
| `enum` | no | | Non-empty list of allowed values. When `type` is set, every enum value must match it |
| `required` | no | `false` | Whether the LLM must provide this |
| `default` | no | | Value used when param is omitted. It must match the effective param type, and if `enum` is set it must also be one of those values |

When a param entry is present, it must be an object using only the fields above. Unsupported param keys are rejected at startup.

### How params map to requests

- **GET**: params become URL query parameters
- **POST**: params become keys in a JSON body
- **URL placeholders**: `{param}` in the URL consumes the param value (not sent as query param or body key). If that param is `required: true`, omitting it fails the request instead of inserting an empty path segment.
- **Raw path placeholders**: `{+path}` preserves `/` separators while still encoding each path segment
- **Raw path safety**: `{+path}` rejects empty segments and `.` / `..` segments so callers cannot escape the configured URL prefix
- **Raw path config contract**: params used by `{+path}` must be `required: true` or have a safe non-empty `default`
- **Placeholder names**: placeholder matching uses the param `name`, so names like `{user-id}` and `{+file-path}` are valid

### Response shaping

- `response` must be an object when set. Unsupported keys are rejected at startup.
- `response.type: text` passes the upstream body through unchanged.
- `response.type: json` pretty-prints parsed JSON by default.
- `response.path` extracts one dot-path from parsed JSON. Missing paths fall back to the raw upstream body.
- `response.template` formats parsed JSON with `{dot.path}` placeholders. Missing placeholders are left unchanged so config mistakes stay visible.
- When both `response.path` and `response.template` are set, the template runs against the extracted subtree.

See [docs/raw-path-placeholders.md](docs/raw-path-placeholders.md) for the exact `{+path}` contract.

## Examples

### GET with query params

```yaml
- name: search_logs
  description: Search logs via LogQL
  url: http://localhost:3100/loki/api/v1/query_range
  retry:
    count: 2
    backoff_ms: 250
  params:
    - name: query
      description: LogQL query
      required: true
    - name: direction
      description: Query direction
      enum: [forward, backward]
      default: backward
    - name: limit
      default: "50"
  response:
    type: json
    path: data.result
```

### POST with JSON body

```yaml
- name: create_alert
  description: Create an alert silence
  method: POST
  url: http://localhost:9093/api/v2/silences
  params:
    - name: matchers
      required: true
    - name: comment
      required: true
  response:
    type: json
```

### URL path parameters

```yaml
- name: get_label_values
  description: List values for a Loki label
  url: http://localhost:3100/loki/api/v1/label/{label}/values
  params:
    - name: label
      description: Label name (e.g. app, job)
      required: true
  response:
    type: json
    path: data
```

### JSON response template

```yaml
- name: summarize_build
  description: Summarize the latest build result
  url: http://localhost:3000/builds/latest
  response:
    type: json
    template: "Build {id}: {status} ({timing.duration_ms} ms)"
```

### Auth via environment variable

```yaml
- name: list_alerts
  description: List active alerts
  url: http://localhost:9093/api/v2/alerts
  auth:
    bearer_env: ALERTMANAGER_TOKEN
  response:
    type: json
```

Explicit `headers.Authorization` still wins if you need a non-Bearer scheme or a fully custom value.

## Config location

Config is loaded from (first found wins):

1. `~/.config/mcp-http-tools/config.yaml`
2. `./config.yaml` (repo root)

If neither exists, the server starts with no tools.

Pass `--config /path/to/config.yaml` or `--config=/path/to/config.yaml` to override the search path and load exactly one file. An explicit override is required: if that file is missing or invalid YAML, the server exits with an error.

## Use with Claude Desktop

Via [supergateway](https://www.npmjs.com/package/supergateway) for SSE transport:

```bash
pnpm dlx supergateway --stdio "node /path/to/mcp-http-tools/index.js --config /path/to/config.yaml" --port 9191
```

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mcp-http-tools": {
      "url": "http://localhost:9191/sse"
    }
  }
}
```

## Use with Claude Code

Add to `.claude/settings.json` or use as a stdio MCP server:

```json
{
  "mcpServers": {
    "mcp-http-tools": {
      "command": "node",
      "args": ["/path/to/mcp-http-tools/index.js", "--config", "/path/to/config.yaml"]
    }
  }
}
```

## Tests

```bash
pnpm test
```

Pushes to `main` and pull requests also run `pnpm test` in GitHub Actions.

## Releasing

`main` is released by GitHub Actions via semantic-release. Conventional commits on `main` determine the next version, create the GitHub release, and publish the package to npm. The same workflow can also be triggered manually from GitHub Actions when a maintainer needs to rerun a release on `main`.

The release workflow uses npm trusted publishing from GitHub Actions, so the job needs `id-token: write` permission and the package must be configured as a trusted publisher in npm for this repository.

## Stack

- Node.js ESM
- [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk) — MCP protocol
- [js-yaml](https://www.npmjs.com/package/js-yaml) — config parsing

## License

MIT
