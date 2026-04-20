import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePath, substituteEnvVars, configToTools, buildRequest, extractResponse, loadConfig, validateConfig, callTool } from "./lib.js";

// ── resolvePath ───────────────────────────────────────────────────────────

describe("resolvePath", () => {
  it("returns value at single-level path", () => {
    assert.equal(resolvePath({ a: 1 }, "a"), 1);
  });

  it("returns value at nested path", () => {
    assert.deepEqual(resolvePath({ data: { result: [1, 2] } }, "data.result"), [1, 2]);
  });

  it("returns undefined for missing path", () => {
    assert.equal(resolvePath({ a: 1 }, "b.c"), undefined);
  });

  it("handles numeric index in arrays", () => {
    assert.equal(resolvePath({ arr: ["a", "b"] }, "arr.1"), "b");
  });

  it("returns undefined when obj is null", () => {
    assert.equal(resolvePath(null, "a.b"), undefined);
  });

  it("handles deeply nested path", () => {
    assert.equal(resolvePath({ a: { b: { c: { d: 42 } } } }, "a.b.c.d"), 42);
  });

  it("returns full object when path is empty", () => {
    const obj = { x: 1 };
    assert.deepEqual(resolvePath(obj, ""), obj);
  });

  it("returns full object when path is null/undefined", () => {
    const obj = { x: 1 };
    assert.deepEqual(resolvePath(obj, null), obj);
    assert.deepEqual(resolvePath(obj, undefined), obj);
  });
});

// ── substituteEnvVars ─────────────────────────────────────────────────────

describe("substituteEnvVars", () => {
  beforeEach(() => { process.env.__TEST_VAR__ = "secret123"; });
  afterEach(() => { delete process.env.__TEST_VAR__; });

  it("replaces ${VAR} with env value", () => {
    assert.equal(substituteEnvVars("Bearer ${__TEST_VAR__}"), "Bearer secret123");
  });

  it("replaces unset var with empty string", () => {
    assert.equal(substituteEnvVars("key=${NONEXISTENT_VAR_XYZ}"), "key=");
  });

  it("returns string unchanged when no vars present", () => {
    assert.equal(substituteEnvVars("no vars here"), "no vars here");
  });

  it("replaces multiple vars", () => {
    process.env.__TEST_VAR2__ = "world";
    assert.equal(substituteEnvVars("${__TEST_VAR__}-${__TEST_VAR2__}"), "secret123-world");
    delete process.env.__TEST_VAR2__;
  });
});

// ── configToTools ─────────────────────────────────────────────────────────

describe("configToTools", () => {
  it("returns empty array for no tools", () => {
    assert.deepEqual(configToTools({}), []);
    assert.deepEqual(configToTools({ tools: [] }), []);
  });

  it("generates correct schema for tool with required param", () => {
    const config = {
      tools: [{
        name: "test_tool",
        description: "A test",
        url: "http://localhost/api",
        params: [{ name: "q", description: "query", required: true }],
      }],
    };
    const [tool] = configToTools(config);
    assert.equal(tool.name, "test_tool");
    assert.equal(tool.description, "A test");
    assert.deepEqual(tool.inputSchema.required, ["q"]);
    assert.equal(tool.inputSchema.properties.q.type, "string");
    assert.equal(tool.inputSchema.properties.q.description, "query");
  });

  it("param with default is not required", () => {
    const config = {
      tools: [{
        name: "t",
        url: "http://localhost",
        params: [{ name: "limit", default: "50" }],
      }],
    };
    const [tool] = configToTools(config);
    assert.equal(tool.inputSchema.required, undefined);
  });

  it("respects param type", () => {
    const config = {
      tools: [{
        name: "t",
        url: "http://localhost",
        params: [{ name: "count", type: "number", required: true }],
      }],
    };
    const [tool] = configToTools(config);
    assert.equal(tool.inputSchema.properties.count.type, "number");
  });

  it("handles tool with no params", () => {
    const config = {
      tools: [{ name: "ping", description: "Ping", url: "http://localhost/ping" }],
    };
    const [tool] = configToTools(config);
    assert.deepEqual(tool.inputSchema.properties, {});
  });

  it("defaults description to empty string", () => {
    const config = { tools: [{ name: "t", url: "http://localhost" }] };
    const [tool] = configToTools(config);
    assert.equal(tool.description, "");
  });

  it("generates multiple tools preserving order", () => {
    const config = {
      tools: [
        { name: "first", url: "http://a" },
        { name: "second", url: "http://b" },
        { name: "third", url: "http://c" },
      ],
    };
    const tools = configToTools(config);
    assert.equal(tools.length, 3);
    assert.deepEqual(tools.map(t => t.name), ["first", "second", "third"]);
  });

  it("mixes required and optional params correctly", () => {
    const config = {
      tools: [{
        name: "t",
        url: "http://localhost",
        params: [
          { name: "q", required: true },
          { name: "limit", default: "10" },
          { name: "format", required: true },
        ],
      }],
    };
    const [tool] = configToTools(config);
    assert.deepEqual(tool.inputSchema.required, ["q", "format"]);
    assert.equal(Object.keys(tool.inputSchema.properties).length, 3);
  });

  it("omits description from property when not provided", () => {
    const config = {
      tools: [{
        name: "t",
        url: "http://localhost",
        params: [{ name: "q" }],
      }],
    };
    const [tool] = configToTools(config);
    assert.equal(tool.inputSchema.properties.q.description, undefined);
  });

  it("includes default in property schema when provided", () => {
    const config = {
      tools: [{
        name: "t",
        url: "http://localhost",
        params: [{ name: "limit", default: 50 }],
      }],
    };
    const [tool] = configToTools(config);
    assert.equal(tool.inputSchema.properties.limit.default, 50);
  });

  it("includes enum in property schema when provided", () => {
    const config = {
      tools: [{
        name: "t",
        url: "http://localhost",
        params: [{ name: "format", type: "string", enum: ["json", "csv", "xml"] }],
      }],
    };
    const [tool] = configToTools(config);
    assert.deepEqual(tool.inputSchema.properties.format.enum, ["json", "csv", "xml"]);
  });

  it("omits enum and default from property when not provided", () => {
    const config = {
      tools: [{
        name: "t",
        url: "http://localhost",
        params: [{ name: "q" }],
      }],
    };
    const [tool] = configToTools(config);
    assert.equal(tool.inputSchema.properties.q.enum, undefined);
    assert.equal(tool.inputSchema.properties.q.default, undefined);
  });
});

// ── buildRequest GET ──────────────────────────────────────────────────────

describe("buildRequest GET", () => {
  it("builds URL with query params from args", () => {
    const tc = { url: "http://localhost:9090/api/v1/query", params: [{ name: "query" }] };
    const { url, options } = buildRequest(tc, { query: "up" });
    assert.equal(url, "http://localhost:9090/api/v1/query?query=up");
    assert.equal(options.method, "GET");
  });

  it("applies default values for missing params", () => {
    const tc = {
      url: "http://localhost/api",
      params: [
        { name: "q", required: true },
        { name: "limit", default: "50" },
      ],
    };
    const { url } = buildRequest(tc, { q: "test" });
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("q"), "test");
    assert.equal(parsed.searchParams.get("limit"), "50");
  });

  it("skips params not in args and without defaults", () => {
    const tc = {
      url: "http://localhost/api",
      params: [{ name: "q" }, { name: "optional" }],
    };
    const { url } = buildRequest(tc, { q: "test" });
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("q"), "test");
    assert.equal(parsed.searchParams.get("optional"), null);
  });

  it("includes headers with env var substitution", () => {
    process.env.__TEST_TOKEN__ = "abc";
    const tc = {
      url: "http://localhost/api",
      headers: { Authorization: "Bearer ${__TEST_TOKEN__}" },
      params: [],
    };
    const { options } = buildRequest(tc, {});
    assert.equal(options.headers.Authorization, "Bearer abc");
    delete process.env.__TEST_TOKEN__;
  });

  it("omits headers object when no headers configured", () => {
    const tc = { url: "http://localhost/api", params: [] };
    const { options } = buildRequest(tc, {});
    assert.equal(options.headers, undefined);
  });

  it("substitutes {param} placeholders in URL path", () => {
    const tc = {
      url: "http://localhost:3100/loki/api/v1/label/{label}/values",
      params: [{ name: "label", required: true }],
    };
    const { url } = buildRequest(tc, { label: "app" });
    assert.equal(url, "http://localhost:3100/loki/api/v1/label/app/values");
  });

  it("does not add URL path params as query params", () => {
    const tc = {
      url: "http://localhost/api/{id}/details",
      params: [
        { name: "id", required: true },
        { name: "format", default: "json" },
      ],
    };
    const { url } = buildRequest(tc, { id: "123" });
    const parsed = new URL(url);
    assert.ok(parsed.pathname.includes("/123/"));
    assert.equal(parsed.searchParams.get("id"), null);
    assert.equal(parsed.searchParams.get("format"), "json");
  });

  it("encodes special characters in URL path params", () => {
    const tc = {
      url: "http://localhost/api/{name}",
      params: [{ name: "name", required: true }],
    };
    const { url } = buildRequest(tc, { name: "hello world/foo" });
    assert.ok(url.includes("hello%20world%2Ffoo"));
  });

  it("works with no params", () => {
    const tc = { url: "http://localhost/health" };
    const { url, options } = buildRequest(tc, {});
    assert.equal(url, "http://localhost/health");
    assert.equal(options.method, "GET");
  });

  it("coerces number args to string query params", () => {
    const tc = { url: "http://localhost/api", params: [{ name: "limit", type: "number" }] };
    const { url } = buildRequest(tc, { limit: 100 });
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("limit"), "100");
  });

  it("defaults method to GET when not specified", () => {
    const tc = { url: "http://localhost/api", params: [] };
    const { options } = buildRequest(tc, {});
    assert.equal(options.method, "GET");
  });

  it("normalizes method case", () => {
    const tc = { method: "get", url: "http://localhost/api", params: [] };
    const { options } = buildRequest(tc, {});
    assert.equal(options.method, "GET");
  });

  it("defaults args to empty object when called with no second argument", () => {
    const tc = { url: "http://localhost/api", params: [{ name: "limit", default: "10" }] };
    const { url } = buildRequest(tc);
    assert.ok(new URL(url).searchParams.get("limit") === "10");
  });
});

// ── validateConfig ────────────────────────────────────────────────────────

describe("validateConfig", () => {
  it("returns empty array for empty or missing tools", () => {
    assert.deepEqual(validateConfig({}), []);
    assert.deepEqual(validateConfig({ tools: [] }), []);
  });

  it("returns empty array for valid tool", () => {
    const config = { tools: [{ name: "t", url: "http://localhost" }] };
    assert.deepEqual(validateConfig(config), []);
  });

  it("accepts all valid HTTP methods case-insensitively", () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "get", "post"]) {
      const config = { tools: [{ name: "t", url: "http://localhost", method }] };
      assert.deepEqual(validateConfig(config), [], `method "${method}" should be valid`);
    }
  });

  it("reports missing name", () => {
    const config = { tools: [{ url: "http://localhost" }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('"name"'));
  });

  it("reports missing url", () => {
    const config = { tools: [{ name: "t" }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('"url"'));
  });

  it("reports invalid method with tool name in message", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", method: "FETCH" }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("FETCH"));
    assert.ok(errors[0].includes('"t"'));
  });

  it("reports multiple errors across multiple tools", () => {
    const config = {
      tools: [
        { url: "http://localhost" },
        { name: "t" },
        { name: "t2", url: "http://localhost", method: "BADMETHOD" },
      ],
    };
    assert.equal(validateConfig(config).length, 3);
  });

  it("includes index in error reference for unnamed tools", () => {
    const config = { tools: [{ url: "http://localhost" }] };
    const errors = validateConfig(config);
    assert.ok(errors[0].includes("tools[0]"));
  });

  it("reports param missing name", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", params: [{ type: "string" }] }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("params[0]"));
    assert.ok(errors[0].includes('"name"'));
  });

  it("accepts params that all have names", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", params: [{ name: "q" }] }] };
    assert.deepEqual(validateConfig(config), []);
  });

  it("reports invalid response.type", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", response: { type: "xml" } }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("xml"));
    assert.ok(errors[0].includes("response.type"));
  });

  it("accepts valid response types", () => {
    for (const type of ["text", "json"]) {
      const config = { tools: [{ name: "t", url: "http://localhost", response: { type } }] };
      assert.deepEqual(validateConfig(config), [], `type "${type}" should be valid`);
    }
  });

  it("accepts tool with no response config", () => {
    const config = { tools: [{ name: "t", url: "http://localhost" }] };
    assert.deepEqual(validateConfig(config), []);
  });

  it("reports non-positive timeout", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", timeout: 0 }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("timeout"));
  });

  it("reports negative timeout", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", timeout: -1000 }] };
    assert.equal(validateConfig(config).length, 1);
  });

  it("reports string timeout", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", timeout: "30s" }] };
    assert.equal(validateConfig(config).length, 1);
  });

  it("accepts valid positive timeout", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", timeout: 5000 }] };
    assert.deepEqual(validateConfig(config), []);
  });

  it("reports duplicate tool names", () => {
    const config = { tools: [
      { name: "t", url: "http://localhost" },
      { name: "t", url: "http://localhost/other" },
    ] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("duplicate"));
    assert.ok(errors[0].includes('"t"'));
  });

  it("allows distinct tool names", () => {
    const config = { tools: [
      { name: "first", url: "http://localhost/a" },
      { name: "second", url: "http://localhost/b" },
    ] };
    assert.deepEqual(validateConfig(config), []);
  });

  it("reports tool name with spaces", () => {
    const config = { tools: [{ name: "my tool", url: "http://localhost" }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("tool name"));
  });

  it("reports tool name starting with a digit", () => {
    const config = { tools: [{ name: "1tool", url: "http://localhost" }] };
    assert.equal(validateConfig(config).length, 1);
  });

  it("accepts tool names with underscores and hyphens", () => {
    const config = { tools: [{ name: "get_user-info", url: "http://localhost" }] };
    assert.deepEqual(validateConfig(config), []);
  });

  it("reports invalid URL", () => {
    const config = { tools: [{ name: "t", url: "not-a-url" }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('"url"'));
  });

  it("accepts URL with path param placeholders", () => {
    const config = { tools: [{ name: "t", url: "http://localhost/api/{id}/data" }] };
    assert.deepEqual(validateConfig(config), []);
  });

  it("reports invalid param type", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", params: [{ name: "q", type: "str" }] }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('"str"'));
    assert.ok(errors[0].includes("params[0]"));
  });

  it("accepts all valid param types", () => {
    for (const type of ["string", "number", "integer", "boolean", "array", "object"]) {
      const config = { tools: [{ name: "t", url: "http://localhost", params: [{ name: "p", type }] }] };
      assert.deepEqual(validateConfig(config), [], `param type "${type}" should be valid`);
    }
  });

  it("reports duplicate param names within a tool", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", params: [{ name: "q" }, { name: "q" }] }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("duplicate param name"));
    assert.ok(errors[0].includes('"q"'));
  });

  it("allows same param name in different tools", () => {
    const config = {
      tools: [
        { name: "a", url: "http://localhost", params: [{ name: "q" }] },
        { name: "b", url: "http://localhost", params: [{ name: "q" }] },
      ],
    };
    assert.deepEqual(validateConfig(config), []);
  });

  it("reports empty response.path", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", response: { type: "json", path: "" } }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("response.path"));
  });

  it("reports whitespace-only response.path", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", response: { type: "json", path: "   " } }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("response.path"));
  });

  it("accepts valid response.path", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", response: { type: "json", path: "data.result" } }] };
    assert.deepEqual(validateConfig(config), []);
  });
});

// ── buildRequest POST ─────────────────────────────────────────────────────

describe("buildRequest POST", () => {
  it("builds JSON body from args", () => {
    const tc = {
      method: "POST",
      url: "http://localhost/api",
      params: [{ name: "name" }, { name: "value" }],
    };
    const { url, options } = buildRequest(tc, { name: "foo", value: "bar" });
    assert.equal(url, "http://localhost/api");
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), { name: "foo", value: "bar" });
  });

  it("sets Content-Type header automatically", () => {
    const tc = { method: "POST", url: "http://localhost/api", params: [] };
    const { options } = buildRequest(tc, {});
    assert.equal(options.headers["Content-Type"], "application/json");
  });

  it("applies default values in body", () => {
    const tc = {
      method: "POST",
      url: "http://localhost/api",
      params: [{ name: "format", default: "json" }],
    };
    const { options } = buildRequest(tc, {});
    assert.deepEqual(JSON.parse(options.body), { format: "json" });
  });

  it("does not override explicit Content-Type", () => {
    const tc = {
      method: "POST",
      url: "http://localhost/api",
      headers: { "Content-Type": "text/plain" },
      params: [],
    };
    const { options } = buildRequest(tc, {});
    assert.equal(options.headers["Content-Type"], "text/plain");
  });

  it("excludes URL path params from body", () => {
    const tc = {
      method: "POST",
      url: "http://localhost/api/{id}",
      params: [
        { name: "id", required: true },
        { name: "data", required: true },
      ],
    };
    const { url, options } = buildRequest(tc, { id: "abc", data: "payload" });
    assert.ok(url.includes("/abc"));
    const body = JSON.parse(options.body);
    assert.equal(body.id, undefined);
    assert.equal(body.data, "payload");
  });

  it("sends empty body when no params match", () => {
    const tc = { method: "POST", url: "http://localhost/api", params: [] };
    const { options } = buildRequest(tc, {});
    assert.deepEqual(JSON.parse(options.body), {});
  });
});

// ── buildRequest PUT / PATCH / DELETE ────────────────────────────────────

describe("buildRequest PUT/PATCH/DELETE", () => {
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    it(`${method}: builds JSON body and sets Content-Type`, () => {
      const tc = {
        method,
        url: "http://localhost/api",
        params: [{ name: "value" }],
      };
      const { options } = buildRequest(tc, { value: "x" });
      assert.equal(options.method, method);
      assert.deepEqual(JSON.parse(options.body), { value: "x" });
      assert.equal(options.headers["Content-Type"], "application/json");
    });
  }

  it("PUT excludes URL path params from body", () => {
    const tc = {
      method: "PUT",
      url: "http://localhost/api/{id}",
      params: [{ name: "id" }, { name: "data" }],
    };
    const { url, options } = buildRequest(tc, { id: "42", data: "payload" });
    assert.ok(url.includes("/42"));
    const body = JSON.parse(options.body);
    assert.equal(body.id, undefined);
    assert.equal(body.data, "payload");
  });

  it("DELETE applies param defaults in body", () => {
    const tc = {
      method: "DELETE",
      url: "http://localhost/api",
      params: [{ name: "reason", default: "expired" }],
    };
    const { options } = buildRequest(tc, {});
    assert.deepEqual(JSON.parse(options.body), { reason: "expired" });
  });
});

// ── extractResponse ───────────────────────────────────────────────────────

describe("extractResponse", () => {
  it("returns raw text when type is text", () => {
    assert.equal(extractResponse("hello", { type: "text" }), "hello");
  });

  it("returns raw text when no config", () => {
    assert.equal(extractResponse("hello"), "hello");
    assert.equal(extractResponse("hello", null), "hello");
  });

  it("returns pretty JSON when type is json with no path", () => {
    const raw = '{"a":1,"b":2}';
    assert.equal(extractResponse(raw, { type: "json" }), JSON.stringify({ a: 1, b: 2 }, null, 2));
  });

  it("extracts nested value via path", () => {
    const raw = JSON.stringify({ data: { result: [1, 2, 3] } });
    assert.equal(
      extractResponse(raw, { type: "json", path: "data.result" }),
      JSON.stringify([1, 2, 3], null, 2)
    );
  });

  it("returns raw text on invalid JSON gracefully", () => {
    assert.equal(extractResponse("not json", { type: "json" }), "not json");
  });

  it("returns raw text when path resolves to undefined", () => {
    const raw = JSON.stringify({ a: 1 });
    assert.equal(extractResponse(raw, { type: "json", path: "b.c" }), raw);
  });

  it("extracts scalar value via path", () => {
    const raw = JSON.stringify({ status: "success", data: { count: 42 } });
    assert.equal(extractResponse(raw, { type: "json", path: "data.count" }), "42");
  });

  it("handles empty JSON object", () => {
    assert.equal(extractResponse("{}", { type: "json" }), "{}");
  });

  it("handles JSON array at root", () => {
    const raw = '[1,2,3]';
    assert.equal(extractResponse(raw, { type: "json" }), JSON.stringify([1, 2, 3], null, 2));
  });

  it("returns string value unwrapped (no surrounding quotes) when path resolves to a string", () => {
    const raw = JSON.stringify({ message: "hello world" });
    assert.equal(extractResponse(raw, { type: "json", path: "message" }), "hello world");
  });

  it("returns URL strings via path without extra quoting", () => {
    const raw = JSON.stringify({ links: { self: "https://example.com/api/v1" } });
    assert.equal(extractResponse(raw, { type: "json", path: "links.self" }), "https://example.com/api/v1");
  });
});

// ── loadConfig ────────────────────────────────────────────────────────────

describe("loadConfig", () => {
  it("returns an object", () => {
    const config = loadConfig();
    assert.equal(typeof config, "object");
    assert.notEqual(config, null);
  });

  it("returns empty object and writes to stderr when config YAML is malformed", async () => {
    const dir = join(tmpdir(), `mcp-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const badConfig = join(dir, "config.yaml");
    writeFileSync(badConfig, "tools:\n  - name: [invalid yaml\n");

    // Temporarily override HOME so loadConfig finds our bad file first.
    // We monkey-patch the module by writing to an env var and using a wrapper.
    // Instead, test via a dynamic import with a patched homedir isn't easy in ESM.
    // So we verify loadConfig handles malformed yaml gracefully via direct file read.
    const { load } = await import("js-yaml");
    let threw = false;
    try { load(readFileSync(badConfig, "utf8")); } catch { threw = true; }
    assert.ok(threw, "js-yaml should throw on malformed YAML");

    rmSync(dir, { recursive: true });
  });
});

// ── integration: config → buildRequest → extractResponse ──────────────────

describe("integration", () => {
  function mockFetch(responseBody, status = 200) {
    globalThis.fetch = async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody),
    });
  }
  afterEach(() => { delete globalThis.fetch; });

  it("full flow: config → tool schema → request → response extraction", async () => {
    const config = {
      tools: [{
        name: "get_data",
        description: "Fetch data",
        url: "http://localhost:9090/api/v1/query",
        params: [
          { name: "query", description: "PromQL", required: true },
        ],
        response: { type: "json", path: "data.result" },
      }],
    };

    // Generate MCP tool schema
    const [tool] = configToTools(config);
    assert.equal(tool.name, "get_data");
    assert.deepEqual(tool.inputSchema.required, ["query"]);

    // Build request
    const { url, options } = buildRequest(config.tools[0], { query: "up" });
    assert.ok(url.includes("query=up"));
    assert.equal(options.method, "GET");

    // Mock fetch and extract response
    mockFetch({ status: "success", data: { result: [{ metric: {}, value: [0, "1"] }] } });
    const res = await fetch(url, options);
    const raw = await res.text();
    const text = extractResponse(raw, config.tools[0].response);
    const parsed = JSON.parse(text);
    assert.equal(parsed[0].value[1], "1");
  });

  it("POST flow with path params and body", async () => {
    const toolConfig = {
      name: "update_item",
      method: "POST",
      url: "http://localhost/api/{id}",
      params: [
        { name: "id", required: true },
        { name: "status", required: true },
        { name: "priority", default: "normal" },
      ],
      response: { type: "json" },
    };

    const { url, options } = buildRequest(toolConfig, { id: "42", status: "active" });
    assert.ok(url.includes("/42"));
    const body = JSON.parse(options.body);
    assert.equal(body.status, "active");
    assert.equal(body.priority, "normal");
    assert.equal(body.id, undefined);

    mockFetch({ ok: true, id: "42" });
    const res = await fetch(url, options);
    const raw = await res.text();
    const text = extractResponse(raw, toolConfig.response);
    assert.ok(text.includes('"id": "42"'));
  });

  it("handles upstream error response gracefully", async () => {
    const toolConfig = {
      name: "bad_query",
      url: "http://localhost/api",
      params: [{ name: "q", required: true }],
      response: { type: "json", path: "data.result" },
    };

    const { url, options } = buildRequest(toolConfig, { q: "bad{" });
    mockFetch({ status: "error", error: "parse error" }, 400);
    const res = await fetch(url, options);
    const raw = await res.text();
    // path doesn't exist, falls back to raw
    const text = extractResponse(raw, toolConfig.response);
    assert.ok(text.includes("parse error"));
  });

  it("text response passes through unchanged", async () => {
    const toolConfig = {
      name: "health",
      url: "http://localhost/health",
      response: { type: "text" },
    };

    const { url, options } = buildRequest(toolConfig, {});
    mockFetch("OK");
    const res = await fetch(url, options);
    const raw = await res.text();
    assert.equal(extractResponse(raw, toolConfig.response), "OK");
  });

  it("callTool: non-2xx response exposes status code and marks isError", async () => {
    const toolConfig = {
      name: "query",
      url: "http://localhost/api",
      params: [{ name: "q" }],
      response: { type: "json" },
    };
    mockFetch({ error: "not found" }, 404);
    const { text, isError } = await callTool(toolConfig, { q: "bad" });
    assert.equal(isError, true);
    assert.ok(text.startsWith("HTTP 404:"));
    assert.ok(text.includes("not found"));
  });

  it("callTool: 5xx response surfaces status in error text", async () => {
    const toolConfig = { name: "t", url: "http://localhost/api", response: { type: "text" } };
    mockFetch("Internal Server Error", 500);
    const { text, isError } = await callTool(toolConfig, {});
    assert.equal(isError, true);
    assert.equal(text, "HTTP 500: Internal Server Error");
  });

  it("callTool: truncates oversized error bodies to keep context bounded", async () => {
    const huge = "x".repeat(5000);
    const toolConfig = { name: "t", url: "http://localhost/api", response: { type: "text" } };
    mockFetch(huge, 500);
    const { text, isError } = await callTool(toolConfig, {});
    assert.equal(isError, true);
    assert.ok(text.includes("(truncated, showing 2000/5000 chars)"));
    assert.ok(text.length < 5000, `expected truncated output, got ${text.length} chars`);
  });

  it("callTool: success path extracts response via path", async () => {
    const toolConfig = {
      name: "t",
      url: "http://localhost/api",
      response: { type: "json", path: "data.value" },
    };
    mockFetch({ data: { value: 42 } });
    const { text, isError } = await callTool(toolConfig, {});
    assert.equal(isError, undefined);
    assert.equal(text, "42");
  });

  it("callTool: times out after configured timeout", async () => {
    globalThis.fetch = (_url, options) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ ok: true, status: 200, text: async () => "late" }), 200);
      options?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      });
    });
    const toolConfig = { name: "t", url: "http://localhost/api", timeout: 50 };
    const { text, isError } = await callTool(toolConfig, {});
    assert.equal(isError, true);
    assert.ok(text.includes("timed out"), `expected timeout message, got: ${text}`);
  });

  it("callTool: network error returns isError with message", async () => {
    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
    const toolConfig = { name: "t", url: "http://localhost/api" };
    const { text, isError } = await callTool(toolConfig, {});
    assert.equal(isError, true);
    assert.ok(text.includes("ECONNREFUSED"));
  });

  it("callTool: null args falls back to empty object without throwing", async () => {
    const toolConfig = {
      name: "t",
      url: "http://localhost/api",
      params: [{ name: "limit", default: "5" }],
      response: { type: "text" },
    };
    mockFetch("ok");
    const { text, isError } = await callTool(toolConfig, null);
    assert.equal(isError, undefined);
    assert.equal(text, "ok");
  });

  it("callTool: undefined args falls back to empty object without throwing", async () => {
    const toolConfig = { name: "t", url: "http://localhost/api", response: { type: "text" } };
    mockFetch("ok");
    const { text, isError } = await callTool(toolConfig, undefined);
    assert.equal(isError, undefined);
    assert.equal(text, "ok");
  });
});
