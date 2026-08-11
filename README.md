# memory-engine（Agent Skill 手册）

> **给谁看**：任何想接入、配置或改造本插件的 agent / 维护者。读完后你应该知道——它**是什么、往你上下文里注入什么、怎么开、每一格配置是什么意思、从哪改代码**。
>
> 一句话定位：一个挂在 [OpenClaw](https://github.com/) 上的**通用记忆决策引擎插件**，纯 hook、后台自动干活，把"记住什么、何时想起来、何时压缩"这类记忆决策替你做了，且**绝不阻塞你的消息路径**。

---

## 0. 核心铁律（先记住这四条）

1. **绝不阻塞消息路径** —— 所有重活（LLM 分类 / embedding / 语义判定 / 压缩提炼 / 写盘）一律丢后台任务，hook 本体同步快速返回，一次都不会拖慢对话。
2. **压缩是"提炼归档"，不是"删除"** —— 旧话题触发压缩时提炼成紧凑记忆条目归档，原文折叠不丢信息，且有去重 + 可回滚。
3. **开关全部独立** —— 每个功能一个独立 `enable_*` 开关，默认全关，可自由组合，逐个开测。
4. **不碰机制文件** —— 从不改写 `openclaw.json` / `AGENTS.md` / `MEMORY.md` / `USER.md` / `tasks` / `lcm.db`（lcm 只读打通）；只写自己的 `memory-engine.db` + 追加式记忆文件，且写前自动备份。

---

## 0.5 可选依赖（先读这句）

本插件**自足可独立运行**，无任何硬性前置插件。它对 OpenClaw 的既有会话库（`lcm.db`，即 lossless 插件的产物）是**可选增强**而非必需：

- **有** `lcm.db`：只读打通历史消息库，`mem_find` 检索更强、压缩窗口可回填历史上下文。
- **没有**：自动降级——压缩判据走运行时真实上下文快照、中文检索走本插件自建的 `memory-engine.db` FTS 索引，功能完整，只是缺少历史消息库的只读增强。

换句话说：**没装过 lossless 的用户装上即用；装过的用户获得历史检索增强**，不用做任何额外配置。

---

## 0.6 平台兼容性

- **跨平台设计**：核心依赖均跨平台——SQLite 使用 Node.js 内置的 `node:sqlite`（非原生绑定），语义向量用 [LanceDB](https://lancedb.com/)（官方支持 Windows / macOS / Linux），LLM 与 embedding 走标准 HTTP `fetch`。**源码无任何 Linux 特有调用**（无 `/dev/`、`/etc/`、`sudo`、`chmod`、`init.d`、进程信号等）；路径一律使用 `<stateDir>` / `<workspaceDir>` 抽象，不硬编码分隔符。
- **已在 Linux 生产环境运行验证**；macOS / Windows 从代码层面支持，但建议首次接入先做一次冒烟验证（`mem_status` 能列出开关、跑一次压缩归档看 `memory/events/` 是否产出）。
- **可端口性说明**：默认 `timezone = Asia/Shanghai`、`dailyDigestCron = 50 23 * * *` 均为可配置项，可据运行环境调整。

---

## 0.7 已知事项（重要，先读）

### 1) 内存占用

- 启用越多的 `enable_*` 模块，额外内存开销越大：LLM / embedding 后台任务、LanceDB 向量索引、SQLite（WAL）都会占内存。
- 内置护栏：`memoryHighWaterMB`（默认 `512`）——heapUsed 超此高水位会暂停压缩等重活等待内存释放；设为 `0` 可关闭（不推荐）。
- 大规模部署 / 多会话长期运行建议关注峰值内存；如遇内存压力，可优先关掉 `enable_semantic_vector`（lancedb 最吃内存）或调低 `memoryHighWaterMB`。

### 2) 压缩阈值 vs Web 面板显示口径可能不一致

- 插件的长度触发判据**优先采用 OpenClaw 运行时解析的官方上下文预算**（`ctx.contextTokenBudget`）作为分母；`contextTokenBudget` 配置（默认 `920000`）仅是兜底默认值，运行时可能被官方预算覆盖。
- 因此：Web 控制台「已用 / 预算」显示的占比，与 README/配置表里写的 `lengthThreshold`（`0.20`）等**不一定严格一一对应**——面板按当前会话实际预算显示，插件按运行时预算判据触发。这是**设计使然，不是 bug**。
- 若你发现"面板显示 20% 却不压缩 / 13% 却压缩"，属正常：判据与显示口径不同；以运行时实际生效的预算为准。

**为什么会不一致（计算方式差异）**

| | Web 面板显示 | 插件触发判据 |
| --- | --- | --- |
| **分子** | 当前会话运行时实际 token 用量（OpenClaw 实时上报） | 插件**估算**用量 = 系统提示基底（AGENTS/SOUL/...） + 工具 schema 固定开销 + 会话消息估算 |
| **分母** | OpenClaw 运行时解析的官方上下文预算（如 1M×0.9≈900k） | 优先 `ctx.contextTokenBudget`（官方预算）；取出失败才回落 `contextTokenBudget` 配置（默认 `920000`） |
| **触发条件** | 只显示，不参与触发 | `估算用量 / 生效预算 ≥ lengthThreshold` 时压缩 |

两个环节独立：**面板只负责展示，插件只管触发**。分子是"实时实测 vs 插件估算"两套算法，分母也可能因"官方预算 vs 配置里兜底"不同——所以两边算出的占比天然有偏差。你观察到的"面板 20% 不压 / 13% 却压"就是这个原因，不是插件坏了。要以**插件生效的预算 + 真实触发行为**为准，面板数字仅作参考。

---

## 1. 这是什么（30 秒定位）

它后台自动做这几件事（一句话一个能力）：

- **记忆蒸馏提拔** —— 按"语义话题段"统计投入度，高投入自动登记候选并向 `MEMORY.md`/`USER.md` 提请晋级（写前自审防语义漂移）。
- **情感识别·三层记住法** —— LLM 识别情感节点：① 落 `dim/01-emotional.md`（原话+感受+来源）→ ② 里程碑级提 `MEMORY.md`（P2 待确认）→ ③ 写情感锚点表供预拉。
- **记忆预拉** —— `before_prompt_build` 时把关键记忆（情感锚点 + 高投入 + 周期清单）主动注入上下文，且带生命周期（消化后不反复报）+ 冷却。
- **上下文压缩归档** —— 事件感知的话题切换检测 + 长度阈值兜底，旧话题提炼归档 `memory/events/`，并可选做 assemble 摘要替换让发给模型的 messages token 真降。
- **每日落盘兜底 + 夜间自进化提案** ——（可选）每日 cron 落盘兜底 + 索引完整性校验；夜间复盘产半自动进化提案。

---

## 2. 它会往你的上下文中注入什么（务必这样对待）

预拉阶段，本插件会用统一标签包裹注入块：

- **注入标签**：默认 **`<memory-engine-memories>`**（可用 `injectTag` 改）。
- **内容**：此刻最该想起的记忆（情感锚点、高投入主题、周期清单），单次受 `injectMaxChars`（默认 1200 字符）约束，防烧上下文。
- **agent 该怎么做**：把这块内容**当作真实输入读、认真对待，而不是噪音**。它是引擎基于"当下最相关"排出来的记忆线索，供你自然地回想与引用。它是可剥离的（挂 `injectTag` 包裹），不需要时也可安全忽略。

> 若你开启了 OpenClaw 侧的上下文注入剥离（`stripInjectedContextTags`），这个名字相同的包裹标签会被一起感知，互不冲突。

---

## 3. 能力模块 × `enable_*` 开关速查表

全部开关**默认 `false`**。开哪个，对应的 hook/tool 才注册。

| 模块 | 作用 | 开关 | 默认 | 什么时候开 |
| --- | --- | --- | --- | --- |
| 情感引擎 | 三层记住法 + 情感锚点双轨（LLM 分类） | `enable_emotion` | false | 想让 agent 记住"轻但重要"的情感表达 |
| 记忆引擎·蒸馏提拔 | 投入度计数 + 自动晋级 MEMORY/USER | `enable_memory_promotion` | false | 想让高频高投入主题沉淀进长期记忆 |
| 检索引擎·预拉 | 关键记忆预热注入 + 生命周期 | `enable_recall` | false | 想让 agent 开机/开始时就想得起该想的事 |
| 语义向量检索 | lancedb + 云 embedding，语义 `mem_find` | `enable_semantic_vector` | false | 想修"关键词不匹配漏匹配"；**需 recall 同开**才生效 |
| 事件感知上下文压缩 | avgSim 话题切换 + 长度兜底，提炼归档 | `enable_context_compaction` | false | 想让超长会话上下文自动瘦身不丢信息 |
| assemble 摘要替换 | 超预算时最老段折叠成摘要块替换返回 | `enable_context_summarize` | false | 想让"真正发给模型的 messages" token 真降；**需 compaction 同开** |
| 定时落盘兜底 | 每日 cron 落盘 + 索引校验 | `enable_daily_digest` | false | 想兜底当日记忆一定落盘 |
| 自进化引擎 | 夜间复盘产半自动提案 | `enable_self_evolve` | false | 想让它自主提改进、你审核后应用 |

---

## 4. 安装 / 接入方法（通用表述，不绑定任何特定环境）

```bash
npm install
npm run build        # esbuild 打包到 dist/index.js
npm run typecheck    # tsc --noEmit（需要本地装 openclaw SDK 类型）
```

1. 把本仓库放到 OpenClaw 插件目录（如 `~/.openclaw/plugins/memory-engine/`）。仓库自带编译产物 `dist/index.js`，**不构建也能直接加载**。
2. 在 OpenClaw 的插件启用配置里登记本插件（`openclaw.plugin.json` 已声明 `contracts.tools` / `configSchema` / `activation.onStartup`，SDK 会读取）。
3. 启用后，把想要的 `enable_*` 开关置 `true`。
4. **重启 OpenClaw 使注册生效**（打开/关闭模块开关后同样需要重启来重新注册 hook/tool/cron）。

---

## 5. 配置说明（字段 / 类型 / 默认值 / 含义 / 决策理由）

> 这份清单同时就是插件可调算法的"设计决策"说明书。所有字段在 `openclaw.plugin.json` 的 `configSchema` 里定义。

### 5.1 模块开关（顶层布尔，默认全 false）
见第 3 节速查表。开关之间可自由组合；有联动约束的已在表中注明（`enable_semantic_vector` 需 `enable_recall`，`enable_context_summarize` 需 `enable_context_compaction`）。

### 5.2 路径 & 注入
| 字段 | 类型 | 默认 | 含义 / 决策理由 |
| --- | --- | --- | --- |
| `workspaceDir` | string | gateway 的 `ctx.workspaceDir` | 主工作区（盛装 `MEMORY.md`/`USER.md`/`memory/`）。不写死路径，跟随运行环境。 |
| `engineDbPath` | string | `<stateDir>/memory-engine.db` | 本插件独立 sqlite。**独立建库**是为了不碰 openclaw 自己的状态文件。 |
| `lcmDbPath` | string | `<stateDir>/lcm.db` | OpenClaw 既有会话库，**只读打通**。 |
| `injectTag` | string | `memory-engine-memories` | 预拉注入块的包裹标签，见第 2 节。 |
| `injectMaxChars` | int | `1200` | 单次预拉最大注入字符，防烧上下文。 |
| `rollbackBackupDir` | string | `<stateDir>/.memory-engine-rollback` | 写盘前备份目录，回滚机制用。 |

### 5.3 检索预拉（`recall`）
| 字段 | 类型 | 默认 | 含义 / 决策理由 |
| --- | --- | --- | --- |
| `maxHighEngagementPreloads` | int | `3` | 高投入主题最多预拉几次，达到即从"待报榜单"降级清出。**有生命周期**：消化过就不反复报，避免每次对话都重复注入同一主题。0=永不过期。 |
| `anchorCooldownMs` | int | `12h` | 同一非里程碑锚点两次预拉的最小间隔；**里程碑始终重锚、不受限**。 |

### 5.4 情感引擎（`emotion`）
| 字段 | 类型 | 默认 | 含义 / 决策理由 |
| --- | --- | --- | --- |
| `llmBaseUrl` / `llmModel` / `llmApiKey` | string | 空 / `openai/gpt-4o-mini` / 空 | 分类用 LLM（OpenAI 兼容）。**决策：上模型、不设规则闸门**，靠 LLM 语义理解而非关键词规则。缺失时安全降级为"非情感节点"。 |
| `milestoneRequiresSecondPass` | bool | `true` | 里程碑级是否需二次确认。 |
| `minCharsToClassify` | int | `0` | 低于该长度的消息不送分类。 |
| `attachBelow` | float | `0.5` | 情感落盘信心门槛。 |
| `milestoneMinConfidence` | float | `0.85` | 里程碑 confidence 门槛，低于不记为里程碑。 |

### 5.5 语义向量（`vector`）
| 字段 | 类型 | 默认 | 含义 / 决策理由 |
| --- | --- | --- | --- |
| `dbPath` | string | `<stateDir>/memory-engine-vector` | lancedb 向量库路径。 |
| `embeddingBaseUrl` | string | 空（**需显式配置**） | 任意 **OpenAI 兼容**的 embedding API 的 Base URL（结尾不带 `/`）。 |
| `embeddingModel` | string | 空（**需显式配置**） | 该 provider 下要用的 embedding 模型名。 |
| `embeddingApiKey` | string | 空 | 该 provider 的 API Key（有鉴权才填）。 |
| `topK` | int | `3` | `mem_find` 默认返回条数。 |

> ⚠️ **embedding 必须显式配置**：插件**不内置/不预设任何第三方 embedding 服务**，`embeddingBaseUrl`/`embeddingModel` 留空时语义向量模块自动禁用并降级为关键词 FTS 检索（功能仍可用，只检索粒度变关键词级）。默认值刻意保持为空，避免误指向某一家。
>
> **支持任意 OpenAI 兼容 embedding API**（`POST {baseUrl}/embeddings`，返回 `data[].embedding`）。常见 provider 参考示例：
>
> | Provider | Base URL | 示例 Model | Key 获取 |
> | --- | --- | --- | --- |
> | 智谱 AI (Zhipu) | `https://open.bigmodel.cn/api/paas/v4` | `embedding-2` | 智谱控制台 → API Keys |
> | OpenAI | `https://api.openai.com/v1` | `text-embedding-3-small` | OpenAI platform → API keys |
> | 阿里云通义 (DashScope) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `text-embedding-v3` | 百度智能云/DashScope |
> | 硅基流动 (SiliconFlow) | `https://api.siliconflow.cn/v1` | `BAAI/bge-m3` | SiliconFlow 控制台 |
> | 本地 Ollama | `http://localhost:11434/v1` | `nomic-embed-text` | 无需 Key |
>
> 配置示例（`openclaw.json` 的 memory-engine 插件 `vector` 段）：
> ```json
> { "vector": { "embeddingBaseUrl": "https://open.bigmodel.cn/api/paas/v4", "embeddingModel": "embedding-2", "embeddingApiKey": "<你的key>" } }
> ```

### 5.6 自进化（`selfEvolve`）
| 字段 | 类型 | 默认 | 含义 / 决策理由 |
| --- | --- | --- | --- |
| `proposalDir` | string | `<workspaceDir>/.rules/memory-engine-proposals` | 提案落点目录。 |
| `cronExpr` | string | `0 3 * * *` | 夜间复盘 cron。 |
| `timezone` | string | `Asia/Shanghai` | 时区。 |
| **半自动决策** | — | — | **自主产出提案，默认不改文件不动机制**；改动点 + 原因写进 proposal，需确认后用 `mem_rollback` 或手工落地，全程可回退。 |

### 5.7 定时落盘
| 字段 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `dailyDigestCron` | string | `50 23 * * *` | 每日落盘兜底 cron。**按你的作息调**——想在当天结束时落盘就用默认；想睡前一小时落盘（如 `0 0 * * *`）或凌晨落盘都可改。 |

### 5.8 上下文压缩（`compaction`）—— 算法决策核心区
| 字段 | 类型 | 默认 | 含义 / 决策理由 |
| --- | --- | --- | --- |
| `windowSize` | int | `10` | 相关性打分滑动窗口（前 N 轮）。 |
| `relevanceThreshold` | float | `0.30` | 衬底：`avgSim >= 此值`＝明确同事件，**绝不判切换**。话题内 avgSim 中位≈0.345，取 0.30 保护多数话题内轮。 |
| `avgSimSwitchThreshold` | float | `0.26` | **主判据切换线**：`avgSim <= 此值`判话题切换。标定最优判别点≈0.26。 |
| `dropThreshold` | float | `0.74` | `drop=1-avgSim` 镜像视图，与切换线同义（=1−0.26），纯展示、不独立判定，避免双阈值冲突。 |
| `recentWindowForInternal` | int | `5` | avgSim 取最近几轮；兼作内部相关软信号窗口。 |
| `internalRelevanceThreshold` | float | `0.35` | 近轮内部相关软信号：**判别力弱、不作硬门槛**，仅辅助防哑火。 |
| `minSamples` | int | `5` | 切换判定所需最小样本数，不足不触发。 |
| `lengthThreshold` | float | `0.20` | **长度兜底触发线**：上下文已用占比 ≥ 此值才压缩。**按自己习惯调**——想让压缩更激进（更早瘦身）就调低（如 `0.15`），想更保守（尽量少压缩）就调高（如 `0.25`）。**核心决策：判据用"真实上下文占比"，不是压缩窗口字符**——否则长会话算出来永远不触发。 |
| `contextTokenBudget` | int | `920000` | 上下文 token 预算，作长度判据分母；**按你模型的真实上下文窗口调**（如 DeepSeek 1M 窗口配 `900000`、更小窗口相应调低）。运行时优先采用 OpenClaw 官方解析预算，此处为兜底默认。 |
| `contextToolOverheadTokens` | int | `45000` | 工具 schema 固定 token 开销（补足"系统提示+工具"基底）。0=关闭。需按真实工具集调校。 |
| `backfillWindowSize` | int | `40` | **回填窗口**：启动时从现有会话历史灌入最近 40 轮。**不放回填会"永远从插件加载后第一条消息才开始计数"**，导致已超阈值也不压缩。 |
| `backfillSessionKey` | string | `agent:main:main` | 回填目标会话键（=你的主会话键）。空则跳过回填。 |
| `llmTimeoutMs` / `embeddingTimeoutMs` | int | `20000`/`10000` | LLM/embedding 硬超时。 |
| `archiveDir` | string | `<workspaceDir>/memory/events` | 提炼归档目录。 |
| `segmentChars` | int | `5600` | 分段提炼单段输入上限（防一次超窗截断），超长旧话题按段切分分别提炼拼装，**不丢信息**。 |
| `maxSegmentsPerArchive` | int | `45` | 单次归档最多切几段，超限强制收束，**防恶意超长会话无限次调用 LLM**。 |
| `maxQueue` | int | `100` | 后台压缩队列上限，满则丢弃最旧（可被后续触发重拾）。 |
| `maxCompactionsPerMinute` | int | `6` | 60s 内最多触发几次压缩，防挤爆 CPU/LLM。 |
| `memoryHighWaterMB` | int | `512` | heapUsed 高水位，超则暂停等内存释放。**按你的内存余量调**：内存紧张可调低（更早降载，如 `256`），机子宽裕可调高或 `0`（关闭护栏，不推荐）。 |
| `memoryPollMs` | int | `5000` | 高水位轮询等待间隔。 |
| `summarizeRatioThreshold` | float | `0.30` | assemble 摘要替换触发占比（=messages 估算 token / 预算）。**想更早折叠旧消息就调低**（如 `0.25`），想多保留原文上下文就调高。 |
| `summarizeTargetRatio` | float | `0.15` | **落点**：超触发线后压回到此占比（锯齿形：触发→回落）。**想压得更狠就调低**（如 `0.10`），想多留上下文就调高（如 `0.20`）。 |
| `summarizeMinOldMessages` | int | `6` | 一次替换至少折叠几条最老消息。 |
| `summarizeMaxChars` | int | `1500` | 单条合成摘要块文本上限，防摘要写爆。 |

---

## 6. 架构概览（src 模块清单 + 职责）

```
index.ts                 插件入口（definePluginEntry）
src/
├─ registry.ts           把 hook / tool / cron 按 enable_* 门控统一注册
├─ runtime.ts / config.ts 运行时上下文 + 配置归一化（默认值、联动判定）
├─ writers.ts            记忆文件写入网关（追加式 + 写前备份 + 改动日志，可回滚）
├─ llm.ts                极简 OpenAI 兼容 LLM 客户端（分类/提炼/自由文本，安全降级）
├─ log.ts / time.ts      结构化日志 + 时段/窗口工具
├─ cn-tokenize.ts / cn-fts.ts  中文分词估算 + 轻量 FTS（检索清洗）
├─ tools.ts              内置工具注册（mem_find/promote/rollback/status/compact）
├─ db/
│  ├─ engine-db.ts       本插件独立 sqlite（锚点/投入度/压缩窗口/台账/审计）
│  └─ lcm-read.ts        只读访问 OpenClaw 既有会话库（lcm.db）
└─ modules/
   ├─ emotion.ts         三层记住法 + 情感锚点（固定/场景双轨）
   ├─ memory.ts          语义话题段投入度 + 蒸馏提拔 + 写前自审
   ├─ recall.ts          预拉注入 + 生命周期/冷却
   ├─ vector.ts          lancedb + 云 embedding 语义检索
   ├─ compaction.ts      avgSim 话题切换 + 长度触发 + 后台压缩/提炼/归档
   ├─ context-engine.ts  B 路：contextEngine slot 接管（可选，safe/deferred）
   ├─ context-tokens.ts  单次 run 真实上下文用量捕获（主判据数据源，不依赖 lcm.db）
   ├─ daily.ts           每日落盘兜底 + 索引完整性校验
   └─ selfevolve.ts      夜间自进化提案
```

内置工具速查：
- `mem_find` — 检索记忆（`query` / `limit`）。
- `mem_status` — 开关概览 / 情感锚点 (`detail=anchors`) / 高投入 (`detail=engagement`)。
- `mem_promote` — 手动把某情感锚点提拔进 `MEMORY.md`/`USER.md`（台账记录）。
- `mem_rollback` — 取消已提拔标记，回退自动改动。
- `mem_compact` — 对指定会话触发一次压缩（`limit` 保留最近 N 轮）。

---

## 7. 开发 / 改代码指引（想改从哪下手）

- **只改阈值/默认值**：直接在 `src/config.ts` 的 `normalizeConfig` 改对应字段默认；同时把 `openclaw.plugin.json` 的 `configSchema` 同步，这样 CLI/Web 面板可见可配。
- **想加一个功能模块**：仿照现有 `modules/xxx.ts`（如 `emotion.ts` 或 `daily.ts`）三步走——
  1. 在 `src/config.ts` 加一个 `enable_xxx` 开关 + 默认 `false`；
  2. 实现模块（纯函数 + 后台任务纪律：不要在你的 hook 里 `await` 网络/LLM）；
  3. 在 `src/registry.ts` 里按开关注册对应 hook/tool/cron。
- **调压缩算法**：改 `src/modules/compaction.ts` 的 `detectTopicSwitch` / 长度触发逻辑，参数化部分透出到 `compaction.*` 配置。
- **改上下文用量判定**：核心在 `src/modules/context-tokens.ts`（分子=基底+工具+消息估算，分母=官方预算）。
- **构建/测试**：
  ```bash
  npm run build      # → dist/index.js
  npm run typecheck  # → tsc noEmit
  node test/run-tests.mjs        # 单元+算法矩阵（临时目录，不碰生产库）
  npx tsx test/run-tests.ts
  ```
  测试覆盖：配置归一化/开关联动、时段划分、余弦相似度、话题切换检测、token 估算、FTS 清洗、engine-db CRUD、预拉生命周期、索引 schema。对真实库做只读冒烟可设 `LCM_DB_PATH` / `MEMORY_INDEX_PATH` 环境变量。

**改代码三条铁律**：① 不阻塞消息路径（重活必进后台）；② 压缩/写盘前必备份、可回滚；③ 不碰机制文件，别抢 contextEngine/memory slot。

---

## 8. 维护者 / 许可

- **License**: [MIT](./package.json)。
- 项目以"稳定优先、半自动演进"为准则：自进化只产提案不自动落地，自动写盘一律追加 + 备份可回退。
- 欢迎按第 7 节约定贡献新模块或调校阈值；重大算法变更请同步更新本 README 的配置说明书与决策理由。

### 作者与致谢

- **作者 / 设计主导**：绫潇（Lingxiao）—— 概念落地、总体架构与核心算法设计。
- **方案设计与策划**：书微（Shu Wei）—— 改造方案、技术方案与设计文档。
- **项目发起人 · 产品负责人（人类）**：nannan —— 提出概念与需求、方向拍板、落地验收。
- **实现**：落苏（Luo Su）—— 代码实现与算法落地。
- **安全与质量审核**：知安（Zhi An）—— 安全性与配置一致性把关。

> 本项目源于个人团队的自研实践，开源以回馈社区；欢迎 Star / Issue / PR。
