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

  it("writes warning to stderr for unset env vars", () => {
    const original = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = (msg) => { captured += msg; return true; };
    try {
      substituteEnvVars("${DEFINITELY_NOT_SET_VAR_XYZ_123}");
    } finally {
      process.stderr.write = original;
    }
    assert.ok(captured.includes("DEFINITELY_NOT_SET_VAR_XYZ_123"), "expected warning in stderr");
    assert.ok(captured.includes("not set"), "expected 'not set' in warning");
  });

  it("does not warn for env vars that are set", () => {
    const original = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = (msg) => { captured += msg; return true; };
    try {
      substituteEnvVars("${__TEST_VAR__}");
    } finally {
      process.stderr.write = original;
    }
    assert.equal(captured, "");
  });

  it("returns empty string unchanged when input is empty", () => {
    assert.equal(substituteEnvVars(""), "");
  });

  it("does not warn when env var is set to empty string", () => {
    process.env.__EMPTY_VAR__ = "";
    const original = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = (msg) => { captured += msg; return true; };
    let result;
    try {
      result = substituteEnvVars("${__EMPTY_VAR__}");
    } finally {
      process.stderr.write = original;
      delete process.env.__EMPTY_VAR__;
    }
    assert.equal(result, "");
    assert.equal(captured, "", "no warning expected for set-but-empty var");
  });

  it("coerces non-string input to string before substitution", () => {
    assert.equal(substituteEnvVars(123), "123");
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

  it("keeps required raw path params required in the generated schema", () => {
    const config = {
      tools: [{
        name: "t",
        url: "http://localhost/api/{+path}",
        params: [{ name: "path", required: true }],
      }],
    };
    const [tool] = configToTools(config);
    assert.deepEqual(tool.inputSchema.required, ["path"]);
  });

  it("allows optional raw path params in the generated schema when a safe default exists", () => {
    const config = {
      tools: [{
        name: "t",
        url: "http://localhost/api/{+path}",
        params: [{ name: "path", default: "jobs/default" }],
      }],
    };
    const [tool] = configToTools(config);
    assert.equal(tool.inputSchema.required, undefined);
    assert.equal(tool.inputSchema.properties.path.default, "jobs/default");
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

  it("schema includes additionalProperties: false", () => {
    const config = { tools: [{ name: "t", url: "http://localhost" }] };
    const [tool] = configToTools(config);
    assert.equal(tool.inputSchema.additionalProperties, false);
  });

  it("returns empty array when tools is non-array (type mismatch)", () => {
    assert.deepEqual(configToTools({ tools: "oops" }), []);
    assert.deepEqual(configToTools({ tools: 42 }), []);
  });

  it("treats params: null same as no params", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", params: null }] };
    const [tool] = configToTools(config);
    assert.deepEqual(tool.inputSchema.properties, {});
    assert.equal(tool.inputSchema.required, undefined);
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

  it("applies defaults for standard URL path placeholders", () => {
    const tc = {
      url: "http://localhost/items/{id}",
      params: [{ name: "id", default: "42" }],
    };
    const { url } = buildRequest(tc, {});
    assert.equal(url, "http://localhost/items/42");
  });

  it("preserves slash separators for {+param} path placeholders", () => {
    const tc = {
      url: "http://localhost/api/{+path}",
      params: [{ name: "path", required: true }],
    };
    const { url } = buildRequest(tc, { path: "jobs/notifications with space" });
    assert.equal(url, "http://localhost/api/jobs/notifications%20with%20space");
  });

  it("applies safe defaults for raw path placeholders", () => {
    const tc = {
      url: "http://localhost/api/{+path}",
      params: [{ name: "path", default: "jobs/default" }],
    };
    const { url } = buildRequest(tc, {});
    assert.equal(url, "http://localhost/api/jobs/default");
  });

  it("coerces non-string raw path args before encoding", () => {
    const tc = {
      url: "http://localhost/api/{+path}",
      params: [{ name: "path", required: true, type: "number" }],
    };
    const { url } = buildRequest(tc, { path: 42 });
    assert.equal(url, "http://localhost/api/42");
  });

  it("coerces non-string raw path defaults before encoding", () => {
    const tc = {
      url: "http://localhost/api/{+path}",
      params: [{ name: "path", default: 42, type: "number" }],
    };
    const { url } = buildRequest(tc, {});
    assert.equal(url, "http://localhost/api/42");
  });

  it("throws descriptive error when required raw path param is not provided", () => {
    const tc = {
      url: "http://localhost/api/{+path}",
      params: [{ name: "path", required: true }],
    };
    assert.throws(
      () => buildRequest(tc, {}),
      /Required raw path parameter "path" was not provided/
    );
  });

  it("rejects raw path placeholders with leading dot-dot segments", () => {
    const tc = {
      url: "http://localhost/api/{+path}",
      params: [{ name: "path", required: true }],
    };
    assert.throws(
      () => buildRequest(tc, { path: "../admin" }),
      /Invalid raw path param "path"/
    );
  });

  it("rejects raw path placeholders with nested dot-dot segments", () => {
    const tc = {
      url: "http://localhost/api/{+path}",
      params: [{ name: "path", required: true }],
    };
    assert.throws(
      () => buildRequest(tc, { path: "a/../../admin" }),
      /Invalid raw path param "path"/
    );
  });

  it("rejects raw path placeholders with empty segments", () => {
    const tc = {
      url: "http://localhost/api/{+path}",
      params: [{ name: "path", required: true }],
    };
    assert.throws(
      () => buildRequest(tc, { path: "a//admin" }),
      /Invalid raw path param "path"/
    );
  });

  it("rejects raw path placeholders with single dot segments", () => {
    const tc = {
      url: "http://localhost/api/{+path}",
      params: [{ name: "path", required: true }],
    };
    assert.throws(
      () => buildRequest(tc, { path: "a/./admin" }),
      /Invalid raw path param "path"/
    );
  });

  it("rejects optional raw path param with safe default when user provides invalid override", () => {
    const tc = {
      url: "http://localhost/api/{+path}",
      params: [{ name: "path", default: "jobs/default" }],
    };
    assert.throws(
      () => buildRequest(tc, { path: "../admin" }),
      /Invalid raw path param "path"/
    );
  });

  it("allows optional raw path param with safe default when user provides valid override", () => {
    const tc = {
      url: "http://localhost/api/{+path}",
      params: [{ name: "path", default: "jobs/default" }],
    };
    const { url } = buildRequest(tc, { path: "jobs/custom" });
    assert.equal(url, "http://localhost/api/jobs/custom");
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

  it("treats null args same as empty object", () => {
    const tc = { url: "http://localhost/api", params: [{ name: "limit", default: "10" }] };
    const { url } = buildRequest(tc, null);
    assert.equal(new URL(url).searchParams.get("limit"), "10");
  });

  it("serializes array param as JSON string in query", () => {
    const tc = { url: "http://localhost/api", params: [{ name: "tags", type: "array" }] };
    const { url } = buildRequest(tc, { tags: ["a", "b", "c"] });
    assert.equal(new URL(url).searchParams.get("tags"), '["a","b","c"]');
  });

  it("serializes object param as JSON string in query", () => {
    const tc = { url: "http://localhost/api", params: [{ name: "filter", type: "object" }] };
    const { url } = buildRequest(tc, { filter: { key: "value" } });
    assert.equal(new URL(url).searchParams.get("filter"), '{"key":"value"}');
  });

  it("strips CRLF from header values to prevent injection", () => {
    const tc = {
      url: "http://localhost/api",
      headers: { Authorization: "Bearer token\r\nX-Injected: evil" },
      params: [],
    };
    const { options } = buildRequest(tc, {});
    assert.ok(!options.headers.Authorization.includes("\r"), "CR must be stripped");
    assert.ok(!options.headers.Authorization.includes("\n"), "LF must be stripped");
    assert.equal(options.headers.Authorization, "Bearer tokenX-Injected: evil");
  });

  it("strips CRLF from header values after env var substitution", () => {
    process.env.__CRLF_TOKEN__ = "abc\r\ndef";
    const tc = {
      url: "http://localhost/api",
      headers: { Authorization: "Bearer ${__CRLF_TOKEN__}" },
      params: [],
    };
    const { options } = buildRequest(tc, {});
    assert.ok(!options.headers.Authorization.includes("\r"));
    assert.ok(!options.headers.Authorization.includes("\n"));
    delete process.env.__CRLF_TOKEN__;
  });

  it("skips param with undefined value instead of sending 'undefined' string", () => {
    const tc = { url: "http://localhost/api", params: [{ name: "q" }, { name: "limit", default: "5" }] };
    const { url } = buildRequest(tc, { q: undefined });
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("q"), null, "undefined arg must not appear in query");
    assert.equal(parsed.searchParams.get("limit"), "5", "default should still apply");
  });

  it("sends false boolean as string 'false' in query", () => {
    const tc = { url: "http://localhost/api", params: [{ name: "active", type: "boolean" }] };
    const { url } = buildRequest(tc, { active: false });
    assert.equal(new URL(url).searchParams.get("active"), "false");
  });

  it("sends zero as string '0' in query", () => {
    const tc = { url: "http://localhost/api", params: [{ name: "offset", type: "integer" }] };
    const { url } = buildRequest(tc, { offset: 0 });
    assert.equal(new URL(url).searchParams.get("offset"), "0");
  });

  it("sends false boolean default as string 'false' in query", () => {
    const tc = { url: "http://localhost/api", params: [{ name: "verbose", type: "boolean", default: false }] };
    const { url } = buildRequest(tc, {});
    assert.equal(new URL(url).searchParams.get("verbose"), "false");
  });

  it("serializes array default as JSON string in query", () => {
    const tc = { url: "http://localhost/api", params: [{ name: "tags", type: "array", default: ["a", "b"] }] };
    const { url } = buildRequest(tc, {});
    assert.equal(new URL(url).searchParams.get("tags"), '["a","b"]');
  });

  it("sends null arg value as string 'null' in query", () => {
    const tc = { url: "http://localhost/api", params: [{ name: "filter" }] };
    const { url } = buildRequest(tc, { filter: null });
    assert.equal(new URL(url).searchParams.get("filter"), "null");
  });

  it("ignores extra keys in args that have no matching param", () => {
    const tc = { url: "http://localhost/api", params: [{ name: "q" }] };
    const { url } = buildRequest(tc, { q: "hello", unknown: "ignored" });
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("q"), "hello");
    assert.equal(parsed.searchParams.get("unknown"), null);
  });

  it("substitutes ${ENV_VAR} in URL before building request", () => {
    process.env.__TEST_BASE__ = "http://api.example.com";
    const tc = { url: "${__TEST_BASE__}/v1/query", params: [{ name: "q" }] };
    const { url } = buildRequest(tc, { q: "test" });
    assert.ok(url.startsWith("http://api.example.com/v1/query"), `got: ${url}`);
    delete process.env.__TEST_BASE__;
  });

  it("substitutes ${ENV_VAR} in URL combined with {param} path substitution", () => {
    process.env.__TEST_BASE__ = "http://api.example.com";
    const tc = {
      url: "${__TEST_BASE__}/v1/{resource}",
      params: [{ name: "resource", required: true }],
    };
    const { url } = buildRequest(tc, { resource: "users" });
    assert.equal(url, "http://api.example.com/v1/users");
    delete process.env.__TEST_BASE__;
  });

  it("appends params to URL that already has a query string", () => {
    const tc = {
      url: "http://localhost/api?version=2&format=json",
      params: [{ name: "q" }],
    };
    const { url } = buildRequest(tc, { q: "hello" });
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("version"), "2");
    assert.equal(parsed.searchParams.get("format"), "json");
    assert.equal(parsed.searchParams.get("q"), "hello");
  });

  it("sends empty string arg as empty query param", () => {
    const tc = { url: "http://localhost/api", params: [{ name: "q" }] };
    const { url } = buildRequest(tc, { q: "" });
    assert.equal(new URL(url).searchParams.get("q"), "");
  });

  it("substitutes empty string for missing path param arg", () => {
    const tc = {
      url: "http://localhost/api/{id}/details",
      params: [{ name: "id", required: true }],
    };
    const { url } = buildRequest(tc, {});
    assert.ok(url.includes("//details"), `expected empty segment, got: ${url}`);
  });

  it("treats params: null same as no params", () => {
    const tc = { url: "http://localhost/api", params: null };
    const { url, options } = buildRequest(tc, {});
    assert.equal(url, "http://localhost/api");
    assert.equal(options.method, "GET");
  });

  it("throws descriptive error when url is missing", () => {
    assert.throws(
      () => buildRequest({ name: "t" }, {}),
      /missing.*url/i
    );
  });

  it("throws descriptive error when env var in URL resolves to invalid URL", () => {
    assert.throws(
      () => buildRequest({ url: "${__UNSET_MCP_BASE_XYZ__}/api" }, {}),
      /Invalid URL/i
    );
  });

  it("coerces numeric header value to string", () => {
    const tc = {
      url: "http://localhost/api",
      headers: { "X-Version": 2 },
      params: [],
    };
    const { options } = buildRequest(tc, {});
    assert.equal(options.headers["X-Version"], "2");
    assert.equal(typeof options.headers["X-Version"], "string");
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

  it("reports non-string method without throwing", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", method: 123 }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("method"));
    assert.ok(errors[0].includes("123"));
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

  it("reports empty-string response.type", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", response: { type: "" } }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('response.type'));
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

  it("reports non-string url without throwing", () => {
    const config = { tools: [{ name: "t", url: 42 }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('"url"'));
    assert.ok(errors[0].includes("string"));
  });

  it("accepts URL with path param placeholders", () => {
    const config = { tools: [{ name: "t", url: "http://localhost/api/{id}/data", params: [{ name: "id" }] }] };
    assert.deepEqual(validateConfig(config), []);
  });

  it("accepts raw path URL placeholders", () => {
    const config = { tools: [{ name: "t", url: "http://localhost/api/{+path}", params: [{ name: "path", required: true }] }] };
    assert.deepEqual(validateConfig(config), []);
  });

  it("rejects optional raw path URL placeholders without a default", () => {
    const config = { tools: [{ name: "t", url: "http://localhost/api/{+path}", params: [{ name: "path" }] }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /raw path placeholder "\{\+path\}" requires params\["path"\] to be required or have a non-empty default/i);
  });

  it("accepts optional raw path URL placeholders with a safe non-empty default", () => {
    const config = {
      tools: [{
        name: "t",
        url: "http://localhost/api/{+path}",
        params: [{ name: "path", default: "jobs/default" }],
      }],
    };
    assert.deepEqual(validateConfig(config), []);
  });

  it("accepts optional raw path URL placeholders with a safe non-string default", () => {
    const config = {
      tools: [{
        name: "t",
        url: "http://localhost/api/{+path}",
        params: [{ name: "path", default: 42, type: "number" }],
      }],
    };
    assert.deepEqual(validateConfig(config), []);
  });

  it("rejects optional raw path URL placeholders with an empty default", () => {
    const config = {
      tools: [{
        name: "t",
        url: "http://localhost/api/{+path}",
        params: [{ name: "path", default: "" }],
      }],
    };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /raw path placeholder "\{\+path\}" requires params\["path"\] to be required or have a non-empty default/i);
  });

  it("rejects optional raw path URL placeholders with dot-dot default segments", () => {
    const config = {
      tools: [{
        name: "t",
        url: "http://localhost/api/{+path}",
        params: [{ name: "path", default: "../admin" }],
      }],
    };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /raw path placeholder "\{\+path\}" requires params\["path"\] to be required or have a non-empty default/i);
  });

  it("rejects optional raw path URL placeholders with single-dot default segments", () => {
    const config = {
      tools: [{
        name: "t",
        url: "http://localhost/api/{+path}",
        params: [{ name: "path", default: "./admin" }],
      }],
    };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /raw path placeholder "\{\+path\}" requires params\["path"\] to be required or have a non-empty default/i);
  });

  it("reports URL placeholder without matching param definition", () => {
    const config = { tools: [{ name: "t", url: "http://localhost/api/{id}", params: [{ name: "query" }] }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("{id}"), `expected error about {id}, got: ${errors[0]}`);
  });

  it("reports raw URL placeholder without matching param definition", () => {
    const config = { tools: [{ name: "t", url: "http://localhost/api/{+path}", params: [{ name: "query" }] }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("{+path}"), `expected error about {+path}, got: ${errors[0]}`);
  });

  it("reports URL placeholder when no params defined at all", () => {
    const config = { tools: [{ name: "t", url: "http://localhost/api/{org}/{repo}" }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 2);
    assert.ok(errors.some(e => e.includes("{org}")));
    assert.ok(errors.some(e => e.includes("{repo}")));
  });

  it("reports response.path without response.type json", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", response: { path: "data.result" } }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("response.path"), `expected error about response.path, got: ${errors[0]}`);
    assert.ok(errors[0].includes('"json"'), `expected mention of "json", got: ${errors[0]}`);
  });

  it("reports response.path when response.type is text", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", response: { type: "text", path: "data.result" } }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("response.path"));
  });

  it("reports invalid param type", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", params: [{ name: "q", type: "str" }] }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('"str"'));
    assert.ok(errors[0].includes("params[0]"));
  });

  it("reports empty-string param type", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", params: [{ name: "q", type: "" }] }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('params[0]'));
    assert.ok(errors[0].includes('invalid type'));
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

  it("accepts valid headers object", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", headers: { Authorization: "Bearer token", "X-Custom": "value" } }] };
    assert.deepEqual(validateConfig(config), []);
  });

  it("reports error when headers is an array", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", headers: ["bad"] }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('"headers"'));
  });

  it("reports error when a header value is not a string", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", headers: { Authorization: { token: "secret" } } }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("headers["));
    assert.ok(errors[0].includes("Authorization"));
  });

  it("accepts numeric header values", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", headers: { "X-Version": 2 } }] };
    assert.deepEqual(validateConfig(config), []);
  });

  it("reports error when tools is a string instead of array", () => {
    const errors = validateConfig({ tools: "oops" });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('"tools"'));
    assert.ok(errors[0].includes("array"));
  });

  it("reports error when tools is a number instead of array", () => {
    const errors = validateConfig({ tools: 42 });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('"tools"'));
  });

  it("reports error for null tool entry without throwing", () => {
    const errors = validateConfig({ tools: [null] });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("tools[0]"));
    assert.ok(errors[0].includes("object"));
  });

  it("reports error for string tool entry without throwing", () => {
    const errors = validateConfig({ tools: ["my-tool"] });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("tools[0]"));
  });

  it("reports error for null param entry without throwing", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", params: [null] }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("params[0]"));
    assert.ok(errors[0].includes("object"));
  });

  it("reports error for array tool entry without throwing", () => {
    const errors = validateConfig({ tools: [["a", "b"]] });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("tools[0]"));
    assert.ok(errors[0].includes("object"));
  });

  it("reports error for array param entry without throwing", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", params: [["p1", "p2"]] }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("params[0]"));
    assert.ok(errors[0].includes("object"));
  });

  it("reports NaN timeout", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", timeout: NaN }] };
    assert.equal(validateConfig(config).length, 1);
  });

  it("reports Infinity timeout", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", timeout: Infinity }] };
    assert.equal(validateConfig(config).length, 1);
  });

  it("accepts URL with ${ENV_VAR} placeholder without reporting invalid URL", () => {
    const config = { tools: [{ name: "t", url: "${API_BASE}/api/v1" }] };
    assert.deepEqual(validateConfig(config), []);
  });

  it("accepts URL combining ${ENV_VAR} and {param} placeholders", () => {
    const config = { tools: [{ name: "t", url: "${API_BASE}/api/{id}", params: [{ name: "id" }] }] };
    assert.deepEqual(validateConfig(config), []);
  });

  it("reports error when params is an object instead of array", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", params: { name: "q" } }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('"params"'));
    assert.ok(errors[0].includes("array"));
  });

  it("reports error when params is a string instead of array", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", params: "q" }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('"params"'));
  });

  it("reports error when param has both required:true and a default", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", params: [{ name: "q", required: true, default: "foo" }] }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('"q"'));
    assert.ok(errors[0].includes("required") && errors[0].includes("default"));
  });

  it("reports error when unnamed param has both required:true and a default", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", params: [{ required: true, default: "foo" }] }] };
    const errors = validateConfig(config);
    const err = errors.find(e => e.includes("required") && e.includes("default"));
    assert.ok(err, "expected a required+default error");
    assert.ok(err.includes("params[0]") && !err.includes('params[0] ("'), "param name should not appear in error when unnamed");
  });

  it("reports error when unnamed param has an invalid type", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", params: [{ type: "str" }] }] };
    const errors = validateConfig(config);
    const err = errors.find(e => e.includes("invalid type"));
    assert.ok(err, "expected an invalid type error");
    assert.ok(err.includes("params[0]") && !err.includes('params[0] ("'), "param name should not appear in error when unnamed");
  });

  it("does not report error when param has required:false and a default", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", params: [{ name: "q", required: false, default: "foo" }] }] };
    assert.deepEqual(validateConfig(config), []);
  });

  it("does not report error when param has required:true and no default", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", params: [{ name: "q", required: true }] }] };
    assert.deepEqual(validateConfig(config), []);
  });

  it("accepts valid URL with existing query string", () => {
    const config = { tools: [{ name: "t", url: "http://localhost/api?version=2&format=json" }] };
    assert.deepEqual(validateConfig(config), []);
  });

  it("reports error when header value is null", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", headers: { Authorization: null } }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("Authorization"));
  });

  it("reports error when header value is a boolean", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", headers: { "X-Debug": true } }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("X-Debug"));
  });

  it("reports error for number tool entry without throwing", () => {
    const errors = validateConfig({ tools: [42] });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("tools[0]"));
    assert.ok(errors[0].includes("object"));
  });

  it("reports error for boolean tool entry without throwing", () => {
    const errors = validateConfig({ tools: [true] });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("tools[0]"));
    assert.ok(errors[0].includes("object"));
  });

  it("reports error when response.path is null (bare YAML key)", () => {
    // YAML `path:` with no value produces null — should be caught
    const config = { tools: [{ name: "t", url: "http://localhost", response: { type: "json", path: null } }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("response.path"));
  });

  it("reports error when response.path is a number", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", response: { type: "json", path: 42 } }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("response.path"));
  });

  it("reports error when tool name starts with a digit", () => {
    const config = { tools: [{ name: "1tool", url: "http://localhost" }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("tool name"));
  });

  it("reports error when tool name contains invalid characters", () => {
    const config = { tools: [{ name: "my tool!", url: "http://localhost" }] };
    const errors = validateConfig(config);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("tool name"));
  });

  it("accepts tool names with hyphens and underscores", () => {
    const config = { tools: [{ name: "my-tool_v2", url: "http://localhost" }] };
    assert.deepEqual(validateConfig(config), []);
  });

  it("reports error when response.path is set but response.type is not json", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", response: { type: "text", path: "data.value" } }] };
    const errors = validateConfig(config);
    assert.ok(errors.length >= 1);
    assert.ok(errors.some(e => e.includes("response.path") && e.includes("json")));
  });

  it("reports error when response.path is set with no response.type (defaults to text)", () => {
    const config = { tools: [{ name: "t", url: "http://localhost", response: { path: "data.value" } }] };
    const errors = validateConfig(config);
    assert.ok(errors.length >= 1);
    assert.ok(errors.some(e => e.includes("response.path") && e.includes("json")));
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

  it("rejects invalid raw path placeholders before building POST requests", () => {
    const tc = {
      method: "POST",
      url: "http://localhost/api/{+path}",
      params: [
        { name: "path", required: true },
        { name: "status", required: true },
      ],
    };
    assert.throws(
      () => buildRequest(tc, { path: "../admin", status: "active" }),
      /Invalid raw path param "path"/
    );
  });

  it("sends empty body when no params match", () => {
    const tc = { method: "POST", url: "http://localhost/api", params: [] };
    const { options } = buildRequest(tc, {});
    assert.deepEqual(JSON.parse(options.body), {});
  });

  it("skips param with undefined value — not sent as null in body", () => {
    const tc = {
      method: "POST",
      url: "http://localhost/api",
      params: [{ name: "q" }, { name: "format", default: "json" }],
    };
    const { options } = buildRequest(tc, { q: undefined });
    const body = JSON.parse(options.body);
    assert.equal("q" in body, false, "undefined arg must be omitted from body");
    assert.equal(body.format, "json", "default should still apply");
  });

  it("preserves false boolean in body", () => {
    const tc = { method: "POST", url: "http://localhost/api", params: [{ name: "active", type: "boolean" }] };
    const { options } = buildRequest(tc, { active: false });
    assert.strictEqual(JSON.parse(options.body).active, false);
  });

  it("preserves zero in body", () => {
    const tc = { method: "POST", url: "http://localhost/api", params: [{ name: "offset", type: "integer" }] };
    const { options } = buildRequest(tc, { offset: 0 });
    assert.strictEqual(JSON.parse(options.body).offset, 0);
  });

  it("preserves false boolean default in body", () => {
    const tc = { method: "POST", url: "http://localhost/api", params: [{ name: "verbose", type: "boolean", default: false }] };
    const { options } = buildRequest(tc, {});
    assert.strictEqual(JSON.parse(options.body).verbose, false);
  });

  it("preserves array value in body without double-serializing", () => {
    const tc = { method: "POST", url: "http://localhost/api", params: [{ name: "tags", type: "array" }] };
    const { options } = buildRequest(tc, { tags: ["a", "b", "c"] });
    assert.deepEqual(JSON.parse(options.body).tags, ["a", "b", "c"]);
  });

  it("preserves object value in body without double-serializing", () => {
    const tc = { method: "POST", url: "http://localhost/api", params: [{ name: "filter", type: "object" }] };
    const { options } = buildRequest(tc, { filter: { key: "value" } });
    assert.deepEqual(JSON.parse(options.body).filter, { key: "value" });
  });

  it("preserves null in body", () => {
    const tc = { method: "POST", url: "http://localhost/api", params: [{ name: "filter" }] };
    const { options } = buildRequest(tc, { filter: null });
    assert.strictEqual(JSON.parse(options.body).filter, null);
  });

  it("applies array default to body without double-serializing", () => {
    const tc = { method: "POST", url: "http://localhost/api", params: [{ name: "tags", type: "array", default: ["x", "y"] }] };
    const { options } = buildRequest(tc, {});
    assert.deepEqual(JSON.parse(options.body).tags, ["x", "y"]);
  });

  it("applies object default to body without double-serializing", () => {
    const tc = { method: "POST", url: "http://localhost/api", params: [{ name: "filter", type: "object", default: { key: "val" } }] };
    const { options } = buildRequest(tc, {});
    assert.deepEqual(JSON.parse(options.body).filter, { key: "val" });
  });

  it("treats params: null same as no params", () => {
    const tc = { method: "POST", url: "http://localhost/api", params: null };
    const { options } = buildRequest(tc, {});
    assert.deepEqual(JSON.parse(options.body), {});
    assert.equal(options.headers["Content-Type"], "application/json");
  });

  it("does not duplicate Content-Type when config uses lowercase content-type header", () => {
    const tc = {
      method: "POST",
      url: "http://localhost/api",
      headers: { "content-type": "text/plain" },
      params: [],
    };
    const { options } = buildRequest(tc, {});
    const ctKeys = Object.keys(options.headers).filter(k => k.toLowerCase() === "content-type");
    assert.equal(ctKeys.length, 1, "only one content-type header key expected");
    assert.equal(options.headers["content-type"], "text/plain");
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

  it("returns 'null' string when path resolves to null", () => {
    const raw = JSON.stringify({ data: null });
    assert.equal(extractResponse(raw, { type: "json", path: "data" }), "null");
  });

  it("returns 'false' string when path resolves to boolean false", () => {
    const raw = JSON.stringify({ enabled: false });
    assert.equal(extractResponse(raw, { type: "json", path: "enabled" }), "false");
  });

  it("returns '0' string when path resolves to zero", () => {
    const raw = JSON.stringify({ count: 0 });
    assert.equal(extractResponse(raw, { type: "json", path: "count" }), "0");
  });

  it("returns empty string unchanged when type is text", () => {
    assert.equal(extractResponse("", { type: "text" }), "");
  });

  it("returns empty string unchanged when json parse fails on empty input", () => {
    assert.equal(extractResponse("", { type: "json" }), "");
  });

  it("returns empty string when json parse fails on empty input with path", () => {
    assert.equal(extractResponse("", { type: "json", path: "data.result" }), "");
  });

  it("returns array extracted via path as pretty JSON", () => {
    const raw = JSON.stringify({ items: [{ id: 1 }, { id: 2 }] });
    const result = extractResponse(raw, { type: "json", path: "items" });
    assert.deepEqual(JSON.parse(result), [{ id: 1 }, { id: 2 }]);
  });
});

// ── loadConfig ────────────────────────────────────────────────────────────

describe("loadConfig", () => {
  it("returns empty object when no paths exist", () => {
    assert.deepEqual(loadConfig(["/nonexistent/path/config.yaml"]), {});
  });

  it("returns empty array when paths list is empty", () => {
    assert.deepEqual(loadConfig([]), {});
  });

  it("loads valid config from an explicit path", () => {
    const dir = join(tmpdir(), `mcp-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "config.yaml");
    writeFileSync(p, "tools:\n  - name: t\n    url: http://localhost\n");
    try {
      const result = loadConfig([p]);
      assert.equal(result.tools.length, 1);
      assert.equal(result.tools[0].name, "t");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("returns empty object and writes to stderr when config YAML is malformed", () => {
    const dir = join(tmpdir(), `mcp-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "config.yaml");
    writeFileSync(p, "tools:\n  - name: [invalid yaml\n");
    const original = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = (msg) => { captured += msg; return true; };
    let result;
    try {
      result = loadConfig([p]);
    } finally {
      process.stderr.write = original;
      rmSync(dir, { recursive: true });
    }
    assert.deepEqual(result, {});
    assert.ok(captured.includes("failed to parse"), `expected parse error in stderr, got: ${captured}`);
  });

  it("skips non-existent paths and loads the first existing one", () => {
    const dir = join(tmpdir(), `mcp-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "config.yaml");
    writeFileSync(p, "tools: []\n");
    try {
      const result = loadConfig(["/does/not/exist.yaml", p]);
      assert.deepEqual(result, { tools: [] });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("uses default paths when called with no argument", () => {
    const config = loadConfig();
    assert.equal(typeof config, "object");
    assert.notEqual(config, null);
  });

  it("returns empty object for an empty YAML file", () => {
    const dir = join(tmpdir(), `mcp-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "config.yaml");
    writeFileSync(p, "");
    try {
      const result = loadConfig([p]);
      assert.deepEqual(result, {});
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("stops at first existing path even when malformed — does not fall through to next", () => {
    const dir1 = join(tmpdir(), `mcp-test-bad-${Date.now()}`);
    const dir2 = join(tmpdir(), `mcp-test-good-${Date.now()}`);
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    try {
      const badPath = join(dir1, "config.yaml");
      const goodPath = join(dir2, "config.yaml");
      writeFileSync(badPath, "tools:\n  - name: [invalid yaml\n");
      writeFileSync(goodPath, "tools:\n  - name: fallback\n    url: http://localhost\n");
      const original = process.stderr.write.bind(process.stderr);
      process.stderr.write = () => true;
      let result;
      try {
        result = loadConfig([badPath, goodPath]);
      } finally {
        process.stderr.write = original;
      }
      assert.deepEqual(result, {}, "malformed first path should return {} without falling through");
    } finally {
      rmSync(dir1, { recursive: true });
      rmSync(dir2, { recursive: true });
    }
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

  it("callTool: invalid raw GET path returns isError before fetch", async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, status: 200, text: async () => "ok" };
    };
    const toolConfig = {
      name: "t",
      url: "http://localhost/api/{+path}",
      params: [{ name: "path", required: true }],
    };
    const { text, isError } = await callTool(toolConfig, { path: "../admin" });
    assert.equal(isError, true);
    assert.ok(text.includes('Invalid raw path param "path"'));
    assert.equal(fetchCalled, false, "fetch must not run for invalid raw paths");
  });

  it("callTool: omitted raw GET path uses safe default", async () => {
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return { ok: true, status: 200, text: async () => "ok" };
    };
    const toolConfig = {
      name: "t",
      url: "http://localhost/api/{+path}",
      params: [{ name: "path", default: "jobs/default" }],
    };
    const { text, isError } = await callTool(toolConfig, {});
    assert.equal(isError, undefined);
    assert.equal(text, "ok");
    assert.equal(capturedUrl, "http://localhost/api/jobs/default");
  });

  it("callTool: coerces non-string raw GET path args before fetch", async () => {
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return { ok: true, status: 200, text: async () => "ok" };
    };
    const toolConfig = {
      name: "t",
      url: "http://localhost/api/{+path}",
      params: [{ name: "path", required: true, type: "number" }],
    };
    const { text, isError } = await callTool(toolConfig, { path: 42 });
    assert.equal(isError, undefined);
    assert.equal(text, "ok");
    assert.equal(capturedUrl, "http://localhost/api/42");
  });

  it("callTool: coerces non-string raw GET path defaults before fetch", async () => {
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return { ok: true, status: 200, text: async () => "ok" };
    };
    const toolConfig = {
      name: "t",
      url: "http://localhost/api/{+path}",
      params: [{ name: "path", default: 42, type: "number" }],
    };
    const { text, isError } = await callTool(toolConfig, {});
    assert.equal(isError, undefined);
    assert.equal(text, "ok");
    assert.equal(capturedUrl, "http://localhost/api/42");
  });

  it("callTool: rejects optional raw GET path with invalid override", async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; };
    const toolConfig = {
      name: "t",
      url: "http://localhost/api/{+path}",
      params: [{ name: "path", default: "jobs/default" }],
    };
    const { text, isError } = await callTool(toolConfig, { path: "../admin" });
    assert.equal(isError, true);
    assert.ok(text.includes('Invalid raw path param "path"'));
    assert.equal(fetchCalled, false, "fetch must not run for invalid raw path overrides");
  });

  it("callTool: allows optional raw GET path with valid override", async () => {
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return { ok: true, status: 200, text: async () => "ok" };
    };
    const toolConfig = {
      name: "t",
      url: "http://localhost/api/{+path}",
      params: [{ name: "path", default: "jobs/default" }],
    };
    const { text, isError } = await callTool(toolConfig, { path: "jobs/custom" });
    assert.equal(isError, undefined);
    assert.equal(text, "ok");
    assert.equal(capturedUrl, "http://localhost/api/jobs/custom");
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

  it("callTool: success with no response config passes raw text through", async () => {
    const toolConfig = { name: "t", url: "http://localhost/api" };
    mockFetch("raw output");
    const { text, isError } = await callTool(toolConfig, {});
    assert.equal(isError, undefined);
    assert.equal(text, "raw output");
  });

  it("callTool: numeric header value is coerced without throwing", async () => {
    const toolConfig = { name: "t", url: "http://localhost/api", headers: { "X-Version": 2 } };
    mockFetch("ok");
    const { text, isError } = await callTool(toolConfig, {});
    assert.equal(isError, undefined);
    assert.equal(text, "ok");
  });

  it("callTool: missing url returns isError instead of throwing", async () => {
    const toolConfig = { name: "t" };
    const { text, isError } = await callTool(toolConfig, {});
    assert.equal(isError, true);
    assert.ok(typeof text === "string" && text.length > 0);
    assert.ok(text.toLowerCase().includes("url"), `expected url-related error, got: ${text}`);
  });

  it("callTool: missing required raw path param returns isError instead of throwing", async () => {
    const toolConfig = { name: "t", url: "http://localhost/api/{+path}", params: [{ name: "path", required: true }] };
    const { text, isError } = await callTool(toolConfig, {});
    assert.equal(isError, true);
    assert.ok(text.includes("Required raw path parameter"));
    assert.ok(text.includes("path"));
  });

  it("callTool: non-Error thrown value uses String(err) fallback", async () => {
    globalThis.fetch = async () => { throw "something went wrong"; };
    const toolConfig = { name: "t", url: "http://localhost/api" };
    const { text, isError } = await callTool(toolConfig, {});
    assert.equal(isError, true);
    assert.ok(text.includes("something went wrong"), `expected err string in text, got: ${text}`);
  });

  it("callTool: concurrent calls have isolated AbortControllers", async () => {
    globalThis.fetch = (_url, opts) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ ok: true, status: 200, text: async () => "ok" }), 30);
      opts?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });
    const [timedOut, succeeded] = await Promise.all([
      callTool({ name: "fast", url: "http://localhost/api", timeout: 10 }, {}),
      callTool({ name: "slow", url: "http://localhost/api", timeout: 5000 }, {}),
    ]);
    assert.equal(timedOut.isError, true);
    assert.ok(timedOut.text.includes("timed out"));
    assert.equal(succeeded.isError, undefined);
    assert.equal(succeeded.text, "ok");
  });

  it("callTool: success with json type and no path pretty-prints", async () => {
    const toolConfig = {
      name: "t",
      url: "http://localhost/api",
      response: { type: "json" },
    };
    mockFetch({ status: "ok", count: 3 });
    const { text, isError } = await callTool(toolConfig, {});
    assert.equal(isError, undefined);
    const parsed = JSON.parse(text);
    assert.equal(parsed.status, "ok");
    assert.equal(parsed.count, 3);
  });

  it("callTool: json path missing in response falls back to raw JSON", async () => {
    const toolConfig = {
      name: "t",
      url: "http://localhost/api",
      response: { type: "json", path: "no.such.key" },
    };
    mockFetch({ status: "ok" });
    const { text, isError } = await callTool(toolConfig, {});
    assert.equal(isError, undefined);
    assert.ok(text.includes("ok"), `expected raw JSON fallback, got: ${text}`);
  });

  it("callTool: POST sends body and returns extracted response", async () => {
    let capturedBody;
    globalThis.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "42", status: "created" }) };
    };
    const toolConfig = {
      name: "create_item",
      method: "POST",
      url: "http://localhost/api/{id}",
      params: [
        { name: "id", required: true },
        { name: "status", required: true },
        { name: "priority", default: "normal" },
      ],
      response: { type: "json", path: "status" },
    };
    const { text, isError } = await callTool(toolConfig, { id: "42", status: "active" });
    assert.equal(isError, undefined);
    assert.equal(text, "created");
    assert.equal(capturedBody.status, "active");
    assert.equal(capturedBody.priority, "normal");
    assert.equal(capturedBody.id, undefined, "path param must not appear in body");
  });

  it("callTool: invalid raw POST path returns isError before fetch", async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, status: 200, text: async () => "ok" };
    };
    const toolConfig = {
      name: "t",
      method: "POST",
      url: "http://localhost/api/{+path}",
      params: [
        { name: "path", required: true },
        { name: "status", required: true },
      ],
    };
    const { text, isError } = await callTool(toolConfig, { path: "a/../../admin", status: "active" });
    assert.equal(isError, true);
    assert.ok(text.includes('Invalid raw path param "path"'));
    assert.equal(fetchCalled, false, "fetch must not run for invalid raw paths");
  });

  it("callTool: omitted raw POST path uses safe default", async () => {
    let capturedUrl;
    let capturedBody;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedBody = JSON.parse(options.body);
      return { ok: true, status: 200, text: async () => "ok" };
    };
    const toolConfig = {
      name: "t",
      method: "POST",
      url: "http://localhost/api/{+path}",
      params: [
        { name: "path", default: "jobs/default" },
        { name: "status", required: true },
      ],
    };
    const { text, isError } = await callTool(toolConfig, { status: "active" });
    assert.equal(isError, undefined);
    assert.equal(text, "ok");
    assert.equal(capturedUrl, "http://localhost/api/jobs/default");
    assert.deepEqual(capturedBody, { status: "active" });
  });

  it("callTool: coerces non-string raw POST path defaults before fetch", async () => {
    let capturedUrl;
    let capturedBody;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedBody = JSON.parse(options.body);
      return { ok: true, status: 200, text: async () => "ok" };
    };
    const toolConfig = {
      name: "t",
      method: "POST",
      url: "http://localhost/api/{+path}",
      params: [
        { name: "path", default: 42, type: "number" },
        { name: "status", required: true },
      ],
    };
    const { text, isError } = await callTool(toolConfig, { status: "active" });
    assert.equal(isError, undefined);
    assert.equal(text, "ok");
    assert.equal(capturedUrl, "http://localhost/api/42");
    assert.deepEqual(capturedBody, { status: "active" });
  });

  it("callTool: rejects optional raw POST path with invalid override", async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; };
    const toolConfig = {
      name: "t",
      method: "POST",
      url: "http://localhost/api/{+path}",
      params: [
        { name: "path", default: "jobs/default" },
        { name: "status", required: true },
      ],
    };
    const { text, isError } = await callTool(toolConfig, { path: "../../admin", status: "active" });
    assert.equal(isError, true);
    assert.ok(text.includes('Invalid raw path param "path"'));
    assert.equal(fetchCalled, false, "fetch must not run for invalid raw path overrides");
  });

  it("callTool: allows optional raw POST path with valid override", async () => {
    let capturedUrl;
    let capturedBody;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedBody = JSON.parse(options.body);
      return { ok: true, status: 200, text: async () => "ok" };
    };
    const toolConfig = {
      name: "t",
      method: "POST",
      url: "http://localhost/api/{+path}",
      params: [
        { name: "path", default: "jobs/default" },
        { name: "status", required: true },
      ],
    };
    const { text, isError } = await callTool(toolConfig, { path: "jobs/custom", status: "active" });
    assert.equal(isError, undefined);
    assert.equal(text, "ok");
    assert.equal(capturedUrl, "http://localhost/api/jobs/custom");
    assert.deepEqual(capturedBody, { status: "active" });
  });

  it("callTool: POST non-2xx marks isError", async () => {
    const toolConfig = {
      name: "create_item",
      method: "POST",
      url: "http://localhost/api",
      params: [{ name: "name", required: true }],
    };
    mockFetch({ error: "conflict" }, 409);
    const { text, isError } = await callTool(toolConfig, { name: "dup" });
    assert.equal(isError, true);
    assert.ok(text.startsWith("HTTP 409:"));
  });
});
