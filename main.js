// Agent Workspace — project page: language (English / 中文), reveals on scroll, and the lanes behind
// the page, drawn like the app's Team Map (one coloured lane per agent, branching and joining).

const ZH = {
  'nav.overview': '总览', 'nav.main': '主 Agent', 'nav.map': '工作地图', 'nav.start': '开始使用',
  'hero.eyebrow': '开源 · Claude Code + Codex',
  'hero.title': 'Agent 可以并行。<br><span class="grad">你不必串行。</span>',
  'hero.lede': 'Agent Workspace 是你的编程 Agent 的会议室：所有 Agent 坐在同一张桌前，一个主 Agent 统一调度，一张地图记下工作是怎么推进的。',
  'hero.download': '下载 macOS 版', 'hero.github': '在 GitHub 上查看',
  'hero.fine': '免费开源，直接使用你已有的 Claude Code 和 Codex。也提供 Windows 版（实验性）。',
  'float.needs': '待你处理', 'float.needsSub': '小王 · 修改 src/api/orders.ts', 'float.voice': '「小张，用并发索引。」', 'float.voiceTo': '已交给小张',
  'float.lane': '小李 · 已完成', 'float.laneSub': '营收卡片，测试通过',
  'float.voice2': '「大家进展怎么样？」', 'float.voice2To': '发给主 Agent',
  'works.label': '支持', 'works.ssh': 'SSH 服务器',
  'ov.kicker': '总览', 'ov.title': '所有 Agent 一目了然，没有被忽略的等待。',
  'ov.p1': '每个 Agent 一张卡片：做了什么、在做什么、需要你做什么。',
  'ov.p2': '提问和权限请求连同改动内容一起留在卡片上，直到你处理。',
  'ov.p3': '在卡片上直接回复、批准或调整方向；每个 Agent 在自己的 git worktree 里工作。',
  'card.a': '订单接口校验', 'card.needs': '待处理', 'card.aAsk': 'Claude Code 请求授权 · 修改 src/api/orders.ts',
  'card.allow': '允许', 'card.deny': '拒绝', 'card.b': '营收卡片', 'card.done': '已完成',
  'card.bDone': '营收卡片已显示与上周相比的变化，测试通过。', 'card.c': '订单历史索引', 'card.working': '运行中',
  'ma.kicker': '主 Agent', 'ma.title': '一个对话管住整个团队，打字或开口都行。',
  'ma.p1': '告诉主 Agent 你要什么，它会给对应的 Agent 交代清楚，必要时新建 Agent，或 fork 一个去试另一种方案。',
  'ma.p2': '问一句「大家进展怎么样？」，它按每个 Agent 当下在做的事回答。',
  'ma.p3': '麦克风可以像通话一样常开，点名就直接交给那个 Agent；语音识别可以完全在本机完成。',
  'ma.p4': '它只负责协调，从不改代码，也不会自己批准任何权限请求。',
  'wm.kicker': '工作地图', 'wm.title': '看清工作是怎么推进的。',
  'wm.lede': 'Agent 的长对话很难回头读。工作地图把它画出来：每个任务、每次决定、每条试过的分支。',
  'wm.s.title': '会话地图',
  'wm.s.text': '把 Agent 的对话画成一棵任务树，带每个任务的结果、过程中的决定，以及 fork 出去尝试其他方案的分支。点一下就跳到对应位置。',
  'wm.t.title': '团队地图',
  'wm.t.text': '在主 Agent 旁边，每个 Agent 一条线：什么交给了谁、各自进展如何。对话太长会自动分章，地图随之更新。',
  'more.title': '内置的其他能力。', 'more.lede': '让一支 Agent 团队真正能天天用起来的那些细节。',
  'm1.t': '旁支提问', 'm1.p': '用 /btw 问 Agent 关于这份工作的问题，它不用停下，也不会写进它的上下文。',
  'm2.t': 'Fork', 'm2.p': '从之前任意一条消息之前分叉到新的 worktree，对比不同方案。',
  'm3.t': '远端服务器', 'm3.p': 'Agent 通过 SSH 跑在你的服务器上，用那里已有的 CLI 和登录。',
  'm4.t': '图片和文件', 'm4.p': '粘贴截图、用 @ 引用文件，或者直接拖进来；主 Agent 也会帮你转交。',
  'm5.t': '共享记忆', 'm5.p': '你希望 Agent 知道的事，在 Claude Code、Codex 和你的多台机器之间共享。',
  'm6.t': '接上任何会话', 'm6.p': '在任意文件夹里继续之前的 Claude Code 或 Codex 会话，带完整历史。',
  'compat.title': '两种 CLI，同样的功能。',
  c1: '总览卡片、卡片上处理权限', c2: '担任主 Agent', c3: '会话地图与团队地图', c4: 'Fork', c5: '旁支提问', c6: '在 SSH 服务器上运行',
  'pv.title': '你的机器，你的 Agent，你的规则。',
  'pv1.t': '本地优先', 'pv1.p': 'Agent 通过你机器或服务器上的 claude 和 codex CLI 运行，中间没有任何我们的服务器。',
  'pv2.t': '权限不打折', 'pv2.p': '沿用各 CLI 自己的权限模式，可按 Agent 设置，从不绕过；也不改你的 CLI 设置。',
  'pv3.t': '声音只属于你', 'pv3.p': '用你自己的 OpenAI key，或用本机模型，音频不会发送到任何地方。',
  'st.title': '让你的 Agent 进同一间会议室。',
  'st1.t': '装好 Claude Code 或 Codex', 'st1.p': '并登录。用你现有的套餐就够了。',
  'st2.t': '下载 Agent Workspace', 'st2.p': 'macOS（Apple Silicon），或 Windows（实验性）。',
  'st3.t': '添加项目，开口说话', 'st3.p': '新建 Agent，或者直接告诉主 Agent 你要做什么。',
  'st.download': '下载最新版本', 'st.readme': '阅读 README',
  'st.fine': 'macOS 版还没有经过 Apple 公证：第一次打开请在「应用程序」里右键点击，选择「打开」。',
  'ft.releases': '版本发布',
};

Object.assign(ZH, {
  'ov.title': '所有 Agent 一目了然。',
  'ov.c0t': '每个 Agent 一张卡片。', 'ov.c0': '它在做什么，实时可见。',
  'ov.c1t': '需要你时，它在卡片上等。', 'ov.c1': '提问和权限请求连同改动一起留在那里，直到你处理。',
  'ov.c2t': '就地处理。', 'ov.c2': '不用点进去，直接批准、回复或调整方向。',
  'ov.c3t': '整个团队并排在一起。', 'ov.c3': 'Claude Code 和 Codex，各自在自己的 worktree 里。',
  'ov.c4t': '这就是总览。', 'ov.c4': '每个 Agent 都在这里汇报，没有被忽略的等待。',
  'card.planning': '规划校验逻辑', 'card.aDone': '已加上校验：空订单和非法数量会被拒绝。测试通过。', 'card.d': '营收迷你折线图',
  'ui.here': '在应用里',
  'ma.title': '一个对话管住整个团队。',
  'ma.c0t': '你要什么，说一次就够。', 'ma.c0': '打字，或者让麦克风像通话一样常开。',
  'ma.c1t': '它分别交代给每个 Agent。', 'ma.c1': '主 Agent 把你的话整理成清楚的指令，发给对应的 Agent。',
  'ma.c2t': '也可以直接点名。', 'ma.c2': '「小张，迁移先停一下」直接交给小张。',
  'ma.c3t': '随时问进展。', 'ma.c3': '它按每个 Agent 当下在做的事回答，自己从不改代码。',
  'ma.c4t': '都在一个对话里。', 'ma.c4': '主 Agent 就在侧边栏最上方，随时一点就到。',
  'ma.say': '帮我转达：小李，显示和上周的对比；小张，用并发索引；小刘，折线图别超过 40px。',
  'ma.hub': '主 Agent',
  'ma.r1': '在营收卡片上显示和上周相比的变化。', 'ma.r2': '订单历史的迁移用并发索引。', 'ma.r3': '迷你折线图控制在 40px 高以内。',
  'ma.direct': '「小张，迁移先停一下。」',
  'ma.q': '大家进展怎么样？', 'ma.s1': '在等你批准修改 orders.ts', 'ma.s2': '已完成：卡片显示了周同比', 'ma.s3': '正在写并发索引的迁移',
  'wm.c0t': '一段会话，变成一张地图。', 'wm.c0': '每个 Agent 的对话，按它做过的任务分好段。',
  'wm.c1t': '每个任务都有结果。', 'wm.c1': '做成了什么，花了多少工夫。',
  'wm.c2t': '还有背后的决定。', 'wm.c2': '为什么这样做，而不是另一种。',
  'wm.c3t': 'Fork 也留在地图上。', 'wm.c3': '尝试过别的方案的分支，一点就到。',
  'wm.c4t': '团队也有一张地图。', 'wm.c4': '在主 Agent 旁边，每个 Agent 一条线：什么交给了谁、各自到了哪一步。',
  'wm.c5t': '就在对话旁边。', 'wm.c5': '点一下任务，就跳到对应的位置。',
  'wm.n1': '在看板上加 RevenueCard', 'wm.n1m': '2 轮 · 2 个文件 · 测试通过', 'wm.n2': '导出订单 CSV', 'wm.n2m': '1 轮 · 1 个文件',
  'wm.n3': '加载骨架屏', 'wm.n3m': '1 轮 · 1 个文件', 'wm.forkTxt': '改试迷你折线图', 'wm.n4': '显示周同比变化',
  'wm.n4m': '营收卡片显示周同比，零营收也能正常显示', 'wm.d1': '按自然周比较，周一为一周开始', 'wm.d2': '总营收仍作为主数字',
  'n.a': '小王', 'n.b': '小李', 'n.c': '小张', 'n.d': '小刘',
  'wm.lane1': '完成', 'wm.lane2': '进行中', 'wm.lane3': '进行中',
});

Object.assign(ZH, {"hero.eyebrow": "开源 · 支持 Claude Code 和 Codex", "hero.title": "多开不乱，<br><span class=\"grad\">一眼看全。</span>", "hero.lede": "Claude Code 和 Codex 开得再多，谁在干活、谁在等你、每一步怎么走的，都在一个窗口里。", "hero.fine": "免费开源，用的就是你已经装好的 Claude Code 和 Codex。也有 Windows 版（实验性）。", "ov.title": "所有 Agent，一屏看完。", "ov.c0t": "每个 Agent 一张卡片", "ov.c0": "它在做什么，实时看得到。", "ov.c1t": "需要你时，它在卡片上等", "ov.c1": "问题或者改动会一直留着，你走开一小时回来也还在。", "ov.c2t": "直接在卡片上回", "ov.c2": "批准、回复、换个方向，都不用点进去。", "ov.c3t": "四个也好，十个也好", "ov.c3": "Claude Code 和 Codex 排在一起，各用各的 worktree。", "ov.c4t": "在应用里", "ov.c4": "打开应用，第一眼看到的就是总览。", "ma.title": "说一次，主 Agent 帮你分下去。", "ma.c0t": "说一次就行", "ma.c0": "打字，或者直接说出来。", "ma.c1t": "主 Agent 帮你拆开", "ma.c1": "每个 Agent 只收到跟它有关的那部分，写成清楚的指令。", "ma.c2t": "也可以直接点名", "ma.c2": "说出名字，就直接交给那个 Agent。", "ma.c3t": "随时问进展", "ma.c3": "它按每个 Agent 实际在做的事回答，自己从不碰代码。", "ma.c4t": "在应用里", "ma.c4": "主 Agent 就在侧边栏最上面。", "wm.title": "几个小时的对话，不用从头翻。", "wm.c0t": "对话变成一个个任务", "wm.c0": "长对话按 Agent 实际做过的事分好段。", "wm.c1t": "每个任务的结果", "wm.c1": "做成了什么，用了几轮、改了几个文件。", "wm.c2t": "还有为什么", "wm.c2": "过程中做的决定，跟着任务一起留着。", "wm.c3t": "试过又放弃的也在", "wm.c3": "fork 出去的方案是一条分支，点开就能看。", "wm.c4t": "主 Agent 也有一张", "wm.c4": "每个 Agent 一条线：什么交给了谁，现在到哪了。", "wm.c5t": "在应用里", "wm.c5": "地图就在对话旁边，点一下任务就跳过去。", "more.title": "还有这些，天天都会用到。", "more.lede": "同时跑不止一个 Agent 以后，这些会经常用。", "m1.p": "用 /btw 问 Agent 一句，它接着干活，这个问题也不会进它的上下文。", "m2.p": "从之前任意一条消息之前分出去，进新的 worktree，换个思路试试。", "m3.p": "Agent 可以通过 SSH 跑在你的服务器上，用那里装好的 CLI 和登录。", "m4.p": "粘贴截图、用 @ 引用文件，或者直接拖进来；主 Agent 也能帮你转交。", "m5.p": "想让 Agent 记住的事，在 Claude Code、Codex 和你的几台机器之间共享。", "m6.p": "在任意文件夹里接着之前的 Claude Code 或 Codex 会话，历史都在。", "compat.title": "Claude Code 和 Codex 都一样能用。", "pv.title": "在你的机器上跑，用你自己的账号。", "pv1.t": "中间没有我们的服务器", "pv1.p": "Agent 通过你机器或服务器上的 claude 和 codex CLI 运行，不经过我们。", "pv2.t": "权限按你设的来", "pv2.p": "沿用各 CLI 自己的权限模式，可以按 Agent 设，从不绕过；你的 CLI 设置也不动。", "pv3.t": "语音可以只在本机", "pv3.p": "用你自己的 OpenAI key，或者用本机模型，音频不出你的电脑。", "st.title": "用你现有的 Agent 试试。"});

Object.assign(ZH, {"hero.lede": "在一个窗口里，同时用 Claude Code 和 Codex。", "hero.fine": "免费开源 · 支持 macOS 和 Windows", "ov.title": "所有 Agent，一屏看完。", "ov.c0t": "每个 Agent 一张卡片", "ov.c0": "实时显示进度。", "ov.c1t": "需要你时，在卡片上等你", "ov.c1": "附带它要做的改动。", "ov.c2t": "就地处理", "ov.c2": "不用点进去。", "ov.c3t": "四个、十个都行", "ov.c3": "Claude Code 和 Codex 一起排开。", "ov.c4t": "在应用里", "ov.c4": "打开应用的第一屏。", "ma.title": "说一次，主 Agent 帮你分派。", "ma.c0t": "说一次就行", "ma.c0": "打字或语音。", "ma.c1t": "自动拆分", "ma.c1": "每个 Agent 只收到自己的部分。", "ma.c2t": "直接点名", "ma.c2": "直接交给对应的 Agent。", "ma.c3t": "随时问进展", "ma.c3": "按实际进度回答。", "ma.c4t": "在应用里", "ma.c4": "侧边栏最上方。", "wm.title": "几小时的对话，一张图看懂。", "wm.c0t": "按任务分段", "wm.c0": "不用再翻聊天记录。", "wm.c1t": "每个任务的结果", "wm.c1": "产出、轮数、文件。", "wm.c2t": "做决定的原因", "wm.c2": "过程中的取舍都留着。", "wm.c3t": "试过的方案", "wm.c3": "fork 显示为分支。", "wm.c4t": "整个团队", "wm.c4": "每个 Agent 一条线。", "wm.c5t": "在应用里", "wm.c5": "就在对话旁边。", "more.title": "其他功能", "more.lede": "", "m1.t": "旁支提问", "m1.p": "问一句，不打断它。", "m2.t": "Fork", "m2.p": "从任意一条消息换个方案。", "m3.t": "远端服务器", "m3.p": "通过 SSH 在服务器上运行。", "m4.t": "图片和文件", "m4.p": "截图、@ 文件、拖拽都行。", "m5.t": "共享记忆", "m5.p": "跨 CLI、跨机器同步。", "m6.t": "接上已有会话", "m6.p": "接着之前的会话继续。", "compat.title": "Claude Code 和 Codex 功能一致", "c1": "总览卡片与权限处理", "c2": "担任主 Agent", "c3": "工作地图", "c4": "Fork", "c5": "旁支提问", "c6": "SSH 远端运行", "pv.title": "默认在本地运行", "pv1.t": "不经过我们的服务器", "pv1.p": "Agent 在你的电脑或服务器上运行。", "pv2.t": "权限照旧", "pv2.p": "沿用 CLI 自己的设置，从不绕过。", "pv3.t": "本地语音", "pv3.p": "可选，音频不出你的电脑。", "st.title": "用你现有的 Agent 试试。", "st1.t": "安装 Claude Code 或 Codex", "st1.p": "用现有账号登录。", "st2.t": "下载 Agent Workspace", "st2.p": "macOS · Windows（测试版）", "st3.t": "添加项目", "st3.p": "新建 Agent，或直接问主 Agent。", "st.fine": "macOS 首次打开：右键点击应用 › 打开。", "card.aDone": "已加上校验，测试通过。"});

Object.assign(ZH, {"mu.btw": "/btw 这里为什么用 UTC？", "mu.sess": "修复结账跳转", "mu.sessMeta": "昨天 · 32 轮"});

Object.assign(ZH, {"hero.fine": "免费开源", "hero.downloadWin": "下载 Windows 版", "hero.github": "在 GitHub 上查看", "hero.ver": "最新版本"});

Object.assign(ZH, {"ma.title": "说一次，<br>主 Agent 帮你分派。", "ov.c5t": "自动排序", "ov.c5": "等你处理的排最前，其次是最活跃的。"});

Object.assign(ZH, {"works.agents": "Agent", "works.runs": "运行在", "works.ssh": "SSH 服务器"});

Object.assign(ZH, {"works.runs": "桌面应用", "works.remote": "Agent 也可运行在"});

Object.assign(ZH, {"works.remote": "Agent 运行在", "works.local": "本机"});

Object.assign(ZH, {"works.remote": "运行环境"});

Object.assign(ZH, {"hero.lede": "任务再多、Agent 再多，进度一眼看清，要紧的自动排在最前。"});

Object.assign(ZH, {"hero.kick": ""});

Object.assign(ZH, {"hero.lede": "每个 Agent 在做什么、哪个最急，打开就知道。"});

Object.assign(ZH, {"hero.lede": "每个 Agent 在做什么、哪个最急，一目了然。"});

Object.assign(ZH, {"hero.title": "多开不乱，<br><span class=\"grad\">一眼看全。</span>", "hero.prompt": ""});

Object.assign(ZH, {"hero.ask": "想修改 src/db/index.sql", "hero.sum": "4 个 Agent", "hero.say": "「小张，用并发索引。」"});

Object.assign(ZH, {"hero.prompt": "<span class=\"typed\">别再挨个切终端了。</span><span>一个窗口，全部管住。</span>"});

Object.assign(ZH, {"hero.prompt": "<span class=\"typed\">不用再挨个切终端了。</span><span>一个窗口，全部搞定。</span>"});

Object.assign(ZH, {"hero.msg": "主 Agent 发来新指令", "hm.n1": "读订单表结构", "hm.n2": "写迁移脚本", "hm.d1": "用并发索引，不锁表", "hm.n3": "试过部分索引", "hm.n4": "跑迁移测试", "hero.say": "告诉大家：提交前先跑测试。"});

Object.assign(ZH, {"hero.prompt": "<span class=\"typed\">不想在多个 Agent 窗口之间来回切？</span><span>一个窗口，全部搞定。</span>"});

Object.assign(ZH, {"hv.edit": "修改", "hv.run": "运行", "hv.write": "新建", "hv.plan": "计划", "hd.a": "已加上数量校验，正在写测试。", "hd.b": "已加上周同比，测试通过。", "hd.c": "表结构已读完，正在写索引。", "hd.d": "图表高度控制在 40px 以内。", "hs.needs": "待你处理", "n.e": "小陈", "n.f": "小周", "n.g": "小吴", "hero.sum": "7 个 Agent · 3 个项目"});

Object.assign(ZH, {"hero.prompt": "<span class=\"typed\">不想在多个 Agent 窗口之间来回切换？</span><span>一个窗口，全部搞定。</span>"});

Object.assign(ZH, {"hero.q": "用普通索引还是并发索引？", "hero.o1": "并发索引", "hero.o2": "普通索引", "hero.o3": "回复…"});

Object.assign(ZH, {"nav.mem": "记忆", "mm.kicker": "记忆", "mm.title": "教会一个 Agent，<br>所有 Agent 都知道。", "mm.c0t": "说一次就行", "mm.c0": "在你的消息上点「记住」。", "mm.c1t": "提炼成一条笔记", "mm.c1": "记下的是你的要求，不是原话。", "mm.c2t": "所有 Agent 都能用", "mm.c2": "Claude Code 和 Codex，每台机器都同步。", "mm.c3t": "你的文件不会被改", "mm.c3": "先备份，你自己写的内容一字不动。", "mm.you": "你", "mm.msg": "这里别用 default export，我们都按名字导入。", "mm.rem": "记住", "mm.nt": "优先使用具名导出", "mm.scope": "项目 · shop", "mm.nb": "这个代码库里用具名导出，按名字导入模块。", "mm.merge": "已与一条关于导入的旧笔记合并", "mm.bak": "已备份", "mm.ownk": "你的内容：一字未动", "mm.oursk": "我们的部分：一行带标记", "mu.btwA": "日志要跨服务器对比。"});

Object.assign(ZH, {"sc.t": "不离开对话，旁边就能看", "sc.p": "打开文件、看这一轮改了什么、问个旁支问题、查 Agent 记住了什么，都在对话旁边的侧栏里。", "sc.t0": "预览", "sc.t1": "改动", "sc.t2": "旁支提问", "sc.t3": "记忆", "sc.a": "这样各台服务器的日志才能对上。这个回答只留在侧栏，不进 Agent 的上下文。", "sc.run": "Agent 仍在工作", "sc.m2": "提交前先跑测试", "sc.m3": "用 pnpm，不用 npm", "m7.t": "! 命令", "m7.p": "在 Agent 的目录里直接跑命令，它能看到输出。", "m8.t": "每个 Agent 单独选模型", "m8.p": "从下一轮起切换模型。"});

Object.assign(ZH, {"hero.o3": "或输入你自己的答案", "tm.h": "团队地图", "cv.me": "给订单历史加个索引（按客户、最新在前）。", "cv.ai": "这张表很大、写入频繁。普通索引建的时候会锁写入；并发索引不锁，但更慢。"});

Object.assign(ZH, {"mv.m1": "给订单接口加上输入校验。", "mv.r1": "已经让小王去做了。", "mv.m2": "大家进展怎么样？", "mv.r2": "小李已经完成。小张刚才在等你选索引类型，你选了并发索引，它现在在写迁移。", "mv.r3": "已转给小王、小张和小刘。小李已经完成，不用再发。", "ln.to": "交给", "ln.new": "新建", "ln.wait": "在等你", "ln.done": "完成", "ln.working": "在干活", "ln.a1": "订单接口加校验", "ln.a2": "营收卡片显示周同比", "ln.a3": "订单历史加索引", "ln.a4": "折线图控制高度", "ln.a5": "提交前先跑测试"});

Object.assign(ZH, {"sm.t1": "读表结构和已有迁移", "sm.m1": "1 轮 · 2 条命令", "sm.o1": "orders 表有 210 万行，customer_id 上没有索引。", "sm.t2": "加订单历史索引", "sm.going": "进行中", "sm.m2": "2 轮 · 1 个文件", "sm.a1": "只给近期订单建部分索引", "sm.w1": "旧订单也要查", "sm.d1": "用并发索引", "sm.n1": "普通索引（会锁写入）"});

Object.assign(ZH, {"wm.n1": "在看板上加 RevenueCard", "wm.n1m": "2 轮 · 2 个文件", "wm.o1": "显示总营收，测试通过。", "wm.n2": "导出订单 CSV", "wm.n2m": "1 轮 · 1 个文件", "wm.n3": "加载骨架屏", "wm.n3m": "1 轮 · 1 个文件", "wm.n4": "显示周同比变化", "wm.n4m": "2 轮 · 3 个文件", "wm.at": "按最近 7 天对比", "wm.aw": "和周报对不上", "wm.d1": "按自然周，周一开始", "wm.nt": "滚动 7 天", "wl.1": "营收卡片", "wl.2": "订单历史加索引", "wl.3": "换成折线图试试", "wl.4": "折线图控制高度"});

Object.assign(ZH, {"hd.bw": "正在加周同比。", "hd.c": "表结构已读完，在看已有迁移。", "hd.c2": "按并发索引写迁移。", "cv.ph": "给小张发消息…", "mv.ph": "给主 Agent 发消息…"});

Object.assign(ZH, {"ov.mb": "已加上周同比，测试通过。", "ov.mc": "正在写索引迁移。", "ov.md": "用折线图还是柱状图？"});

Object.assign(ZH, {"cv.a1": "orders 表有 210 万行，customer_id 上没有索引。", "cv.a2": "历史页按客户筛选、按时间排序，建一个 (customer_id, created_at DESC) 的索引就够了。", "cv.m2": "好。建索引的时候会影响下单吗？", "cv.ai": "普通索引建的时候会锁写入；并发索引不锁，但更慢。", "sm.t3": "看历史页怎么查订单", "sm.m3": "1 轮 · 3 个文件", "sm.o3": "按客户筛选，按时间排序。", "sm.t4": "跑迁移测试", "sm.m4": "接下来"});

const EN = {};
document.querySelectorAll('[data-k]').forEach((el) => (EN[el.dataset.k] = el.innerHTML));

function setLang(lang) {
  const dict = lang === 'zh' ? ZH : EN;
  document.documentElement.dataset.lang = lang;
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-k]').forEach((el) => {
    const v = dict[el.dataset.k] ?? EN[el.dataset.k];
    if (v !== undefined) el.innerHTML = v;
  });
  document.querySelectorAll('img[data-shot]').forEach((img) => (img.src = `assets/${lang}/${img.dataset.shot}.png`));
  document.title = 'Agent Workspace';
  try { localStorage.setItem('lang', lang); } catch {}
}
const saved = (() => { try { return localStorage.getItem('lang'); } catch { return null; } })();
const fromUrl = new URLSearchParams(location.search).get('lang');
setLang(fromUrl || saved || (navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en'));
document.querySelector('.lang').addEventListener('click', () => setLang(document.documentElement.dataset.lang === 'zh' ? 'en' : 'zh'));

// Reveal on scroll; the hero's window settles flat when it comes in.
const io = new IntersectionObserver(
  (entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add('in'), io.unobserve(e.target))),
  { threshold: 0.15, rootMargin: '0px 0px -40px 0px' },
);
document.querySelectorAll('.reveal, .stage, .map-card').forEach((el) => io.observe(el));

// Stories advance with the scroll: the stage stays on screen for a short stretch (about a quarter
// of a screen per step), so the steps go by as the reader scrolls on, without waiting for anything.
// A caption scrolls to its step. Each element with data-at shows from that step on.
const stories = [...document.querySelectorAll('.story')];
const narrowMq = matchMedia('(max-width: 960px)');
function show(story, step) {
  if (story.dataset.step === String(step)) return;
  const steps = Number(story.dataset.steps);
  const caps = story.querySelectorAll('.caps li');
  story.dataset.step = String(step);

  story.querySelectorAll('[data-at]').forEach((el) => {
    const at = Number(el.dataset.at);
    if (el.closest('.caps')) el.classList.toggle('cur', at === Math.min(step, caps.length - 1));
    else el.classList.toggle('on', at <= step);
  });
}
function progress(story) {
  const r = story.getBoundingClientRect();
  return Math.min(1, Math.max(0, -r.top / Math.max(1, r.height - innerHeight)));
}
function updateStories() {
  for (const story of stories) {
    const steps = Number(story.dataset.steps);
    show(story, narrowMq.matches ? steps - 1 : Math.min(steps - 1, Math.floor(progress(story) * steps)));
  }
}
for (const story of stories)
  story.querySelectorAll('.caps li').forEach((li) =>
    li.addEventListener('click', () => {
      const steps = Number(story.dataset.steps);
      const span = story.offsetHeight - innerHeight;
      scrollTo({ top: story.offsetTop + (span * (Number(li.dataset.at) + 0.5)) / steps, behavior: 'smooth' });
    }),
  );
const sizeCards = () => document.querySelectorAll('.iso-cards').forEach((el) => el.style.setProperty('--stage-w', `${el.clientWidth}px`));
addEventListener('scroll', updateStories, { passive: true });
addEventListener('resize', () => { sizeCards(); stories.forEach((st) => delete st.dataset.step); updateStories(); });
sizeCards();
updateStories();

const nav = document.querySelector('.nav');
const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

// The lanes: soft coloured lines drifting across, now and then branching off and joining back,
// with a node travelling along each, as work moves along an agent's lane.
(function lanes() {
  const canvas = document.getElementById('lanes');
  const ctx = canvas.getContext('2d');
  const HUES = ['#6366f1', '#0ea5e9', '#14b8a6', '#f59e0b', '#ec4899', '#22c55e', '#8b5cf6', '#06b6d4'];
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w = 0, h = 0, dpr = 1, lines = [];
  function resize() {
    dpr = Math.min(2, devicePixelRatio || 1);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.max(5, Math.round(w / 180));
    lines = Array.from({ length: n }, (_, i) => ({
      x: ((i + 0.5) / n) * w + (Math.random() - 0.5) * 60,
      hue: HUES[i % HUES.length],
      amp: 18 + Math.random() * 40,
      freq: 0.0016 + Math.random() * 0.0016,
      phase: Math.random() * Math.PI * 2,
      speed: 0.00012 + Math.random() * 0.00016,
      branch: Math.random() < 0.5 ? { at: 0.2 + Math.random() * 0.4, len: 0.18 + Math.random() * 0.2, dir: Math.random() < 0.5 ? -1 : 1 } : null,
      dot: Math.random(),
    }));
  }
  const xAt = (l, y, t) => l.x + Math.sin(y * l.freq + l.phase + t * l.speed * 6) * l.amp;
  function frame(t) {
    ctx.clearRect(0, 0, w, h);
    for (const l of lines) {
      ctx.strokeStyle = l.hue; ctx.globalAlpha = 0.28; ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let y = -10; y <= h + 10; y += 12) { const x = xAt(l, y, t); y < 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      ctx.stroke();
      if (l.branch) {
        // A fork: leaves the lane, runs beside it, and joins back.
        const y0 = l.branch.at * h, y1 = (l.branch.at + l.branch.len) * h, off = 46 * l.branch.dir;
        ctx.globalAlpha = 0.2; ctx.beginPath();
        for (let y = y0; y <= y1; y += 8) {
          const k = (y - y0) / (y1 - y0);
          const bend = Math.sin(k * Math.PI);
          const x = xAt(l, y, t) + off * Math.min(1, bend * 1.6);
          y === y0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      const p = (l.dot + t * l.speed) % 1;
      const y = p * (h + 40) - 20, x = xAt(l, y, t);
      ctx.globalAlpha = 0.9; ctx.fillStyle = l.hue;
      ctx.shadowColor = l.hue; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
    if (!still) requestAnimationFrame(frame);
  }
  addEventListener('resize', resize);
  resize();
  requestAnimationFrame(frame);
})();

// Download buttons go straight to the latest release's installers (their names carry the version);
// without the API (offline, rate limit) they stay on the releases page.
fetch('https://api.github.com/repos/Flitternie/agent-workspace/releases/latest')
  .then((r) => (r.ok ? r.json() : null))
  .then((rel) => {
    if (!rel) return;
    const asset = (re) => rel.assets?.find((a) => re.test(a.name))?.browser_download_url;
    const mac = asset(/\.dmg$/i), win = asset(/\.exe$/i);
    if (mac) document.querySelector('[data-dl="mac"]').href = mac;
    if (win) document.querySelector('[data-dl="win"]').href = win;
  })
  .catch(() => {});

// The hero prompt: both lines type out on first view; then the first one keeps retyping what people
// are tired of, one thing after another. The cursor sits on the line being typed.
(function typeLines() {
  const LINES = {
    en: ['Stop juggling tabs and terminals.', 'Stop juggling Claude Code and Codex.', 'Stop checking which agent is stuck.', 'Stop scrolling back to see what changed.', 'Stop repeating yourself to every agent.'],
    zh: ['不想在多个 Agent 窗口之间来回切换？', '想让 Claude Code 和 Codex 在同一个窗口里干活？', '想快速知道哪个 Agent 卡住了？', '想一眼看到每个 Agent 做过哪些改动？', '想一句话通知所有 Agent？'],
  };
  const KEEP = { en: 5, zh: 0 };
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const lang = () => document.documentElement.dataset.lang;
  const speed = () => (lang() === 'zh' ? 80 : 38) + Math.random() * 40;
  let run = 0;
  async function type(el, text, from, id) {
    for (let n = from + 1; n <= text.length; n++) {
      if (id !== run) return false;
      el.textContent = text.slice(0, n);
      await wait(speed());
    }
    return true;
  }
  async function start() {
    const id = ++run;
    const spans = document.querySelectorAll('.prompt span');
    if (spans.length < 2 || !LINES[lang()]) return;
    const [first, second] = spans;
    // As wide as the longest line, so a line never wraps and the block never shifts.
    const probe = first.cloneNode();
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
    first.parentNode.appendChild(probe);
    let widest = 0;
    for (const t of [...LINES[lang()], second.textContent]) { probe.textContent = t; widest = Math.max(widest, probe.getBoundingClientRect().width); }
    probe.remove();
    first.parentNode.style.width = `${Math.ceil(widest) + 24}px`;
    const firstText = first.textContent, secondText = second.textContent;
    if (still) return;
    first.textContent = ''; second.textContent = '';
    first.classList.add('caret'); second.classList.remove('caret');
    await wait(500);
    dispatchEvent(new CustomEvent('amw:pain', { detail: 0 }));
    if (!(await type(first, firstText, 0, id))) return;
    await wait(250);
    first.classList.remove('caret'); second.classList.add('caret');
    if (!(await type(second, secondText, 0, id))) return;
    await wait(700);
    second.classList.remove('caret'); first.classList.add('caret');
    let i = 0;
    for (;;) {
      await wait(2600);
      if (id !== run) return;
      const l = lang(), lines = LINES[l];
      const from = first.textContent;
      for (let n = from.length; n > KEEP[l]; n--) {
        if (id !== run) return;
        first.textContent = from.slice(0, n - 1);
        await wait(l === 'zh' ? 45 : 22);
      }
      i = (i + 1) % lines.length;
      dispatchEvent(new CustomEvent('amw:pain', { detail: i }));
      if (!(await type(first, lines[i], KEEP[l], id))) return;
    }
  }
  start();
  // A language switch rewrites the lines: type them again.
  document.querySelector('.lang').addEventListener('click', () => setTimeout(start, 0));
})();


// The main agent's Team Map, drawn the way the app draws it (MainLanes): time runs down; your messages
// on a grey lane at the left; a hand-off curves into that agent's lane (its own colour); waiting is a
// diamond, done a small circle; each lane ends with a square and how that agent is doing now.
function drawLanes(box, rows, lanes) {
  const T = (k, en) => (document.documentElement.dataset.lang === 'zh' ? ZH[k] : en) ?? en;
  const STEP = 14, PAD = 9, ROW = 26, mid = ROW / 2;
  const x = (l) => PAD + l * STEP;
  const width = PAD + lanes.length * STEP + PAD;
  const span = lanes.map((_, k) => { const idx = rows.map((r, n) => (r.lane === k + 1 ? n : -1)).filter((n) => n >= 0); return [idx[0], idx[idx.length - 1]]; });
  const lastMain = rows.reduce((a, r, n) => (r.kind === 'ask' || r.kind === 'send' || r.kind === 'new' ? n : a), -1);
  box.querySelector('.lanes-legend').innerHTML = lanes.map((l) => `<span class="lane-chip" style="--lane:${l.c}"><span class="lane-dot"></span>${T(l.k, l.n)}</span>`).join('');
  box.querySelector('.lanes-rows').innerHTML = rows.map((r, n) => {
    const l = lanes[r.lane - 1], c = r.lane ? l.c : '#9aa3ae';
    let g = '';
    // Your lane runs down to the last hand-off, so every curve leaves from it (one message can go to several agents).
    if (n < lastMain) g += `<line x1="${x(0)}" y1="${n === 0 ? mid : 0}" x2="${x(0)}" y2="${ROW}" stroke="#9aa3ae" stroke-width="1.5"/>`;
    else if (n === lastMain && r.kind === 'ask') g += `<line x1="${x(0)}" y1="${n === 0 ? mid : 0}" x2="${x(0)}" y2="${mid}" stroke="#9aa3ae" stroke-width="1.5"/>`;
    lanes.forEach((ln, k) => { const [a, b] = span[k]; if (a === undefined || n < a || n > b) return; g += `<line x1="${x(k + 1)}" y1="${n === a ? mid : 0}" x2="${x(k + 1)}" y2="${n === b ? mid : ROW}" stroke="${ln.c}" stroke-width="2"/>`; });
    if (r.kind === 'send' || r.kind === 'new') g += `<path d="M ${x(0)} 0 C ${x(0)} ${mid} ${x(r.lane)} 0 ${x(r.lane)} ${mid}" fill="none" stroke="${c}" stroke-width="2"/>`;
    if (r.kind === 'ask') g += `<circle cx="${x(0)}" cy="${mid}" r="4" fill="#fff" stroke="#6b7280" stroke-width="1.5"/>`;
    else if (r.kind === 'wait') g += `<rect x="${x(r.lane) - 4}" y="${mid - 4}" width="8" height="8" transform="rotate(45 ${x(r.lane)} ${mid})" fill="#fff" stroke="${c}" stroke-width="2"/>`;
    else if (r.kind === 'settled') g += `<circle cx="${x(r.lane)}" cy="${mid}" r="3" fill="#fff" stroke="${c}" stroke-width="1.5"/>`;
    else if (r.kind === 'out') g += `<rect x="${x(r.lane) - 3.5}" y="${mid - 3.5}" width="7" height="7" rx="1.5" fill="${c}"/>`;
    else g += `<circle cx="${x(r.lane)}" cy="${mid}" r="4.5" fill="${c}" stroke="${c}" stroke-width="1.5"/>`;
    const verb = { send: T('ln.to', 'to'), new: T('ln.new', 'new'), wait: T('ln.wait', 'waiting on you'), settled: T('ln.done', 'done'), out: r.st === 'd' ? T('ln.done', 'done') : T('ln.working', 'working') }[r.kind];
    const label = r.kind === 'ask' ? `<span class="lanes-label lask"><span class="truncate">${T(r.k, r.t)}</span></span>` : `<span class="lanes-label${r.kind === 'out' ? ' outcome' : ''}"><span class="lanes-verb${r.kind === 'out' ? ` st-${r.st}` : ''}">${verb}</span><span class="lanes-alias" style="--lane:${c}">${T(l.k, l.n)}</span></span>`;
    return `<li class="lanes-row${r.fresh ? ' fresh' : ''}"><svg width="${width}" height="${ROW}" class="lanes-svg">${g}</svg>${label}</li>`;
  }).join('');
}
const LANES = [{ k: 'n.a', n: 'Alice', c: '#6366f1' }, { k: 'n.b', n: 'Bob', c: '#0ea5e9' }, { k: 'n.c', n: 'Charlie', c: '#14b8a6' }, { k: 'n.d', n: 'Diana', c: '#f59e0b' }];
const LANE_ROWS = [
  { kind: 'ask', k: 'ln.a1', t: 'Orders API checks' }, { kind: 'new', lane: 1 },
  { kind: 'ask', k: 'ln.a2', t: 'Weekly change on revenue' }, { kind: 'new', lane: 2 },
  { kind: 'ask', k: 'ln.a3', t: 'Index for order history' }, { kind: 'new', lane: 3 },
  { kind: 'ask', k: 'ln.a4', t: 'Keep the chart short' }, { kind: 'new', lane: 4 },
  { kind: 'settled', lane: 2 },
];
const LANE_BROADCAST = [{ kind: 'ask', k: 'ln.a5', t: 'Run tests before committing', fresh: true }, { kind: 'send', lane: 1, fresh: true }, { kind: 'send', lane: 3, fresh: true }, { kind: 'send', lane: 4, fresh: true }];
const laneOutcomes = () => [{ kind: 'out', lane: 1, st: 'w' }, { kind: 'out', lane: 2, st: 'd' }, { kind: 'out', lane: 3, st: 'w' }, { kind: 'out', lane: 4, st: 'w' }];

// The hero app plays one continuous run of a workday, on a loop: agents work across projects; one
// finishes and drops down; another asks a question, jumps to the top (cards and sidebar) and is
// answered on its card; its Work Map opens to show what it did, decision included; then the main
// agent tells everyone something at once.
(function heroApp() {
  const app = document.querySelector('.hero-app');
  if (!app) return;
  const grid = app.querySelector('.ha-grid');
  const card = (id) => grid.querySelector(`[data-id="${id}"]`);
  const SLOTS = [[0, 0], [1, 0], [0, 1], [1, 1]];
  const slotOf = new Map();
  const place = (order, instant) => {
    const movers = order.filter((id, i) => slotOf.get(id) !== i);
    const apply = () => order.forEach((id, i) => { slotOf.set(id, i); const c = card(id); c.style.setProperty('--x', SLOTS[i][0]); c.style.setProperty('--y', SLOTS[i][1]); c.classList.remove('swap'); });
    if (instant || !movers.length || movers.length === order.length && !slotOf.size) return apply();
    movers.forEach((id) => card(id).classList.add('swap'));
    setTimeout(apply, 220);
  };
  const side = app.querySelector('.ha-side');
  const RANK = { n: 0, w: 1, i: 2, d: 3 };
  const rankOf = (el) => RANK[el.dataset.st] ?? 1;
  // The sidebar orders itself like the app: in each project, who needs you first, then who is
  // working, then idle and done; projects by their most urgent agent. Moves are animated (FLIP).
  const sortSide = () => {
    const items = [...side.querySelectorAll('.hs-proj, .hs-row')];
    const before = new Map(items.map((el) => [el, el.getBoundingClientRect().top]));
    const projs = [...side.querySelectorAll('.hs-proj')];
    for (const p of projs) {
      const rows = [...p.querySelectorAll('.hs-row')];
      rows.sort((x, y) => rankOf(x) - rankOf(y) || x.dataset.home - y.dataset.home).forEach((r) => p.appendChild(r));
      p.dataset.rank = Math.min(...rows.map(rankOf));
    }
    projs.sort((x, y) => x.dataset.rank - y.dataset.rank || x.dataset.home - y.dataset.home).forEach((p) => side.appendChild(p));
    const moved = new Map(items.map((el) => [el, before.get(el) - el.getBoundingClientRect().top]));
    for (const el of items) {
      const parent = el.classList.contains('hs-row') ? el.closest('.hs-proj') : null;
      const dy = moved.get(el) - (parent ? moved.get(parent) : 0);
      if (!dy) continue;
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => requestAnimationFrame(() => { el.style.transition = 'transform 0.6s cubic-bezier(0.2, 0.7, 0.2, 1)'; el.style.transform = ''; }));
    }
  };
  side.querySelectorAll('.hs-proj').forEach((p, i) => (p.dataset.home = i));
  side.querySelectorAll('.hs-row').forEach((r, i) => (r.dataset.home = i));
  const set = (id, st, pct) => {
    const c = card(id); c.dataset.st = st; if (pct != null) c.querySelector('.hc-bar i').style.width = pct + '%';
    const r = side.querySelector(`.hs-row[data-id="${id}"]`);
    if (r) { r.dataset.st = st; sortSide(); }
  };
  const mode = (m) => (app.dataset.scene = m);
  const view = (v) => (app.dataset.view = v);
  const ask = () => app.querySelector('.ha-agent .cv-ask');
  const cursorTo = (el) => {
    const cur = app.querySelector('.ha-cursor'), box = cur.offsetParent.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (!r.width) return; // nothing to point at (the sidebar is hidden on a phone)
    cur.style.transform = `translate(${r.left - box.left + r.width * 0.55}px, ${r.top - box.top + r.height * 0.4}px)`;
    app.classList.add('cursor-on');
  };
  const click = () => { app.classList.add('clicking'); setTimeout(() => app.classList.remove('clicking'), 260); };
  const reset = () => {
    mode('0'); view('overview'); app.classList.remove('cursor-on', 'answered', 'team', 'said'); ask().classList.remove('picked');
    drawLanes(app.querySelector('.mv-lanes'), [...LANE_ROWS, ...laneOutcomes()], LANES);
    side.querySelector('.hs-row.act')?.classList.remove('act');
    place(['a', 'b', 'c', 'd'], true);
    set('a', 'w', 40); set('b', 'w', 75); set('c', 'w', 30); set('d', 'w', 55);
  };
  // One continuous run: work goes on; Bob finishes; Charlie asks (top of its card, sidebar on top);
  // you open Charlie: its conversation and Session Map, the question with its options; you pick one
  // and it goes on; back on the Overview the Team Map shows everyone, and the main agent tells them all.
  const timeline = [
    [900, () => { set('a', 'w', 55); set('b', 'w', 92); set('c', 'w', 45); set('d', 'w', 70); }],
    [2400, () => { set('b', 'd', 100); place(['a', 'c', 'd', 'b']); }],
    [3800, () => { set('c', 'n'); place(['c', 'a', 'd', 'b']); mode('2'); }],
    [5300, () => cursorTo(card('c').querySelector('.hc-h'))],
    [6200, () => click()],
    [6400, () => { view('agent'); side.querySelector('.hs-row[data-id="c"]').classList.add('act'); app.classList.remove('cursor-on'); }],
    [7700, () => cursorTo(ask().querySelector('.o1'))],
    [8500, () => { click(); ask().classList.add('picked'); }],
    [9000, () => { app.classList.add('answered'); app.classList.remove('cursor-on'); set('c', 'w', 60); mode('0'); place(['a', 'c', 'd', 'b']); }],
    [10600, () => { view('overview'); side.querySelector('.hs-row.act')?.classList.remove('act'); }],
    [11200, () => cursorTo(side.querySelector('.aw-row:nth-of-type(2), .ha-side .aw-row + .aw-row'))],
    [12000, () => { click(); }],
    [12200, () => { view('main'); app.classList.remove('cursor-on'); side.querySelector('.ha-side .aw-row + .aw-row').classList.add('act'); }],
    [13200, () => { app.classList.add('said'); mode('4'); set('a', 'w', 70); set('d', 'w', 85); drawLanes(app.querySelector('.mv-lanes'), [...LANE_ROWS.filter((r) => r.kind !== 'wait'), ...LANE_BROADCAST, ...laneOutcomes()], LANES); }],
    [16400, () => { view('overview'); side.querySelector('.ha-side .aw-row + .aw-row').classList.remove('act'); }],
  ];
  const LOOP = 19500;
  reset();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const run = () => {
    reset();
    for (const [t, f] of timeline) setTimeout(f, t);
  };
  run();
  setInterval(run, LOOP);
})();

// The side-column tile: cycles through what the side column holds; a tab shows its panel.
(function sideTile() {
  const tile = document.querySelector('.tile-side');
  if (!tile) return;
  let i = 0, timer;
  const show = (n) => { i = n; tile.dataset.tab = String(n); };
  const loop = () => { clearInterval(timer); if (!matchMedia('(prefers-reduced-motion: reduce)').matches) timer = setInterval(() => show((i + 1) % 4), 3200); };
  tile.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', () => { show(Number(t.dataset.tab)); loop(); }));
  show(0); loop();
})();

// The Work Map section's Team Map: the same drawing as the main agent's page, for three agents.
(function workMapLanes() {
  const box = document.querySelector('.wm-lanes');
  if (!box) return;
  const lanes = [{ k: 'n.b', n: 'Bob', c: '#6366f1' }, { k: 'n.c', n: 'Charlie', c: '#0ea5e9' }, { k: 'n.d', n: 'Diana', c: '#14b8a6' }];
  const rows = [
    { kind: 'ask', k: 'wl.1', t: 'Revenue card' }, { kind: 'new', lane: 1 },
    { kind: 'ask', k: 'wl.2', t: 'Index for order history' }, { kind: 'new', lane: 2 },
    { kind: 'ask', k: 'wl.3', t: 'Try a line chart' }, { kind: 'new', lane: 3 },
    { kind: 'settled', lane: 1 }, { kind: 'wait', lane: 2 },
    { kind: 'ask', k: 'wl.4', t: 'Keep the chart short' }, { kind: 'send', lane: 3 },
    { kind: 'out', lane: 1, st: 'd' }, { kind: 'out', lane: 2, st: 'w' }, { kind: 'out', lane: 3, st: 'w' },
  ];
  const draw = () => drawLanes(box, rows, lanes);
  draw();
  document.querySelector('.lang').addEventListener('click', () => setTimeout(draw, 0));
})();

// The hero window by room: on a phone its own compact layout at full size (one column of cards, the
// map under the conversation); on a tablet the desktop layout scaled down; otherwise as it is.
(function fitHero() {
  const app = document.querySelector('.hero-app'), frame = document.querySelector('.stage .window');
  if (!app || !frame) return;
  const W = 1180;
  const fit = () => {
    const room = frame.parentElement.clientWidth;
    const compact = room < 640, scaled = !compact && room < 960;
    app.classList.toggle('compact', compact);
    app.classList.toggle('scaled', scaled);
    app.style.width = scaled ? `${W}px` : '';
    frame.style.zoom = scaled ? String(room / W) : '';
  };
  addEventListener('resize', fit);
  fit();
})();

// On a phone the stories do not scroll-play: each one's pieces rise in when it comes into view.
(function seen() {
  const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (e.target.closest('.story').classList.add('seen'), io.unobserve(e.target))), { threshold: 0.12 });
  document.querySelectorAll('.story .story-stage').forEach((el) => io.observe(el));
})();

// Phone: each caption sits right above the piece it explains (built once; hidden on wide screens,
// where the captions stay in the left column). [caption indexes] → the piece they go above.
(function phoneCaptions() {
  const PLAN = {
    overview: [[[0, 1, 2], '.main-card'], [[3, 4], '.m1']],
    'main-agent': [[[0], '.say'], [[1], '.hub'], [[2], '.direct'], [[3], '.summary']],
    'work-map': [[[0, 1, 2, 3], '.wm-smap'], [[4], '.wm-lanes']],
    memory: [[[0], '.mm-chat'], [[1], '.mm-note'], [[2], '.mm-targets'], [[3], '.mm-file']],
  };
  for (const [id, groups] of Object.entries(PLAN)) {
    const story = document.getElementById(id);
    if (!story) continue;
    const caps = story.querySelectorAll('.caps li');
    let n = 0;
    groups.forEach(([idx, sel], g) => {
      const target = story.querySelector(`.iso ${sel}`);
      if (!target) return;
      const box = document.createElement('div');
      box.className = `m-cap m-cap-${g}`;
      for (const i of idx) {
        const li = caps[i];
        if (!li) continue;
        const row = document.createElement('p');
        row.innerHTML = `<i>${++n}</i><span class="m-cap-t"></span>`;
        const t = row.querySelector('.m-cap-t');
        t.appendChild(li.querySelector('b').cloneNode(true));
        t.appendChild(li.querySelector('span').cloneNode(true));
        box.appendChild(row);
      }
      target.parentNode.insertBefore(box, target);
    });
  }
})();
