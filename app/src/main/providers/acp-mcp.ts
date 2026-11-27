// The main agent's workspace tools for a CLI reached through ACP: offered as an MCP server in
// session/new's `mcpServers` (stdio, which every ACP agent takes). The CLI starts a tiny bridge
// script (this app's own runtime as node) that speaks MCP over its stdio and forwards each call to
// this process over 127.0.0.1 with a random token; the tools themselves run here, in the app.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { WorkspaceTool } from '../main-agent';

/** The MCP server's name: CLIs prefix its tools with it (OpenCode: `workspace_create_agent`). */
export const MCP_SERVER_NAME = 'workspace';

/** Told to the main agent: CLIs present MCP tools under their own names. */
export const MCP_TOOLS_NOTE = `Your workspace tools (list_workspace_agents, create_agent, send_to_agent and the others named above) are on the MCP server "${MCP_SERVER_NAME}"; your CLI may show them prefixed (e.g. ${MCP_SERVER_NAME}_create_agent, mcp_${MCP_SERVER_NAME}_create_agent) or as tools.${MCP_SERVER_NAME}.create_agent(...) in its code tool. They are not shell commands: never run them in a shell.`;

/** Told to a research's agent on a CLI reached through ACP: where its research tools are. */
export const RESEARCH_TOOLS_NOTE = 'Your research tools (research_overview, research_record, research_tell and the others named above) are on the MCP server "research"; your CLI may show them prefixed (e.g. research_research_overview, mcp_research_research_overview). They are not shell commands: never run them in a shell.';

/** A minimal MCP stdio server (initialize, tools/list, tools/call, ping), forwarding to the app. No dependencies. */
const BRIDGE = String.raw`'use strict';
const url = process.env.AMW_MCP_URL;
const token = process.env.AMW_MCP_TOKEN;
const out = (m) => process.stdout.write(JSON.stringify(Object.assign({ jsonrpc: '2.0' }, m)) + '\n');
async function call(path, body) {
  const r = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error('Agent Workspace answered ' + r.status);
  return r.json();
}
async function handle(m) {
  if (m.method === undefined || m.id === undefined) return; // responses and notifications
  try {
    if (m.method === 'initialize')
      return out({ id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agent-workspace', version: '1.0.0' } } });
    if (m.method === 'ping') return out({ id: m.id, result: {} });
    if (m.method === 'tools/list') return out({ id: m.id, result: { tools: await call('/tools') } });
    if (m.method === 'tools/call') {
      const r = await call('/call', { name: m.params && m.params.name, arguments: (m.params && m.params.arguments) || {} });
      return out({ id: m.id, result: { content: [{ type: 'text', text: String(r.text) }], isError: !!r.isError } });
    }
    out({ id: m.id, error: { code: -32601, message: 'Method not found: ' + m.method } });
  } catch (e) {
    out({ id: m.id, error: { code: -32603, message: String((e && e.message) || e) } });
  }
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { void handle(JSON.parse(line)); } catch { /* not JSON */ }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

/** The bridge script on disk (content-addressed, written once per version). */
export function bridgeScript(home = homedir()): string {
  // In the user's own folder (not a shared temp dir another account could have made first), private to them;
  // rewritten when its contents are not exactly ours.
  const dir = join(home, '.agent-workspace', 'bin');
  const file = join(dir, `mcp-bridge-${createHash('sha256').update(BRIDGE).digest('hex').slice(0, 12)}.cjs`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let same = false;
  try {
    same = readFileSync(file, 'utf8') === BRIDGE;
  } catch {
    /* not there yet */
  }
  if (!same) writeFileSync(file, BRIDGE, { mode: 0o600 });
  return file;
}

/** ACP's stdio MCP server entry. */
export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface McpBridge {
  server: AcpMcpServer;
  /** Names the CLI may give these tools (bare, or prefixed with the server's name). */
  owns(name: string): boolean;
  close(): void;
}

/** Serves `tools` over 127.0.0.1 with a random token: what a bridge forwards to. */
async function serveTools(tools: WorkspaceTool[]): Promise<{ port: number; token: string; owns: (name: string) => boolean; close: () => void }> {
  const token = randomBytes(24).toString('hex');
  const listed = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.schema) }));
  const http: Server = createServer((req, res) => {
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'unauthorized' });
    if (req.method === 'GET' && req.url === '/tools') return reply(200, listed);
    if (req.method !== 'POST' || req.url !== '/call') return reply(404, { error: 'not found' });
    let body = '';
    req.on('data', (d: Buffer) => {
      body += d.toString();
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', async () => {
      try {
        const { name, arguments: args } = JSON.parse(body) as { name: string; arguments: Record<string, unknown> };
        const tool = tools.find((t) => t.name === name);
        if (!tool) return reply(200, { text: `Unknown tool: ${name}`, isError: true });
        const parsed = tool.schema.safeParse(args ?? {});
        if (!parsed.success) return reply(200, { text: `Invalid arguments: ${parsed.error.message}`, isError: true });
        reply(200, { text: await tool.run(parsed.data as Record<string, unknown>) });
      } catch (error) {
        reply(200, { text: (error as Error).message || String(error), isError: true });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (http.address() as { port: number }).port;
  const names = new Set(tools.map((t) => t.name));
  return {
    port,
    token,
    owns: (name) => {
      const n = name.trim();
      for (const t of names) if (n === t || n.endsWith(`_${t}`) || n.endsWith(`__${t}`) || n.endsWith(`/${t}`) || n.endsWith(`.${t}`) || n.endsWith(`:${t}`)) return true;
      return false;
    },
    close: () => http.close(),
  };
}

/** Serves `tools` to a bridge the CLI starts; resolves once listening. */
export async function startMcpBridge(tools: WorkspaceTool[], opts: { node?: string; name?: string } = {}): Promise<McpBridge> {
  const served = await serveTools(tools);
  return {
    server: {
      name: opts.name ?? MCP_SERVER_NAME,
      command: opts.node ?? process.execPath,
      args: [bridgeScript()],
      env: [
        { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
        { name: 'AMW_MCP_URL', value: `http://127.0.0.1:${served.port}` },
        { name: 'AMW_MCP_TOKEN', value: served.token },
      ],
    },
    owns: served.owns,
    close: served.close,
  };
}

/** The same bridge in Python, for a CLI on an SSH host (where python3 is more often there than node). */
const PY_BRIDGE = String.raw`import json, os, sys, urllib.request
URL = os.environ['AMW_MCP_URL']
TOKEN = os.environ['AMW_MCP_TOKEN']
def out(m):
    m['jsonrpc'] = '2.0'
    sys.stdout.write(json.dumps(m) + '\n')
    sys.stdout.flush()
def call(path, body=None):
    req = urllib.request.Request(URL + path, data=None if body is None else json.dumps(body).encode(), headers={'authorization': 'Bearer ' + TOKEN, 'content-type': 'application/json'}, method='GET' if body is None else 'POST')
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.loads(r.read().decode())
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        m = json.loads(line)
    except Exception:
        continue
    if 'method' not in m or 'id' not in m:
        continue
    try:
        p = m.get('params') or {}
        if m['method'] == 'initialize':
            out({'id': m['id'], 'result': {'protocolVersion': p.get('protocolVersion') or '2025-06-18', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'agent-workspace', 'version': '1.0.0'}}})
        elif m['method'] == 'ping':
            out({'id': m['id'], 'result': {}})
        elif m['method'] == 'tools/list':
            out({'id': m['id'], 'result': {'tools': call('/tools')}})
        elif m['method'] == 'tools/call':
            r = call('/call', {'name': p.get('name'), 'arguments': p.get('arguments') or {}})
            out({'id': m['id'], 'result': {'content': [{'type': 'text', 'text': str(r.get('text'))}], 'isError': bool(r.get('isError'))}})
        else:
            out({'id': m['id'], 'error': {'code': -32601, 'message': 'Method not found: ' + str(m['method'])}})
    except Exception as e:
        out({'id': m['id'], 'error': {'code': -32603, 'message': str(e)}})
`;

/**
 * Tools served here to a CLI on `host`: the Python bridge is put there (content-addressed, in
 * ~/.agent-workspace/bin), and reaches this process through a tunnel on the shared SSH connection.
 */
export async function startRemoteBridge(host: string, tools: WorkspaceTool[], name: string): Promise<McpBridge> {
  const { sshForward, sshRunInput, sshError } = await import('../util/ssh');
  const served = await serveTools(tools);
  try {
    const file = `mcp-bridge-${createHash('sha256').update(PY_BRIDGE).digest('hex').slice(0, 12)}.py`;
    const put = await sshRunInput(host, `d="$HOME/.agent-workspace/bin"; mkdir -p "$d" && chmod 700 "$d" && cat > "$d/${file}" && echo "$d/${file}"`, Buffer.from(PY_BRIDGE));
    if (put.code !== 0) throw new Error(sshError(host, put.stderr));
    const path = put.stdout.trim().split('\n').pop()!;
    const tunnel = await sshForward(host, served.port);
    return {
      server: {
        name,
        command: 'python3',
        args: [path],
        env: [
          { name: 'AMW_MCP_URL', value: `http://127.0.0.1:${tunnel.remotePort}` },
          { name: 'AMW_MCP_TOKEN', value: served.token },
        ],
      },
      owns: served.owns,
      close: () => {
        tunnel.cancel();
        served.close();
      },
    };
  } catch (error) {
    served.close();
    throw error;
  }
}
