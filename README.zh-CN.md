<p align="center">
  <img src="app/build/icon.png" width="88" alt="Agent Workspace">
</p>

<h1 align="center">Agent Workspace</h1>

<p align="center">
  <b>多开不乱，一眼看全。</b><br>
  一个桌面应用，把并行的多个 Agent 放在一起管理。
</p>

<p align="center">
  <a href="https://github.com/Flitternie/agent-workspace/releases/latest"><img src="https://img.shields.io/github/v/release/Flitternie/agent-workspace?label=%E4%B8%8B%E8%BD%BD&color=2563eb" alt="最新版本"></a>
  <img src="https://img.shields.io/badge/Claude%20Code-supported-d97757" alt="支持 Claude Code">
  <img src="https://img.shields.io/badge/Codex-supported-10a37f" alt="支持 Codex">
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon-111?logo=apple" alt="macOS">
  <img src="https://img.shields.io/badge/Windows-%E5%AE%9E%E9%AA%8C%E6%80%A7-555?logo=windows" alt="Windows（实验性）">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-16a34a" alt="AGPL-3.0"></a>
</p>

<p align="center">
  <a href="https://github.com/Flitternie/agent-workspace/releases/latest"><b>下载</b></a> ·
  <a href="README.md">English</a> ·
  <a href="app/README.md">开发文档</a>
</p>

<p align="center">
  <img src="docs/assets/zh/demo.webp" alt="应用演示：几个 Agent 在工作，其中一个提问后排到最前；点进去在它的会话地图旁边回答；最后主 Agent 把一条指令转给所有人" width="900">
</p>

同时开过几个 Claude Code 或 Codex 的人都知道：终端开了一堆，有个 Agent 已经等你二十分钟了你都不知道，它们之前试过什么也很难翻回去看。Agent Workspace 把它们放进一个窗口。

## 总览

**所有 Agent，一屏看完。**

- 每个 Agent 一张卡片：做了什么、在做什么、需要你做什么。
- 提问和权限请求连同改动内容一起留在卡片上，直到你处理。
- 在卡片上直接回复、批准或调整方向；每个 Agent 在自己的 git worktree 里工作。
- 卡片和侧边栏会自动排序：等你处理的排最前，其次是在干活的，最后是已完成的。

<p align="center">
  <img src="docs/assets/zh/overview.png" alt="应用里的总览：四个 Agent，其中一个在请求授权">
</p>

## 主 Agent

**说一次，主 Agent 帮你分下去。**

<p align="center">
  <img src="docs/assets/zh/team-map.png" alt="主 Agent 把指令转给几个 Agent，旁边是团队地图">
</p>

- 告诉主 Agent 你要什么，它会给对应的 Agent 交代清楚，必要时新建 Agent，或 fork 一个去试另一种方案。
- 问一句「大家进展怎么样？」，它按每个 Agent 当下在做的事回答。
- 麦克风可以像通话一样常开：「小张，迁移先停一下」直接交给小张，其余交给主 Agent。语音识别可以完全在本机完成。
- 它只负责协调，从不改代码，也不会自己批准任何权限请求。

## 工作地图（Work Map）

**几个小时的对话，不用从头翻。**

<p align="center">
  <img src="docs/assets/zh/session-map.png" alt="会话地图：按任务分段，带结果、决策点和 fork 分支">
</p>

- **会话地图（Session Map）：** 把 Agent 的对话画成一棵任务树，带每个任务的结果、过程中的决定，以及 fork 出去尝试其他方案的分支。点一下就跳到对应位置。
- **团队地图（Team Map）：** 在主 Agent 旁边，每个 Agent 一条线：什么交给了谁、各自进展如何。对话太长会自动分章，地图随之更新。

## 记忆

**教会一个 Agent，所有 Agent 都知道。**

- 在你说过的话上点「记住」，它会被提炼成一条笔记：记下的是你的要求，不是原话；可以只对这个项目生效，也可以对所有项目生效。
- 笔记会同步给所有 Agent：Claude Code 和 Codex，本机和你的服务器都有。正在运行的 Agent 下一条消息就能收到。
- 你自己的记忆文件不会被改：应用只写它自己带标记的那一段，而且会先备份。

## 内置的其他能力

- **对话旁的侧栏：** 预览文件、看这一轮改了什么、问旁支问题（`/btw`，不打断 Agent，也不进它的上下文）、查这个 Agent 记住了什么。
- **Fork：** 从之前任意一条消息之前分叉，进到新的 worktree。
- **远端服务器：** Agent 可以通过 SSH 跑在你的服务器上，用那里的 CLI 和登录。
- **图片和文件：** 粘贴截图、用 `@` 引用文件，或者直接拖进来。
- **`!` 命令和模型：** 在 Agent 的目录里直接跑命令，或者从下一轮起给它换模型。
- **接上已有会话：** 继续任何一个之前的 Claude Code 或 Codex 会话。

每项功能在两种 CLI 上都一样可用：

| | Claude Code | Codex |
|---|:---:|:---:|
| 总览卡片、卡片上处理权限 | ✓ | ✓ |
| 担任主 Agent | ✓ | ✓ |
| 会话地图与团队地图 | ✓ | ✓ |
| Fork | ✓ | ✓ |
| 旁支提问 | ✓ | ✓ |
| 图片与 `@` 文件 | ✓ | ✓ |
| 在 SSH 服务器上运行 | ✓ | ✓ |
| 接上已有会话 | ✓ | ✓ |

## 开始使用

1. **装好并登录 Claude Code 和/或 Codex。** Agent Workspace 直接使用它们和你现有的套餐，不需要额外的账号或 API key。
2. **下载**[最新版本](https://github.com/Flitternie/agent-workspace/releases/latest)：macOS（Apple Silicon）用 `.dmg`，Windows（x64，实验性）用 `.exe`。
3. **打开应用**，添加项目文件夹、新建 Agent；或者直接告诉主 Agent 你要做什么。

> [!NOTE]
> macOS 版还没有经过 Apple 公证，第一次打开请在「应用程序」里右键点击，选择「打开」。Windows 上如果 SmartScreen 提示，选择「更多信息 → 仍要运行」。

## 隐私

- **中间没有我们的服务器。** Agent 通过你机器或服务器上的 `claude` 和 `codex` CLI 运行，中间没有任何我们的服务器，工作区数据留在你的硬盘上。
- **权限按你设的来。** 权限遵循各 CLI 自己的模式，可按 Agent 单独设置，从不绕过。应用不改你的 CLI 设置；共享记忆只在先备份后，写入它自己标记的那一段。
- **语音可以只在本机。** 用你自己的 OpenAI key，或用本机模型（SenseVoice、Whisper、Paraformer），音频不会发送到任何地方。

<details>
<summary><b>从源码运行</b></summary>

需要：macOS（已在 Apple Silicon 上测试）、Node 22，以及 `claude` 和/或 `codex` CLI。

```bash
npm run setup   # 依赖装在 app/node_modules
npm start       # 启动工作区
npm run demo    # 独立的演示，用模拟 Agent
```

脚本、测试、代码结构和发版流程见 [app/README.md](app/README.md)。

</details>

## 许可证

[AGPL-3.0](LICENSE)。欢迎提 issue 和 PR。
