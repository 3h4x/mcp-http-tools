#!/usr/bin/env node
/**
 * mcp-http-proxy
 * Generic MCP server — tools defined via YAML config, each maps to an HTTP request.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, validateConfig, configToTools, buildRequest, extractResponse } from "./lib.js";

const config = loadConfig();
const configErrors = validateConfig(config);
for (const e of configErrors) process.stderr.write(`[mcp-http-tools] config error: ${e}\n`);
const toolConfigs = config.tools ?? [];
const mcpTools = configToTools(config);
const toolMap = new Map(toolConfigs.map(t => [t.name, t]));

const server = new Server(
  { name: "mcp-http-tools", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: mcpTools,
}));

const DEFAULT_TIMEOUT_MS = 30_000;

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const toolConfig = toolMap.get(name);
  if (!toolConfig) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }

  const { url, options } = buildRequest(toolConfig, args ?? {});
  const timeout = toolConfig.timeout ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const raw = await res.text();
    const text = extractResponse(raw, toolConfig.response);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg = err.name === "AbortError" ? `Request timed out after ${timeout}ms` : err.message;
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
  } finally {
    clearTimeout(timer);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
