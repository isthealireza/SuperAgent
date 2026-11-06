import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--env-file-if-exists=.env', 'src/mcp-server.mjs'],
  cwd: process.cwd(),
});
const client = new Client({ name: 'superagent-mcp-smoke', version: '1.0.0' });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['get_task_status', 'start_task', 'status']);
  const status = await client.callTool({ name: 'status', arguments: {} });
  const details = JSON.parse(status.content[0].text);
  assert.equal(details.healthy, true, 'the Super Agent Router must be healthy');
  assert.equal(details.owner, process.env.GITHUB_OWNER ?? 'isthealireza');
  console.log(JSON.stringify({ tools: tools.map(tool => tool.name), status: details }, null, 2));
} finally {
  await client.close();
}
// The SDK can leave a referenced child-process stream alive after a clean MCP close.
process.exit(0);
