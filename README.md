<p align="center">
  <img src="app/build/icon.png" width="88" alt="Agent Workspace">
</p>

<h1 align="center">Agent Workspace</h1>

<p align="center">
  <b>Stop juggling tabs and terminals. Run a meeting with your agents.</b><br>
  A desktop app for managing parallel agents, side by side.
</p>

<p align="center">
  <a href="https://github.com/Flitternie/agent-workspace/releases/latest"><img src="https://img.shields.io/github/v/release/Flitternie/agent-workspace?label=download&color=2563eb" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/Claude%20Code-supported-d97757" alt="Claude Code supported">
  <img src="https://img.shields.io/badge/Codex-supported-10a37f" alt="Codex supported">
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon-111?logo=apple" alt="macOS">
  <img src="https://img.shields.io/badge/Windows-experimental-555?logo=windows" alt="Windows (experimental)">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-16a34a" alt="AGPL-3.0"></a>
</p>

<p align="center">
  <a href="https://github.com/Flitternie/agent-workspace/releases/latest"><b>Download</b></a> ·
  <a href="README.zh-CN.md">中文</a> ·
  <a href="app/README.md">Developer docs</a>
</p>

<p align="center">
  <img src="docs/assets/en/demo.webp" alt="A run through the app: agents at work, one asks a question and moves to the top, you answer it on its page beside its Session Map, then the main agent passes an instruction to everyone" width="900">
</p>

If you run several Claude Code or Codex sessions at once, you know how it goes: a dozen terminals, an agent that has been waiting on you for twenty minutes, and no easy way to see what each one already tried. Agent Workspace puts them all in one window.

## Overview

**See every agent at once.**

- Each agent is a card: what it did, what it is doing, what it needs from you.
- Questions and permission requests stay on the card, with the proposed change, until you answer.
- Reply, approve or redirect from the card. Each agent works in its own git worktree.
- Cards and the sidebar sort themselves: whatever waits on you comes first, then what is working, then what is done.

<p align="center">
  <img src="docs/assets/en/overview.png" alt="The Overview in the app: four agents, one asking for permission">
</p>

## Main agent

**Tell one agent. It tells the rest.**

<p align="center">
  <img src="docs/assets/en/team-map.png" alt="The main agent relaying instructions to three agents, with its Team Map">
</p>

- Tell the main agent what you need; it briefs the right agents, starts new ones, or forks one to try another approach.
- Ask "how is everyone doing?" and get an answer from what each agent is doing now.
- Keep the mic open like a call: "Alice, add a regression test" goes straight to Alice, everything else to the main agent. Speech recognition can run entirely on device.
- It coordinates, and never edits code or approves a permission request on its own.

## Work Map

**Read back a long session without scrolling through it.**

<p align="center">
  <img src="docs/assets/en/session-map.png" alt="A Session Map: tasks with outcomes, decisions and a fork">
</p>

- **Session Map:** an agent's conversation as a tree of tasks, with outcomes, the decisions along the way and the forks that tried something else. Click a task to jump there.
- **Team Map:** one lane per agent beside the main agent: what went to whom, and where each stands. Long conversations turn into chapters, and the map follows.

## Memory

**Teach one agent. All of them know.**

- Click **Remember** on something you said. It is turned into a note about how you want things done, not a copy of your words, for this project or for everything.
- The note reaches every agent: Claude Code and Codex, on this machine and on your servers. Running agents get it with their next message.
- Your own memory files stay yours. The app writes only its own marked section, after a backup.

## Also built in

- **A side column** beside each conversation: preview a file, see what changed this turn, ask a side question (`/btw`, which never interrupts the agent or enters its context), or check what the agent remembers.
- **Fork** from before any earlier message, into a new worktree.
- **Remote machines.** Agents run on your servers over SSH, with the CLIs and logins there.
- **Images and files.** Paste a screenshot, `@`-mention a file, or drop one in.
- **`!` commands and models.** Run a command in an agent's folder, or switch its model from the next turn.
- **Continue** any existing Claude Code or Codex session.

Every feature works the same with both CLIs:

| | Claude Code | Codex |
|---|:---:|:---:|
| Overview cards, permissions on the card | ✓ | ✓ |
| Runs the main agent | ✓ | ✓ |
| Session Map and Team Map | ✓ | ✓ |
| Fork | ✓ | ✓ |
| Side questions | ✓ | ✓ |
| Images and `@` files | ✓ | ✓ |
| Agents on SSH hosts | ✓ | ✓ |
| Continue existing sessions | ✓ | ✓ |

## Get started

1. **Install Claude Code and/or Codex** and sign in. Agent Workspace uses them, with your existing plan: no extra account or API key.
2. **Download** the [latest release](https://github.com/Flitternie/agent-workspace/releases/latest): the `.dmg` for macOS (Apple Silicon), or the `.exe` for Windows (x64, experimental).
3. **Open it**, add a project folder and start an agent, or just tell the main agent what you need.

> [!NOTE]
> The macOS app is not notarized yet. The first time, right-click it in Applications and choose **Open**. On Windows, if SmartScreen warns, choose **More info → Run anyway**.

## Privacy

- **No server in between.** Agents run through the `claude` and `codex` CLIs on your machine or your server. No server of ours sits in between, and your workspace stays on your disk.
- **Permissions as you set them.** Permissions follow each CLI's own modes, per agent, and are never bypassed. Your CLI settings are left alone; shared memory writes only to its own marked section, after a backup.
- **Voice can stay local.** Use OpenAI with your own key, or an on-device model (SenseVoice, Whisper, Paraformer) that sends no audio anywhere.

<details>
<summary><b>Build from source</b></summary>

Requirements: macOS (Apple Silicon tested), Node 22, and the `claude` and/or `codex` CLI.

```bash
npm run setup   # installs into app/node_modules
npm start       # the workspace
npm run demo    # a separate demo with mock agents
```

Scripts, tests, the code layout and releasing are in [app/README.md](app/README.md).

</details>

## License

[AGPL-3.0](LICENSE). Issues and pull requests are welcome.
