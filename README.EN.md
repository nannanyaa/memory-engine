# memory-engine — A Generic Memory Decision Engine Plugin for OpenClaw

> **Who is this for**: any agent / maintainer who wants to integrate, configure, or extend this plugin. After reading you should know — **what it is, what it injects into your context, how to enable it, what every config field means, and where to change the code**.
>
> **One-liner**: a **generic memory decision engine plugin** for [OpenClaw](https://github.com/), pure-hook, works in the background. It automates the memory decisions — *what to remember, when to recall, when to compact* — and **never blocks your message path**.

---

## 0. Core Rules (read these four first)

1. **Never blocks the message path** — all heavy work (LLM classification / embedding / semantic scoring / compaction / disk writes) is deferred to background tasks. The hook itself returns synchronously and fast; it never slows down a conversation.
2. **Compaction is "distill & archive", not "delete"** — when an old topic triggers compaction it is distilled into a compact memory entry and archived. Source content is folded, not lost; it is deduped and rollback-able.
3. **All switches are independent** — every feature has its own `enable_*` flag, all default `false`, free to combine, enabled one module at a time.
4. **Never touches mechanism files** — it never rewrites `openclaw.json` / `AGENTS.md` / `MEMORY.md` / `USER.md` / `tasks` / `lcm.db` (lcm is read-only); it only writes its own `memory-engine.db` + append-only memory files, always backed up before writing.

---

## 0.5 Optional Dependencies (read this first)

This plugin is **self-sufficient and runs standalone** with no hard prerequisite plugins. OpenClaw's existing conversation store (`lcm.db`, i.e. the artifact of the lossless plugin) is an **optional enhancement**, not a requirement:

- **With** `lcm.db`: it read-only integrates the historical message store — `mem_find` retrieval is stronger and the compaction window can backfill historical context.
- **Without** it: it degrades gracefully — the compaction trigger reads the real-time context snapshot, and Chinese retrieval uses the plugin's own `memory-engine.db` FTS index. All features remain functional; you only lose the read-only historical enhancement.

In other words: **users who never installed lossless can install and use it immediately; those who did get historical retrieval enhancement** — no extra configuration needed.

---

## 1. What Is This (30-second overview)

It does the following automatically in the background (one capability per line):

- **Memory distillation & promotion** — tracks engagement per *semantic topic segment*; high-engagement items are auto-registered as promotion candidates to `MEMORY.md` / `USER.md` (with pre-write self-review to prevent semantic drift).
- **Emotion recognition · 3-layer remembering** — LLM-classifies emotional moments: ① record to `dim/01-emotional.md` (original words + feeling + source) → ② milestone-level promoted to `MEMORY.md` (P2 pending confirmation) → ③ written to the emotion-anchor table for preloading.
- **Memory preload / recall** — at `before_prompt_build`, proactively injects key memories (emotion anchors + high-engagement + periodic checks) into context, with lifecycle (won't nag after being absorbed) and cooldown.
- **Context compaction & archiving** — event-aware topic-switch detection + length threshold fallback; old topics distilled and archived to `memory/events/`, optionally with assemble-summarize replacement to truly reduce the message tokens sent to the model.
- **Daily digest fallback + nightly self-evolution proposals** — (optional) daily cron digest fallback + index integrity check; nightly review produces semi-automatic evolution proposals.

---

## 2. What It Injects Into Your Context (treat it this way)

During preload, the plugin wraps injected blocks in a uniform tag:

- **Injection tag**: default **`<memory-engine-memories>`** (configurable via `injectTag`).
- **Content**: the memories most worth recalling right now (emotion anchors, high-engagement topics, periodic checks), bounded by `injectMaxChars` (default 1200 chars) to avoid burning context.
- **What the agent should do**: **read this block as real input and take it seriously, not as noise**. It is the memory clue the engine ranked as "most relevant right now", for you to recall and reference naturally. It is detachable (wrapped by `injectTag`), so you can safely ignore it if not needed.

> If you enable OpenClaw-side injection stripping (`stripInjectedContextTags`), a matching wrapper tag is sensed together — they don't conflict.

---

## 3. Capability Modules × `enable_*` Switch Quick Reference

All switches default **`false`**. The corresponding hook/tool is registered only when enabled.

| Module | What it does | Switch | Default | When to enable |
| --- | --- | --- | --- | --- |
| Emotion engine | 3-layer remembering + dual-track emotion anchors (LLM-classified) | `enable_emotion` | false | When you want the agent to remember "light but important" emotional expressions |
| Memory · distillation promotion | engagement counting + auto-promotion to MEMORY/USER | `enable_memory_promotion` | false | When you want high-frequency/high-engagement topics to settle into long-term memory |
| Retrieval · preload | pre-warm key memories with lifecycle | `enable_recall` | false | When you want the agent to remember what it should at start-up |
| Semantic vector retrieval | lancedb + cloud embedding, semantic `mem_find` | `enable_semantic_vector` | false | To fix "keyword mismatch → missed match"; **requires `enable_recall`** to take effect |
| Event-aware context compaction | avgSim topic-switch + length fallback, distill & archive | `enable_context_compaction` | false | When you want long sessions to automatically slim down without losing info |
| Assemble summarize | fold oldest segment into a summary block when over budget | `enable_context_summarize` | false | To truly reduce "message tokens sent to the model"; **requires `enable_context_compaction`** |
| Scheduled digest fallback | daily cron digest + index check | `enable_daily_digest` | false | To guarantee today's memory gets persisted |
| Self-evolution engine | nightly review → semi-automatic proposals | `enable_self_evolve` | false | When you want it to propose improvements that you review then apply |

---

## 4. Installation / Integration

```bash
npm install
npm run build        # esbuild bundle → dist/index.js
npm run typecheck    # tsc --noEmit (requires local OpenClaw SDK types)
```

1. Place this repo in your OpenClaw plugins directory (e.g. `~/.openclaw/plugins/memory-engine/`). The repo ships compiled `dist/index.js`, so it **loads without building**.
2. Register the plugin in OpenClaw's plugin-enabled config (`openclaw.plugin.json` already declares `contracts.tools` / `configSchema` / `activation.onStartup`, which the SDK reads).
3. After enabling, set the `enable_*` switches you want to `true`.
4. **Restart OpenClaw for registration to take effect** (also needed after toggling module switches to re-register hooks/tools/crons).

---

## 5. Configuration Reference (field / type / default / meaning / rationale)

> This table doubles as the plugin's "design-decisions" manual for its tunable algorithms. Every field is defined in `openclaw.plugin.json`'s `configSchema`.

### 5.1 Module switches (top-level booleans, all default false)
See the quick-reference in §3. Switches combine freely; coupling constraints are noted in the table (`enable_semantic_vector` needs `enable_recall`; `enable_context_summarize` needs `enable_context_compaction`).

### 5.2 Paths & Injection
| Field | Type | Default | Meaning / rationale |
| --- | --- | --- | --- |
| `workspaceDir` | string | gateway's `ctx.workspaceDir` | Main workspace (holds `MEMORY.md`/`USER.md`/`memory/`). Not hardcoded — follows the runtime environment. |
| `engineDbPath` | string | `<stateDir>/memory-engine.db` | Plugin's own independent sqlite. **Separate DB** so it never touches OpenClaw's own state files. |
| `lcmDbPath` | string | `<stateDir>/lcm.db` | OpenClaw's existing conversation store, **read-only integration**. |
| `injectTag` | string | `memory-engine-memories` | Wrapper tag for the preload injection block, see §2. |
| `injectMaxChars` | int | `1200` | Max chars injected per preload, to avoid burning context. |
| `rollbackBackupDir` | string | `<stateDir>/.memory-engine-rollback` | Pre-write backup dir, used by the rollback mechanism. |

### 5.3 Retrieval / preload (`recall`)
| Field | Type | Default | Meaning / rationale |
| --- | --- | --- | --- |
| `maxHighEngagementPreloads` | int | `3` | How many times a high-engagement topic may be preloaded before it drops off the "to-announce" list. **Has lifecycle**: once absorbed it won't re-nag, avoiding repeating the same topic every conversation. 0 = never expires. |
| `anchorCooldownMs` | int | `12h` | Minimum gap between two preloads of the same non-milestone anchor; **milestones are always re-anchored, never rate-limited**. |

### 5.4 Emotion engine (`emotion`)
| Field | Type | Default | Meaning / rationale |
| --- | --- | --- | --- |
| `llmBaseUrl` / `llmModel` / `llmApiKey` | string | empty / `openai/gpt-4o-mini` / empty | Classification LLM (OpenAI-compatible). **Decision: use a model, no rule gate** — rely on LLM semantic understanding rather than keyword rules. When missing, safely degrades to "not an emotion node". |
| `milestoneRequiresSecondPass` | bool | `true` | Whether milestone-level requires a second confirmation pass. |
| `minCharsToClassify` | int | `0` | Messages shorter than this are not sent for classification. |
| `attachBelow` | float | `0.5` | Confidence threshold to attach an emotional record to disk. |
| `milestoneMinConfidence` | float | `0.85` | Confidence threshold for a milestone; below this it is not recorded as a milestone. |

### 5.5 Semantic vector (`vector`)
| Field | Type | Default | Meaning / rationale |
| --- | --- | --- | --- |
| `dbPath` | string | `<stateDir>/memory-engine-vector` | LanceDB vector DB path. |
| `embeddingBaseUrl` | string | empty (**must configure**) | Base URL of any **OpenAI-compatible** embedding API (no trailing `/`). |
| `embeddingModel` | string | empty (**must configure**) | The embedding model name under that provider. |
| `embeddingApiKey` | string | empty | The provider's API key (only if it authenticates). |
| `topK` | int | `3` | Default number of results returned by `mem_find`. |

> ⚠️ **Embedding must be explicitly configured**: the plugin does **not bake in or preset any third-party embedding service**. When `embeddingBaseUrl`/`embeddingModel` are empty, the semantic vector module auto-disables and falls back to keyword FTS retrieval (still functional, just keyword-granularity). The default is intentionally empty to avoid silently pointing at any one vendor.
>
> **Any OpenAI-compatible embedding API works** (`POST {baseUrl}/embeddings`, returns `data[].embedding`). Common provider examples:
>
> | Provider | Base URL | Example Model | Get key |
> | --- | --- | --- | --- |
> | Zhipu AI | `https://open.bigmodel.cn/api/paas/v4` | `embedding-2` | Zhipu console → API Keys |
> | OpenAI | `https://api.openai.com/v1` | `text-embedding-3-small` | OpenAI platform → API keys |
> | Alibaba DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `text-embedding-v3` | DashScope |
> | SiliconFlow | `https://api.siliconflow.cn/v1` | `BAAI/bge-m3` | SiliconFlow console |
> | Local Ollama | `http://localhost:11434/v1` | `nomic-embed-text` | No key needed |
>
> Config example (`memory-engine` plugin `vector` section in `openclaw.json`):
> ```json
> { "vector": { "embeddingBaseUrl": "https://open.bigmodel.cn/api/paas/v4", "embeddingModel": "embedding-2", "embeddingApiKey": "<your-key>" } }
> ```

### 5.6 Self-evolution (`selfEvolve`)
| Field | Type | Default | Meaning / rationale |
| --- | --- | --- | --- |
| `proposalDir` | string | `<workspaceDir>/.rules/memory-engine-proposals` | Where proposals land. |
| `cronExpr` | string | `0 3 * * *` | Nightly review cron. |
| `timezone` | string | `Asia/Shanghai` | Timezone. |
| **Semi-automatic decision** | — | — | **Produces proposals autonomously, but by default does not change files or mechanism**; change points + reasons are written into the proposal, and need confirmation (via `mem_rollback` or manual) before applying — fully rollback-able. |

### 5.7 Scheduled digest
| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `dailyDigestCron` | string | `50 23 * * *` | Daily digest fallback cron. |

### 5.8 Context compaction (`compaction`) — the algorithm decision core
| Field | Type | Default | Meaning / rationale |
| --- | --- | --- | --- |
| `windowSize` | int | `10` | Relevance-scoring sliding window (previous N turns). |
| `relevanceThreshold` | float | `0.30` | Floor: `avgSim >= this` = clearly same event, **never a switch**. Within-topic avgSim median ≈ 0.345, so 0.30 protects most within-topic turns. |
| `avgSimSwitchThreshold` | float | `0.26` | **Primary switch line**: `avgSim <= this` = topic switch. Calibrated optimal discriminant ≈ 0.26. |
| `dropThreshold` | float | `0.74` | Mirror of `drop = 1 - avgSim`, same as the switch line (= 1 − 0.26), display-only, not an independent trigger, avoids dual-threshold conflict. |
| `recentWindowForInternal` | int | `5` | How many recent turns avgSim uses; also the internal soft-signal window. |
| `internalRelevanceThreshold` | float | `0.35` | Recent internal relevance soft signal: **weak discriminator, not a hard gate**, only helps avoid under-firing. |
| `minSamples` | int | `5` | Minimum samples required before a switch decision; below this, no trigger. |
| `lengthThreshold` | float | `0.20` | **Length fallback trigger**: compact when context usage ≥ this ratio. **Core decision: use "real context ratio", not compaction-window chars** — otherwise long sessions never trigger. |
| `contextTokenBudget` | int | `920000` | Context token budget, denominator for the length check; at runtime prefers OpenClaw's official parsed budget. |
| `contextToolOverheadTokens` | int | `45000` | Fixed tool-schema token overhead (to complete "system prompt + tools" base). 0 = off. Tune to your real toolset. |
| `backfillWindowSize` | int | `40` | **Backfill window**: on start, load the recent 40 turns from existing session history. **Without backfill it would "start counting only from the first message after plugin load"**, so an already-over-threshold context would never compact. |
| `backfillSessionKey` | string | `agent:main:main` | Target session key to backfill (= your main session key). Empty = skip backfill. |
| `llmTimeoutMs` / `embeddingTimeoutMs` | int | `20000` / `10000` | LLM / embedding hard timeouts. |
| `archiveDir` | string | `<workspaceDir>/memory/events` | Distill-archive directory. |
| `segmentChars` | int | `5600` | Max chars per segment when distilling (to avoid truncating one window); overlong old topics are split into segments, distilled separately, then reassembled — **no info lost**. |
| `maxSegmentsPerArchive` | int | `45` | Max segments per archive pass; forces closure if exceeded, **protects against maliciously long sessions spamming the LLM**. |
| `maxQueue` | int | `100` | Background compaction queue cap; if full, drops the oldest (can be re-picked up by a later trigger). |
| `maxCompactionsPerMinute` | int | `6` | Max compactions per 60s, to avoid slamming CPU/LLM. |
| `memoryHighWaterMB` | int | `512` | heapUsed high-water mark; pauses while over, waiting for memory to free. 0 = off. |
| `memoryPollMs` | int | `5000` | High-water polling interval. |
| `summarizeRatioThreshold` | float | `0.30` | Assemble-summarize trigger ratio (= estimated message tokens / budget). |
| `summarizeTargetRatio` | float | `0.15` | **Landing point**: after the trigger, compress back to this ratio (sawtooth: trigger → settle). |
| `summarizeMinOldMessages` | int | `6` | Minimum oldest messages to fold in one replacement. |
| `summarizeMaxChars` | int | `1500` | Max chars of a single synthesized summary block, to avoid over-blowing it. |

---

## 6. Architecture Overview (src module map + responsibilities)

```
index.ts                 entry point (definePluginEntry)
src/
├─ registry.ts           registers hook / tool / cron per enable_* gate
├─ runtime.ts / config.ts  runtime context + config normalization (defaults, coupling)
├─ writers.ts            memory-file write gateway (append-only + backup + change log, rollback-able)
├─ llm.ts                minimal OpenAI-compatible LLM client (classify/distill/free-text, safe degrade)
├─ log.ts / time.ts      structured logging + time-window utilities
├─ cn-tokenize.ts / cn-fts.ts  Chinese token estimate + lightweight FTS (retrieval cleaning)
├─ tools.ts              built-in tool registration (mem_find/promote/rollback/status/compact)
├─ db/
│  ├─ engine-db.ts       plugin's own sqlite (anchors / engagement / compaction window / ledger / audit)
│  └─ lcm-read.ts        read-only access to OpenClaw's existing conversation store (lcm.db)
└─ modules/
   ├─ emotion.ts         3-layer remembering + emotion anchors (fixed / scenario dual-track)
   ├─ memory.ts          semantic-topic engagement + distillation promotion + pre-write self-review
   ├─ recall.ts          preload injection + lifecycle / cooldown
   ├─ vector.ts          lancedb + cloud embedding semantic retrieval
   ├─ compaction.ts      avgSim topic-switch + length trigger + background compaction / distill / archive
   ├─ context-engine.ts  B-path: contextEngine slot takeover (optional, safe/deferred)
   ├─ context-tokens.ts  per-run real context usage capture (primary data source for the trigger, independent of lcm.db)
   ├─ daily.ts           daily digest fallback + index integrity check
   └─ selfevolve.ts      nightly self-evolution proposals
```

Built-in tool quick reference:
- `mem_find` — search memory (`query` / `limit`).
- `mem_status` — switch overview / emotion anchors (`detail=anchors`) / engagement (`detail=engagement`).
- `mem_promote` — manually promote an emotion anchor into `MEMORY.md`/`USER.md` (ledger-recorded).
- `mem_rollback` — undo an already-promoted mark, roll back automatic changes.
- `mem_compact` — trigger one compaction for a session (`limit` keeps the recent N turns).

---

## 7. Development / How to Modify (where to start)

- **Only tuning thresholds/defaults**: edit the field defaults in `normalizeConfig` in `src/config.ts`; also sync `openclaw.plugin.json`'s `configSchema` so the CLI/Web panel shows them as configurable.
- **Add a feature module**: follow the existing `modules/xxx.ts` pattern (e.g. `emotion.ts` or `daily.ts`) in three steps —
  1. Add an `enable_xxx` switch + default `false` in `src/config.ts`;
  2. Implement the module (pure functions + background-task discipline: never `await` network/LLM inside your hook);
  3. Register the corresponding hook/tool/cron in `src/registry.ts`.
- **Tune the compaction algorithm**: edit `detectTopicSwitch` / the length trigger in `src/modules/compaction.ts`; parameterize what you can via the `compaction.*` config.
- **Change context-usage check**: the core is in `src/modules/context-tokens.ts` (numerator = base + tools + message estimate; denominator = official budget).
- **Build / test**:
  ```bash
  npm run build      # → dist/index.js
  npm run typecheck  # → tsc noEmit
  node test/run-tests.mjs        # unit + algorithm matrix (temp dir, never touches production DBs)
  npx tsx test/run-tests.ts
  ```
  Test coverage: config normalization / switch coupling, time-window partitioning, cosine similarity, topic-switch detection, token estimation, FTS cleaning, engine-db CRUD, preload lifecycle, index schema. For read-only smoke tests against a real DB, set the `LCM_DB_PATH` / `MEMORY_INDEX_PATH` environment variables.

**Three iron rules when modifying**: ① never block the message path (heavy work must go to the background); ② back up and stay rollback-able before shortening/writing; ③ don't touch mechanism files, don't grab the contextEngine/memory slot.

---

## 8. Maintainer / License

- **License**: [MIT](./package.json).
- Project principle: "stability first, semi-automatic evolution" — self-evolution only produces proposals, never auto-applies; automatic writes are always append + backed up + rollback-able.
- Contributions welcome per §7; for major algorithm changes please update this README's config manual and rationale as well.

### Authors & Credits

- **Author / Design lead**: Lingxiao (绫潇) — concept, architecture and core algorithm design.
- **Project partner**: nannan — requirements, direction and acceptance.
- **Implementation**: Luo Su (落苏) — coding and algorithm implementation.
- **Security & quality review**: Zhi An (知安) — security and config consistency.

> Born from a personal team's self-built practice, open-sourced to give back; Star / Issue / PR are welcome.
