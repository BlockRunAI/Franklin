# Franklin 架构 · Architecture

> **Franklin — The AI agent with a wallet.**
> 第一个 Autonomous Economic Agent 类别的参考实现:不仅生成文本,还能自主用 USDC 执行真实工作(营销、交易、内容)。

本文档描述 `brcc` 仓库(发布包名 `@blockrun/franklin`)的整体架构、模块边界和关键数据流。

---

## 1. 一张图看懂

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Terminal (Ink + React)                          │
│                     src/ui/app.tsx  ·  model-picker                    │
└───────────────┬─────────────────────────────────────────┬───────────────┘
                │ StreamEvent                              │ 用户输入
                ▼                                          │
┌─────────────────────────────────────────────────────────────────────────┐
│                       Agent Loop  src/agent/                            │
│                                                                         │
│  interactiveSession()                                                   │
│    ├─ optimize → reduce → microCompact → autoCompact  (token 管线)      │
│    ├─ ModelClient.complete()   (SSE 流式 + prompt caching)              │
│    ├─ StreamingExecutor        (并发执行工具调用)                        │
│    ├─ PermissionManager        (default / trust / plan / deny)         │
│    └─ ErrorClassifier          (context / rate / payment / transient)  │
└──────┬──────────────────┬──────────────────┬────────────────┬──────────┘
       │                  │                  │                │
       ▼                  ▼                  ▼                ▼
┌──────────┐      ┌───────────────┐   ┌──────────────┐  ┌──────────────┐
│  Tools   │      │    Plugins    │   │     MCP      │  │   Wallet     │
│ src/tools│      │  src/plugins  │   │   src/mcp    │  │  src/wallet  │
│          │      │               │   │              │  │              │
│ 11 内置  │      │ registry +    │   │ stdio + HTTP │  │ @blockrun/llm│
│ 工具能力 │      │ runner        │   │ 服务发现 +   │  │ Base + Solana│
│          │      │ (workflow /   │   │ 信任机制     │  │ x402 签名    │
│          │      │  channel)     │   │              │  │              │
└──────────┘      └───────┬───────┘   └──────────────┘  └──────┬───────┘
                          │                                    │
                          ▼                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   Payment Proxy  src/proxy/server.ts                    │
│        (Claude Code / 第三方 SDK 兼容层,本地 :8402 监听)                 │
│                                                                         │
│   收到请求 → 模型别名解析 → 调用 Gateway → 402 → 签名 → 重试             │
│             ↑ smart router (src/router) 按 15 维打分选档位               │
│             ↑ fallback chain (src/proxy/fallback)                       │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ HTTPS POST /v1/messages
                                ▼
                  ┌──────────────────────────────┐
                  │   BlockRun Gateway           │
                  │   blockrun.ai / sol.blockrun │
                  │                              │
                  │   55+ LLMs  +  付费 API      │
                  │   x402 micropayments         │
                  └──────────────────────────────┘
```

---

## 2. 目录结构

```
src/
├── index.ts                 # CLI 入口 (commander) + 子命令注册
├── banner.ts                # Franklin ASCII banner (chafa 生成)
├── config.ts                # 版本、链、Gateway URL、BLOCKRUN_DIR
├── pricing.ts               # MODEL_PRICING (55+ 模型单源真相)
│
├── agent/                   # 智能体主循环
│   ├── loop.ts              # interactiveSession() — 推理/动作循环
│   ├── llm.ts               # ModelClient — 流式 + x402 + SSE 解析
│   ├── types.ts             # CapabilityHandler / StreamEvent / AgentConfig
│   ├── compact.ts           # 自动压缩 + 微压缩
│   ├── tokens.ts            # 估算 vs 实际 token 记账
│   ├── reduce.ts            # token 预算优化管线
│   ├── optimize.ts          # max_tokens 升档 (4K → 64K)
│   ├── commands.ts          # /retry · /model · /compact · /wallet …
│   ├── permissions.ts       # 许可模式
│   ├── streaming-executor.ts# 并发工具执行器
│   └── error-classifier.ts  # 错误分类与恢复策略
│
├── tools/                   # 11 个内置能力
│   ├── index.ts             # 能力注册表
│   ├── read · write · edit · bash · glob · grep
│   ├── webfetch · websearch
│   ├── task · imagegen · askuser
│   └── subagent.ts          # 子智能体工厂
│
├── plugin-sdk/              # 插件公共合约
│   ├── plugin.ts            # Plugin · PluginManifest · PluginContext
│   ├── workflow.ts          # Workflow · Step · ModelTier
│   ├── channel.ts           # Channel · ChannelMessage
│   ├── tracker.ts           # TrackedAction
│   └── search.ts            # SearchResult
│
├── plugins/                 # 插件运行时
│   ├── registry.ts          # 发现与加载 (dev / user / bundled)
│   └── runner.ts            # workflow 执行编排
├── plugins-bundled/         # 随 Franklin 一起发布的插件
│
├── wallet/manager.ts        # @blockrun/llm 封装 (Base + Solana)
│
├── proxy/                   # 本地付费代理 (Claude Code 兼容层)
│   ├── server.ts            # HTTP :8402 + x402 流程
│   ├── fallback.ts          # 回退链
│   └── sse-translator.ts    # SSE 格式翻译
│
├── router/index.ts          # Smart router — 15 维请求分类
│
├── session/                 # 会话持久化
│   ├── storage.ts           # JSONL 追加写 + meta.json
│   └── search.ts            # 内存全文检索 (无 SQLite)
│
├── stats/                   # 用量与洞察
│   ├── tracker.ts           # recordUsage() + 防抖落盘
│   └── insights.ts          # 成本趋势 + 预测
│
├── ui/                      # Ink + React 终端 UI
│   ├── app.tsx              # 主组件 (输入框 / 工具状态 / 流式渲染)
│   ├── model-picker.ts      # 模型选择器分类
│   └── terminal.ts          # ANSI / raw mode / 优雅退出
│
├── mcp/                     # MCP 客户端
│   ├── config.ts            # 服务器发现 + 项目信任表
│   └── client.ts            # @modelcontextprotocol/sdk 封装
│
├── social/                  # 原生 X bot (一等公民,v3.2.0 后不再是插件)
│   ├── db.ts                # JSONL 去重 + 回复日志
│   ├── x.ts                 # X API
│   └── a11y.ts              # 无障碍
│
└── commands/                # CLI 子命令实现 (13 个)
    ├── start · proxy · setup · balance · models · config
    ├── stats · logs · daemon · init · uninit
    ├── social · plugin
```

持久化根目录: **`~/.blockrun/`**

```
~/.blockrun/
├── payment-chain               # 当前链 (base | solana)
├── sessions/                   # JSONL 会话历史 (保留最近 20)
├── runcode-stats.json          # 累计用量
├── runcode-debug.log           # 调试日志
├── social-replies.jsonl        # X bot 回复记录
├── social-prekeys.jsonl        # 预去重指纹
├── mcp.json                    # 全局 MCP 配置
├── trusted-projects.json       # 项目 .mcp.json 信任表
└── plugins/<id>/               # 每个用户安装的插件数据目录
```

---

## 3. 核心模块详解

### 3.1 CLI 入口 · `src/index.ts`

Commander 注册 15 个主命令,默认子命令 `start`:

| 命令 | 作用 |
|---|---|
| `setup [chain]` | 创建 Base / Solana 钱包 |
| `start` | 交互式会话(默认) |
| `proxy` | 启动本地付费代理 `:8402`,给 Claude Code 用 |
| `models` | 列出所有可用模型与定价 |
| `balance` | 查 USDC 余额 |
| `config` | 读写 `~/.blockrun/` 下的用户配置 |
| `stats` / `insights` | 用量、成本、趋势 |
| `logs` | 调试日志查看器(支持 follow) |
| `search <query>` | 跨会话历史全文搜索 |
| `social [action]` | 原生 X bot |
| `daemon <action>` | 后台 proxy 管理 |
| `init` / `uninit` | macOS LaunchAgent 开机自启 |
| `plugins` | 已安装插件列表 |
| *(动态)* | 插件注册的命令 |

全局 flag: `--trust`、`--debug`、`-m <model>` 跨所有模式生效。
快捷入口: `runcode base` / `runcode solana` 会落盘链偏好再进 `start`。

### 3.2 Agent 主循环 · `src/agent/loop.ts`

`interactiveSession(config, getUserInput, onEvent, onAbortReady)` 是整个运行时心脏,每一轮按顺序:

1. **Token 管线**(约 `loop.ts:117-165`)
   - `optimizeHistory()` — 清除思考轨迹、老化旧结果
   - `reduceTokens()` — 规范化空白、收缩冗长消息
   - `microCompact()` — 丢弃老旧工具结果,避免 context 雪球
   - `autoCompactIfNeeded()` — 超过 ~80% 窗口就触发摘要(含 3 次重试熔断)
2. **System prompt 注入**(ultrathink 可选)
3. **StreamingExecutor** 准备就绪(用于并发启动工具)
4. **`ModelClient.complete()`** 发起 SSE 请求,实时把 text / thinking delta 推给 UI
5. **错误恢复**(`loop.ts:221-294`)
   - Context 超限 → 强制压缩 + 重试
   - 瞬时错误 → 指数退避 (2^N × 1000ms)
   - Rate limit → 回退免费模型(按会话去重,防乒乓)
   - 付费失败 → 走回退链
6. **Token 记账** → `stats/tracker`
7. **工具结果收集** → 拼回历史
8. **Token 预算警告**(每会话达到 70% 提醒一次)

会话以 JSONL 落盘在 `~/.blockrun/sessions/`,ID 形如 `session-YYYY-MM-DDTHH-MM-SS`,最多保留 20 个。

### 3.3 ModelClient · `src/agent/llm.ts`

这里是 **Franklin 与 Gateway 的唯一桥梁**。

**方法**
- `streamCompletion(req, signal)` → `AsyncGenerator<StreamChunk>`
- `complete(req, signal, onToolReady?, onStreamDelta?)`

**x402 握手**(`llm.ts:205-220`, `372-464`)
```
POST /v1/messages  →  402 Payment Required
                 ↓
        parsePaymentRequired(header)
                 ↓
   Base:  createPaymentPayload(pk, from, to, amount, network)
   Sol:   createSolanaPaymentPayload(secretBytes, from, to, amount, feePayer)
                 ↓
   重试,带 PAYMENT-SIGNATURE header
```

钱包缓存 TTL 30 分钟(`llm.ts:128-131`)。

**Anthropic prompt caching**(`llm.ts:56-119`, `167-177`)

策略 `system_and_3`:system prompt 常驻缓存,滚动缓存最近 3 条消息 + 最后一个工具定义,多轮对话 input token 约降 75%。

**SSE 解析**(`llm.ts:480-543`): 1MB buffer 上限,累积 `text / thinking / tool_use` delta,命中 `message_stop` 结束。

**模型特化**: GLM 系列用 `temperature=0.8` 并在 `-thinking-` 变体开 thinking;Anthropic 打开 prompt caching beta flag。

### 3.4 Tools · `src/tools/`

11 个内置能力 + 1 个子智能体工厂,都实现 `CapabilityHandler`:

| 工具 | 文件 | 作用 |
|---|---|---|
| Read | read.ts | 按行号读文件 |
| Write | write.ts | 新建文件 |
| Edit | edit.ts | 块编辑 / 行替换 |
| Bash | bash.ts | shell 命令 |
| Glob | glob.ts | 文件名模式匹配 |
| Grep | grep.ts | 正则搜索 |
| WebFetch | webfetch.ts | 抓 HTML 并解析 |
| WebSearch | websearch.ts | 搜索(Exa / fallback) |
| Task | task.ts | 任务清单管理 |
| ImageGen | imagegen.ts | DALL-E 图片生成 |
| AskUser | askuser.ts | 交互式提问(委托 Ink) |
| SubAgent | subagent.ts | 隔离配置的子智能体 |

通过 `config.capabilities: CapabilityHandler[]` 注入 agent loop,loop 不关心具体实现。

### 3.5 Plugin 系统 · `src/plugin-sdk`, `src/plugins`, `src/plugins-bundled`

**公共合约**(`plugin-sdk/`)
- **`PluginManifest`** — id / name / version / provides / entry
- **`Plugin`** — manifest + workflows? + channels? + commands? + lifecycle hooks
- **`Workflow`** — `steps: WorkflowStep[]`,每步声明 `modelTier: free | cheap | premium | none`
- **`WorkflowStepContext`** — `callModel(tier, prompt)` / `generateImage?` / `search()` / `sendMessage?` / `track()` / `isDuplicate()` / `dryRun`
- **`Channel`** — 抽象发布平台(X、Reddit、Telegram…)

**Registry**(`plugins/registry.ts`)按优先级扫描:
1. `$RUNCODE_PLUGINS_DIR/*` — 开发态
2. `~/.blockrun/plugins/*` — 用户安装
3. `src/plugins-bundled/*` — 随包发布

每个 manifest 通过动态 `import(entry)` 加载,注入 `PluginContext { dataDir, pluginDir, log }`,调 `onLoad()`。

**Runner**(`plugins/runner.ts`)按 config → steps → model dispatch → track 顺序编排,动作日志追加写到 `~/.blockrun/workflows/<name>.jsonl`,支持 pre-key 去重。

> `plugins-bundled/` 当前为空:之前的 social 插件在 v3.2.0 被提升为 `src/social/`(一等公民),仍保留目录给未来官方插件。

### 3.6 钱包 + 付费 · `src/wallet`, `src/proxy`, `src/router`

**`wallet/manager.ts`** 是 `@blockrun/llm` 的薄封装:`walletExists`、`setupWallet`、`setupSolanaWallet`、`getAddress`。真正的私钥生成、签名、KDF 都在 `@blockrun/llm` v1.4.2 里。

**`proxy/server.ts`** — 本地 :8402,定位是 **"让 Claude Code / 第三方 Anthropic SDK 透明用上 Franklin 钱包"**:
- 模型别名解析(`auto`/`eco`/`premium`/`sonnet`/`opus`/`haiku`/`gpt` …)
- 向 Gateway 转发
- 402 → 签名 → 重试
- 失败 → 走 `fallback.ts` 的回退链
- `recordUsage()` 写统计
- 每模型自适应 `max_tokens`

**`router/index.ts`** — Smart router。给每个请求打 15 维分:token 量、代码特征、推理关键词、命令式、多步、agentic pattern…映射到 `SIMPLE / MEDIUM / COMPLEX / REASONING` 四档,再按 profile(`auto / eco / premium / free`)选具体模型。返回 `{ model, tier, confidence, signals[], savings% (vs Opus) }`。

| Tier | auto | eco | premium |
|---|---|---|---|
| SIMPLE | gemini-2.5-flash | nemotron-ultra | kimi-k2.5 |
| MEDIUM | kimi-k2.5 | gemini-2.5-flash-lite | gpt-5.3-codex |
| COMPLEX | gemini-3.1-pro | gemini-2.5-flash-lite | claude-opus-4.6 |
| REASONING | grok-4.1-fast-reasoning | grok-4.1-fast-reasoning | grok-4.1-fast-reasoning |

### 3.7 Session 与 Stats

**`session/storage.ts`** — JSONL 追加写(崩溃安全),metadata 单独 JSON;`~/.blockrun/sessions` 不可写时降级到 `/tmp/runcode/sessions`。保留最近 20 个会话,当前活跃会话永远不剪。

**`session/search.ts`** — 内存全文搜索(刻意不上 SQLite):tokenize / 引号短语 / 片段提取 / 词频打分 + phrase bonus 3× + assistant 权重 1.1× + 时间衰减。"每天 30 回,一年 1 万行仍 < 1MB" 的设计容量。

**`stats/tracker.ts`** — `~/.blockrun/runcode-stats.json`,结构 `{ totalRequests, totalCostUsd, totalInputTokens, totalOutputTokens, totalFallbacks, byModel{}, history[last 1000] }`。用 **2000ms 防抖落盘**防止 proxy 高并发下 `load → modify → save` 丢数据。

`stats/insights.ts` 按天切片,生成成本趋势 + 月度投影,给 `/insights` 命令用。

### 3.8 UI · `src/ui/`

Ink + React 终端 UI。`app.tsx`(37K)是主组件,事件循环把 agent 发来的 `StreamEvent` 非阻塞翻译成界面更新:

- 输入框全宽,显示当前模型 + 钱包余额 + 会话累计成本
- 工具状态:spinner + 预览 + 实时输出
- 文字/思考 delta 实时流式渲染
- 模型选择器:先分类视图,再 flat 列表键盘导航
- Slash 命令 palette

`terminal.ts` 管 raw mode、信号处理、Ctrl+C 优雅退出。

### 3.9 MCP · `src/mcp/`

**`config.ts`** 按顺序发现 MCP server:
1. 内置: `blockrun-mcp`、`unbrowse`(若系统有这些可执行文件)
2. 全局: `~/.blockrun/mcp.json`
3. 项目: `{workDir}/.mcp.json` — **只有项目进信任表才加载**,信任表在 `~/.blockrun/trusted-projects.json`

**`client.ts`** 封装 `@modelcontextprotocol/sdk` 的 `Client`,支持 stdio 和 HTTP(SSE)两种传输,`listTools()` 自动把每个 MCP 工具包成 `CapabilityHandler` 注入 agent loop。

### 3.10 Social(原生 X Bot) · `src/social/`

v3.2.0 之后从 plugin 升为一等公民,原因: X 接入要求太多仪式(回复节流、失败重试、预去重、日记账),插件 SDK 的通用 Channel 合约表达不下。

**`db.ts`** 两个 JSONL 文件:
- `social-replies.jsonl` — 每条回复的完整记录(含 status = `posted / failed / skipped / drafted`、`cost_usd`)
- `social-prekeys.jsonl` — pre-key 去重(`sha256(author + snippet + time_bucket)`),**在花钱调 LLM 前**就判断 "这条看过没"

启动时扫一遍重建三个内存索引:`repliesByUrl`、`repliesToday`、`preKeysSet`。关键不变式:`hasPosted()` 只认 `status='posted'`,失败不占名额。

### 3.11 Commands · `src/commands/`

13 个子命令文件,每个负责一个 CLI 动作。`start.ts` 和 `proxy.ts` 是两个主模式:前者拉起交互式 agent loop,后者启本地付费代理。其余都是管理性命令。

---

## 4. 关键数据流:一条用户消息的生命周期

```
用户在终端输入
     │
     ▼
interactiveSession() 拿到 userInput,追加进 history
     │
     ▼
Token 管线
  ├─ optimizeHistory()   (剥 thinking + 老化旧 result)
  ├─ reduceTokens()      (规范化 + 收缩)
  ├─ microCompact()      (丢弃老旧 tool_result)
  └─ autoCompactIfNeeded() (> 80% 就摘要)
     │
     ▼
注入 system prompt (+ ultrathink)
     │
     ▼
ModelClient.complete()
  ├─ 构建 payload + prompt caching (system_and_3)
  ├─ GLM / Anthropic 特化
  ├─ POST /v1/messages → Gateway
  │    │
  │    ├─ 200 OK + SSE stream
  │    │
  │    └─ 402 Payment Required
  │         │
  │         ├─ parsePaymentRequired(header)
  │         ├─ createPaymentPayload() (Base / Solana)
  │         └─ 带 PAYMENT-SIGNATURE 重试
  │
  ├─ 解析 SSE:
  │    ├─ text delta     → UI 实时打印
  │    ├─ thinking delta → UI 实时打印
  │    └─ tool_use       → onToolReady() 并发启动工具
  │
  └─ 累积 stop_reason / usage
     │
     ▼
StreamingExecutor.collectResults()
  (bash / read / edit / grep / … 并发运行后收结果)
     │
     ▼
tool_result 追加进 history
     │
     ▼
  stop_reason == 'end_turn' ?
     ├─ 是 → appendToSession(id) + recordUsage() + turn_done 事件 → 下一轮等输入
     └─ 否 → 回到 Token 管线继续
```

---

## 5. 设计准则

1. **核心不感知插件** — agent loop 只认 `CapabilityHandler`,工具是内置的、MCP 的、还是插件 workflow 调出来的它都不关心。
2. **Token 管线是分层的** — 便宜的手段(strip / reduce / microCompact)先用足,再走贵的 autoCompact 摘要。
3. **x402 对调用方透明** — 业务代码只调 `complete()`,402 → 签名 → 重试的全流程压在 `ModelClient` 里。
4. **Smart router 的省钱叙事以 Opus 为基准** — 任何新模型加进来都报告 "相对 Opus 省 X%",用户心智统一。
5. **JSONL first, SQLite never** — 会话、social 去重、回复日志一律 append-only JSONL。可 grep 可 diff 可 cat,崩溃安全,规模够用(每日 30 条回复 / 年 1 万行 <1MB)。
6. **Wallet 薄到几乎不存在** — 所有敏感逻辑在 `@blockrun/llm`,Franklin 只做 UX 和缓存(30min TTL)。
7. **`~/.blockrun/` 是单一持久化根** — 用户迁移 / 备份只需拷贝这一个目录。
8. **Error recovery 要克制** — 付费失败的 fallback 链按会话去重,避免同一个损坏模型被反复试;rate limit 的 free-model 回退也按会话记忆。

---

## 6. 外部依赖边界

| 外部依赖 | 用途 | 进入点 |
|---|---|---|
| `@blockrun/llm` v1.4.2 | 钱包、x402 签名、DALL-E | `src/wallet/manager.ts`, `src/agent/llm.ts`, `src/tools/imagegen.ts` |
| `@modelcontextprotocol/sdk` v1.29 | MCP 客户端 | `src/mcp/client.ts` |
| `commander` | CLI 参数解析 | `src/index.ts` |
| `ink` / `react` | 终端 UI | `src/ui/*` |
| **BlockRun Gateway** | 55+ LLM 统一入口 + 付费 API | `blockrun.ai/api` (Base) · `sol.blockrun.ai/api` (Solana) |

Franklin 与 Gateway 的协议是 **Anthropic Messages API 兼容的流式接口 + x402**。换句话说,任何能调 Anthropic API 的客户端,指向本地 :8402 付费代理,都能自动享受 Franklin 的钱包、智能路由和统计。这也是 proxy 模式对 Claude Code 存在的意义。

---

## 7. 如何扩展

- **新增工具** — 在 `src/tools/` 加一个实现 `CapabilityHandler` 的文件,`src/tools/index.ts` 导出,进 agent config 的 `capabilities`。
- **新增 workflow plugin** — 实现 `Plugin` 合约,放进 `src/plugins-bundled/<id>/`(官方)或 `~/.blockrun/plugins/<id>/`(用户),registry 会自动发现。
- **新增 CLI 子命令** — 在 `src/commands/` 加文件,`src/index.ts` 里 `program.command(...)` 注册。
- **接入新的付费 API** — 让它挂在 BlockRun Gateway 后面,Franklin 无需改动,`MODEL_PRICING` 里加一行即可(`pricing.ts`)。
- **接入新的链** — 扩 `config.ts` 的 `API_URLS`、`@blockrun/llm` 加相应钱包与签名器、`llm.ts` 的 `signPayment()` 加分支。

---

## 8. 定位复盘

> **Franklin runs your money.**

每个新功能问一次:

- 这让 Franklin 更像"那个管钱包的 agent"了吗? → 做
- 这把 Franklin 稀释回"又一个写代码的工具"了吗? → 不做

护城河是付费层。品类是 Autonomous Economic Agent。垂直是 marketing 和 trading。其他都是执行细节。
