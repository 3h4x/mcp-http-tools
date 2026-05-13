import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getDefaultConfigPaths() {
  return [
    join(homedir(), ".config", "mcp-http-tools", "config.yaml"),
    resolve(__dirname, "config.yaml"),
  ];
}

function parseConfigPathArg(argv) {
  let configPath;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error('Missing value for "--config"');
      }
      if (configPath !== undefined) {
        throw new Error('Duplicate "--config" flag');
      }
      configPath = next;
      i++;
      continue;
    }

    if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      if (!value) {
        throw new Error('Missing value for "--config"');
      }
      if (configPath !== undefined) {
        throw new Error('Duplicate "--config" flag');
      }
      configPath = value;
    }
  }
  return configPath;
}

function resolveConfigSource(configSource) {
  if (Array.isArray(configSource)) {
    return { paths: configSource, explicit: false };
  }
  if (configSource && typeof configSource === "object") {
    const configPath = configSource.configPath ?? parseConfigPathArg(configSource.argv ?? []);
    return configPath
      ? { paths: [resolve(configPath)], explicit: true }
      : { paths: getDefaultConfigPaths(), explicit: false };
  }
  return { paths: getDefaultConfigPaths(), explicit: false };
}

export function loadConfig(configSource) {
  const { paths, explicit } = resolveConfigSource(configSource);
  if (explicit) {
    const p = paths[0];
    if (!existsSync(p)) {
      throw new Error(`Config file not found: ${p}`);
    }
    try {
      return yaml.load(readFileSync(p, "utf8")) ?? {};
    } catch (err) {
      throw new Error(`Failed to parse config at ${p}: ${err.message}`);
    }
  }

  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      return yaml.load(readFileSync(p, "utf8")) ?? {};
    } catch (err) {
      process.stderr.write(`[mcp-http-tools] failed to parse config at ${p}: ${err.message}\n`);
      return {};
    }
  }
  return {};
}

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
  return String(str).replace(/\$\{(\w+)\}/g, (_, name) => {
    if (!(name in process.env)) {
      process.stderr.write(`[mcp-http-tools] warning: env var "${name}" is not set\n`);
      return "";
    }
    return process.env[name];
  });
}

const VALID_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const VALID_RESPONSE_TYPES = new Set(["text", "json"]);
const VALID_PARAM_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);
const TOOL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
const INVALID_RAW_PATH_SEGMENTS = new Set(["", ".", ".."]);
const URL_PLACEHOLDER_RE = /(?<!\$)\{(\+?[\w-]+)\}/g;
const URL_PLACEHOLDER_SUB_RE = /\{(\+?)([\w-]+)\}/g;

export function validateConfig(config) {
  const errors = [];
  if (config.tools != null && !Array.isArray(config.tools)) {
    errors.push('"tools" must be an array');
    return errors;
  }
  const seenNames = new Set();
  for (const [i, tool] of (config.tools ?? []).entries()) {
    if (tool == null || typeof tool !== "object" || Array.isArray(tool)) {
      errors.push(`tools[${i}]: entry must be an object`);
      continue;
    }
    const ref = `tools[${i}]${tool.name ? ` ("${tool.name}")` : ""}`;
    if (!tool.name) {
      errors.push(`${ref}: missing required field "name"`);
    } else {
      if (!TOOL_NAME_RE.test(tool.name)) {
        errors.push(`${ref}: tool name must start with a letter or underscore and contain only letters, digits, underscores, or hyphens`);
      }
      if (seenNames.has(tool.name)) {
        errors.push(`${ref}: duplicate tool name "${tool.name}"`);
      } else {
        seenNames.add(tool.name);
      }
    }
    if (!tool.url) {
      errors.push(`${ref}: missing required field "url"`);
    } else {
      if (typeof tool.url !== "string") {
        errors.push(`${ref}: "url" must be a string`);
      } else if (!tool.url.includes("${")) {
        try {
          new URL(tool.url.replace(/\{[^}]+\}/g, "x"));
        } catch {
          errors.push(`${ref}: "url" is not a valid URL`);
        }
      }
      if (typeof tool.url === "string") {
        const paramsByName = new Map((Array.isArray(tool.params) ? tool.params : []).map(p => [p?.name, p]));
        const paramNames = new Set(paramsByName.keys());
        for (const [, ph] of tool.url.matchAll(URL_PLACEHOLDER_RE)) {
          const paramName = ph.startsWith("+") ? ph.slice(1) : ph;
          if (!paramNames.has(paramName)) {
            errors.push(`${ref}: URL placeholder "{${ph}}" has no matching param definition`);
            continue;
          }
          if (ph.startsWith("+")) {
            const param = paramsByName.get(paramName);
            const hasSafeDefault = param?.default !== undefined && isSafeRawPathValue(param.default);
            if (param?.required !== true && !hasSafeDefault) {
              errors.push(`${ref}: raw path placeholder "{${ph}}" requires params["${paramName}"] to be required or have a non-empty default without "." or ".." segments`);
            }
          }
        }
      }
    }
    if (tool.method !== undefined) {
      const method = typeof tool.method === "string" ? tool.method.toUpperCase() : "";
      if (!VALID_METHODS.has(method)) {
        errors.push(`${ref}: invalid method "${tool.method}" — expected one of: GET, POST, PUT, PATCH, DELETE`);
      }
    }
    if (tool.params != null && !Array.isArray(tool.params)) {
      errors.push(`${ref}: "params" must be an array`);
    }
    const seenParams = new Set();
    for (const [j, param] of (Array.isArray(tool.params) ? tool.params : []).entries()) {
      if (param == null || typeof param !== "object" || Array.isArray(param)) {
        errors.push(`${ref}: params[${j}] must be an object`);
        continue;
      }
      if (!param.name) {
        errors.push(`${ref}: params[${j}] missing required field "name"`);
      } else {
        if (seenParams.has(param.name)) {
          errors.push(`${ref}: params[${j}] duplicate param name "${param.name}"`);
        } else {
          seenParams.add(param.name);
        }
      }
      if (param.required === true && param.default !== undefined) {
        errors.push(`${ref}: params[${j}]${param.name ? ` ("${param.name}")` : ""} cannot have both "required: true" and a "default"`);
      }
      if (param.type !== undefined && !VALID_PARAM_TYPES.has(param.type)) {
        errors.push(`${ref}: params[${j}]${param.name ? ` ("${param.name}")` : ""} has invalid type "${param.type}" — expected one of: string, number, integer, boolean, array, object`);
      }
    }
    if (tool.headers !== undefined && tool.headers !== null) {
      if (typeof tool.headers !== "object" || Array.isArray(tool.headers)) {
        errors.push(`${ref}: "headers" must be an object`);
      } else {
        for (const [k, v] of Object.entries(tool.headers)) {
          if (typeof v !== "string" && typeof v !== "number") {
            errors.push(`${ref}: headers["${k}"] must be a string or number`);
          }
        }
      }
    }
    if (tool.response?.type !== undefined && !VALID_RESPONSE_TYPES.has(tool.response.type)) {
      errors.push(`${ref}: invalid response.type "${tool.response.type}" — expected "text" or "json"`);
    }
    if (tool.response?.path !== undefined && (typeof tool.response.path !== "string" || tool.response.path.trim() === "")) {
      errors.push(`${ref}: "response.path" must be a non-empty string`);
    }
    if (tool.response?.path !== undefined && (tool.response?.type ?? "text") !== "json") {
      errors.push(`${ref}: "response.path" requires response.type "json"`);
    }
    if (tool.timeout !== undefined && (typeof tool.timeout !== "number" || !Number.isFinite(tool.timeout) || tool.timeout <= 0)) {
      errors.push(`${ref}: "timeout" must be a positive number (milliseconds)`);
    }
  }
  return errors;
}

export function configToTools(config) {
  const tools = Array.isArray(config.tools) ? config.tools : [];
  return tools.map(t => {
    const properties = {};
    const required = [];
    for (const p of t.params ?? []) {
      properties[p.name] = {
        type: p.type ?? "string",
        ...(p.description && { description: p.description }),
        ...(p.enum && { enum: p.enum }),
        ...(p.default !== undefined && { default: p.default }),
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
        additionalProperties: false,
      },
    };
  });
}

export function buildRequest(toolConfig, args) {
  args = args ?? {};
  if (!toolConfig.url) throw new Error('tool config is missing required "url" field');
  const method = (toolConfig.method ?? "GET").toUpperCase();
  const headers = {};
  const paramsByName = new Map((toolConfig.params ?? []).map(p => [p.name, p]));

  if (toolConfig.headers) {
    for (const [k, v] of Object.entries(toolConfig.headers)) {
      headers[k] = substituteEnvVars(v).replace(/[\r\n]/g, "");
    }
  }

  const usedInUrl = new Set();
  const resolvedUrl = substituteEnvVars(toolConfig.url).replace(URL_PLACEHOLDER_SUB_RE, (_, raw, name) => {
    usedInUrl.add(name);
    const param = paramsByName.get(name);
    let value;
    if (name in args && args[name] !== undefined) {
      value = args[name];
    } else if (param?.default !== undefined) {
      value = param.default;
    } else {
      value = "";
    }

    if (raw === "+") {
      if (value === "" && param?.required === true) {
        throw new Error(`Required raw path parameter "${name}" was not provided`);
      }
      return encodeRawPathParam(name, value);
    }
    return encodeURIComponent(value);
  });

  const bodyMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  if (bodyMethods.has(method)) {
    const body = {};
    for (const p of toolConfig.params ?? []) {
      if (usedInUrl.has(p.name)) continue;
      if (p.name in args && args[p.name] !== undefined) {
        body[p.name] = args[p.name];
      } else if (p.default !== undefined) {
        body[p.name] = p.default;
      }
    }
    if (!Object.keys(headers).some(k => k.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/json";
    }
    return {
      url: resolvedUrl,
      options: { method, headers, body: JSON.stringify(body) },
    };
  }

  let url;
  try {
    url = new URL(resolvedUrl);
  } catch {
    throw new Error(`Invalid URL after resolving placeholders: "${resolvedUrl}"`);
  }
  for (const p of toolConfig.params ?? []) {
    if (usedInUrl.has(p.name)) continue;
    if (p.name in args && args[p.name] !== undefined) {
      url.searchParams.set(p.name, toQueryString(args[p.name]));
    } else if (p.default !== undefined) {
      url.searchParams.set(p.name, toQueryString(p.default));
    }
  }
  return {
    url: url.toString(),
    options: { method, ...(Object.keys(headers).length && { headers }) },
  };
}

function toQueryString(val) {
  return (val !== null && typeof val === "object") ? JSON.stringify(val) : String(val);
}

function encodeRawPathParam(name, value) {
  const normalizedValue = String(value);
  const segments = normalizedValue.split("/");
  for (const segment of segments) {
    if (INVALID_RAW_PATH_SEGMENTS.has(segment)) {
      throw new Error(`Invalid raw path param "${name}": segments must not be empty, "." or ".."`);
    }
  }
  return segments.map(encodeURIComponent).join("/");
}

function isSafeRawPathValue(value) {
  const segments = String(value).split("/");
  return segments.every(segment => !INVALID_RAW_PATH_SEGMENTS.has(segment));
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ERROR_BODY_CHARS = 2000;

export async function callTool(toolConfig, args) {
  const timeout = toolConfig.timeout ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const { url, options } = buildRequest(toolConfig, args);
    const res = await fetch(url, { ...options, signal: controller.signal });
    const raw = await res.text();
    if (!res.ok) {
      const body = raw.length > MAX_ERROR_BODY_CHARS
        ? `${raw.slice(0, MAX_ERROR_BODY_CHARS)}… (truncated, showing ${MAX_ERROR_BODY_CHARS}/${raw.length} chars)`
        : raw;
      return { text: `HTTP ${res.status}: ${body}`, isError: true };
    }
    return { text: extractResponse(raw, toolConfig.response) };
  } catch (err) {
    const msg = err.name === "AbortError" ? `Request timed out after ${timeout}ms` : (err.message ?? String(err));
    return { text: `Error: ${msg}`, isError: true };
  } finally {
    clearTimeout(timer);
  }
}

export function extractResponse(raw, responseConfig) {
  const type = responseConfig?.type ?? "text";
  if (type === "text") return raw;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }

  if (responseConfig?.path) {
    const extracted = resolvePath(parsed, responseConfig.path);
    if (extracted === undefined) return raw;
    if (typeof extracted === "string") return extracted;
    return JSON.stringify(extracted, null, 2);
  }
  return JSON.stringify(parsed, null, 2);
}
