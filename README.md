# Agent Workspace

A desktop workspace for running several coding agents (Claude Code and Codex) in parallel, designed like a meeting rather than a set of terminals.

- **Overview as a meeting.** Every agent is a card that reports what it did and what it needs from you. Questions and permission requests stay on their card until you answer, however long you spend with another agent.
- **Talk to them.** The microphone stays open like a call. Say "Alice, add a regression test" or "小张，迁移先停一下" and it goes to that agent without changing your view. Short pauses join one message; a leading "stop / 等一下" halts the agent at once.
- **Steer or interrupt.** A message to a busy agent joins its current turn by default. ⌘Enter, or a spoken "stop", interrupts it and starts over.
- **Uses what you already have.** Agents run through the Claude Code and Codex CLIs installed on your Mac, with your existing logins. Permissions default to each tool's own auto mode (never bypassed), and can be set per agent.
- **Speech, cloud or local.** OpenAI transcription, or on-device models (SenseVoice, Whisper, Paraformer) that are downloaded on demand and never send audio anywhere.
- **Also:** per-task git worktrees, continuing existing Claude Code / Codex sessions from any folder, unified diff / terminal / plan rendering for both providers, Markdown, scoped memory, and English / 中文 UI.

## Run

Requirements: macOS (Apple Silicon tested), Node 22, and the `claude` and/or `codex` CLIs, signed in. An OpenAI key (`OPENAI_API_KEY`, or an `openai.key` file next to the app) is optional; without it, use a local speech model.

```bash
npm run setup   # installs into app/node_modules; npm and Electron caches stay in app/.cache
npm start       # the real workspace (data in app/.data)
npm run demo    # a separate demo with three mock agents (data in app/.data-demo)
```

Everything the app writes stays inside `app/` (data, worktrees, downloaded models, caches). It does not change `~/.claude`, `~/.codex` or any global configuration.

## Repository

The app (Electron + React + TypeScript) lives in `app/`. See [app/README.md](app/README.md) for scripts, tests, layout and third-party credits.
