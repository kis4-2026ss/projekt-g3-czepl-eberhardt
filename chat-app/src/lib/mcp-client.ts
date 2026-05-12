import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export interface DirectusCreds {
  url:   string;
  token: string;
}

const MCP_URL = process.env.MCP_URL ?? 'http://localhost:3001/mcp';

export async function openMcp(creds?: DirectusCreds): Promise<Client> {
  const headers: Record<string, string> = {};
  if (creds) {
    headers['X-Directus-Url']   = creds.url;
    headers['X-Directus-Token'] = creds.token;
  }
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers },
  });
  const client = new Client({ name: 'mcp-console', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

export async function listTools(client: Client): Promise<McpTool[]> {
  const { tools } = await client.listTools();
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
  }));
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const res = await client.callTool({ name, arguments: args });
  const content = (res.content as Array<{ type: string; text?: string }> | undefined) ?? [];
  const text = content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
  return { text, isError: Boolean(res.isError) };
}
