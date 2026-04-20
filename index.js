#!/usr/bin/env node
/**
 * mcp-http-tools
 * Generic MCP server — tools defined via YAML config, each maps to an HTTP request.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, validateConfig, configToTools, callTool } from "./lib.js";

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

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const toolConfig = toolMap.get(name);
  if (!toolConfig) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  const { text, isError } = await callTool(toolConfig, args);
  return { content: [{ type: "text", text }], ...(isError && { isError: true }) };
});

const transport = new StdioServerTransport();
await server.connect(transport);
