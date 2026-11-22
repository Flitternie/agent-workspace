// The tools the app hands to a Claude session, as that session's MCP client sees them. One tool whose
// schema the SDK cannot turn into a listing (a z.record did this) leaves the whole server with no tools,
// silently: the agents then work without them. Every tool is listed here, through a real MCP client.
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { researchTools } from '../../src/main/research-tools';
import { workspaceTools } from '../../src/main/main-agent';
import type { WorkspaceTool } from '../../src/main/main-agent';

async function listed(tools: WorkspaceTool[]): Promise<string[]> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const server = sdk.createSdkMcpServer({ name: 'probe', version: '1.0.0', tools: tools.map((t) => sdk.tool(t.name, t.description, t.schema.shape, async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }))) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await (server as unknown as { instance: { connect: (t: unknown) => Promise<void> } }).instance.connect(a);
  const client = new Client({ name: 'probe', version: '1.0.0' });
  await client.connect(b);
  const r = await client.listTools();
  await client.close();
  return r.tools.map((t) => t.name).sort();
}

const fake = new Proxy({}, { get: () => () => undefined }) as never;

describe('tools as a Claude session lists them', () => {
  it('every research tool, for an agent of a research and for the main agent', async () => {
    for (const caller of [{ kind: 'agent' as const, taskId: 't' }, { kind: 'main' as const }]) {
      const tools = researchTools(fake, caller);
      expect(await listed(tools)).toEqual(tools.map((t) => t.name).sort());
    }
  });
  it('every workspace tool of the main agent', async () => {
    const tools = workspaceTools(fake);
    expect(await listed(tools)).toEqual(tools.map((t) => t.name).sort());
  });
});
