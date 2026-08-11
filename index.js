#!/usr/bin/env node
import { createServer as createHttpServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, validateConfig, configToTools, callTool, verifyBearerToken } from "./lib.js";

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
function createMcpServer() {
  const server = new Server(
    { name: "mcp-http-tools", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: mcpTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const toolConfig = toolMap.get(name);
    if (!toolConfig) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    const { text, isError } = await callTool(toolConfig, args);
    return { content: [{ type: "text", text }], ...(isError && { isError: true }) };
  });

  return server;
}

if (process.argv.includes("--http")) {
  const port = Number(process.env.MCP_HTTP_PORT ?? 3000);
  const token = process.env.MCP_HTTP_TOKEN;
  if (!token) {
    process.stderr.write("[mcp-http-tools] MCP_HTTP_TOKEN must be set to use --http\n");
    process.exit(1);
  }

  const httpServer = createHttpServer(async (req, res) => {
    if (!verifyBearerToken(req.headers.authorization, token)) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
      return;
    }
    const mcpServer = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  });
  httpServer.listen(port, "127.0.0.1", () => {
    process.stderr.write(`[mcp-http-tools] HTTP transport listening on 127.0.0.1:${port}/mcp\n`);
  });
} else {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
