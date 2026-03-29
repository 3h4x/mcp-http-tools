# mcp-http-tools

Turn any HTTP API into MCP tools via YAML config. No code required.

Define your tools in a YAML file — each one maps to an HTTP request. The MCP server reads the config, exposes the tools, and proxies requests to your APIs.

## Quick start

```bash
npm install
# or
pnpm install
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

## Config reference

Each tool supports:

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | yes | | MCP tool name |
| `description` | no | `""` | Shown to the LLM |
| `url` | yes | | Target HTTP endpoint. Supports `{param}` placeholders |
| `method` | no | `GET` | HTTP method (`GET` or `POST`) |
| `headers` | no | | Static headers. Supports `${ENV_VAR}` substitution |
| `params` | no | `[]` | Tool input parameters (see below) |
| `response.type` | no | `text` | `text` (raw) or `json` (parsed) |
| `response.path` | no | | Dot-path to extract from JSON (e.g. `data.result`) |

### Params

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | yes | | Parameter name |
| `description` | no | | Shown to the LLM |
| `type` | no | `string` | JSON Schema type (`string`, `number`, `boolean`) |
| `required` | no | `false` | Whether the LLM must provide this |
| `default` | no | | Value used when param is omitted |

### How params map to requests

- **GET**: params become URL query parameters
- **POST**: params become keys in a JSON body
- **URL placeholders**: `{param}` in the URL consumes the param value (not sent as query param or body key)

## Examples

### GET with query params

```yaml
- name: search_logs
  description: Search logs via LogQL
  url: http://localhost:3100/loki/api/v1/query_range
  params:
    - name: query
      description: LogQL query
      required: true
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

### Auth via environment variable

```yaml
- name: list_alerts
  description: List active alerts
  url: http://localhost:9093/api/v2/alerts
  headers:
    Authorization: "Bearer ${ALERTMANAGER_TOKEN}"
  response:
    type: json
```

## Config location

Config is loaded from (first found wins):

1. `~/.config/mcp-http-tools/config.yaml`
2. `./config.yaml` (repo root)

If neither exists, the server starts with no tools.

## Use with Claude Desktop

Via [supergateway](https://www.npmjs.com/package/supergateway) for SSE transport:

```bash
npx -y supergateway --stdio "node /path/to/mcp-http-tools/index.js" --port 9191
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
      "args": ["/path/to/mcp-http-tools/index.js"]
    }
  }
}
```

## Tests

```bash
pnpm test
```

## Stack

- Node.js ESM
- [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk) — MCP protocol
- [js-yaml](https://www.npmjs.com/package/js-yaml) — config parsing

## License

MIT
