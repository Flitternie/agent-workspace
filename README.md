<p align="center">
  <img src="app/build/icon.png" width="88" alt="Agent Workspace">
</p>

<h1 align="center">Agent Workspace</h1>

<p align="center">
  <b>English</b> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <b>Stop juggling tabs and terminals. Run a meeting with your agents.</b><br>
  A desktop app for managing parallel agents, side by side.
</p>

<p align="center">
  <a href="https://github.com/Flitternie/agent-workspace/releases/latest"><img src="https://badgen.net/github/tag/Flitternie/agent-workspace?label=download&color=2563eb" alt="Latest release"></a>
  <img src="https://badgen.net/badge/works%20with/Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20Antigravity%20%C2%B7%20OpenCode/d97757" alt="Works with Claude Code, Codex, Antigravity and OpenCode">
  <img src="https://badgen.net/badge/platform/macOS%20%C2%B7%20Windows/111" alt="macOS and Windows">
  <a href="LICENSE"><img src="https://badgen.net/badge/license/AGPL-3.0/16a34a" alt="AGPL-3.0"></a>
</p>

<p align="center">
  <a href="https://github.com/Flitternie/agent-workspace/releases/latest"><b>Download</b></a> ·
  <a href="#get-started">Get started</a> ·
  <a href="#faq">FAQ</a> ·
  <a href="app/README.md">Developer docs</a>
</p>

<p align="center">
  <img src="docs/assets/en/demo.webp" alt="A run through the app: agents at work, one asks a question and moves to the top, you answer it on its page beside its Session Map, then the main agent passes an instruction to everyone" width="900">
</p>

If you run several coding agents at once, you know how it goes: a dozen terminals, an agent that has been waiting on you for twenty minutes, and no easy way to see what each one already tried. Agent Workspace puts them all in one window, whichever CLI they run on: Claude Code, Codex, Antigravity or OpenCode.

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
- The note reaches every agent on this machine and on your servers, whatever CLI it uses. Running agents get it with their next message.
- Your own memory files stay yours. The app writes only its own marked section, after a backup.

## Also built in

- **Side column:** preview a file, ask a side question with `/btw`, or check what the agent remembers, all beside the conversation
- **Fork:** branch an agent from before any earlier message, into a new worktree
- **Remote machines:** run agents on your servers over SSH, with the CLIs and logins there
- **Remote Control:** pick an agent up on your phone, in the Claude app or, for Codex, the ChatGPT app
- **Images and files:** paste a screenshot, `@`-mention a file, or drop one in
- **`!` commands:** run a command in the agent's folder; it sees the output
- **Model per agent:** switch an agent's model from its header
- **Pick up a session:** continue a session you started in a terminal, with its full history

What each CLI supports:

| | Claude Code | Codex | Antigravity | OpenCode |
|---|:---:|:---:|:---:|:---:|
| Overview cards, permissions on the card | ✓ | ✓ | ✓ | ✓ |
| Runs the main agent | ✓ | ✓ | ✓ | ✓ |
| Session Map and Team Map | ✓ | ✓ | ✓ | ✓ |
| Fork | ✓ | ✓ | ✓ | ✓ |
| Side questions | ✓ | ✓ | ✓ | ✓ |
| Images and `@` files | ✓ | ✓ | ✓ | ✓ |
| Agents on SSH hosts | ✓ | ✓ | ✓ | ✓ |
| Continue existing sessions | ✓ | ✓ | ✓ | ✓ |
| Sub-agents shown | ✓ | ✓ | ✓ | ✓ |
| Remote Control from your phone | ✓ | ✓ | | |

Antigravity and OpenCode connect through the [Agent Client Protocol](https://agentclientprotocol.com), and each CLI's own commands cover the rest: sign-in, limits and forks.

## Get started

1. **Install a coding agent and sign in:** Claude Code, Codex, Antigravity or OpenCode, one or several. Agent Workspace uses your existing plan, with no extra account or API key; OpenCode's free models need no sign-in at all.
2. **Download** the [latest release](https://github.com/Flitternie/agent-workspace/releases/latest): the `.dmg` for macOS (Apple Silicon), or the `.exe` for Windows (x64, experimental).
3. **Open it**, add a project folder and start an agent, or just tell the main agent what you need.

> [!NOTE]
> The macOS app is not notarized yet. The first time, right-click it in Applications and choose **Open**. On Windows, if SmartScreen warns, choose **More info → Run anyway**.

## FAQ

<details>
<summary><b>Do I need another subscription or an API key?</b></summary>

No. The app drives the coding agents you already have, on your existing plan. An OpenAI key is only needed if you choose OpenAI for speech recognition.
</details>

<details>
<summary><b>How is this different from opening several terminals?</b></summary>

You see every agent on one screen, and whichever one is waiting on you moves to the top. You can give one instruction to the main agent instead of repeating it in each terminal, and the Work Map shows what each agent did without scrolling back through its conversation.
</details>

<details>
<summary><b>Does my code or conversation go through your servers?</b></summary>

No. There is no server of ours. Agents run through their own CLIs (`claude`, `codex`, `agy`, `opencode`) on your machine or on your own server over SSH, and the workspace data stays on your disk.
</details>

<details>
<summary><b>Can it approve things on my behalf?</b></summary>

No. Each agent follows the permission mode you choose for it, enforced by its CLI's own permission system, and nothing bypasses it. The main agent cannot approve another agent's request either.
</details>

<details>
<summary><b>Will it change my CLAUDE.md, AGENTS.md or GEMINI.md?</b></summary>

Only its own marked section, and only after a backup. What you wrote yourself is never changed. You can turn shared memory off in Settings.
</details>

<details>
<summary><b>Does audio leave my computer?</b></summary>

Only if you choose OpenAI for speech recognition. With an on-device model (SenseVoice, Whisper or Paraformer), audio stays on your machine. Voice is optional.
</details>

<details>
<summary><b>Does it work on Windows and Linux?</b></summary>

macOS on Apple Silicon is the main platform. There is a Windows x64 build, still experimental. There is no Linux build yet, though agents can run on Linux servers over SSH.
</details>

## Development

<details>
<summary><b>Build from source</b></summary>

Requirements: macOS (Apple Silicon tested), Node 22, and at least one of the `claude`, `codex`, `agy` or `opencode` CLIs.

```bash
npm run setup   # installs into app/node_modules
npm start       # the workspace
npm run demo    # a separate demo with mock agents
```

Scripts, tests, the code layout and releasing are in [app/README.md](app/README.md).

</details>

## License

[AGPL-3.0](LICENSE). Issues and pull requests are welcome.
