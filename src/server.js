// One MCP server: the shared tools (tools/shared.js) plus the tools of one
// product, added by `register` (gifos-meet-mcp or gifos-broadcast-mcp).
// Several servers may share one context: the HTTP transport makes a server
// per request over the same bot, stores and clock.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSharedTools } from './tools/shared.js';

export function createServer({ name, version, ctx, register }) {
  if (!name || !version) throw new Error('createServer needs a name and a version.');
  const server = new McpServer({ name, version });
  registerSharedTools(server, ctx, { name, version });
  if (typeof register === 'function') register(server, ctx);
  server.clock = ctx.clock;
  return server;
}
