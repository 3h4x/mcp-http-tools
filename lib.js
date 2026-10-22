import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { timingSafeEqual, createPublicKey, createHash, verify as verifySignature } from "node:crypto";
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
const VALID_TOOL_KEYS = new Set(["name", "description", "url", "method", "headers", "params", "response", "timeout", "auth", "retry", "requests", "strict"]);
const VALID_REQUEST_KEYS = new Set(["key", "url", "method", "headers", "params", "response", "timeout", "auth", "retry"]);
const REQUEST_ONLY_TOOL_KEYS = ["url", "method", "headers", "response", "timeout", "auth", "retry"];
const VALID_PARAM_KEYS = new Set(["name", "description", "type", "enum", "required", "default", "pattern", "maxLength", "minimum", "maximum"]);
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
  if (obj.strict !== undefined && typeof obj.strict !== "boolean") {
    errors.push(`${ref}: "strict" must be a boolean`);
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
  for (const [j, param] of (Array.isArray(obj.params) ? obj.params : []).entries()) {
    if (param == null || typeof param !== "object" || Array.isArray(param)) continue;
    const pref = `${ref}: params[${j}]${param.name ? ` ("${param.name}")` : ""}`;
    if (param.pattern !== undefined) {
      if (param.type !== undefined && param.type !== "string") {
        errors.push(`${pref} "pattern" is only valid on string params`);
      }
      let re = null;
      if (typeof param.pattern !== "string" || param.pattern === "") {
        errors.push(`${pref} "pattern" must be a non-empty string`);
      } else {
        try {
          re = compileParamPattern(param.pattern);
        } catch {
          errors.push(`${pref} "pattern" is not a valid regular expression`);
        }
      }
      if (re) {
        if (typeof param.default === "string" && !re.test(param.default)) {
          errors.push(`${pref} default value does not match "pattern"`);
        }
        if (Array.isArray(param.enum)) {
          for (const value of param.enum) {
            if (typeof value === "string" && !re.test(value)) {
              errors.push(`${pref} enum value ${JSON.stringify(value)} does not match "pattern"`);
              break;
            }
          }
        }
      }
    }
    if (param.maxLength !== undefined) {
      if (param.type !== undefined && param.type !== "string") {
        errors.push(`${pref} "maxLength" is only valid on string params`);
      }
      if (!Number.isInteger(param.maxLength) || param.maxLength < 1) {
        errors.push(`${pref} "maxLength" must be a positive integer`);
      } else if (typeof param.default === "string" && param.default.length > param.maxLength) {
        errors.push(`${pref} default value is longer than "maxLength"`);
      }
    }
    for (const bound of ["minimum", "maximum"]) {
      if (param[bound] === undefined) continue;
      if (param.type !== "number" && param.type !== "integer") {
        errors.push(`${pref} "${bound}" is only valid on number or integer params`);
      }
      if (typeof param[bound] !== "number" || !Number.isFinite(param[bound])) {
        errors.push(`${pref} "${bound}" must be a finite number`);
      }
    }
    const hasMin = typeof param.minimum === "number" && Number.isFinite(param.minimum);
    const hasMax = typeof param.maximum === "number" && Number.isFinite(param.maximum);
    if (hasMin && hasMax && param.minimum > param.maximum) {
      errors.push(`${pref} "minimum" is greater than "maximum"`);
    }
    if (typeof param.default === "number") {
      if (hasMin && param.default < param.minimum) errors.push(`${pref} default value is below "minimum"`);
      if (hasMax && param.default > param.maximum) errors.push(`${pref} default value is above "maximum"`);
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

const VALID_ACCESS_KEYS = new Set(["name", "token_env", "tools"]);
const MIN_SCOPED_TOKEN_LENGTH = 32;

function validateAccess(config, errors) {
  if (config.strict_args !== undefined && typeof config.strict_args !== "boolean") {
    errors.push('"strict_args" must be a boolean');
  }
  if (config.access === undefined || config.access === null) return;
  if (!Array.isArray(config.access)) {
    errors.push('"access" must be an array');
    return;
  }
  const toolNames = new Set((Array.isArray(config.tools) ? config.tools : []).map(t => t?.name));
  const seenNames = new Set();
  const seenEnvs = new Set();
  for (const [i, entry] of config.access.entries()) {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`access[${i}]: entry must be an object`);
      continue;
    }
    const ref = `access[${i}]${entry.name ? ` ("${entry.name}")` : ""}`;
    for (const key of Object.keys(entry)) {
      if (!VALID_ACCESS_KEYS.has(key)) errors.push(`${ref}: has unsupported field "${key}"`);
    }
    if (typeof entry.name !== "string" || !entry.name) {
      errors.push(`${ref}: missing required field "name"`);
    } else if (seenNames.has(entry.name)) {
      errors.push(`${ref}: duplicate access name "${entry.name}"`);
    } else {
      seenNames.add(entry.name);
    }
    if (!isValidEnvVarName(entry.token_env)) {
      errors.push(`${ref}: "token_env" must be an environment variable name containing only letters, digits, and underscores`);
    } else if (entry.token_env === "MCP_HTTP_TOKEN") {
      errors.push(`${ref}: "token_env" must not be MCP_HTTP_TOKEN -- that is the unrestricted token`);
    } else if (seenEnvs.has(entry.token_env)) {
      errors.push(`${ref}: duplicate token_env "${entry.token_env}"`);
    } else {
      seenEnvs.add(entry.token_env);
    }
    if (!Array.isArray(entry.tools) || entry.tools.length === 0) {
      errors.push(`${ref}: "tools" must be a non-empty array of tool names`);
    } else {
      for (const t of entry.tools) {
        if (!toolNames.has(t)) errors.push(`${ref}: unknown tool "${t}"`);
      }
      if (new Set(entry.tools).size !== entry.tools.length) errors.push(`${ref}: "tools" lists a tool twice`);
    }
  }
}

// Builds the principals that may call the HTTP transport: the unrestricted MCP_HTTP_TOKEN
// (tools: null = every tool) plus one per `access` entry, restricted to its listed tools.
// Fails closed: an access entry whose token env var is unset, too short or a duplicate of any
// other token aborts startup instead of silently leaving that principal out or, worse, open.
export function resolvePrincipals(config, env = process.env) {
  const principals = [];
  const errors = [];
  if (env.MCP_HTTP_TOKEN) principals.push({ name: "admin", token: env.MCP_HTTP_TOKEN, tools: null });
  for (const entry of config.access ?? []) {
    const token = env[entry.token_env];
    if (!token) {
      errors.push(`access "${entry.name}": ${entry.token_env} is not set`);
      continue;
    }
    if (token.length < MIN_SCOPED_TOKEN_LENGTH) {
      errors.push(`access "${entry.name}": ${entry.token_env} must be at least ${MIN_SCOPED_TOKEN_LENGTH} characters`);
      continue;
    }
    principals.push({ name: entry.name, token, tools: new Set(entry.tools) });
  }
  const seen = new Set();
  for (const p of principals) {
    if (seen.has(p.token)) errors.push(`access "${p.name}": token is identical to another principal's token`);
    seen.add(p.token);
  }
  return { principals, errors };
}

// Checks every principal (no early exit) so response time does not reveal which one matched.
export function authenticate(authHeader, principals) {
  let match = null;
  for (const p of principals) {
    if (verifyBearerToken(authHeader, p.token) && match === null) match = p;
  }
  return match;
}

const VALID_OAUTH_KEYS = new Set(["issuer", "audience", "resource", "allowed_emails", "jwks_uri", "userinfo_uri", "tools"]);
const OAUTH_URL_KEYS = ["issuer", "resource", "jwks_uri", "userinfo_uri"];
const JWKS_TTL_MS = 10 * 60_000;
const JWKS_MIN_REFETCH_MS = 60_000;
const CLOCK_SKEW_S = 60;
const USERINFO_CACHE_MAX = 1000;

function isHttpsUrl(value) {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function validateOauth(config, errors) {
  const oauth = config.oauth;
  if (oauth === undefined || oauth === null) return;
  if (typeof oauth !== "object" || Array.isArray(oauth)) {
    errors.push('"oauth" must be an object');
    return;
  }
  for (const key of Object.keys(oauth)) {
    if (!VALID_OAUTH_KEYS.has(key)) errors.push(`oauth: has unsupported field "${key}"`);
  }
  for (const key of OAUTH_URL_KEYS) {
    const required = key === "issuer" || key === "resource";
    if (oauth[key] === undefined && !required) continue;
    if (!isHttpsUrl(oauth[key])) errors.push(`oauth: "${key}" must be an https URL`);
  }
  if (typeof oauth.audience !== "string" || !oauth.audience) errors.push('oauth: "audience" must be a non-empty string');
  if (!Array.isArray(oauth.allowed_emails) || oauth.allowed_emails.length === 0
    || !oauth.allowed_emails.every(e => typeof e === "string" && e.includes("@"))) {
    errors.push('oauth: "allowed_emails" must be a non-empty array of e-mail addresses');
  }
  if (oauth.tools !== undefined) {
    const toolNames = new Set((Array.isArray(config.tools) ? config.tools : []).map(t => t?.name));
    if (!Array.isArray(oauth.tools) || oauth.tools.length === 0) {
      errors.push('oauth: "tools" must be a non-empty array of tool names');
    } else {
      for (const t of oauth.tools) {
        if (!toolNames.has(t)) errors.push(`oauth: unknown tool "${t}"`);
      }
    }
  }
}

// RFC 9728 protected-resource metadata. Served unauthenticated so an MCP client can find
// the authorization server it should send the user to.
export function oauthResourceMetadata(oauth) {
  return {
    resource: oauth.resource,
    authorization_servers: [oauth.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "profile", "email"],
  };
}

// The well-known URL of that document for this resource (RFC 9728 section 3.1: the
// resource's path, if any, is appended after the well-known segment).
export function oauthResourceMetadataUrl(oauth) {
  const url = new URL(oauth.resource);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

function base64UrlJson(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

// Returns an async (authHeader) => principal | null that accepts an RS256 JWT access token
// from `oauth.issuer`: signature against its JWKS, iss, aud, exp/nbf, and the user's e-mail
// (from the token, else the userinfo endpoint) on `allowed_emails`. Never throws: any
// failure is a null (= 401), logged without the token.
export function createOauthVerifier(oauth, { fetchImpl = fetch, now = () => Date.now(), log = () => {} } = {}) {
  const issuer = oauth.issuer.replace(/\/$/, "");
  const jwksUri = oauth.jwks_uri ?? `${issuer}/.well-known/jwks.json`;
  const userinfoUri = oauth.userinfo_uri ?? null;
  const allowed = new Set(oauth.allowed_emails.map(e => e.toLowerCase()));
  const tools = oauth.tools ? new Set(oauth.tools) : null;
  let keys = new Map();
  let fetchedAt = 0;
  const emails = new Map();

  async function loadKeys() {
    // Stamped before the fetch, so a failing or slow JWKS is not refetched on every request.
    fetchedAt = now();
    const res = await fetchImpl(jwksUri, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`JWKS ${jwksUri} -> HTTP ${res.status}`);
    const body = await res.json();
    const next = new Map();
    for (const jwk of body.keys ?? []) {
      if (jwk.kty !== "RSA" || (jwk.use && jwk.use !== "sig") || !jwk.kid) continue;
      next.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
    }
    keys = next;
  }

  async function keyFor(kid) {
    const age = now() - fetchedAt;
    if (age > JWKS_TTL_MS || (!keys.has(kid) && age > JWKS_MIN_REFETCH_MS)) await loadKeys();
    return keys.get(kid) ?? null;
  }

  async function emailFor(token, claims) {
    if (typeof claims.email === "string") return claims.email;
    if (!userinfoUri) return null;
    const cacheKey = createHash("sha256").update(token).digest("hex");
    const cached = emails.get(cacheKey);
    if (cached) return cached.email;
    const res = await fetchImpl(userinfoUri, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`userinfo -> HTTP ${res.status}`);
    const info = await res.json();
    if (info.sub !== claims.sub) throw new Error("userinfo sub does not match the token");
    const email = typeof info.email === "string" ? info.email : null;
    if (emails.size >= USERINFO_CACHE_MAX) emails.clear();
    emails.set(cacheKey, { email });
    return email;
  }

  return async function verifyOauthToken(authHeader) {
    if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) return null;
    const token = authHeader.slice("Bearer ".length);
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    try {
      const header = base64UrlJson(parts[0]);
      const claims = base64UrlJson(parts[1]);
      if (header.alg !== "RS256") return null;
      const key = await keyFor(header.kid);
      if (!key) return null;
      const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
      if (!verifySignature("RSA-SHA256", signed, key, Buffer.from(parts[2], "base64url"))) return null;
      const nowS = now() / 1000;
      if (claims.iss !== issuer && claims.iss !== oauth.issuer) return null;
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!aud.includes(oauth.audience)) return null;
      if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < nowS) return null;
      if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_S > nowS) return null;
      const email = await emailFor(token, claims);
      if (!email || !allowed.has(email.toLowerCase())) {
        log(`oauth: sub=${claims.sub} is not an allowed user`);
        return null;
      }
      return { name: `oauth:${email.toLowerCase()}`, token: null, tools };
    } catch (err) {
      log(`oauth: token rejected (${err.message})`);
      return null;
    }
  };
}

export function validateConfig(config) {
  const errors = [];
  if (config.tools != null && !Array.isArray(config.tools)) {
    errors.push('"tools" must be an array');
    return errors;
  }
  validateAccess(config, errors);
  validateOauth(config, errors);
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
        ...(p.pattern !== undefined && { pattern: `^(?:${p.pattern})$` }),
        ...(p.maxLength !== undefined && { maxLength: p.maxLength }),
        ...(p.minimum !== undefined && { minimum: p.minimum }),
        ...(p.maximum !== undefined && { maximum: p.maximum }),
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
    let value;
    if (p.name in args && args[p.name] !== undefined) {
      value = args[p.name];
    } else if (p.default !== undefined) {
      value = p.default;
    } else {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(p.name, String(item));
      }
    } else {
      url.searchParams.set(p.name, toQueryString(value));
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

export async function callTool(toolConfig, args, options = {}) {
  const strict = options.strict === true || toolConfig.strict === true;
  if (Array.isArray(toolConfig.requests)) {
    if (strict) {
      const known = new Set(toolConfig.requests.flatMap(r => (r.params ?? []).map(p => p.name)));
      const unknown = Object.keys(args ?? {}).filter(k => !known.has(k));
      if (unknown.length > 0) {
        return { text: `Error: unknown argument(s): ${unknown.join(", ")}`, isError: true };
      }
    }
    return callCompositeTool(toolConfig, args);
  }
  return callSingleRequest(toolConfig, args, { ...options, strict });
}

function compileParamPattern(pattern) {
  return new RegExp(`^(?:${pattern})$`);
}

// The MCP SDK does not validate arguments against the advertised inputSchema, so anything a
// param declares (enum, pattern, maxLength, minimum, maximum) has to be enforced here or it is only a hint.
// `strict` additionally rejects unknown arguments and wrong types. Unknown arguments matter for
// GET tools: they are appended to the query string, so a caller could otherwise add a second
// `query=` next to one the config pinned in the URL.
// Returns an error message, or null when the arguments are acceptable.
export function validateArgs(params, args, { strict = false } = {}) {
  args = args ?? {};
  if (args === null || typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const byName = new Map((params ?? []).map(p => [p.name, p]));
  if (strict) {
    const unknown = Object.keys(args).filter(k => !byName.has(k));
    if (unknown.length > 0) return `unknown argument(s): ${unknown.join(", ")}`;
  }
  for (const [name, value] of Object.entries(args)) {
    const param = byName.get(name);
    if (!param || value === undefined) continue;
    if (strict && !isValidParamValueForType(value, param.type ?? "string")) {
      return `argument "${name}" must be of type ${param.type ?? "string"}`;
    }
    if (param.enum !== undefined && !param.enum.some(v => isDeepStrictEqual(v, value))) {
      return `argument "${name}" must be one of: ${param.enum.join(", ")}`;
    }
    if (param.pattern !== undefined && !compileParamPattern(param.pattern).test(String(value))) {
      return `argument "${name}" does not match the allowed pattern`;
    }
    if (param.maxLength !== undefined && String(value).length > param.maxLength) {
      return `argument "${name}" is longer than ${param.maxLength} characters`;
    }
    if (param.minimum !== undefined || param.maximum !== undefined) {
      // Non-strict tools may receive a numeric string; a value that is not a number at all
      // cannot be range-checked, so it fails rather than slipping past the bound.
      const n = typeof value === "number" ? value : (typeof value === "string" && value.trim() !== "" ? Number(value) : NaN);
      if (!Number.isFinite(n)) return `argument "${name}" must be a number`;
      if (param.minimum !== undefined && n < param.minimum) return `argument "${name}" must be >= ${param.minimum}`;
      if (param.maximum !== undefined && n > param.maximum) return `argument "${name}" must be <= ${param.maximum}`;
    }
  }
  if (strict) {
    for (const p of params ?? []) {
      if (p.required === true && args[p.name] === undefined) return `missing required argument "${p.name}"`;
    }
  }
  return null;
}

async function callSingleRequest(requestConfig, args, options = {}) {
  const invalid = validateArgs(requestConfig.params, args, options);
  if (invalid) return { text: `Error: ${invalid}`, isError: true };
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
