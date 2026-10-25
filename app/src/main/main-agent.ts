// The main agent: a Claude Code or Codex session that talks with the user and runs
// the workspace through these tools (Claude: in-process MCP server; Codex: app-server
// dynamic tools). The tools run here, in the app; the main agent never edits code
// itself and cannot answer another agent's permission requests — that stays with the user.
import { z } from 'zod';
import type { AgentProvider, AttentionItem, Task } from '../shared/types';

export interface WorkspaceTool {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  run: (args: Record<string, unknown>) => Promise<string>;
}

/** What the tools need from the workspace (implemented by Workspace). */
export interface MainAgentHost {
  listAgents(): Array<{ task: Task; projectName: string; pending: string[]; connected: boolean }>;
  listProjects(): Array<{ projectId: string; name: string; rootPath: string }>;
  findAgent(name: string): Task | undefined;
  transcriptText(taskId: string, limit: number): string;
  sendFromMain(taskId: string, text: string, interrupt: boolean): Promise<{ ok: boolean; delivery?: string; error?: string }>;
  createFromMain(args: { projectId: string; provider: AgentProvider; title: string; instruction?: string; role?: string }): Promise<Task>;
  stopFromMain(taskId: string): Promise<void>;
  saveMemory(scope: 'project' | 'global', body: string, projectId?: string): void;
  availableProviders(): AgentProvider[];
  listRequests(): Array<{ item: AttentionItem; agent: string }>;
  answerFromMain(attentionId: string, args: { choice?: string; answer?: string; userWords?: string }): Promise<string>;
}

const agentArg = z.string().describe('The agent’s name, e.g. "Alice" or "小王" (case-insensitive). A role like "Database" also works when it is unique.');

export function workspaceTools(host: MainAgentHost): WorkspaceTool[] {
  const agent = (name: unknown): Task => {
    const t = host.findAgent(String(name ?? ''));
    if (!t) throw new Error(`No agent named "${String(name)}". Call list_agents to see the names.`);
    return t;
  };
  return [
    {
      name: 'list_agents',
      description:
        'List every coding agent in the workspace: name, role, provider, project, status (running / waiting_for_user / done / idle…), its latest report, and what it is waiting on from the user.',
      schema: z.object({}),
      run: async () => {
        const all = host.listAgents();
        if (!all.length) return 'There are no agents yet. Use create_agent to start one.';
        return all
          .map(({ task: t, projectName, pending, connected }) =>
            [
              `- ${t.alias}${t.name !== t.alias ? ` (role: ${t.name})` : ''} — ${t.provider}, project "${projectName}", status ${t.status}${connected ? '' : ' (not connected; resumes when messaged)'}`,
              `  task: ${t.title}`,
              `  latest: ${t.summary}`,
              ...(pending.length ? [`  waiting on the user: ${pending.join(' | ')}`] : []),
            ].join('\n'),
          )
          .join('\n');
      },
    },
    {
      name: 'read_agent',
      description: 'Read the recent conversation of one agent (its messages, tool calls with diffs and command output, and what the user said to it).',
      schema: z.object({ agent: agentArg, limit: z.number().int().min(1).max(80).optional().describe('How many recent items (default 25).') }),
      run: async (a) => {
        const t = agent(a.agent);
        return host.transcriptText(t.taskId, typeof a.limit === 'number' ? a.limit : 25) || `${t.alias} has no messages yet.`;
      },
    },
    {
      name: 'send_to_agent',
      description:
        'Send a message to one agent on the user’s behalf. If the agent is busy, the message joins its current work at the next step (steer); set interrupt=true only when the user wants it to stop what it is doing first. Write the message as clear instructions for that agent.',
      schema: z.object({ agent: agentArg, message: z.string().min(1), interrupt: z.boolean().optional() }),
      run: async (a) => {
        const t = agent(a.agent);
        const r = await host.sendFromMain(t.taskId, String(a.message), a.interrupt === true);
        if (!r.ok) return `Not delivered to ${t.alias}: ${r.error}`;
        return r.delivery === 'steer'
          ? `Added to ${t.alias}'s current work; it will read it at its next step.`
          : r.delivery === 'interrupt'
            ? `Stopped ${t.alias}'s current turn and sent the message.`
            : `Sent to ${t.alias}; it is working on it.`;
      },
    },
    {
      name: 'create_agent',
      description:
        'Start a new coding agent on a project (it gets its own git worktree) and give it its first instruction. Use list_projects for project ids. Only create one when no existing agent fits the work.',
      schema: z.object({
        project: z.string().describe('Project id or name from list_projects.'),
        title: z.string().min(1).describe('Short task title.'),
        instruction: z.string().min(1).describe('The first instruction for the new agent.'),
        provider: z.enum(['claude', 'codex']).optional().describe('Defaults to the first available.'),
        role: z.string().optional().describe('Optional one-word role, e.g. "Database".'),
      }),
      run: async (a) => {
        const projects = host.listProjects();
        const want = String(a.project).toLowerCase();
        const p = projects.find((x) => x.projectId.toLowerCase() === want || x.name.toLowerCase() === want);
        if (!p) return `Unknown project "${String(a.project)}". Known projects: ${projects.map((x) => `${x.name} (${x.projectId})`).join(', ') || 'none — ask the user to add a project folder first'}.`;
        const providers = host.availableProviders();
        const provider = (a.provider as AgentProvider | undefined) ?? providers[0];
        if (!provider || !providers.includes(provider)) return `Provider ${String(a.provider)} is not available here. Available: ${providers.join(', ') || 'none'}.`;
        const t = await host.createFromMain({ projectId: p.projectId, provider, title: String(a.title), instruction: String(a.instruction), role: a.role ? String(a.role) : undefined });
        return `Started ${t.alias} (${provider}) on ${p.name}: "${t.title}".`;
      },
    },
    {
      name: 'stop_agent',
      description: 'Interrupt an agent’s current turn (it stays in the workspace and can be messaged again).',
      schema: z.object({ agent: agentArg }),
      run: async (a) => {
        const t = agent(a.agent);
        await host.stopFromMain(t.taskId);
        return `Stopped ${t.alias}.`;
      },
    },
    {
      name: 'list_requests',
      description:
        'List what the agents are waiting on from the user: questions (with their options) and permission requests (with the allowed decisions). Each has a request_id for answer_request.',
      schema: z.object({}),
      run: async () => {
        const all = host.listRequests();
        if (!all.length) return 'No agent is waiting on the user.';
        return all
          .map(({ item: a, agent }) =>
            [
              `- request_id ${a.id} · ${agent} · ${a.kind === 'approval' ? 'PERMISSION REQUEST' : 'question'}: ${a.headline}`,
              ...(a.details && a.details !== a.headline ? [`  details: ${a.details.slice(0, 600)}`] : []),
              ...(a.options?.length ? [`  decisions: ${a.options.map((o) => `${o.id} = "${o.label}"`).join(', ')}`] : []),
              ...(a.questions ?? []).map((q) => `  question: ${q.question}${q.options.length ? ` — options: ${q.options.map((o) => o.label).join(' / ')}` : ''}`),
              ...(a.providerRequestId ? [] : ['  (asked in its reply: answer_request sends your answer to it as a message)']),
            ].join('\n'),
          )
          .join('\n');
      },
    },
    {
      name: 'answer_request',
      description:
        'Pass the user’s answer to an agent’s request. Questions: answer = the user’s answer (one line per question). Permission requests: choice = a decision id from list_requests; to allow anything you must quote, in user_words, the user’s own words from their latest message that approve it. Denying never needs a quote. Never decide a permission request on your own.',
      schema: z.object({
        request_id: z.string(),
        answer: z.string().optional(),
        choice: z.string().optional(),
        user_words: z.string().optional().describe('Verbatim quote from the user’s latest message approving this request.'),
      }),
      run: async (a) => host.answerFromMain(String(a.request_id), { answer: a.answer as string | undefined, choice: a.choice as string | undefined, userWords: a.user_words as string | undefined }),
    },
    {
      name: 'list_projects',
      description: 'List the project folders added to the workspace (id, name, path).',
      schema: z.object({}),
      run: async () => host.listProjects().map((p) => `- ${p.name} (id ${p.projectId}): ${p.rootPath}`).join('\n') || 'No projects yet; the user adds folders from the New task dialog.',
    },
    {
      name: 'save_memory',
      description: 'Save a durable note the user wants remembered (a convention or preference). Project notes load into new agent sessions on that project; global notes into every new session.',
      schema: z.object({ scope: z.enum(['project', 'global']), note: z.string().min(1), project: z.string().optional().describe('Project id or name (for scope=project).') }),
      run: async (a) => {
        let projectId: string | undefined;
        if (a.scope === 'project') {
          const want = String(a.project ?? '').toLowerCase();
          projectId = host.listProjects().find((x) => x.projectId.toLowerCase() === want || x.name.toLowerCase() === want)?.projectId;
          if (!projectId) return 'Which project? Pass project (see list_projects).';
        }
        host.saveMemory(a.scope as 'project' | 'global', String(a.note), projectId);
        return 'Saved.';
      },
    },
  ];
}

export const MAIN_AGENT_PROMPT = `You are the main agent of Agent Workspace: the user's single point of contact for a team of coding agents (Claude Code and Codex sessions), each working on its own task.

How to work:
- The user talks to you by voice or text, often briefly. Figure out what they want and get it done through your tools: list_agents and read_agent to see what is going on, send_to_agent to pass on instructions, create_agent for new work, stop_agent to halt one, save_memory for conventions.
- Do not write or edit code yourself and do not run project commands; delegate to the agent working on that task. You may read files to understand a question.
- When you forward an instruction, send it to the agent that owns that work, worded as a clear instruction. Say briefly what you did ("Sent to Charlie: …").
- When the user asks about status, call list_agents and answer in a few lines.
- If it is unclear which agent the user means, ask a short question instead of guessing.
- When agents wait on the user (call list_requests; the user may also just say "what do they need?"), tell the user plainly what each one asks and the choices, so they can decide here without opening the agent.
- Pass on the user's decisions with answer_request. For a permission request, only pass on approval the user has just given in their own words, and quote those words; never approve on your own judgment. If unsure, ask the user.
- Reply in the user's language, concisely.`;

/** Main-agent provider to use: the setting, else the first installed and signed-in CLI. */
export function pickMainProvider(setting: 'claude' | 'codex' | 'off' | undefined, ready: (p: 'claude' | 'codex') => boolean): 'claude' | 'codex' | undefined {
  if (setting === 'off') return undefined;
  if (setting) return ready(setting) ? setting : undefined;
  return (['claude', 'codex'] as const).find(ready);
}
