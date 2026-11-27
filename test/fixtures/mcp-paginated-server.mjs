// Minimal stdio MCP server that splits tools/list and resources/list over two pages.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListResourcesRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'paged', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} } });
const tool = (name) => ({ name, inputSchema: { type: 'object' } });
const resource = (name) => ({ name, uri: `test://${name}` });

server.setRequestHandler(ListToolsRequestSchema, async (req) =>
  req.params?.cursor === 'page-2'
    ? { tools: [tool('second')] }
    : { tools: [tool('first')], nextCursor: 'page-2' });
server.setRequestHandler(ListResourcesRequestSchema, async (req) =>
  req.params?.cursor === 'page-2'
    ? { resources: [resource('beta')] }
    : { resources: [resource('alpha')], nextCursor: 'page-2' });

await server.connect(new StdioServerTransport());
