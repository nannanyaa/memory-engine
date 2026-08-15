# memory-engine · 初始化配置引导（Skill 级）

> 给**拿到本插件、准备接入的 agent / 维护者**用的逐步引导。
> 目标：读完走一遍，插件就能以"你自己的敏感信息"跑起来，且**没有任何项目敏感信息残留在代码或仓库里**。

---

## 0. 核心设计（先懂这一句）

**敏感 / 个性化内容一律不进源码**，全部放在你**工作区根目录**的两个外部配置文件里：

| 外部文件 | 装什么 | 不进 git |
|:--|:--|:--:|
| `memory-engine.keywords.json` | 情感场景触发词、全局场景词 | ✅ |
| `memory-engine.local.config.json` | API 密钥、embedding 配置（BaseURL/Model/Key）等 | ✅ |

**插件启动时会自动检测**：
- 工作区**有**这两个文件 → 读取并使用其中的值；
- 工作区**没有** → **自动生成一份空白模板**（带注释引导），供你填写。

所以你**无需手动创建任何文件**——装上、跑一次，模板就自动生成了。你要做的只是**往模板里填你自己的东西**。

---

## 1. 首次接入三步走

### 第 1 步：装好插件

```bash
npm install
npm run build        # esbuild 打包到 dist/index.js
npm run typecheck    # tsc --noEmit（可选，校验类型）
```

1. 把仓库放进 OpenClaw 插件目录（如 `~/.openclaw/plugins/memory-engine/`）。自带 `dist/index.js`，**不构建也能直接加载**。
2. 在 OpenClaw 启用配置里登记本插件（`openclaw.plugin.json` 已声明 `contracts.tools` / `configSchema` / `activation.onStartup`）。
3. 启动 OpenClaw（或重启 gateway）让插件注册生效。

> **首次启动后**：插件会在你工作区根目录**自动创建**：
> - `memory-engine.keywords.json`（空白模板）
> - `memory-engine.local.config.json`（空白模板，含 emotion/vector 密钥位）

### 第 2 步：决定要开哪些模块（用预设）

复制 `presets/` 下适合你的预设到配置里：
- `presets/minimal.json` — 最安全，先跑几天确认无副作用
- `presets/1m-standard.json` — 大窗口模型开箱即用
- `presets/low-resource.json` — 低配设备

### 第 3 步：填外部配置文件（这是"你的个性化"）

打开自动生成的 `memory-engine.local.config.json`，填你要用的**密钥 / embedding**：

```jsonc
{
  "emotion": {
    "llmBaseUrl": "",          // 可选，情感分类 LLM 的 base URL（OpenAI 兼容）
    "llmModel": "openai/gpt-4o-mini",
    "llmApiKey": ""            // 可选，情感分类 LLM 的 API key
  },
  "vector": {
    "embeddingBaseUrl": "",    // embedding 服务 base URL（结尾不带 /）
    "embeddingModel": "",      // 例如 "embedding-2"
    "embeddingApiKey": ""      // embedding 服务 API key
  }
}
```

再打开 `memory-engine.keywords.json` 填你的**情感场景触发词**：

```jsonc
{
  "emotionScenarioHints": {
    "爱慕": "想你,喜欢,你是我的,离不开",
    "想念": "想你,好久没见,梦里都是你",
    // ... 其他维度按需填；留空则该维度退化为通用匹配
  },
  "globalScenarioHints": {
    "relationship": "在乎,陪伴,承诺",
    "body": "体重,身材,减脂"
    // 这些是你想让它"听到某话题就唤起相关记忆"的专属词
  }
}
```

> **⚠️ 关键词不进 git**：这两个文件只在你本地工作区存在。**推送源码仓库时它们不会、也不该被带上**（源码里已无任何敏感信息，全部靠运行时读外部文件注入）。

---

## 2. 安全边界（对维护者很重要）

- **源码 = 通用壳**：`src/` 里不含任何"人 / 项目 / 密钥 / 关键词"实例信息，全部是加载外部配置的逻辑与通用默认值。
- **敏感信息只在外部文件**：密钥、embedding、关键词、人名映射都在 `*.local.config.json` / `*.keywords.json`。
- **推送前无需手动脱敏**：因为源码本来就是干净的。直接 `git push` 即可。
- 若你 fork 后把自己的内容写进了源码 → 那是你的选择，但**不要推到公开上游**。

---

## 3. 验证是否配好

1. `npm run typecheck` — 0 错误。
2. 启动后确认工作区生成了两个外部文件（若第一次没生成，检查 workspaceDir 是否被正确解析）。
3. 填好密钥 / 关键词后重启，看日志是否正常加载（无 `missing apiKey` / `keyword 全空` 告警）。
4. 测试：对某个场景词发一条包含该词的消息，确认相关情感锚点被唤起。

---

## 4. 故障排查速查

| 现象 | 原因 / 解法 |
|:--|:--|
| 自动生成的模板没出现 | workspaceDir 未传；确认插件配置里 `workspaceDir` 或运行时环境已提供 |
| 关键词全空 / 唤起不到记忆 | `memory-engine.keywords.json` 里对应维度的词留空了；去填 |
| embedding 不生效 | `embeddingBaseUrl/Model/Key` 没填，或没开 `enable_semantic_vector`（且需 `enable_recall` 同开） |
| 情感识别不触发 | `emotion.llmApiKey` 缺，或没开 `enable_emotion` |

---

> 本引导随仓库维护。如果你新增了外部配置项，记得在这里同步加一行「放到哪个文件 / 填什么」。
