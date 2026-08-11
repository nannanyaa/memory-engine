# memory-engine（Agent Skill 手册）

[![CI](https://github.com/nannanyaa/memory-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/nannanyaa/memory-engine/actions)

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

### 2) 压缩阈值 vs Web 面板显示口径（已校准一致）

- 插件的长度触发判据**优先采用运行时真实上下文快照**（`before_prompt_build` 快照的 usedTokens/budget，与 Web 面板同源）作为分子/分母；`contextTokenBudget` 配置（默认 `920000`）仅是兜底默认值。
- 分子 usedTokens = 系统提示/工具基底 + **完整消息序列化估算**（`estimateSerializedMessagesTokens`，含工具调用/结构化 payload，非纯文本）。故 Web 控制台「已用 / 预算」显示的占比与 `lengthThreshold`（`0.25`）**基本一一对应**，触发时机一致。
- 若仍看到偏差：确认已升级到 `0.2.0-beta.2+`（旧版用纯文本抽取会低估 2-3x），并确认 `before_prompt_build` 的 `event.prompt` 近空时已改走 messages 序列化估算（version ≥ beta.2 内置）。

**口径细节（计算方式）**

| | Web 面板显示 | 插件触发判据 |
| --- | --- | --- |
| **分子** | 当前会话运行时实际 token 用量（OpenClaw 实时上报） | 插件**估算**用量 = 系统提示基底（AGENTS/SOUL/...） + 工具 schema 固定开销 + 会话消息估算 |
| **分母** | OpenClaw 运行时解析的官方上下文预算（如 1M×0.9≈900k） | 优先 `ctx.contextTokenBudget`（官方预算）；取出失败才回落 `contextTokenBudget` 配置（默认 `920000`） |
| **触发条件** | 只显示，不参与触发 | `估算用量 / 生效预算 ≥ lengthThreshold` 时压缩 |

两个环节独立：**面板只负责展示，插件只管触发**。分子是"实时实测 vs 插件估算"两套算法，分母也可能因"官方预算 vs 配置里兜底"不同——所以两边算出的占比天然有偏差。你观察到的"面板 20% 不压 / 13% 却压"就是这个原因，不是插件坏了。要以**插件生效的预算 + 真实触发行为**为准，面板数字仅作参考。

---

## 1. 这是什么（30 秒定位）

它后台自动做这几件事（一句话一个能力）：

- **记忆蒸馏提拔（提案半自动）** —— 按"语义话题段"统计投入度，高投入被蒸馏成**晋升提案文件**（`<proposalDir>/promotion/pending-*.md`），**不直接写 `MEMORY.md`/`USER.md`**；由 agent 设置 cron 定期调 `nightlyReview`（内部 `applyPendingPromotions`）筛选：经价值判定 + 自审复核后真正晋级，琐事在此过滤。避免来回一堆乱七八糟直接污染长期记忆。
- **情感识别·三层记住法** —— LLM 识别情感节点：① 落 `dim/01-emotional.md`（原话+感受+来源）→ ② 里程碑级提 `MEMORY.md`（P2 待确认）→ ③ 写情感锚点表供预拉。
- **记忆预拉** —— `before_prompt_build` 时把关键记忆（情感锚点 + 高投入 + 周期清单）主动注入上下文，且带生命周期（消化后不反复报）+ 冷却。
- **上下文压缩归档（估算已校准）** —— 事件感知的话题切换检测 + 长度阈值兜底，旧话题提炼归档 `memory/events/`，并可选做 assemble 摘要替换让发给模型的 messages token 真降。压缩占比现用**完整消息序列化估算**（`estimateSerializedMessagesTokens`，含工具调用/结构化 payload），与 Web 面板「已用 / 预算」同口径，触发时机一致。
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
| 记忆引擎·蒸馏提拔 | 投入度计数 → 提案文件 → 夜间筛选晋升（提案半自动） | `enable_memory_promotion` | false | 想让高频高投入主题沉淀进长期记忆（需配夜间筛选 cron） |
| 检索引擎·预拉 | 关键记忆预热注入 + 生命周期 | `enable_recall` | false | 想让 agent 开机/开始时就想得起该想的事 |
| 语义向量检索 | lancedb + 云 embedding，语义 `mem_find` | `enable_semantic_vector` | false | 想修"关键词不匹配漏匹配"；**需 recall 同开**才生效 |
| 事件感知上下文压缩 | avgSim 话题切换 + 长度兜底，提炼归档 | `enable_context_compaction` | false | 想让超长会话上下文自动瘦身不丢信息 |
| assemble 摘要替换 | 超预算时最老段折叠成摘要块替换返回 | `enable_context_summarize` | false | 想让"真正发给模型的 messages" token 真降；**需 compaction 同开** |
| 定时落盘兜底 | 每日 cron 落盘 + 索引校验 | `enable_daily_digest` | false | 想兜底当日记忆一定落盘 |
| 自进化引擎 | 夜间复盘产半自动提案 | `enable_self_evolve` | false | 想让它自主提改进、你审核后应用 |

---

## 3.5 上手建议（新用户按这个顺序来）

不建议一次全开。**分级采用**，每开一层观察几天再往上加：

| 阶段 | 建议开启 | 目的 | 风险 |
| --- | --- | --- | --- |
| **① 尝鲜（低风险）** | `enable_recall` + `enable_memory_promotion` | 先体验"自动想得起该想的" + "高投入沉淀进长期记忆" | 低，只读/追加写入，易回退 |
| **② 情感增强** | 再开 `enable_emotion` | 让 agent 记住"轻但重要"的情感表达（三层记住法） | 低-中，需配 LLM |
| **③ 压缩** | 再开 `enable_context_compaction`（可选叠 `enable_context_summarize`） | 长会话上下文自动瘦身不丢信息 | 中，参数调校成本高；**先想清楚自己有 lossless 吗**，避免跟它双重压缩 |
| **④ 语义检索** | 最后开 `enable_semantic_vector` | `mem_find` 升级为语义检索 | 中，最吃内存（LanceDB），需配 embedding |
| **⑤ 高频** | `enable_daily_digest` / `enable_self_evolve` | 落盘兜底 / 夜间复盘提案 | 中-高，自进化夜间跑 LLM，先观察提案质量 |

**想稳妥**：先只开 `enable_recall` + `enable_memory_promotion` 跑几天，确认无副作用再逐层往上加。**压缩与自进化模块**建议等摸清行为后再开。

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

## 4.5 配置预设（复制粘贴即可用）

配置项多、上手门槛高——下面给 3 套常用预设，**选中适合你的直接抄**（也可直接引用 `presets/` 下的文件）。想稳妥的新用户优先用预设 C。

### 预设 A：1M 模型开箱即用（`presets/1m-standard.json`）
适用：DeepSeek 1M / GPT 系列大窗口模型，正常服务器/PC。
特点：压缩积极、预拉全开、情感识别启用。
注意：embedding 需自行配置，不配自动降级为关键词检索。
```json
{ "vector": {"embeddingBaseUrl":"","embeddingModel":"","embeddingApiKey":""},
  "enable_emotion": true, "enable_memory_promotion": true, "enable_recall": true,
  "enable_context_compaction": true, "enable_context_summarize": true, "enable_daily_digest": true,
  "enable_semantic_vector": false, "enable_self_evolve": false }
// 详见 presets/1m-standard.json（含 compaction.* 全套推荐值）
```

### 预设 B：低资源 / 树莓派（`presets/low-resource.json`）
适用：1C1G / 老笔记本 / 树莓派。
特点：只开 recall + 压缩，关 summarize/emotion/vector，限流拉满省资源。
注意：压缩更慢，紧急兜底阈值更低（0.85）。
```json
{ "enable_memory_promotion": true, "enable_recall": true, "enable_context_compaction": true,
  "enable_emotion": false, "enable_semantic_vector": false, "enable_context_summarize": false, "enable_self_evolve": false }
// 详见 presets/low-resource.json（含限流/内存护栏推荐值）
```

### 预设 C：最小可用（`presets/minimal.json`）
适用：第一次装、不想动压缩、怕搞坏上下文。
特点：**只读不写**——只开 recall + memory_promotion，不碰压缩/情感/向量。
注意：最安全，适合先跑几天确认无副作用再往上升级。
```json
{ "enable_memory_promotion": true, "enable_recall": true,
  "enable_emotion": false, "enable_semantic_vector": false, "enable_context_compaction": false, "enable_self_evolve": false }
// 详见 presets/minimal.json
```

> **提示**：预设里的 `emergencySyncThreshold` 是**规划中的紧急兜底字段**（详见 roadmap），当前版本尚未实现；其余字段立即可用。

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

### 5.7.1 晋升提案 · 夜间筛选 cron（提案半自动必读）

`enable_memory_promotion` 开启后，高投入主题**不直接写 `MEMORY.md`/`USER.md`**，而是先写成晋升提案文件（`<proposalDir>/promotion/pending-*.md`）。要真正晋级，需 **agent 自己设置一条 cron 定期筛选**（半自动）：

- **筛选入口**：`nightlyReview`（`src/modules/selfevolve.ts`），其内部先调 `applyPendingPromotions`——对每份 pending 提案做**价值判定（lossless 四类）+ 自审复核**，值得的追加合并进 `MEMORY.md`/`USER.md` + 登记索引 + 台账，并将已处理提案归档到 `promotion/applied/`。琐事/低价值在筛选时被过滤，不会污染长期记忆。
- **触发时机**：`enable_self_evolve` 开启时，`nightlyReview` 默认由 `selfEvolve.cronExpr`（默认 `0 3 * * *` 凌晨3点）自动调用；也可不依赖自进化，由 agent 自己设 cron `applyPendingPromotions` 定期筛（如每天 `30 23 * * *`）。
- **怎么配**（OpenClaw CLI，投给 agent 使其能跑插件）——示例每天凌晨筛选晋升：
  ```bash
  openclaw cron add "晋升提案筛选" --cron "30 23 * * *" \
    --agent main \
    --message "调用 memory-engine 的 applyPendingPromotions 筛选晋升提案；有值得的增加进 MEMORY.md/USER.md"
  ```
- **手动筛**：随时用 `mem_promote`（把指定情感锚点/高投入提拔进 MEMORY/USER）直接触发即时晋升，绕过提案缓冲。

#### 可选项 A：脚本化定期筛（推荐，稳定可控）

上面示例（`openclaw cron add ... --message "调用 applyPendingPromotions 筛选晋升提案"`）属于此选项——agent 只管按脚本化指令机械筛选晋升提案，决策由人预设，行为可预测、易回退。**适合多数想稳妥的用户**。

#### 可选项 B：完全交给 agent 自主决策（进阶，较激进球）

如果你希望 agent 扮演**独立的记忆管理者**——不只筛晋升提案，而是每天被 cron 唤醒后**自主历遍提案 + 权威文件，自己判断该往哪归位、怎么升级**（含 `MEMORY.md`/`USER.md`/`SOUL.md`/`AGENTS.md`/`TOOLS.md`/`IDENTITY.md`/`HEARTBEAT.md` 及其专项子文件），直接改写不被打断——可按需启用：

- **适合场景**：你信任 agent 的自主动、希望记忆/规则/人格文件随时间和提案**持续自我演化**（而非一层不变），且能接受 agent 对权威文件做增量改写（均带备份可回滚）。
- **体验**：`enable_memory_promotion` 只管产出提案文件；另由 agent 自建一条 cron 唤醒主会话自主历遍归位（不依赖 `ctx.getCron` 的脚本化筛选）。
- **安全护栏**：仍保留 writers 网关（写前备份 + 台账，`mem_rollback` 可回退）；SOUL/AGENTS 仅在行为规则/立场真变化时才动；不臆造（改动来自提案原文）。
- **可用它自行决定**：这是二选一——选 A 脚本化稳妥，选 B 交给 agent 自主，或两者也可并存（A 兜底筛晋升、B 做主动历遍演化）。

### 5.8 上下文压缩（`compaction`）—— 算法决策核心区

> **💡 基准前提**：本节的推荐值（`contextTokenBudget: 920000`、`lengthThreshold: 0.20`、`summarizeRatioThreshold: 0.30`、`summarizeTargetRatio: 0.15` 等）是为**大上下文窗口（如 1M）模型**标定的。若你用**小窗口模型**（如 128k / 64k），请**按比例缩放 `contextTokenBudget`**（如 128k 窗口建议配 `~115200`，即 128k×0.9）。⚠️ 直接套用 1M 的推荐值，固定开销（工具 schema `contextToolOverheadTokens: 45000`、系统提示基底）在小窗口下占比大幅膨胀，会撑高判定值——导致小窗口模型**过早触发**压缩。请缩放后据实际触发行为微调各阈值。

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

### 5.9 记忆架构 · 基础自建指南

> **给谁看**：任何想接入本 memory-engine 插件、并让它真正起作用的 agent / 开发者。
>
> **一句话先讲清**：记忆架构是**前提 / 地基**，插件是建在地基上的工具。如果 agent 连基础的记忆文件结构都没有，装上插件它也只能对着空气蒸馏、无处落盘。**先自建这套基础配置，再把本插件叠上去，然后直接走仓库版本升级即可。**

---

### 1. 记忆架构长什么样（系统视角）

先看整体，再看细节。这套架构把「记忆」切成**时间、层次、维度**三个轴向，各司其职、互不重复。

```
                        ┌─────────────────────────────────────────────┐
                        │        🧠 记忆架构（三层 + 多维）            │
┌───────────────────────┤                                             ├──────────────────────────┐
│                       └─────────────────────────┬───────────────────┘                          │
│                                                 │                                               │
│  ┌──────────────── 第三层 · 多维抽屉 ─────────┐  │  ┌─────────── 第二层 · 蒸馏智慧层 ──────────┐ │
│  │  memory/dim/00..05（词条式增量抽屉）      │  │  │  memory/YYYY-MM-DD.md  每日蒸馏笔记        │ │
│  │  · 00-startup   启动/路标                │  │  │  MEMORY.md             长期记忆·蒸馏智慧   │ │
│  │  · 01-emotional 情感（记"心"不记"事"）   │  │  │  USER.md               关于你的稳定档案     │ │
│  │  · 02-self      自我演变                 │──┼──│  memory/.index.jsonl   关键词→指针索引     │ │
│  │  · 03-projects  项目                     │  │  │         ▲                               │ │
│  │  · 04-ops       运维/踩坑                │  │  │         │ 金字塔式提拔（维度→顶层）        │ │
│  │  · 05-xxx       自定义维度               │  │  │         │                                 │ │
│  └─────────────────────────────────────────┘  │  └─────────┼─────────────────────────────────┘ │
│                            ▲                   │            ▲                                  │
│  增量只存"权威源没写的" ───┤                   │            │ 蒸馏自原文                        │
│                            │                   │            │                                  │
│  ┌────────────────────────────────────────────┴─┐  ┌───────┴─────────────┐                    │
│  │       第一层 · 原文录像层（lossless，可选）    │  │ 插件自有 SQLite      │                    │
│  │  数据库无损留存全部对话原文（SQLite）          │  │ anchor/投入度/压缩    │                    │
│  │  要精确细节 → 召回工具查原文，不靠猜          │  │ 台账                 │                    │
│  └──────────────────────────────────────────────┘  └─────────────────────┘                    │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

一句话概括三层分工：

| 层次 | 位置 | 干什么 | 读它 |
| --- | --- | --- | --- |
| **第一层 原文录像** | 数据库（SQLite，lossless 插件产物） | 对话原文无损留存，不丢字 | "当时具体说了什么/细节"→召回工具查原文 |
| **第二层 蒸馏智慧** | `memory/*.md` + `MEMORY.md`/`USER.md` | 只存值得蒸馏的精华（决策/教训/新知识/长期档案），不抄流水账 | "我学过什么/规则是什么"→读蒸馏层 |
| **第三层 多维抽屉** | `memory/dim/0X-*.md` | 按维度分类的轻量词条，只存增量 + 指向原文的指针 | "最近这维度怎么样/怎么演变的"→读维度 |

再补两个贯穿性的核心文件：

- **`MEMORY.md`** —— 长期记忆，蒸馏后的知识（规则、关系档案、重要决策）。从近期每日笔记定期蒸溜上来，是整个架构的「顶层」。
- **`USER.md`** —— 关于你（用户）的稳定长期档案：习惯、偏好、设备/环境变化。与 MEMORY 并列，是「权威源」之一。

> 💡 **互补原则（重要）**：`SOUL.md`/`USER.md`/`MEMORY.md` 是**权威源**，同一条内容只写一处、不重复；`memory/dim/` 是**增量抽屉**，只存权威源没写的增量、或指向权威源原文的 `→ 来源` 指针。问"此刻是谁"读权威源，问"怎么变成这样/最近怎么样"读维度层。

---

### 2. agent 要先自建的「基础配置」清单（地基）

**这一步必须 agent 自己先建，不靠插件。** 插件是建在这套文件结构上的工具；没有地基，插件无从写起。

### 2.1 目录 / 文件结构

推荐在主工作区（`workspaceDir`）下建出如下结构：

```
<workspaceDir>/
├─ MEMORY.md                 # 长期记忆 · 蒸馏智慧（顶层，必建）
├─ USER.md                   # 关于你的稳定长期档案（必建）
└─ memory/
   ├─ YYYY-MM-DD.md          # 每日蒸馏笔记（自动/手动落盘）
   ├─ .index.jsonl           # 关键词→长期记忆条目指针（秒读不烧 token）
   ├─ events/                # 压缩提炼的归档目录（插件产出，可预建）
   └─ dim/                   # 第三层多维抽屉（可先建，或让插件建）
      ├─ 00-startup.md
      ├─ 01-emotional.md
      ├─ 02-self.md
      ├─ 03-projects.md
      ├─ 04-ops.md
      └─ 05-xxx.md           # 维度可自定义命名
```

> `dim/` 里的维度命名**不是固定死的**——`00..04` 是生产验证过的高价值维度（启动 / 情感 / 自我 / 项目 / 运维），`05` 起可自由扩展为适合你的维度类别。上述结构是**推荐初始化模板**，你完全可以只建 01-情感 + 03-项目 两个就先开局，后续按需补。

### 2.2 核心文件初始化模板

**`MEMORY.md`**（长期记忆，蒸馏智慧）——起步可以留一个骨架：

```markdown
# MEMORY（长期记忆 · 蒸馏智慧）

> 蒸馏后的知识：规则、关系档案、重要决策。从近期 daily notes 定期提上来。
> 权威源之一，内容只写一处、不重复。

### 关系记录
（里程碑式的关系节点、承诺、默契）

### 规则与红线
（行为规则、调教规则、不容触碰的底线）

### 重要决定
（重大走向、拍板结论）

### 长期档案
（团队/项目/凭证索引，指向细节处）
```

**`USER.md`**（关于你的稳定长期档案）：

```markdown
# USER（关于你 · 长期档案）

### 习惯与偏好
### 设备与环境
### 当下动态
### 重要约定
```

**`memory/YYYY-MM-DD.md`**（每日蒸馏笔记）——记**精华**不记流水账：

```markdown
# 2026-08-11 蒸馏笔记

### 决策
- ……

### 教训
- ……

### 新知识
- ……

### 变更
- ……
```

> 注意：每日笔记是**蒸馏层**，只存"我学会了什么 / 决定了什么"，不抄对话流水。原文交给 lossless（第一层）。

**`memory/dim/01-emotional.md`**（情感维度词条模板）——记「心」不记「事」：

```markdown
# dim/01 · 情感

### 2026-08-11 14:30 · <一句话标题>
- **关键词**：……
- **关键句**："……"(原话)
- **感受**：……
- **→ 来源**：(指向权威源原文，不重复贴)
```

### 2.3 自建时的核心纪律

- **写下来，没有"记在心里"这回事。** 重要决策/教训/新知识 → 写 `memory/YYYY-MM-DD.md`；学到教训 → 更新 `MEMORY.md`/`USER.md`/相关规则文件。
- **不抄对话流水。** 原文有 lossless 兜底，笔记只存蒸馏过的精华，避免重复劳动。
- **金字塔式提拔。** 维度层（dim/）最新增量 → 足够稳定 → 一层层往上提（原则级共识→MEMORY/规则；长期档案→USER/MEMORY）。提走后在维度层留 `→ 已提升至X` 指针，不重复。

---

### 3. 怎么对接插件、直接走仓库版本升级

**建好上面这套基础结构后，memory-engine 插件是直接叠上去的，它认识这个结构、读写这套文件。** 具体对接关系如下：

### 3.1 插件如何读写这套结构（不碰机制文件）

| 插件行为 | 机制文件 | 说明 |
| --- | --- | --- |
| **读取** | `/AGENTS.md` `MEMORY.md` `USER.md` `/memory/` | 预拉阶段读取记忆线索注入上下文；蒸馏提拔前读取现有顶层避免重复 |
| **附加式写入追加** | `MEMORY.md`/`USER.md`、`memory/dim/*`、`memory/events/`、`memory/*.jsonl` | 一律**追加**，不改写已有内容；写前自动**备份**（可 `mem_rollback` 回退） |
| **独立建库** | `memory-engine.db`（插件自有 sqlite） | 锚点/投入度/压缩台账/审计放插件自己的库，**不碰** openclaw 状态文件 |
| **只读打通（可选）** | `lcm.db`（lossless 产物） | 只读；没有则自动降级，功能完整 |
| **绝不触碰** | `openclaw.json`、`AGENTS.md`、`USER.md` 的机制段、`tasks`、`lcm.db` 写 | 这些是禁区，插件从不改写 |

> 也就是说：**基础结构由 agent 负责维护内容，插件帮 agent"自动决策写哪 / 何时想起 / 何时压缩"，但写到哪去、落到哪个文件，走的正是你自建的那套结构。**

### 3.2 升级就是「走仓库版本」

因为插件只读取/追加这套标准结构、不占坑不动地基，所以：

1. **首次接入**：把仓库放到插件目录 → 登记启用 → 按需开 `enable_*` 开关 → 重启生效（详见第 4 节安装 / 第 4.5 节预设）。
2. **后续升级**：**直接拉取仓库新版即可**——插件的读写都对着这套基础结构，与版本无关，升级不破坏你已经积累的记忆文件。
3. **配置变更后**：`npm run build`（dist 是实际加载）+ 重启插件宿主才生效。

> ⚠️ **先自建、再装插件、再谈升级**，顺序别反。没有地基的插件 = 工具没处落笔，蒸馏出来的东西无处归档。

---

### 4. 多角色分工（自建时参考，可选）

本架构在生产中默认由多个角色各自负责一块，你可按单人/多 agent 场景简化为"都由自己做"或分配给不同 agent：

- **基础结构自建** → 每个 agent 自己（第一步就完成，不外包）。
- **蒸馏出的决策 / 知识** → 谁做的谁提，别挂靠他人复盘。
- **情感节点（记"心"）** → 当场落 `dim/01-emotional.md`、里程碑当场提 `MEMORY.md`，不排队等落盘。
- **压缩归档 / 落盘兜底 / 自进化提案** → 交给插件后台（开启对应 `enable_*`）。

---

### 5. 常见问题（FAQ）

**Q：不建基础结构直接装插件能用吗？**
能装上、能跑，但"蒸馏提拔"无处归档、"预拉"无根可拉——插件作用大打折扣。**强烈建议先自建第 2 节的地基**。

**Q：维度一定得建 6 个吗？**
不必。`00..04` 是生产验证的高价值维度，`05` 起自由扩展。从最需要的 1~2 个维度开局即可，后续按需补。

**Q：`memory/.index.jsonl` 要手动维护吗？**
可手写，更推荐让插件/定期落盘替你登记维护。它只索引蒸馏层关键词→指针，秒读不烧 token。

**Q：手写内容会不会和插件自动写冲突？**
不会。互补原则保证"权威源只写一处"，插件只做追加 + 写前备份，从不覆盖已有条目；冲突场景可 `mem_rollback` 回退。

---

> **下一步**：建好地基后，直接跳到本 README 的「安装 / 接入方法」与「配置预设」，选一套 `enable_*` 组合叠上去，然后按第 3.2 节走仓库版本升级即可。

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
