# Agent Workspace — app

A meeting-style overview for parallel coding agents. Each Claude Code, Codex or OpenCode task is a card that reports what it did and what it needs from you. Requests stay on their card until they are answered. Global voice routes a spoken instruction to the right agent without moving your view, and typed text goes only to the agent you selected.

## Run

```bash
cd app
npm run setup        # installs deps; npm + Electron caches stay in app/.cache
npm start            # the real workspace (data in app/.data)
npm run demo         # separate demo entry: three mock agents, data in app/.data-demo
```

Both also work from the repo root.

- **Real agents:** **+ New task** → choose a project folder → Claude Code, Codex or OpenCode. This uses your installed `claude` / `codex` / `opencode` and their existing logins; no extra authorization is needed. The empty Overview and **Settings** (bottom of the sidebar) show CLI availability, Claude/Codex login status (read-only `claude auth status` / `codex login status`) and setup instructions. Permissions follow the agent's selected mode; requests that need your decision appear on its card.
- **Remote machines (SSH):** **Settings › Remote machines** lets you add hosts from `~/.ssh/config` (**Add machine** searches them by alias, user or address); each added host shows whether SSH works without a prompt and whether Claude Code and Codex are installed and signed in there. Folders on those machines can then be added from **+ New task** (**Remote folder…**), and **Continue a session…** gets a source filter (all machines, this Mac, or one host) that also finds sessions the Claude and ChatGPT desktop apps started on that host over SSH. Agents run the CLIs installed on the host, with its login and settings, and their sessions stay there (Codex through `codex app-server` over SSH, Claude Code through the Agent SDK's `spawnClaudeCodeProcess` and a read-only SSH session store). Background checks never prompt; a locked key (**Unlock key…**, passphrase goes to `ssh-add` and the macOS Keychain), a password or 2FA login (**Log in…**) or a new host key (**Check and trust…**) is handled only when you click, through a native dialog, and the login is shared for a few hours through an OpenSSH control master. Worktrees are not created on remote folders yet.
- **Settings:** UI language (English / 中文; the first launch follows the system locale), open mic on launch, confirm every voice send, and where data is stored.
- **Demo:** `npm run demo` seeds three mock agents on first launch. Mock agents are only offered in the demo entry.
- **Resume an old conversation:** **Resume session…** lists sessions the provider saved for that folder. This is a historical resume, not attaching to a process that is running in another terminal.
- **Sub-agent sessions:** **Continue a session…** lists the sessions you or an app started (terminal, IDE, desktop apps, this app). Sessions an agent started for itself inside a task — `claude -p` and `codex exec` runs, Codex sub-agent threads — are hidden behind **Also show sub-agent sessions**; Claude Code's own Task sub-agents live inside their parent session and show there as steps.
- **Agent names:** agents join with a name you can say out loud: Alice, Bob, Charlie… (Chinese UI: 小王, 小李, 小张…). The name is the handle; an optional role (e.g. "database") is shown next to it.
- **Voice (meeting-style):** the microphone is on from launch, like joining a call. Just talk: "Alice, add a regression test" / "小张，迁移先停一下". Each utterance appears as a caption at the bottom and goes to the agent it names, without changing your view. Click the mic button or press **⌥Space** to mute. Prefer push to talk? Settings › Voice › Microphone switches to *Press to toggle* (press to start, press again to send), *Hold to talk* (send when you let go) or *Tap or hold*; the mic is then off the rest of the time, and the shortcut can be changed there (it works while the app is in front). Voice activity is detected on-device, so only speech segments are uploaded for transcription. Needs an OpenAI key, read from `OPENAI_API_KEY` or an `openai.key` file in this folder or a parent (currently `../openai.key`); `AMW_NO_OPENAI=1` disables it and `AMW_NO_AUTOLISTEN=1` starts muted. Without a key, everything else works, and the bar still accepts typed commands.
- Keys: **⌘1…9** focus an agent, **⌘0 / Esc** back to Overview.

## OpenCode

Install [OpenCode](https://opencode.ai/docs/), then configure a model in `opencode` (or use `opencode auth login`). Start the app with `npm start`, choose **New task → OpenCode**, and leave worktree isolation enabled. For a small first task, ask: `Create hello.txt containing Hello from OpenCode, then summarize what changed.` Open the task to see text, reasoning, tools and diffs. Answer permission requests and structured questions on the task card or in its conversation.

The adapter launches the installed `opencode serve` in the task's worktree on an authenticated loopback port. It detects the CLI version: 1.x uses the legacy [HTTP/SSE API](https://opencode.ai/docs/server/), while 2.x (including 2.2.5) uses `/api` routes, execution events and forms. The old SDK's `v2` namespace describes the 1.x wire format, not the 2.x server protocol. No SDK dependency or model credentials are added to the app. `~/.opencode/bin` is included in CLI detection, including launches from Finder. Missing or broken CLIs appear unavailable. Unexpected HTTP responses report the URL, status, content type and a bounded body preview.

OpenCode's **Decide automatically** matches its [native auto mode](https://opencode.ai/docs/permissions/#auto-mode): permission requests, including commands and configured `ask` rules, are approved unless a deny rule blocks them. It does not perform Claude/Codex-style risk review. The adapter replies once per request and never saves blanket allowances; explicit denies, private-folder restrictions and the native-subagent restriction remain in force. Questions still require your answer. **Allow file edits** asks before commands and external-directory access; **Ask every time** also asks before edits. Switching modes on the agent's page takes effect immediately and re-evaluates pending permissions. Settings controls the default for new agents.

In 2.x, a follow-up while busy steers the current work; explicit interruption stops the current turn first. In 1.x, every busy follow-up interrupts because its API lacks a steering acknowledgement. Stop/restart preserves the native session and restores its history when messaged again.

This integration is for local coding workers. The main agent can create one with `provider: "opencode"`; the main coordinator itself still runs on Claude Code or Codex. SSH and importing arbitrary external OpenCode sessions are not offered yet. Native OpenCode subagents (`task` in 1.x, `subagent` in 2.x) are disabled because they have separate permission policies and request streams; create additional workspace agents instead.

The main agent's tool list does not hot-reload when provider availability changes. Restart the app after installing OpenCode so the main agent gets the updated `create_agent` provider options; hot-reloading is tracked separately.

Validation commands (from the repository root):

```bash
npm test
npm run typecheck
npm --prefix app run build
npm --prefix app run smoke:providers -- opencode
AMW_E2E_OPENCODE=1 npm --prefix app run test:e2e -- opencode
```

The unit suite exercises real adapter/transport parsing and workspace lifecycle against a simulated CLI/HTTP boundary, including missing CLI detection, permissions, questions, interruption, errors and resume. The opt-in Electron test uses your real OpenCode model/login and makes small model calls in a temporary git repository.

## Isolation

- App state: `app/.data` (override with `AMW_DATA_DIR`). Electron's own profile is also under it.
- New tasks in a git repo get their own worktree under `app/.data/worktrees/…` on a branch `amw/<name>-<id>`. A worktree is removed only when it is clean and has no new commits.
- Not touched: `~/.claude`, `~/.codex`, repo `CLAUDE.md` / `AGENTS.md`, global npm and Electron caches. Provider sessions are stored by the providers themselves, as usual.
- SSH: connection-sharing sockets and the password-prompt helper live in `/tmp/amw-ssh-<uid>/`. Only when you click **Unlock key…** or **Check and trust…** does SSH itself add the key to your agent / Keychain or the host to `~/.ssh/known_hosts`; `~/.ssh/config` is only read.

## Scripts

| Command | What |
|---|---|
| `npm test` | Unit tests: router matrix, attention lifecycle, stale events, approvals, restart, memory scoping, worktrees, content mapping, i18n coverage, voice composition, local STT post-processing |
| `npm run test:e2e` | Drives the built app with mock agents (demo script, settings, selection); screenshots in `test-results/` |
| `AMW_E2E_SSH_HOST=<alias> npm run test:e2e -- ssh-remote` | Opt-in: Claude Code and Codex on that SSH host (scratch repo there, run, restart + resume, import remote sessions, no leftover processes) |
| `AMW_E2E_SSH_HOST=<alias> npm run test:e2e -- ssh-robust` | Opt-in: on that host, native approval (deny), steer and interrupt, the SSH connection dropping mid-session (next message resumes), and the app killed mid-turn (nothing left running) |
| `AMW_E2E_REAL=1 npm run test:e2e` | Also runs Claude Code + Codex through the app: worktrees, permission modes, native approval, steer/interrupt, restart + resume (small real model calls) |
| `AMW_E2E_VOICE=1 npm run test:e2e` | Always-on mic end to end: a WAV fixture plays as the microphone; spoken commands (incl. a leading "等一下") route to the named agents with no click |
| `AMW_E2E_LOCAL_STT=1 npm run test:e2e` | On-device speech recognition in Electron without an OpenAI key (needs SenseVoice in `app/.models`) |
| `npm run smoke:providers -- [claude\|codex\|opencode]` | Adapter contract against the real CLIs: create, approve/deny, resume, discover |
| `npm run smoke:content [claude\|codex]` | Real CLIs edit a file and run a command; both adapters must emit the same diffs, terminal output and approval previews |
| `npm run smoke:voice` | TTS fixtures → STT → router (rules + LLM) against the OpenAI API |
| `npm run typecheck` | Strict TypeScript |

## Layout

```
src/main/                 Electron main = local backend
  workspace.ts            task/session registry, attention queue, dispatch, permission modes, memory, coordinator
  router.ts               voice routing (rules first, optional LLM, never auto-sends a guess)
  providers/              claude.ts (Agent SDK), codex.ts (app-server JSON-RPC), opencode.ts (HTTP/SSE), mock.ts
    *-content.ts          provider output → unified content (diffs, terminal, plans, approvals)
    user-text.ts          strips harness markup from saved user turns
  stt/local.ts            on-device speech models (sherpa-onnx): catalogue, download, transcribe
  openai.ts               cloud STT + routing model (key stays in main)
  role.ts, attention.ts, memory.ts, store.ts, worktree.ts
src/shared/               types, zod-validated IPC schemas, ACP-shaped content model
src/preload/              narrow contextBridge (named channels only)
src/renderer/             React UI
  components/             Overview cards, Focus view, Settings page, voice dock, Markdown, dialogs
  voice/                  always-on listener (VAD) and pause/stop-word composition
  i18n.ts, locales/zh.ts  English + Simplified Chinese
src/smoke/                real-provider / real-API smoke scripts
tests/unit, tests/e2e     vitest + Playwright (Electron)
```

Provider protocol handling was informed by Parallel Code (MIT, © Johannes Millan). The unified content model follows the Agent Client Protocol and its claude-code-acp / codex-acp adapters (Apache-2.0, Zed Industries) and vibe-kanban's normalized logs (Apache-2.0, BloopAI); ideas only, no code copied.

Markdown rendering uses react-markdown, remark-gfm, remark-breaks and rehype-highlight (MIT). Its link/HTML safety rules follow Parallel Code's chat renderer (MIT); the library choice follows vibe-kanban (Apache-2.0). Only ideas were borrowed, no code.
