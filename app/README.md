# Agent Workspace — app

A meeting-style overview for parallel coding agents. Each Claude Code or Codex task is a card that reports what it did and what it needs from you. Requests stay on their card until they are answered. Global voice routes a spoken instruction to the right agent without moving your view, and typed text goes only to the agent you selected.

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
- **Agent names:** agents join with a name you can say out loud: Alice, Bob, Charlie… (Chinese UI: 小王, 小李, 小张…). The name is the handle; an optional role (e.g. "database") is shown next to it.
- **Voice (meeting-style):** the microphone is on from launch, like joining a call. Just talk: "Alice, add a regression test" / "小张，迁移先停一下". Each utterance appears as a caption at the bottom and goes to the agent it names, without changing your view. Click the mic button or press **⌘⇧A** to mute. Voice activity is detected on-device, so only speech segments are uploaded for transcription. Needs an OpenAI key, read from `OPENAI_API_KEY` or an `openai.key` file in this folder or a parent (currently `../openai.key`); `AMW_NO_OPENAI=1` disables it and `AMW_NO_AUTOLISTEN=1` starts muted. Without a key, everything else works, and the bar still accepts typed commands.
- Keys: **⌘1…9** focus an agent, **⌘0 / Esc** back to Overview.

## Isolation

- App state: `app/.data` (override with `AMW_DATA_DIR`). Electron's own profile is also under it.
- New tasks in a git repo get their own worktree under `app/.data/worktrees/…` on a branch `amw/<name>-<id>`. A worktree is removed only when it is clean and has no new commits.
- Not touched: `~/.claude`, `~/.codex`, repo `CLAUDE.md` / `AGENTS.md`, global npm and Electron caches. Provider sessions are stored by the providers themselves, as usual.

## Scripts

| Command | What |
|---|---|
| `npm test` | Unit tests: router matrix, attention lifecycle, stale events, approvals, restart, memory scoping, worktrees, content mapping, i18n coverage, voice composition, local STT post-processing |
| `npm run test:e2e` | Drives the built app with mock agents (demo script, settings, selection); screenshots in `test-results/` |
| `AMW_E2E_REAL=1 npm run test:e2e` | Also runs Claude Code + Codex through the app: worktrees, permission modes, native approval, steer/interrupt, restart + resume (small real model calls) |
| `AMW_E2E_VOICE=1 npm run test:e2e` | Always-on mic end to end: a WAV fixture plays as the microphone; spoken commands (incl. a leading "等一下") route to the named agents with no click |
| `AMW_E2E_LOCAL_STT=1 npm run test:e2e` | On-device speech recognition in Electron without an OpenAI key (needs SenseVoice in `app/.models`) |
| `npm run smoke:providers [claude\|codex]` | Adapter contract against the real CLIs: create, approve/deny, resume, discover |
| `npm run smoke:content [claude\|codex]` | Real CLIs edit a file and run a command; both adapters must emit the same diffs, terminal output and approval previews |
| `npm run smoke:voice` | TTS fixtures → STT → router (rules + LLM) against the OpenAI API |
| `npm run typecheck` | Strict TypeScript |

## Layout

```
src/main/                 Electron main = local backend
  workspace.ts            task/session registry, attention queue, dispatch, permission modes, memory, coordinator
  router.ts               voice routing (rules first, optional LLM, never auto-sends a guess)
  providers/              claude.ts (Agent SDK), codex.ts (app-server JSON-RPC), mock.ts
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
