/**
 * mcp-http-tools — generic HTTP-to-MCP proxy engine.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── config ────────────────────────────────────────────────────────────────

export function loadConfig() {
  const paths = [
    join(homedir(), ".config", "mcp-http-tools", "config.yaml"),
    resolve(__dirname, "config.yaml"),
  ];
  for (const p of paths) {
    if (existsSync(p)) return yaml.load(readFileSync(p, "utf8"));
  }
  return {};
}

// ── helpers ───────────────────────────────────────────────────────────────

export function resolvePath(obj, path) {
  if (!path) return obj;
  const segments = path.split(".");
  let current = obj;
  for (const seg of segments) {
    if (current == null) return undefined;
    current = current[seg];
  }
  return current;
}

export function substituteEnvVars(str) {
  return str.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
}

// ── config validation ─────────────────────────────────────────────────────

const VALID_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export function validateConfig(config) {
  const errors = [];
  for (const [i, tool] of (config.tools ?? []).entries()) {
    const ref = `tools[${i}]${tool.name ? ` ("${tool.name}")` : ""}`;
    if (!tool.name) errors.push(`${ref}: missing required field "name"`);
    if (!tool.url) errors.push(`${ref}: missing required field "url"`);
    if (tool.method && !VALID_METHODS.has(tool.method.toUpperCase())) {
      errors.push(`${ref}: invalid method "${tool.method}" — expected one of: GET, POST, PUT, PATCH, DELETE`);
    }
  }
  return errors;
}

// ── config → MCP tool schemas ─────────────────────────────────────────────

export function configToTools(config) {
  const tools = config.tools ?? [];
  return tools.map(t => {
    const properties = {};
    const required = [];
    for (const p of t.params ?? []) {
      properties[p.name] = {
        type: p.type ?? "string",
        ...(p.description && { description: p.description }),
      };
      if (p.required) required.push(p.name);
    }
    return {
      name: t.name,
      description: t.description ?? "",
      inputSchema: {
        type: "object",
        properties,
        ...(required.length && { required }),
      },
    };
  });
}

// ── build fetch request from tool config + args ───────────────────────────

export function buildRequest(toolConfig, args) {
  const method = (toolConfig.method ?? "GET").toUpperCase();
  const headers = {};

  if (toolConfig.headers) {
    for (const [k, v] of Object.entries(toolConfig.headers)) {
      headers[k] = substituteEnvVars(v);
    }
  }

  // Replace {param} placeholders in the URL with arg values
  const usedInUrl = new Set();
  const resolvedUrl = toolConfig.url.replace(/\{(\w+)\}/g, (_, name) => {
    usedInUrl.add(name);
    return encodeURIComponent(String(args[name] ?? ""));
  });

  const bodyMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  if (bodyMethods.has(method)) {
    const body = {};
    for (const p of toolConfig.params ?? []) {
      if (usedInUrl.has(p.name)) continue;
      if (p.name in args) {
        body[p.name] = args[p.name];
      } else if (p.default !== undefined) {
        body[p.name] = p.default;
      }
    }
    if (!headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    return {
      url: resolvedUrl,
      options: { method, headers, body: JSON.stringify(body) },
    };
  }

  // GET
  const url = new URL(resolvedUrl);
  for (const p of toolConfig.params ?? []) {
    if (usedInUrl.has(p.name)) continue;
    if (p.name in args) {
      url.searchParams.set(p.name, String(args[p.name]));
    } else if (p.default !== undefined) {
      url.searchParams.set(p.name, String(p.default));
    }
  }
  return {
    url: url.toString(),
    options: { method, ...(Object.keys(headers).length && { headers }) },
  };
}

// ── format response ───────────────────────────────────────────────────────

export function extractResponse(raw, responseConfig) {
  const type = responseConfig?.type ?? "text";
  if (type === "text") return raw;

  // json
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }

  if (responseConfig?.path) {
    const extracted = resolvePath(parsed, responseConfig.path);
    return extracted === undefined ? raw : JSON.stringify(extracted, null, 2);
  }
  return JSON.stringify(parsed, null, 2);
}
