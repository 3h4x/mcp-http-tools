import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { timingSafeEqual } from "node:crypto";
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

export function verifyBearerToken(authHeader, expectedToken) {
  if (!expectedToken) return false;
  if (typeof authHeader !== "string") return false;
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return false;
  const provided = authHeader.slice(prefix.length);
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expectedToken);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

const VALID_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const VALID_RESPONSE_TYPES = new Set(["text", "json"]);
const VALID_RESPONSE_KEYS = new Set(["type", "path", "template"]);
const VALID_TOOL_KEYS = new Set(["name", "description", "url", "method", "headers", "params", "response", "timeout", "auth", "retry", "requests"]);
const VALID_REQUEST_KEYS = new Set(["key", "url", "method", "headers", "params", "response", "timeout", "auth", "retry"]);
const REQUEST_ONLY_TOOL_KEYS = ["url", "method", "headers", "response", "timeout", "auth", "retry"];
const VALID_PARAM_KEYS = new Set(["name", "description", "type", "enum", "required", "default"]);
const VALID_PARAM_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);
const VALID_AUTH_KEYS = new Set(["bearer_env"]);
const VALID_RETRY_KEYS = new Set(["count", "backoff_ms"]);
const ENV_VAR_NAME_RE = /^\w+$/;
const TOOL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
const INVALID_RAW_PATH_SEGMENTS = new Set(["", ".", ".."]);
const URL_PLACEHOLDER_RE = /(?<!\$)\{(\+?[\w-]+)\}/g;
const URL_PLACEHOLDER_SUB_RE = /\{(\+?)([\w-]+)\}/g;
const RESPONSE_TEMPLATE_PLACEHOLDER_RE = /\{([\w.-]+)\}/g;

// Validates the "how to make this one HTTP call" fields -- url, method,
// params, headers, auth, response, timeout, retry -- shared by both a
// regular tool and each entry in a composite tool's `requests` array.
// Pushes onto `errors` directly rather than returning a new array, so
// callers don't need to spread/concat at every call site.
function validateRequestShape(obj, ref, errors) {
  if (!obj.url) {
    errors.push(`${ref}: missing required field "url"`);
  } else {
    if (typeof obj.url !== "string") {
      errors.push(`${ref}: "url" must be a string`);
    } else if (!obj.url.includes("${")) {
      try {
        new URL(obj.url.replace(/\{[^}]+\}/g, "x"));
      } catch {
        errors.push(`${ref}: "url" is not a valid URL`);
      }
    }
    if (typeof obj.url === "string") {
      const paramsByName = new Map((Array.isArray(obj.params) ? obj.params : []).map(p => [p?.name, p]));
      const paramNames = new Set(paramsByName.keys());
      for (const [, ph] of obj.url.matchAll(URL_PLACEHOLDER_RE)) {
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
  if (obj.method !== undefined) {
    const method = typeof obj.method === "string" ? obj.method.toUpperCase() : "";
    if (!VALID_METHODS.has(method)) {
      errors.push(`${ref}: invalid method "${obj.method}" — expected one of: GET, POST, PUT, PATCH, DELETE`);
    }
  }
  if (obj.params != null && !Array.isArray(obj.params)) {
    errors.push(`${ref}: "params" must be an array`);
  }
  const seenParams = new Set();
  for (const [j, param] of (Array.isArray(obj.params) ? obj.params : []).entries()) {
    if (param == null || typeof param !== "object" || Array.isArray(param)) {
      errors.push(`${ref}: params[${j}] must be an object`);
      continue;
    }
    for (const key of Object.keys(param)) {
      if (!VALID_PARAM_KEYS.has(key)) {
        errors.push(`${ref}: params[${j}]${param.name ? ` ("${param.name}")` : ""} has unsupported field "${key}"`);
      }
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
    const hasValidParamType = param.type === undefined || VALID_PARAM_TYPES.has(param.type);
    const effectiveParamType = param.type ?? "string";
    if (!hasValidParamType) {
      errors.push(`${ref}: params[${j}]${param.name ? ` ("${param.name}")` : ""} has invalid type "${param.type}" — expected one of: string, number, integer, boolean, array, object`);
    }
    const defaultMatchesType = param.default === undefined || !hasValidParamType || isValidParamValueForType(param.default, effectiveParamType);
    if (!defaultMatchesType) {
      errors.push(`${ref}: params[${j}]${param.name ? ` ("${param.name}")` : ""} default value ${JSON.stringify(param.default)} does not match declared type "${effectiveParamType}"`);
    }
    if (param.enum !== undefined) {
      if (!Array.isArray(param.enum) || param.enum.length === 0) {
        errors.push(`${ref}: params[${j}]${param.name ? ` ("${param.name}")` : ""} "enum" must be a non-empty array`);
      } else {
        if (hasValidParamType) {
          for (const value of param.enum) {
            if (!isValidParamValueForType(value, effectiveParamType)) {
              errors.push(`${ref}: params[${j}]${param.name ? ` ("${param.name}")` : ""} enum value ${JSON.stringify(value)} does not match declared type "${effectiveParamType}"`);
              break;
            }
          }
        }
        if (defaultMatchesType && param.default !== undefined && !param.enum.some(value => isDeepStrictEqual(value, param.default))) {
          errors.push(`${ref}: params[${j}]${param.name ? ` ("${param.name}")` : ""} default must be one of the enum values`);
        }
      }
    }
  }
  if (obj.headers !== undefined && obj.headers !== null) {
    if (typeof obj.headers !== "object" || Array.isArray(obj.headers)) {
      errors.push(`${ref}: "headers" must be an object`);
    } else {
      for (const [k, v] of Object.entries(obj.headers)) {
        if (typeof v !== "string" && typeof v !== "number") {
          errors.push(`${ref}: headers["${k}"] must be a string or number`);
        }
      }
    }
  }
  if (obj.auth !== undefined && obj.auth !== null) {
    if (typeof obj.auth !== "object" || Array.isArray(obj.auth)) {
      errors.push(`${ref}: "auth" must be an object`);
    } else {
      for (const key of Object.keys(obj.auth)) {
        if (!VALID_AUTH_KEYS.has(key)) {
          errors.push(`${ref}: auth has unsupported field "${key}"`);
        }
      }
      if (obj.auth.bearer_env !== undefined && !isValidEnvVarName(obj.auth.bearer_env)) {
        errors.push(`${ref}: "auth.bearer_env" must be an environment variable name containing only letters, digits, and underscores`);
      }
    }
  }
  if (obj.response !== undefined && obj.response !== null) {
    if (typeof obj.response !== "object" || Array.isArray(obj.response)) {
      errors.push(`${ref}: "response" must be an object`);
    } else {
      for (const key of Object.keys(obj.response)) {
        if (!VALID_RESPONSE_KEYS.has(key)) {
          errors.push(`${ref}: response has unsupported field "${key}"`);
        }
      }
      if (obj.response.type !== undefined && !VALID_RESPONSE_TYPES.has(obj.response.type)) {
        errors.push(`${ref}: invalid response.type "${obj.response.type}" — expected "text" or "json"`);
      }
      if (obj.response.path !== undefined && (typeof obj.response.path !== "string" || obj.response.path.trim() === "")) {
        errors.push(`${ref}: "response.path" must be a non-empty string`);
      }
      if (obj.response.path !== undefined && (obj.response.type ?? "text") !== "json") {
        errors.push(`${ref}: "response.path" requires response.type "json"`);
      }
      if (obj.response.template !== undefined && (typeof obj.response.template !== "string" || obj.response.template.trim() === "")) {
        errors.push(`${ref}: "response.template" must be a non-empty string`);
      }
      if (obj.response.template !== undefined && (obj.response.type ?? "text") !== "json") {
        errors.push(`${ref}: "response.template" requires response.type "json"`);
      }
    }
  }
  if (obj.timeout !== undefined && (typeof obj.timeout !== "number" || !Number.isFinite(obj.timeout) || obj.timeout <= 0)) {
    errors.push(`${ref}: "timeout" must be a positive number (milliseconds)`);
  }
  if (obj.retry !== undefined && obj.retry !== null) {
    if (typeof obj.retry !== "object" || Array.isArray(obj.retry)) {
      errors.push(`${ref}: "retry" must be an object`);
    } else {
      for (const key of Object.keys(obj.retry)) {
        if (!VALID_RETRY_KEYS.has(key)) {
          errors.push(`${ref}: retry has unsupported field "${key}"`);
        }
      }
      if (obj.retry.count !== undefined && (!Number.isInteger(obj.retry.count) || obj.retry.count < 0)) {
        errors.push(`${ref}: "retry.count" must be a non-negative integer`);
      }
      if (obj.retry.backoff_ms !== undefined && (typeof obj.retry.backoff_ms !== "number" || !Number.isFinite(obj.retry.backoff_ms) || obj.retry.backoff_ms < 0)) {
        errors.push(`${ref}: "retry.backoff_ms" must be a non-negative number (milliseconds)`);
      }
    }
  }
}

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
    for (const key of Object.keys(tool)) {
      if (!VALID_TOOL_KEYS.has(key)) {
        errors.push(`${ref}: has unsupported field "${key}"`);
      }
    }
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
    const isComposite = tool.requests !== undefined;
    if (isComposite) {
      for (const field of REQUEST_ONLY_TOOL_KEYS) {
        if (tool[field] !== undefined) {
          errors.push(`${ref}: "${field}" is not valid alongside "requests" -- each request in the array declares its own ${field}`);
        }
      }
      if (!Array.isArray(tool.requests) || tool.requests.length === 0) {
        errors.push(`${ref}: "requests" must be a non-empty array`);
      } else {
        const seenKeys = new Set();
        for (const [k, reqItem] of tool.requests.entries()) {
          const rref = `${ref}.requests[${k}]${reqItem?.key ? ` ("${reqItem.key}")` : ""}`;
          if (reqItem == null || typeof reqItem !== "object" || Array.isArray(reqItem)) {
            errors.push(`${rref}: entry must be an object`);
            continue;
          }
          for (const key of Object.keys(reqItem)) {
            if (!VALID_REQUEST_KEYS.has(key)) {
              errors.push(`${rref}: has unsupported field "${key}"`);
            }
          }
          if (!reqItem.key) {
            errors.push(`${rref}: missing required field "key"`);
          } else if (!TOOL_NAME_RE.test(reqItem.key)) {
            errors.push(`${rref}: "key" must start with a letter or underscore and contain only letters, digits, underscores, or hyphens`);
          } else if (seenKeys.has(reqItem.key)) {
            errors.push(`${rref}: duplicate request key "${reqItem.key}"`);
          } else {
            seenKeys.add(reqItem.key);
          }
          validateRequestShape(reqItem, rref, errors);
        }
      }
    } else {
      validateRequestShape(tool, ref, errors);
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
      headers[k] = sanitizeHeaderValue(v);
    }
  }
  applyAuthPreset(toolConfig.auth, headers);

  const usedInUrl = new Set();
  const resolvedUrl = substituteEnvVars(toolConfig.url).replace(URL_PLACEHOLDER_SUB_RE, (_, raw, name) => {
    usedInUrl.add(name);
    const param = paramsByName.get(name);
    const hasArgValue = name in args && args[name] !== undefined;
    const hasDefaultValue = param?.default !== undefined;

    let value;
    if (hasArgValue) {
      value = args[name];
    } else if (hasDefaultValue) {
      value = param.default;
    } else {
      if (raw !== "+" && param?.required === true) {
        throw new Error(`Required path parameter "${name}" was not provided`);
      }
      value = "";
    }

    if (raw === "+") {
      if (!hasArgValue && !hasDefaultValue && param?.required === true) {
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

function sanitizeHeaderValue(value) {
  return substituteEnvVars(value).replace(/[\r\n]/g, "");
}

function applyAuthPreset(authConfig, headers) {
  if (authConfig?.bearer_env === undefined) return;
  if (!isValidEnvVarName(authConfig.bearer_env)) {
    throw new Error('"auth.bearer_env" must be an environment variable name containing only letters, digits, and underscores');
  }
  if (Object.keys(headers).some(key => key.toLowerCase() === "authorization")) return;
  headers.Authorization = sanitizeHeaderValue(`Bearer \${${authConfig.bearer_env}}`);
}

function isValidEnvVarName(value) {
  return typeof value === "string" && ENV_VAR_NAME_RE.test(value);
}

function isValidParamValueForType(value, type) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    default:
      return true;
  }
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
const DEFAULT_RETRY_COUNT = 2;
const DEFAULT_RETRY_BACKOFF_MS = 250;
const TRANSIENT_HTTP_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

function getRetryConfig(toolConfig) {
  if (toolConfig.retry == null) {
    return { count: 0, backoffMs: 0 };
  }
  return {
    count: toolConfig.retry.count ?? DEFAULT_RETRY_COUNT,
    backoffMs: toolConfig.retry.backoff_ms ?? DEFAULT_RETRY_BACKOFF_MS,
  };
}

function getRetryDelayMs(retryConfig, attempt) {
  if (retryConfig.backoffMs <= 0) return 0;
  return retryConfig.backoffMs * (2 ** attempt);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shouldRetryStatus(status, attempt, retryConfig) {
  return attempt < retryConfig.count && TRANSIENT_HTTP_STATUS_CODES.has(status);
}

function shouldRetryError(err, attempt, retryConfig) {
  if (attempt >= retryConfig.count) return false;
  return err?.name === "AbortError" || err instanceof TypeError;
}

export async function callTool(toolConfig, args) {
  if (Array.isArray(toolConfig.requests)) {
    return callCompositeTool(toolConfig, args);
  }
  return callSingleRequest(toolConfig, args);
}

async function callSingleRequest(requestConfig, args) {
  const timeout = requestConfig.timeout ?? DEFAULT_TIMEOUT_MS;
  const retryConfig = getRetryConfig(requestConfig);

  try {
    const { url, options } = buildRequest(requestConfig, args);

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        const raw = await res.text();
        if (!res.ok) {
          if (shouldRetryStatus(res.status, attempt, retryConfig)) {
            const delayMs = getRetryDelayMs(retryConfig, attempt);
            clearTimeout(timer);
            await wait(delayMs);
            continue;
          }
          const body = raw.length > MAX_ERROR_BODY_CHARS
            ? `${raw.slice(0, MAX_ERROR_BODY_CHARS)}… (truncated, showing ${MAX_ERROR_BODY_CHARS}/${raw.length} chars)`
            : raw;
          return { text: `HTTP ${res.status}: ${body}`, isError: true };
        }
        return { text: extractResponse(raw, requestConfig.response) };
      } catch (err) {
        if (shouldRetryError(err, attempt, retryConfig)) {
          const delayMs = getRetryDelayMs(retryConfig, attempt);
          clearTimeout(timer);
          await wait(delayMs);
          continue;
        }
        const msg = err.name === "AbortError" ? `Request timed out after ${timeout}ms` : (err.message ?? String(err));
        return { text: `Error: ${msg}`, isError: true };
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (err) {
    const msg = err?.name === "AbortError" ? `Request timed out after ${timeout}ms` : (err?.message ?? String(err));
    return { text: `Error: ${msg}`, isError: true };
  }
}

// A composite tool fans out to every entry in `requests` IN PARALLEL (this is
// the whole point -- "one project overview" means k8s + logs + metrics +
// errors + policy reports side by side, not queued one after another) and
// merges the results into a single JSON object keyed by each request's
// `key`. One sub-request failing (timeout, HTTP error, whatever) does not
// fail the others -- it shows up as `{ error: "..." }` under its own key, so
// a caller still gets everything that DID succeed instead of an all-or-
// nothing failure.
async function callCompositeTool(toolConfig, args) {
  const settled = await Promise.allSettled(
    toolConfig.requests.map(requestConfig => callSingleRequest(requestConfig, args))
  );
  const merged = {};
  settled.forEach((result, i) => {
    const key = toolConfig.requests[i].key;
    if (result.status === "rejected") {
      merged[key] = { error: result.reason?.message ?? String(result.reason) };
      return;
    }
    const { text, isError } = result.value;
    merged[key] = isError ? { error: text } : parseJsonOrKeepText(text);
  });
  return { text: JSON.stringify(merged, null, 2) };
}

function parseJsonOrKeepText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
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

  let extracted = parsed;
  if (responseConfig?.path) {
    extracted = resolvePath(parsed, responseConfig.path);
    if (extracted === undefined) return raw;
  }

  if (responseConfig?.template) {
    return responseConfig.template.replace(RESPONSE_TEMPLATE_PLACEHOLDER_RE, (match, path) => {
      const value = resolvePath(extracted, path);
      if (value === undefined) return match;
      if (typeof value === "string") return value;
      if (value !== null && typeof value === "object") return JSON.stringify(value);
      return String(value);
    });
  }

  if (typeof extracted === "string") return extracted;
  return JSON.stringify(extracted, null, 2);
}
