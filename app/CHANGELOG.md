# Changelog

Entries from v0.16.2 on are written by release-please from the Conventional Commit titles of merged pull requests (see CONTRIBUTING.md). Earlier releases: [GitHub releases](https://github.com/Flitternie/agent-workspace/releases).

## [0.17.0](https://github.com/Flitternie/agent-workspace/compare/v0.16.1...v0.17.0) (2026-11-28)


### Features

* **composer:** refer an agent to another agent's conversation ([#101](https://github.com/Flitternie/agent-workspace/issues/101)) ([041e6f4](https://github.com/Flitternie/agent-workspace/commit/041e6f444702436fe54766135c5d6e2d30ab70ea))


### Bug Fixes

* **agent-view:** keep following the end of the conversation while the agent works ([#100](https://github.com/Flitternie/agent-workspace/issues/100)) ([242b132](https://github.com/Flitternie/agent-workspace/commit/242b132e0601163bb4ff1a0d45c144990f14017a))
* **agent-view:** list a written file once in its tool row ([#99](https://github.com/Flitternie/agent-workspace/issues/99)) ([7a68386](https://github.com/Flitternie/agent-workspace/commit/7a68386cd0c83ac11f499504c9a1acdce710e3f0))

## [0.16.1](https://github.com/Flitternie/agent-workspace/compare/v0.16.0...v0.16.1) (2026-11-27)

### Features
- **Fork onto another CLI.** The fork dialog lets another installed coding agent continue the conversation, such as Claude Code to Codex or Codex to OpenCode; the new agent shows the conversation up to the chosen point right away. ([#96](https://github.com/Flitternie/agent-workspace/pull/96))
- **Fork from the sidebar.** Fork… is now in an agent's right-click menu in the sidebar. ([#96](https://github.com/Flitternie/agent-workspace/pull/96))

### Improvements
- **Own marks for OpenCode and Antigravity.** Both show their own marks wherever an agent's mark appears, Antigravity in its colours. ([#96](https://github.com/Flitternie/agent-workspace/pull/96))
- **Fresh model list.** The model picker reads the list again each time it opens, so a new plan or another sign-in shows up. ([#96](https://github.com/Flitternie/agent-workspace/pull/96))

## [0.16.0](https://github.com/Flitternie/agent-workspace/compare/v0.15.5...v0.16.0) (2026-11-27)

### Features
- **OpenCode and Antigravity.** OpenCode and Antigravity join Claude Code and Codex as coding agents, with streamed replies, tool calls, plans, images, `@` mentions, sub-agents, forks, side questions, model switching, imported past sessions and the main agent, locally and on SSH hosts. ([#93](https://github.com/Flitternie/agent-workspace/pull/93))
- **Sign in from the app.** OpenCode and Antigravity show their real sign-in state and can be signed in from the app, and Antigravity's quota appears in the limits. ([#93](https://github.com/Flitternie/agent-workspace/pull/93))
- **Remote Control for Codex.** Pair a Codex agent with the ChatGPT app on your phone by scanning a QR code or entering a code, and continue the conversation from there. ([#94](https://github.com/Flitternie/agent-workspace/pull/94))

### Improvements
- **Built for any coding agent.** Pickers, settings, onboarding and remote host rows adapt to however many coding agents you have installed. ([#93](https://github.com/Flitternie/agent-workspace/pull/93))
- **Chinese wording.** The Chinese interface now says "Agent" instead of "编码助手". ([#95](https://github.com/Flitternie/agent-workspace/pull/95))

### Bug Fixes
- **Empty Codex threads resume.** A Codex agent that never received a message now starts afresh after a restart instead of failing. ([#94](https://github.com/Flitternie/agent-workspace/pull/94))

## [0.15.5](https://github.com/Flitternie/agent-workspace/compare/v0.15.4...v0.15.5) (2026-11-26)

### Features
- **Chrome and Artifacts for Claude Code.** Claude Code agents can drive your Chrome through Claude in Chrome and publish Artifacts, as in the interactive CLI. ([#91](https://github.com/Flitternie/agent-workspace/pull/91))
- **Browser and computer use for Codex.** When a Codex agent asks to use an app such as Chrome, the request appears on its card for you to allow, once or for the session. ([#91](https://github.com/Flitternie/agent-workspace/pull/91))

### Improvements
- **Switches in Settings.** Each on/off option is a row with its name, a line on what it does and a switch. ([#91](https://github.com/Flitternie/agent-workspace/pull/91))

### Bug Fixes
- **Layout fixes.** The sub-agent page's scrollbar sits at the window's edge, and the remove button on image thumbnails is centred. ([#91](https://github.com/Flitternie/agent-workspace/pull/91))

## [0.15.4](https://github.com/Flitternie/agent-workspace/compare/v0.15.3...v0.15.4) (2026-11-26)

### Improvements
- **Automatic reconnect.** Agents on an SSH host reconnect by themselves after a dropped connection, showing "disconnected — reconnecting…" instead of an error to dismiss. ([#88](https://github.com/Flitternie/agent-workspace/pull/88))
- **Fewer error notes.** A host that needs a login or key raises one note rather than one per try, each agent shows only its latest error, and connection errors clear once the host is back. ([#88](https://github.com/Flitternie/agent-workspace/pull/88))
- **Instant model switch.** Switching a Claude Code agent's model takes effect right away. ([#88](https://github.com/Flitternie/agent-workspace/pull/88))

### Bug Fixes
- **No hanging remote agents.** A remote agent whose process disappears now notices and reconnects instead of hanging. ([#88](https://github.com/Flitternie/agent-workspace/pull/88))

## [0.15.3](https://github.com/Flitternie/agent-workspace/compare/v0.15.2...v0.15.3) (2026-11-24)

### Features
- **Remote agents survive dropped connections.** Agents on an SSH host keep running when your laptop sleeps or the network changes, and pick up where they were once the connection is back. ([#86](https://github.com/Flitternie/agent-workspace/pull/86))
- **Keep awake.** While any agent is working, the app keeps your computer from sleeping; turn it off under Settings › General. ([#86](https://github.com/Flitternie/agent-workspace/pull/86))
- **Advanced settings.** A new Settings › Advanced section lets you choose how many recent turns show in full, how tool details open, when agents move to idle, the main agent's limits and the `!` command timeout. ([#86](https://github.com/Flitternie/agent-workspace/pull/86))

### Improvements
- **Clearer account limits.** The sidebar lists plan accounts only, each with its provider's mark and its machine name, with bars aligned in columns. ([#86](https://github.com/Flitternie/agent-workspace/pull/86))
- **Smoother resizing.** The side column grows with the window, and resizing no longer redraws the conversation. ([#86](https://github.com/Flitternie/agent-workspace/pull/86))
- **"Local" instead of "This Mac".** Wording across the app now fits every platform. ([#86](https://github.com/Flitternie/agent-workspace/pull/86))

## [0.15.2](https://github.com/Flitternie/agent-workspace/compare/v0.15.1...v0.15.2) (2026-11-22)

### Features
- **Sync.** A new header button picks up what was said in a session elsewhere, such as the terminal or another Claude Code or Codex app, and replays it into the conversation. ([#84](https://github.com/Flitternie/agent-workspace/pull/84))

### Improvements
- **Header buttons in order of use.** The agent header is regrouped by how often each action is used, and the rarely useful Changes panel is gone; a change still opens from its row in the conversation. ([#84](https://github.com/Flitternie/agent-workspace/pull/84))
- **Simpler forking.** The fork dialog has no instruction box: forking back to before a message leaves that message in the fork's reply box to edit and send, and the fork opens as soon as it exists. ([#84](https://github.com/Flitternie/agent-workspace/pull/84))
- **Keep as memory.** Once a note is kept, a single row of buttons offers to tell idle agents now or dismiss. ([#84](https://github.com/Flitternie/agent-workspace/pull/84))

### Bug Fixes
- **Opens at the end.** Opening an agent always shows the end of its conversation, even after scrolling up in another agent. ([#84](https://github.com/Flitternie/agent-workspace/pull/84))
- **Session map styles restored.** The task fold caret and task details line look right again. ([#84](https://github.com/Flitternie/agent-workspace/pull/84))

## [0.15.1](https://github.com/Flitternie/agent-workspace/compare/v0.15.0...v0.15.1) (2026-11-21)

### Improvements
- **Session map grouping stands.** Tasks can no longer be merged by hand, since a merge could not be undone, and merges from earlier versions are cleared. ([#80](https://github.com/Flitternie/agent-workspace/pull/80))
- **Easier-to-spot messages.** Your own messages use a slightly darker grey, distinct from tables and code blocks in replies. ([#80](https://github.com/Flitternie/agent-workspace/pull/80))
- **Tidier account limits.** The sidebar shows only your plan's own usage windows, and the limits card adds the other known windows under clear names. ([#80](https://github.com/Flitternie/agent-workspace/pull/80))

### Bug Fixes
- **Bold text in Chinese.** Bold, italic and strikethrough that end on Chinese punctuation now render instead of showing literal asterisks. ([#80](https://github.com/Flitternie/agent-workspace/pull/80))
- **No overflowing limit lines.** Unrecognised usage windows no longer appear with raw names and overflow the sidebar. ([#80](https://github.com/Flitternie/agent-workspace/pull/80))

## [0.15.0](https://github.com/Flitternie/agent-workspace/compare/v0.14.0...v0.15.0) (2026-11-21)

### Features
- **Account limits in the sidebar.** The bottom of the sidebar shows each account's usage windows as short bars, with remote machines listed separately, folding to one line and highlighted when you get close. ([#78](https://github.com/Flitternie/agent-workspace/pull/78))
- **Drafts that stay.** Each agent keeps its unsent message, shared between its page and its overview tile and kept across restarts. ([#78](https://github.com/Flitternie/agent-workspace/pull/78))
- **Rename in place.** A right-click menu, the same everywhere, lets you rename agents, titles and projects in place, and copy messages. ([#78](https://github.com/Flitternie/agent-workspace/pull/78))

### Improvements
- **Current task in the sidebar.** Each agent row shows the task it is on from its session map, or "Waiting on you", instead of its latest message. ([#78](https://github.com/Flitternie/agent-workspace/pull/78))
- **Tokens and context at a glance.** The agent header shows the tokens used, with a breakdown on click, and the context used sits beside the reply box. ([#78](https://github.com/Flitternie/agent-workspace/pull/78))
- **Tidier sidebar and dialogs.** A history button next to "+" replaces the large "Continue a session…" button, agent names show their whole first line, and the new agent dialog drops the first-instruction box so you type straight into the agent's page. ([#78](https://github.com/Flitternie/agent-workspace/pull/78))
- **Calmer conversations.** Opening an agent's page connects its session quietly in the background, and tool output and earlier turns stay folded so the latest turn is what you see. ([#78](https://github.com/Flitternie/agent-workspace/pull/78))
- **Proper names from the start.** Agents created right after launch get a real name as soon as a model is available. ([#78](https://github.com/Flitternie/agent-workspace/pull/78))

### Other
- **AGPL-3.0 license.** Agent Workspace is now licensed under AGPL-3.0, with a new README in English and Chinese. ([#75](https://github.com/Flitternie/agent-workspace/pull/75))

## [0.14.0](https://github.com/Flitternie/agent-workspace/compare/v0.13.0...v0.14.0) (2026-11-19)

### Features
- **Images in messages.** Paste a screenshot, drop image files or use the image button next to the mic to send images to Claude Code and Codex agents, from an agent's page or its overview tile. Sent images appear in the conversation as thumbnails you can open large, and the main agent can pass them on to the agents it routes work to. ([#62](https://github.com/Flitternie/agent-workspace/pull/62))
- **@ file mentions.** Type `@` in an agent's message box to pick files and folders from its project, filtered as you type, locally or on an SSH host. Mentions show as chips in your messages, and dropping a file or folder onto the box inserts its path. ([#64](https://github.com/Flitternie/agent-workspace/pull/64))

### Improvements
- **Waiting on you, above the reply box.** On the main agent's page, pending requests now sit as one line right above the reply box and unfold into one row per request, where you can allow, deny or answer each. Replying while a request is unfolded tells the main agent which request your message answers. ([#65](https://github.com/Flitternie/agent-workspace/pull/65))
- **Cleaner session map outline.** The outline beside the conversation shows each task and its decisions, and a map opened in the side column stays there however you resize it. ([#66](https://github.com/Flitternie/agent-workspace/pull/66))
- **One click to the archive.** Opening Archived in the sidebar now lists every archived agent at once, grouped under its project. ([#67](https://github.com/Flitternie/agent-workspace/pull/67))

### Bug Fixes
- **No stuck resize cursor.** Resizing the side column no longer leaves the pointer stuck as a resize cursor. ([#66](https://github.com/Flitternie/agent-workspace/pull/66))
