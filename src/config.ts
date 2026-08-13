/**
 * config.ts — memory-engine 配置解析
 *
 * 每个功能模块独立 enable_* 开关，默认全部 false。
 * 路径类配置默认取 gateway_start 的 ctx.workspaceDir / stateDir 解析后的实际值。
 */

export interface MemoryEngineConfig {
  // —— 模块独立开关（全默认 false）——
  enable_emotion: boolean;
  enable_memory_promotion: boolean;
  enable_recall: boolean;
  enable_self_evolve: boolean;
  enable_semantic_vector: boolean;
  enable_daily_digest: boolean;
  enable_context_compaction: boolean;
  /**
   * assemble 摘要替换开关（默认关）。
   * 开：context-engine 的 assemble 收到超预算消息时，把最老段用摘要块替换返回，
   *     让"真正发给模型的那份 messages" token 下降、占比能降（治 32% 不降的根）。
   * 关：assemble 保持原样透传（行为不变，可回滚）。
   */
  enable_context_summarize: boolean;

  // —— 路径/注入 ——
  workspaceDir: string;
  stateDir: string;
  engineDbPath: string;
  lcmDbPath: string;
  injectTag: string;
  injectMaxChars: number;
  rollbackBackupDir: string;

  // —— 记忆引擎 B 投入度阈值 ——
  engagement: {
    minTurns: number;
    minTimeWindows: number;
    minTokens: number;
  };

  // —— 记忆晋升 · 价值判定（2026-08-13 南南拍板：六维加权 + 硬门槛 + 绫潇终审） ——
  // 量纲约定（知安 C3）：
  //   scoreThreshold（0.50） = 六维 valueScore（0~1 加权分）
  //   strongReleaseConfidence（0.80）/ nightlyAutoApplyConfidence（0.85） = LLM 四类分类 confidence（另一坐标）
  //   三者量纲不同，严禁混用同一变量。
  promotion: {
    scoreThreshold: number;            // 六维 valueScore 硬门槛，默认 0.50
    weights: {
      relevance: number;               // 0.30 是否命中四类事实
      consolidation: number;           // 0.24 唯一/去重价值
      recency: number;                 // 0.15 新鲜度
      frequency: number;               // 0.14 投入度热度
      queryDiversity: number;          // 0.10 话题延续（跨段）
      richness: number;                // 0.07 概念富度
    };
    trivialFilter: boolean;            // 直接剔琐事开关，默认 true
    funnelMaxPerTopic: number;         // 同 topic 未 apply 前提案上限，默认 1
    strongReleaseConfidence: number;   // 强放行例外：conf≥此值(LLM分类置信度)放行，默认 0.80
    nightlyAutoApplyConfidence: number; // 夜间 high-conf 自动 apply 线(LLM分类置信度)，默认 0.85
    requireHumanReview: boolean;       // 绫潇终审闸门，默认 true
    staleHours: number;                // 24h 超时兜底（未审滞留时长），默认 24
  };

  // —— 检索引擎预拉生命周期（README：预拉有生命周期，消化了就不反复报）——
  recall: {
    /** 高投入主题最多被预拉几次；达到后自动从"待报榜单"降级清出。0=永不过期（恢复旧行为）。 */
    maxHighEngagementPreloads: number;
    /** 情感锚点预拉冷却：同一非里程碑锚点两次预拉间隔下限(ms)。里程碑(milestone)始终重锚、不受限。0=不冷却。 */
    anchorCooldownMs: number;
  };

  // —— 情感引擎 ——
  emotion: {
    llmBaseUrl: string;
    llmModel: string;
    llmApiKey: string;
    milestoneRequiresSecondPass: boolean;
    minCharsToClassify: number;
    // —— 13 维新增（内部阈值，默认不改现有行为）——
    attachBelow: number;              // 情感落盘信心门槛，默认 0.5
    milestoneMinConfidence: number;   // 里程碑 confidence 门槛，默认 0.85
  };

  // —— 语义向量 ——
  vector: {
    dbPath: string;
    embeddingBaseUrl: string;
    embeddingModel: string;
    embeddingApiKey: string;
    topK: number;
  };

  // —— 自进化引擎 ——
  selfEvolve: {
    proposalDir: string;
    cronExpr: string;
    timezone: string;
  };

  // —— 落盘兜底 cron ——
  dailyDigestCron: string;

// —— 事件感知上下文压缩引擎 ——
// 阈值均基于真实会话关联性标定（bench/calibrate-threshold.mjs + analyze-thresholds.mjs + validate-avgsim.mjs）：
//   B 方向算法主线 = 前段平均相似度 avgSim（新轮 vs 前段最近 K 轮均值）。
//   真实话题切换点 avgSim 中位≈0.24（p10 0.21 / p90 0.32），话题内中位≈0.345（p10 0.26 / p90 0.49），
//   drop=1-avgSim：边界中位≈0.75 vs 话题内≈0.65。avgSim/drop 是判别力最强的信号。
//   internal（近K轮两两）几乎无区分（边界 0.374 vs 话题内 0.367）→ 仅作软信号，不作硬门槛。
//
//   判切换语义（detectTopicSwitch）：
//     衬底 relevanceThreshold：avgSim>=此值 → 明确同事件，绝不判切换（保留）。
//     主判据 avgSimSwitchThreshold：avgSim<=此值 → 话题切换信号 → 旧段压缩。
//     （0.26~0.30 之间为模糊区，默认放行不压，防误伤。）
//   旧默认 relevanceThreshold=0.6 拍脑袋过高（92% 话题内相邻对 <0.6）；
//   internalRelevanceThreshold=0.7 在真实数据上 0 次满足 → 算法整套哑火（必修 bug），故弱化+改低。
  compaction: {
    windowSize: number; // 相关性打分滑动窗口（前 N 轮，默认 10）
    relevanceThreshold: number; // 衬底：avgSim>=此值判定明确同事件、不压缩（实测话题内中位≈0.345，取 0.30 保护多数话题内轮）
    avgSimSwitchThreshold: number; // 主判据切换线：avgSim<=此值判话题切换（实测边界中位≈0.24、最优判别点≈0.26）
    lengthThreshold: number; // 上下文长度阈值兜底（南南定 0.20=20%），超则压缩。用于常规后台压缩触发线。
    emergencySyncThreshold: number; // 紧急同步压缩兜底阈值（南南定默认 0.50，不可更大）。上下文占比不低于此值时，强制同步压缩一次，防上下文爆掉。0=关闭。
    dropThreshold: number; // avgSim 切换线的 drop 镜像视图：drop=1-avgSim>=此值 等价于 avgSim<=切换线（保持单向、纯展示）
    recentWindowForInternal: number; // 前段窗口（avgSim 取最近几轮，同时作内部相关软信号窗口）
    internalRelevanceThreshold: number; // 近轮内部相关软信号（判别力弱，不再硬性门槛；仅辅助，防哑火）
    minSamples: number; // 话题切换判定所需最小样本数
    /** 长度触发用的上下文 token 预算（真实会话预算）。0/未给时用
        保守默认 128000，并优先接受 ctx.contextTokenBudget / lcm 会话实测 token 覆盖。 */
    contextTokenBudget: number;
    /**
     * 工具定义(工具 schema)在上下文里的固定 token 开销。
     * openclaw 不把这些精确暴露给插件；本模块用它补足「系统提示+工具」这一固定基底，
     * 使 0.22 长度判据能按真实上下文量级触发（2026-08-09 根因：旧判据依赖已删 lcm.db）。
     * 0=关闭（仅按运行时实测基底 + 会话消息估算）。不精确，需按真实工具集调校。
     */
    contextToolOverheadTokens: number;
    /** 启动时从现有会话历史回填窗口的最多轮数（南南要求：一旦加载即能按现有上下文检测压缩）。 */
    backfillWindowSize: number;
    /** 回填时用于识别主会话的 session_key（如 agent:main:main）。空则跳过回填。 */
    backfillSessionKey: string;
    llmTimeoutMs: number; // 摘要/提炼硬超时(ms)
    embeddingTimeoutMs: number; // embedding 硬超时(ms)
    archiveDir: string; // 提炼归档目录（默认 memory/events/）
    /** 分段压缩：单段提炼输入上限（字符，<=distill 窗口，防超窗截断）。
        超长旧话题按段切分各自提炼后拼接归档，不丢信息。 */
    segmentChars: number;
    /** 分段压缩：单次归档最多切几段；超上限则只切前 maxSegments 段 + 尾段摘要兜底，
        防恶意超长会话导致无限次 LLM 调用。 */
    maxSegmentsPerArchive: number;
    /** 资源控制：后台压缩任务队列上限；满则丢弃最旧（丢弃可被后续长度/话题触发重拾）。 */
    maxQueue: number;
    /** 资源控制：单时间窗（60s）内最多触发几次压缩（防连续大任务挤爆 CPU/LLM）。 */
    maxCompactionsPerMinute: number;
    /** 资源控制：压缩前检查 heapUsed，超过该水位(单位 MB)则暂停/降频，等内存释放再继续。
        0=不启用内存水位保护。 */
    memoryHighWaterMB: number;
    /** 资源控制：内存高水位时轮询等待间隔(ms)，等释放后再继续压缩。 */
    memoryPollMs: number;
    guardWindowMs: number; // 【P0】【P0修复-会话活跃守卫】transcript 重写前的最小闲置毫秒数；会话活跃(距最后run < 此值)则跳过重写，等闲置再压。默认 3000ms。
    promptEstimateCorrection: number; // 【过早触发修复】before_prompt_build 对完整 prompt 的 token 估算校正系数(<1=压低)。实测估算比真实上下文偏高约1.48x(19.7%真实→0.292估算)，默认0.7把它拉回贴近真实，避免误触发压缩。1=不校正。
    /**
     * assemble 摘要替换触发阈值：messages 估算 token / tokenBudget >= 此值才摘要替换（默认 0.22）。
     * 与 lengthThreshold 同源同语义（真按上下文占比触发），是 assemble 摘要替换的独立阈值。
     */
    summarizeRatioThreshold: number;
    /** assemble 摘要替换：一次替换至少折叠多少条最老消息（不足则不动）。默认 6。 */
    summarizeMinOldMessages: number;
    /** assemble 摘要替换：单条合成摘要块的文本上限（字符，防把摘要又写爆）。默认 1500。 */
    summarizeMaxChars: number;
    /**
     * 方案 A：压缩落点目标占比（锯齿形：超 summarizeRatioThreshold 触发 → 压回到此值）。
     * 南南拍板：触发线 0.30、落点 0.15（Web 端"已用/预算"上下文占比据此压缩）。默认 0.15。
     */
    summarizeTargetRatio: number;
  };
}

export const MODULE_KEYS = [
  "enable_emotion",
  "enable_memory_promotion",
  "enable_recall",
  "enable_self_evolve",
  "enable_semantic_vector",
  "enable_daily_digest",
  "enable_context_compaction",
  "enable_context_summarize",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

/** 取默认 stateDir（openclaw 状态目录，lcm.db 所在目录）。 */
export function defaultStateDirFromWorkspace(workspaceDir: string): string {
  return workspaceDir;
}

/** 将插件配置对象（含用户覆盖）规范化，填默认值。 */
export function normalizeConfig(
  raw: Record<string, unknown> | undefined,
  env: { workspaceDir: string; stateDir: string },
): MemoryEngineConfig {
  const rawCfg = (raw ?? {}) as Record<string, unknown>;
  const workspaceDir = asString(rawCfg.workspaceDir) || env.workspaceDir;
  const stateDir = env.stateDir || workspaceDir;

  const engagement = asObj(rawCfg.engagement);
  const promotion = asObj(rawCfg.promotion);
  const recall = asObj(rawCfg.recall);
  const emotion = asObj(rawCfg.emotion);
  const vector = asObj(rawCfg.vector);
  const selfEvolve = asObj(rawCfg.selfEvolve);
  const compaction = asObj(rawCfg.compaction);

  return {
    enable_emotion: asBool(rawCfg.enable_emotion, false),
    enable_memory_promotion: asBool(rawCfg.enable_memory_promotion, false),
    enable_recall: asBool(rawCfg.enable_recall, false),
    enable_self_evolve: asBool(rawCfg.enable_self_evolve, false),
    enable_semantic_vector: asBool(rawCfg.enable_semantic_vector, false),
    enable_daily_digest: asBool(rawCfg.enable_daily_digest, false),
    enable_context_compaction: asBool(rawCfg.enable_context_compaction, false),
    enable_context_summarize: asBool(rawCfg.enable_context_summarize, false),

    workspaceDir,
    stateDir,
    engineDbPath:
      asString(rawCfg.engineDbPath) || `${stateDir}/memory-engine.db`,
    lcmDbPath: asString(rawCfg.lcmDbPath) || `${stateDir}/lcm.db`,
    injectTag: asString(rawCfg.injectTag) || "memory-engine-memories",
    injectMaxChars: asInt(rawCfg.injectMaxChars, 1200),
    rollbackBackupDir:
      asString(rawCfg.rollbackBackupDir) || `${stateDir}/.memory-engine-rollback`,

    engagement: {
      minTurns: asInt(engagement.minTurns, 15),
      minTimeWindows: asInt(engagement.minTimeWindows, 3),
      minTokens: asInt(engagement.minTokens, 40000),
    },

    promotion: {
      scoreThreshold: asFloat(promotion.scoreThreshold, 0.5),
      weights: {
        relevance: asFloat(asObj(promotion.weights).relevance, 0.3),
        consolidation: asFloat(asObj(promotion.weights).consolidation, 0.24),
        recency: asFloat(asObj(promotion.weights).recency, 0.15),
        frequency: asFloat(asObj(promotion.weights).frequency, 0.14),
        queryDiversity: asFloat(asObj(promotion.weights).queryDiversity, 0.1),
        richness: asFloat(asObj(promotion.weights).richness, 0.07),
      },
      trivialFilter: asBool(promotion.trivialFilter, true),
      funnelMaxPerTopic: asInt(promotion.funnelMaxPerTopic, 1),
      strongReleaseConfidence: asFloat(promotion.strongReleaseConfidence, 0.8),
      nightlyAutoApplyConfidence: asFloat(promotion.nightlyAutoApplyConfidence, 0.85),
      requireHumanReview: asBool(promotion.requireHumanReview, true),
      staleHours: asInt(promotion.staleHours, 24),
    },

    recall: {
      maxHighEngagementPreloads: asInt(recall.maxHighEngagementPreloads, 3),
      anchorCooldownMs: asInt(recall.anchorCooldownMs, 12 * 60 * 60 * 1000),
    },

    emotion: {
      llmBaseUrl: asString(emotion.llmBaseUrl) || "",
      llmModel: asString(emotion.llmModel) || "openai/gpt-4o-mini",
      llmApiKey: asString(emotion.llmApiKey) || "",
      milestoneRequiresSecondPass: asBool(emotion.milestoneRequiresSecondPass, true),
      minCharsToClassify: asInt(emotion.minCharsToClassify, 0),
      // —— 13 维新增（asNumber 不存在，按二审改用 asFloat）——
      attachBelow: asFloat(emotion.attachBelow, 0.5),
      milestoneMinConfidence: asFloat(emotion.milestoneMinConfidence, 0.85),
    },

    vector: {
      dbPath: asString(vector.dbPath) || `${stateDir}/memory-engine-vector`,
      embeddingBaseUrl: asString(vector.embeddingBaseUrl) || "",
      embeddingModel: asString(vector.embeddingModel) || "embedding-2",
      embeddingApiKey: asString(vector.embeddingApiKey) || "",
      topK: asInt(vector.topK, 3),
    },

    selfEvolve: {
      proposalDir:
        asString(selfEvolve.proposalDir) ||
        `${workspaceDir}/.rules/memory-engine-proposals`,
      cronExpr: asString(selfEvolve.cronExpr) || "0 3 * * *",
      timezone: asString(selfEvolve.timezone) || "Asia/Shanghai",
    },

    dailyDigestCron: asString(rawCfg.dailyDigestCron) || "50 23 * * *",

    compaction: {
      windowSize: asInt(compaction.windowSize, 10),
      // 衬底：avgSim>=此值 → 明确同事件绝不压。话题内 avgSim 中位≈0.345，取 0.30 保护多数话题内轮。
      relevanceThreshold: asFloat(compaction.relevanceThreshold, 0.3),
      // 主判据切换线：avgSim<=此值判话题切换。标定：纯 avgSim 最优 F1≈0.50 @0.26（召回 5/8 边界、误报 7/73≈10%）。
      avgSimSwitchThreshold: asFloat(compaction.avgSimSwitchThreshold, 0.26),
      lengthThreshold: asFloat(compaction.lengthThreshold, 0.2),
      // 紧急同步压缩兕底：默认 0.50（南南定，不可更大）。占比不少于此值时同步强制压缩一次。0=关闭。
      emergencySyncThreshold: asFloat(compaction.emergencySyncThreshold, 0.5),
      // drop 镜像：1-avgSim，默认 = 1-0.26 = 0.74，与 avgSim 切换线同义（纯展示，不独立判定，避免双阈值冲突）。
      dropThreshold: asFloat(compaction.dropThreshold, 0.74),
      recentWindowForInternal: asInt(compaction.recentWindowForInternal, 5),
      // 近轮内部相关软信号：判别力弱（边界 0.374 vs 话题内 0.367），不再硬性门槛，仅作辅助防哑火。
      internalRelevanceThreshold: asFloat(
        compaction.internalRelevanceThreshold,
        0.35,
      ),
      minSamples: asInt(compaction.minSamples, 5),
      // 长度触发预算：默认适配真实上下文（当前 contextWindow≈1M，取 920000），
      // 运行时优先用 ctx.contextTokenBudget；0 表示未知/禁用长度触发。
      contextTokenBudget: asInt(compaction.contextTokenBudget, 920000),
      // 工具 schema 固定开销（默认 45k，参考常见全工具集量级；只定基底，可调校）。
      contextToolOverheadTokens: asInt(compaction.contextToolOverheadTokens, 45000),
      // 启动回填窗口：默认取最近 40 轮（含旧段），够话题切换 + 长度检测用。
      backfillWindowSize: asInt(compaction.backfillWindowSize, 40),
      // 默认回填主会话（main）。空则不做回填。
      backfillSessionKey:
        asString(compaction.backfillSessionKey) || "agent:main:main",
      llmTimeoutMs: asInt(compaction.llmTimeoutMs, 20_000),
      embeddingTimeoutMs: asInt(compaction.embeddingTimeoutMs, 10_000),
      archiveDir:
        asString(compaction.archiveDir) || `${workspaceDir}/memory/events`,
      // ——补1：超长输入分段压缩——
      // 单段提炼窗口：distill 内部 source.slice(0,6000)，这里留余量取 5600，保证单段不超窗不截断。
      segmentChars: asInt(compaction.segmentChars, 5600),
      // 单次归档最多切 45 段（≈45×5600≈252KB 原文/段摘要上限；再超则强制收束，防无限 LLM 调用）。
      maxSegmentsPerArchive: asInt(compaction.maxSegmentsPerArchive, 45),
      // ——补2：资源控制——
      // 后台队列上限：满则丢弃最旧压缩任务（防无界堆积）。
      maxQueue: asInt(compaction.maxQueue, 100),
      // 60s 窗口内最多触发 6 次实际 LLM 压缩（防连续大任务挤爆）。
      maxCompactionsPerMinute: asInt(compaction.maxCompactionsPerMinute, 6),
      // 默认内存高水位 512MB：heapUsed 超过则压缩前等待释放。0=关闭。
      memoryHighWaterMB: asInt(compaction.memoryHighWaterMB, 512),
      // 高水位等待轮询间隔 5s。
      memoryPollMs: asInt(compaction.memoryPollMs, 5000),
      guardWindowMs: asInt(compaction.guardWindowMs, 3000), // 【P0修复-会话活跃守卫】默认 3000ms
      promptEstimateCorrection: asFloat(compaction.promptEstimateCorrection, 0.7), // 【过早触发修复】默认 0.7(校正1.48x虚高的~0.68，取0.7) 1=不校正
      // assemble 摘要替换：触发占比 0.22、至少折叠 6 条最老消息、单条摘要上限 1500 字符。
      summarizeRatioThreshold: asFloat(compaction.summarizeRatioThreshold, 0.30),
      summarizeMinOldMessages: asInt(compaction.summarizeMinOldMessages, 6),
      summarizeMaxChars: asInt(compaction.summarizeMaxChars, 1500),
      summarizeTargetRatio: asFloat(compaction.summarizeTargetRatio, 0.15),
    },
  };
}

/** 打开某模块开关是否生效（含联动：语义向量需 recall 同时开）。 */
export function isModuleEnabled(cfg: MemoryEngineConfig, key: ModuleKey): boolean {
  switch (key) {
    case "enable_semantic_vector":
      return cfg.enable_semantic_vector && cfg.enable_recall;
    default:
      return cfg[key];
  }
}

function asBool(v: unknown, dflt: boolean): boolean {
  return typeof v === "boolean" ? v : dflt;
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}
function asInt(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : dflt;
}
function asFloat(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt;
}
function asObj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
