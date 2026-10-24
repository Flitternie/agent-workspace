# Agent Meeting Workspace — v0.1

A meeting-style overview for parallel coding agents. Each Claude Code or Codex task is a card that reports what it did and what it needs from you. Requests stay on their card until they are answered. Global voice routes a spoken instruction to the right agent without moving your view, and typed text goes only to the agent you selected.

See `../SPIKE_REPORT.md` for why it is built this way and `../IMPLEMENTATION_LOG.md` for what was verified.

## Run

```bash
cd app
npm run setup        # installs deps; npm + Electron caches stay in app/.cache
npm start            # builds and launches the app
```

- **Try it without any accounts:** click **Load demo (mock agents)** on the empty Overview.
- **Real agents:** **+ New task** → choose a project folder → Claude Code or Codex. This uses your installed `claude` / `codex` and their existing logins. Nothing is auto-approved, and permission requests appear on the card.
- **Resume an old conversation:** **Resume session…** lists sessions the provider saved for that folder. This is a historical resume, not attaching to a process that is running in another terminal.
- **Voice:** click 🎙 or hold **⌥ Space**, then release. Needs an OpenAI key, read from `OPENAI_API_KEY` or an `openai.key` file in this folder or a parent (currently `../openai.key`). Without a key, everything else works, and the dock still accepts typed "speech".
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
| `npm run smoke:providers [claude\|codex]` | Adapter contract against the real CLIs: create, approve/deny, resume, discover |
| `npm run smoke:voice` | TTS fixture → STT → router (rules + LLM) against the OpenAI API |
| `npm run typecheck` | Strict TypeScript |

## Layout

```
src/main/        Electron main = local backend
  workspace.ts   task/session registry, attention queue, dispatch, memory, coordinator
  router.ts      voice routing (rules first, optional LLM, never auto-sends LLM guesses)
  providers/     claude.ts (Agent SDK), codex.ts (app-server JSON-RPC), mock.ts
  worktree.ts    per-task git worktrees
  openai.ts      STT + classifier (key stays in main)
src/preload/     narrow contextBridge (named, zod-validated channels only)
src/renderer/    React UI: Overview cards, Focus, voice dock, memory panel
```

Provider protocol handling was informed by Parallel Code (MIT, © Johannes Millan).
