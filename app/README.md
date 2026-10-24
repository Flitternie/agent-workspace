# Agent Meeting Workspace — v0.1

A meeting-style overview for parallel coding agents. Each Claude Code or Codex task is a card that reports what it did and what it needs from you. Requests stay on their card until they are answered. Global voice routes a spoken instruction to the right agent without moving your view, and typed text goes only to the agent you selected.

See `../SPIKE_REPORT.md` for why it is built this way and `../IMPLEMENTATION_LOG.md` for what was verified.

## Run

```bash
cd app
npm run setup        # installs deps; npm + Electron caches stay in app/.cache
npm start            # the real workspace (data in app/.data)
npm run demo         # separate demo entry: three mock agents, data in app/.data-demo
```

Both also work from the repo root.

- **Real agents:** **+ New task** → choose a project folder → Claude Code or Codex. This uses your installed `claude` / `codex` and their existing logins; no extra authorization is needed. The empty Overview and **Settings** (bottom of the sidebar) show whether each CLI is installed and signed in (read-only `claude auth status` / `codex login status`) and how to sign in if not. Nothing is auto-approved, and permission requests appear on the card.
- **Settings:** UI language (English / 中文; the first launch follows the system locale), open mic on launch, confirm every voice send, and where data is stored.
- **Demo:** `npm run demo` seeds three mock agents on first launch. Mock agents are only offered in the demo entry.
- **Resume an old conversation:** **Resume session…** lists sessions the provider saved for that folder. This is a historical resume, not attaching to a process that is running in another terminal.
- **Voice (meeting-style):** the microphone is on from launch, like joining a call. Just talk: "Agent A, add a regression test". Each utterance appears as a caption at the bottom and goes to the agent it names, without changing your view. Click the mic button or press **⌘⇧A** to mute. Voice activity is detected on-device, so only speech segments are uploaded for transcription. Needs an OpenAI key, read from `OPENAI_API_KEY` or an `openai.key` file in this folder or a parent (currently `../openai.key`); `AMW_NO_OPENAI=1` disables it and `AMW_NO_AUTOLISTEN=1` starts muted. Without a key, everything else works, and the bar still accepts typed commands.
- Keys: **⌘1…9** focus an agent, **⌘0 / Esc** back to Overview.

## Isolation

- App state: `app/.data` (override with `AMW_DATA_DIR`). Electron's own profile is also under it.
- New tasks in a git repo get their own worktree under `app/.data/worktrees/…` on a branch `amw/<name>-<id>`. A worktree is removed only when it is clean and has no new commits.
- Not touched: `~/.claude`, `~/.codex`, repo `CLAUDE.md` / `AGENTS.md`, global npm and Electron caches. Provider sessions are stored by the providers themselves, as usual.

## Scripts

| Command | What |
|---|---|
| `npm test` | 27 unit tests (router matrix, attention lifecycle, stale events, approvals, restart, memory scoping, worktrees) |
| `npm run test:e2e` | Drives the built app through the spec's demo script with mock agents (screenshots in `test-results/`) |
| `AMW_E2E_REAL=1 npm run test:e2e` | Also runs Claude Code + Codex through the app (small real model calls) |
| `AMW_E2E_VOICE=1 npx vitest run --config vitest.e2e.config.ts tests/e2e/voice-live.test.ts` | Always-on mic end to end: a WAV fixture plays as the microphone (Chromium fake device), two spoken commands route to A and C with no click |
| `npm run smoke:providers [claude\|codex]` | Adapter contract against the real CLIs: create, approve/deny, resume, discover |
| `npm run smoke:content [claude\|codex]` | Real CLIs make a plan, create + edit a file and run a command; checks both adapters emit the same applied diffs, terminal output and approval previews |
| `npm run smoke:voice` | TTS fixture → STT → router (rules + LLM) against the OpenAI API |
| `npm run typecheck` | Strict TypeScript |

## Layout

```
src/main/        Electron main = local backend
  workspace.ts   task/session registry, attention queue, dispatch, memory, coordinator
  router.ts      voice routing (rules first, optional LLM, never auto-sends LLM guesses)
  providers/     claude.ts (Agent SDK), codex.ts (app-server JSON-RPC), mock.ts
                 claude-content.ts / codex-content.ts: provider output → unified content
src/shared/content.ts  ACP-shaped content model: tool kinds, diffs with hunks, terminal, plan, permission kinds
  worktree.ts    per-task git worktrees
  openai.ts      STT + classifier (key stays in main)
src/preload/     narrow contextBridge (named, zod-validated channels only)
src/renderer/    React UI: Overview cards, Focus, voice dock, memory panel
```

Provider protocol handling was informed by Parallel Code (MIT, © Johannes Millan). The unified content model follows the Agent Client Protocol and its claude-code-acp / codex-acp adapters (Apache-2.0, Zed Industries) and vibe-kanban's normalized logs (Apache-2.0, BloopAI); ideas only, no code copied.
