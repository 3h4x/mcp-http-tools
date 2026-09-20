#!/usr/bin/env node
import { createServer as createHttpServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, validateConfig, configToTools, callTool, resolvePrincipals, authenticate } from "./lib.js";

let config;
try {
  config = loadConfig({ argv: process.argv.slice(2) });
} catch (err) {
  process.stderr.write(`[mcp-http-tools] ${err.message}\n`);
  process.exit(1);
}
const configErrors = validateConfig(config);
if (configErrors.length > 0) {
  for (const e of configErrors) process.stderr.write(`[mcp-http-tools] config error: ${e}\n`);
  process.exit(1);
}
const toolConfigs = config.tools ?? [];
const mcpTools = configToTools(config);
const toolMap = new Map(toolConfigs.map(t => [t.name, t]));

// Builds a fresh MCP Server wired to the shared tool config. In stateless HTTP mode a new
// instance is created per request (mirroring the SDK's own stateless-transport example) because
// Server#connect() throws "Already connected to a transport" if reused before the prior
// transport's close() has unset it -- a real race under a single shared Server + StreamableHTTPServerTransport.
function createMcpServer(principal = null) {
  const server = new Server(
    { name: "mcp-http-tools", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );

  const allowed = principal?.tools ?? null;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allowed ? mcpTools.filter(t => allowed.has(t.name)) : mcpTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // A tool outside the principal's allowlist is indistinguishable from one that does not exist.
    const toolConfig = allowed && !allowed.has(name) ? undefined : toolMap.get(name);
    if (!toolConfig) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    if (principal) process.stderr.write(`[mcp-http-tools] call principal=${principal.name} tool=${name}\n`);
    const { text, isError } = await callTool(toolConfig, args, { strict: config.strict_args === true });
    return { content: [{ type: "text", text }], ...(isError && { isError: true }) };
  });

  return server;
}

if (process.argv.includes("--http")) {
  const port = Number(process.env.MCP_HTTP_PORT ?? 3000);
  if (!process.env.MCP_HTTP_TOKEN) {
    process.stderr.write("[mcp-http-tools] MCP_HTTP_TOKEN must be set to use --http\n");
    process.exit(1);
  }
  const { principals, errors: principalErrors } = resolvePrincipals(config);
  if (principalErrors.length > 0) {
    for (const e of principalErrors) process.stderr.write(`[mcp-http-tools] config error: ${e}\n`);
    process.exit(1);
  }

  const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
  const httpServer = createHttpServer(async (req, res) => {
    const principal = authenticate(req.headers.authorization, principals);
    if (!principal) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
      return;
    }
    const mcpServer = createMcpServer(principal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  });
  httpServer.listen(port, host, () => {
    process.stderr.write(`[mcp-http-tools] HTTP transport listening on ${host}:${port}/mcp\n`);
  });
} else {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
