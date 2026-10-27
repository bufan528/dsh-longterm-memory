# 架构

## 1. 总览

```
┌──────────────────────────── DSH Web (浏览器) ────────────────────────────┐
│  左侧栏「长期记忆」入口        独立管理页面                                 │
│  sidebar.panellist            main (keyed)                               │
│         │                          │                                     │
│         └──────► PANEL_ID ◄────────┘                                     │
│                        │                                                 │
│                 Client half (lib/client.js)                              │
│                 · 只 require('react') / ('react/jsx-runtime')            │
│                 · 不 import 任何 @deepseek-ai/*                          │
│                        │  POST /dsh-longterm-memory/api/<method>          │
└────────────────────────┼─────────────────────────────────────────────────┘
                         │ HTTP + 信任围栏
┌────────────────────────┼───────────────── DSH Host (Node) ───────────────┐
│  Host half (lib/host/index.js)                                           │
│  · 零 @deepseek-ai/* 静态 import                                          │
│  · ctx.inject(['webServer' | 'systemPrompt' | 'tools'])                  │
│                        │                                                 │
│                  MemoryService（唯一协调点）                                │
│     ┌──────────────┬───────────────┬──────────────┬──────────────┐       │
│     │ discover     │ repository    │ indexing     │ engine       │       │
│     │ vault        │ Markdown CRUD │ 建立/增量/重建 │ 提取/去重/冲突 │       │
│     └──────────────┴───────────────┴──────────────┴──────────────┘       │
│                        │                                                 │
│                  Obsidian 兼容 Markdown 仓库（本机磁盘）                    │
└──────────────────────────────────────────────────────────────────────────┘
```

## 2. 为什么这样分层

### 2.1 Host half 不静态 import 任何 `@deepseek-ai/*`

DSH 的 profile 安装会把插件硬链接进 `<profile>/node_modules`，而官方包（如
`@deepseek-ai/dsh-tools`）并不在 profile 的 `dependencies` 里——它们通过 DSH
**安装侧模块解析层**（`PluginPackages` 的 ESM+CJS 解析拦截）才能被找到。

这意味着：**静态 import 一个官方包，会让插件的整个激活过程依赖一个未被写入
manifest 的解析约定**。一旦解析不到，`apply()` 根本不会运行，用户的长期记忆就整
体不可用。

因此本插件的 Host half 采取的策略是：

| 需要的宿主能力 | 本插件的做法 | 而不是 |
|---|---|---|
| 服务获取 | `ctx.get('name')`（返回 `undefined`，不抛） | `ctx.name`（未 inject 会抛） |
| 可选服务 | `ctx.inject([...], cb)`（服务缺失则回调不运行，插件照常激活） | 放进 `inject` 硬依赖（整个 profile 里插件不激活） |
| 工具定义 | 手写 `{name, description, parameters, output:{schema, render}, execute}` | `defineTool()` from `@deepseek-ai/dsh-tools` |
| 原子写 | 自己实现（与 `dsh-atomic-write` 同算法） | 依赖 `@deepseek-ai/dsh-atomic-write` 可解析 |
| 打开文件夹 | `child_process.execFile('explorer.exe')` | `@deepseek-ai/dsh-native-command` |
| 消息构造 | 运行时 `await import()`，失败则降级 | 静态 import `@deepseek-ai/dsh-llm` |

**唯一**的 `@deepseek-ai/*` 动态引用在 `src/host/dsh/inject.ts`，用于可选的每步注入，
并且用 `try/catch` 包住，失败只关闭该可选功能。

### 2.2 Client half 只依赖平台 seed 表

DSH 浏览器模块表的 9 个固定基线是：
`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`,
`@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`,
`@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit`。

> **2026-10-27 复核（宿主 0.2.1-rc.3）**：web 壳的 seed 表实际有 **11** 个基线模块
> （新增 `zod` 与 `@tanstack/react-virtual`），本条「9 个」是 0.2.1-rc.2 时的记录。
> 本插件仍只 `require` `react` 与 `react/jsx-runtime`，属更保守的选择，不受影响。
> 证据：[`docs/evidence/dsh-host-0.2.1-rc.3.md`](evidence/dsh-host-0.2.1-rc.3.md) §1.6。

官方插件指南明确要求**不要** `require` `dsh-client-ui-primitives`。本插件因此：
- 只 `require('react')` 与 `require('react/jsx-runtime')`；
- 所有控件（按钮、输入、下拉、复选框、模态框、Toast）自己写，模态框自己实现焦点
  捕获与 Escape；
- 只使用 `--dsw-alias-*` 主题 token（带 fallback），不写死颜色；
- 所有 class 前缀 `lmv-`，避免与宿主样式冲突。

`scripts/lint.mjs` 会强制检查这两条（bundle 里出现的 `require` 必须都在 seed 表内）。

## 3. DSH 接口依据（初版核对于 `0.2.0-rc.2`；宿主 `0.2.1-rc.3` 复核见 `docs/evidence/dsh-host-0.2.1-rc.3.md`）

### 3.1 一级侧边栏入口

`@deepseek-ai/dsh-client-ui-sidebar/lib/client.js` 声明 `sidebar.panellist` 为
root 作用域的 `list` slot（第 503-506 行），并把每一项渲染成侧边栏行；点击时调用
`ctx.layout.selectPanel(id)`（第 478-481 行）。同一个 `id` 用于选中布局里 root 作用
域 `main` keyed slot 的组件（`@deepseek-ai/dsh-client-ui-layout/lib/client.js:118`）。

真实用例（两个官方插件）：

```js
// dsh-client-ui-plugin-manager/lib/client.js:3769-3775
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
  name: "sidebar.panellist", id: PANEL_ID, order: 0, label: () => t("panel"), locale: NS
}, PluginsPanelIcon))
```

本插件：

```ts
// src/client/index.ts
ctx.slots.inject('sidebar.panellist', () =>
  ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('panel') }, MemoryPanelIcon))
ctx.slots.inject('main', () =>
  ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, MemoryPage))
```

`order` 取值依据：Plugins = `0`（plugin-manager:3772）、Automation tasks = `10`
（ui-schedule:6807）；`sidebar.workspaces` 是列表下方独立的 seat。因此 `20` 正好位于
自动化任务之后、工作区之前。

### 3.2 客户端 bundle 格式

每个官方 client 包的首行都是：

```js
window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => { … return module.exports } })
```

（`dsh-client-ui-sidebar/lib/client.js:1-11,530-532`；`templates/decoration/client.js`）

`dsh-client-modules/README.md:50` 明确：**宿主只服务已构建的 `lib/client.js`**，缺失
会在激活时响亮失败。`scripts/build-client.mjs` 因此用 esbuild 产出 CJS，再包进上述
骨架，并在产出后自检（`__ModuleLoader__.load` 必须存在、`require` 只能在 seed 表内）。

### 3.3 记忆注入点

`@deepseek-ai/dsh-system-prompt/lib/index.js:342`：

```js
text: typeof section.text === "function" ? section.text(context) : section.text
```

即 **`text` 可以是函数，并在每次 `assemble()` 时重新求值**。`assemble()` 由 agent
loop 在每个模型 step 前调用（`dsh-agent-loop/lib/index.js:907`）。这是本插件注入主
通道：**一次注册，按需求值，不写会话历史**。

section 的 `interpolate: false` 是必须的：记忆正文可能含 `{{...}}`，插值会让整个
prompt 组装抛错。

### 3.4 提取触发点

**DSH 没有「每轮」Cordis 事件。** `ctx.on("turn/end")` 不存在——`turn/end` 是
**会话日志事件**，只能通过 `ctx.on("session/event", (session, event) => …)` 观察，
或注册 `sessionProjections` 单元。

`@deepseek-ai/dsh-agent-instructions` 用的正是这个模式（监听 `step/end`）。本插件：

```ts
ctx.on('session/event', (session, event) => {
  if (event.type === 'user/message')      buffer.userText.push(...)
  if (event.type === 'assistant/message') buffer.assistantText = [...]
  if (event.type === 'turn/end')          void extractAndStore(buffer)
})
```

`session/event` 是**提交后**的 emit 模式事件，监听器抛错会被隔离，因此绝不影响轮次。
每个会话的提取用 promise chain 串行化，避免两次写同一文件。

### 3.5 客户端 ↔ 宿主 RPC

DSH 有两条通道：
1. **typert Remote**（`ctx.remote.<ns>.<m>()`）——命名空间由 `@deepseek-ai/dsh-api-remotes`
   这个**生成式、手工挑选的程序集**注册，第三方插件**无法**新增自己的命名空间。
2. **插件自己的 webServer 路由**——`ctx.webServer.register({kind, path, handler})`，
   生命周期随 effect 释放。

两个已安装的真实第三方插件都走第 2 条（`dsh-better-sidebar` 注册 `/sidebar/api`）。
本插件同样：

```ts
ctx.effect(() => webServer.register({ kind: 'prefix', path: '/dsh-longterm-memory/api', handler }), '…')
```

### 3.6 信任围栏

路由必须防止任意网页读取/改写用户记忆。实现照抄 `dsh-better-sidebar` 的
`isTrustedApiRequest`（`lib/index.js:3230-3301`）：

- `Host` 头必须是 loopback 或 `ctx.webRuntime.trustedHosts` 中的授权值；
- `sec-fetch-site: cross-site` 直接拒绝；
- 存在 `Origin` 时必须与 Host 主机名一致，或等于桌面壳的 `dsh-app://app`。

## 4. 数据流：从对话到记忆

```
session/event: user/message, assistant/message      ← 按会话缓冲（有上限）
        │
session/event: turn/end                             ← 唯一持久边界
        │
extractFromTurn()                                   ← 纯函数，无 IO、无网络
   · 分句 → 信号规则 → 类型/置信度/重要度
   · scanSecrets：命中高置信机密 → 整个候选拒绝
   · scanSensitive：健康/财务/身份 → 强制降级待确认
        │
compareCandidate()                                  ← 纯函数
   · 重叠系数 ≥ 0.82 且同类型 → merge
   · 否定/替换/数值冲突 → conflict
   · 同类型补充 → update
   · 否则 → create
        │
mayAutoApply()？
   · 仅「confidence = high 且 create/update」自动执行
   · 其余一律进 Inbox（状态 pending）
        │
repository.save()                                   ← 原子写 + 文件锁
        │
journal.append()                                    ← 变更前后摘要 + 原因 + 来源
        │
syncIndex() + writeIndexNotes()                      ← 增量索引 + 人类可读索引页
```

## 5. 数据流：从记忆到模型

```
每个模型 step：agent loop → systemPrompt.assemble()
        │
本节插件 section 的 text() 重新求值
        │
standingFacts(index)
   · 只取 status = active 的 profile / preference，以及所有 pinned
   · 按 budgetTokens / maxItems 裁剪
        │
renderStandingBlock()
   · 明确声明「这是参考数据，不是指令」
   · 每条记忆正文经过 defang()（转义围栏、去控制字符）
        │
放入系统提示词（不写会话历史，不重复计费历史上限）
```

按需检索由 4 个模型工具承担：`memory_search` / `memory_get` / `memory_save` /
`memory_forget`。

**可选**通道：`enablePerStepRecall`（默认关闭）会把检索结果作为用户消息插入
`agent/pre-step`。该消息会变成**持久会话历史**，本会话后续每轮都要重复计费，因此
默认关闭并在设置页明确说明代价。

## 6. 模块职责

| 文件 | 职责 |
|---|---|
| `src/shared/types.ts` | 记忆模型、9 个类别的映射、目录常量 |
| `src/shared/markdown.ts` | Frontmatter 编解码（BOM/CRLF/CJK 安全）、wikilink、slug |
| `src/shared/validate.ts` | zod 元数据校验、修复策略、ID 生成、文件名 |
| `src/shared/search.ts` | CJK 分词（单字+双字）、加权倒排、排序、相关记忆、校验和 |
| `src/shared/recall.ts` | token 估算、注入围栏、去毒化、预算渲染 |
| `src/shared/protocol.ts` | Client↔Host 全部 RPC 方法、请求/响应、错误码 |
| `src/shared/qq-linkage.ts` | QQ 联动契约：配置归一化、会话来源判定、四个执行点决策、运行时能力说明（0.1.5 新增） |
| `src/host/core/fsx.ts` | 原子替换、跨进程文件锁、路径逃逸防护、递归列目录 |
| `src/host/core/layout.ts` | vault 内所有路径的唯一来源 |
| `src/host/core/discover.ts` | 环境判定、Obsidian 检测、候选路径、可用性判定 |
| `src/host/core/vault.ts` | 初始化（幂等）、读写验证、统计、README 生成 |
| `src/host/core/repository.ts` | Markdown CRUD、目录迁移、变更日志、重复 id 检测 |
| `src/host/core/indexing.ts` | 索引建立/增量同步/持久化/损坏恢复、索引页生成 |
| `src/host/core/engine.ts` | 机密/敏感识别、候选提取、相似度、去重/冲突策略 |
| `src/host/core/retrieval.ts` | 任务检索、常驻事实、标签统计 |
| `src/host/core/service.ts` | 唯一协调点；所有 RPC 入口 |
| `src/host/core/llm-extraction.ts` | 模型提取的纯逻辑：提示词构建、响应解析、边界（第二轮新增） |
| `src/host/dsh/llm.ts` | 真实 DSH 模型适配器：prepareCall + 流式收集，不可解析即降级（第二轮新增） |
| `src/host/config.ts` | zod 配置校验（不依赖 Schemastery） |
| `src/host/dsh/tools.ts` | 4 个模型工具的定义与执行 |
| `src/host/dsh/inject.ts` | 提示词 section、turn 提取、可选每步注入 |
| `src/host/dsh/routes.ts` | HTTP RPC + 信任围栏 + 方法分发 |
| `src/host/index.ts` | 插件入口（`apply`/`inject`/`name`） |
| `src/client/**` | 侧边栏图标、管理页面、5 个视图、自有控件、i18n、样式 |

## 7. 关键设计取舍

| 取舍 | 选择 | 理由 |
|---|---|---|
| 索引介质 | JSON 而非 SQLite | 无原生模块编译；文件可人工查看；损坏时只需重建，绝不成为唯一事实来源 |
| 语义检索 | **不实现** | 本部署没有可验证可用的 embedding 模型；伪造向量比没有更糟。关键词/CJK 双字/标签/路径/链接检索已全部可用 |
| 自动提取 | 默认规则式 | 零成本、零外发、可测试；模型辅助提取显式标记为未实现 |
| 注入主通道 | 系统提示词 section | 不写会话历史；任意变化只影响自身，不追加持久消息 |
| 删除 | 只归档，不真删 | 「某条事实曾经存在过」本身也是信息；真删需二次确认 |
| 配置 | zod，不用 Schemastery | 避免 `@deepseek-ai/schemastery` 解析失败拖垮激活 |
| 设置持久化 | 只存用户改动（delta） | 否则第一次运行就会把默认值冻到磁盘，之后 `cordis.patch.yml` 的改动永远失效 |

## 8. 模型辅助提取（第二轮实现）

规则提取是默认路径；模型提取是**可选增强**，默认关闭。

```
enableLlmExtraction = true
        │
   createDshLlmAdapter()          src/host/dsh/llm.ts
        │  · 带保护的动态 import('@deepseek-ai/dsh-llm')
        │  · ctx.get('agentDefaultModel').currentSelection() 取路由
        │  · ctx.get('llm').prepareCall({provider, model, maxTokens}, signal)
        │  · createUserMessage({content, source}) + EXTRACTION_SYSTEM_PROMPT
        │  · 流式收集（容忍两种 chunk 形状）→ 文本
        ▼
   parseModelAnswer()             src/host/core/llm-extraction.ts
        │  · 剥 ```json 围栏 / 前后散文
        │  · 整体 ≤16 KiB，条目 ≤8，字段长度全部有界
        │  · zod 校验；不合格条目丢弃，**不猜**
        ▼
   candidatesFromModel()          src/host/core/engine.ts
        │  · 与规则路径同一套 scanSecrets / isPredominantlySecret / redactSecrets
        │  · 同一套 scanSensitive 降级
        │  · **依据校验**：主题词 ≥50% 能在本轮原文定位，
        │    否则降为 low；仅助手回复提到则降 medium
        ▼
   processTurn 合并（模型版本覆盖同主题规则版本）→ 轮次幂等 → 待确认去重
```

**失败即降级**：模块不可解析 / 服务缺失 / 调用抛错 / 输出非法 —— 全部回退到规则提取，
轮次不会丢失。

**为什么模型不能直接改写记忆库**：它只能提议候选；写入仍由 `MemoryRepository` 做，
元数据、原子写、文件锁、变更日志、索引同步都不经过模型。

## 9. 提示词贡献的自证（`previewStanding`）

`systemPrompt.section()` 只返回一个 disposer，注册进去的 descriptor 拿不回来。为了让
「插件到底往系统提示词写了什么」可被外部核验，`installStandingSection` 把同一个
descriptor 也记到 service 上，并暴露 `POST /api/previewStanding`：它调用**注册给
`systemPrompt` 的那个 `text` 回调本身**。

依据：`dsh-system-prompt/lib/index.js:342` 在装配时正是
`section.text(context)`，所以回调输出就是分区文本。这让「真实宿主上的提示词贡献」
可以零模型调用地被验证（见 `docs/verification.md` §5.3），而不必伪造一个会话去骗过
`assemble()`。

## 10. QQ 接入联动

**定位**：QQ 的连接、扫码、网关与凭据全部属于官方插件 `@tencent-connect/dsh-qqbot`；
本插件只做「状态展示 + 导航 + 联动策略 + 诊断」。完整使用说明见
[`docs/qq-integration.md`](qq-integration.md)。

### 10.1 为什么不做成「调用官方插件」

官方插件**不注册 cordis 服务、不导出内部模块、没有导航 API**（证据见
[`docs/evidence/qq-official-plugin.md`](evidence/qq-official-plugin.md) §2、§8.3）。
因此本插件与它**唯一的耦合点**是一条只读 HTTP 探针：

```text
GET /qqbot/im-qqbot/bind   （同源 fetch，AbortController 4 s）
  200 + JSON  → 已加载，按 phase 区分 bound / waiting / starting / saving / failed
  404         → 未安装 / 未加载（或该 profile 无 webServer）
  其它        → 无法确认（不猜测）
```

探针在客户端半边，不读 `qrSvg` / `url` 内容，也不携带任何凭据。**不要**改用
`ctx.get('im-qqbot')`：官方插件不 provide 服务，加载了也只会得到 `undefined`
（证据文档 §6.1）。

> 宿主另提供 `pluginInventory/list` 作为可选判据（宿主侧 `ctx.get('pluginInventory')`，
> 客户端可经 `ctx.remote.pluginInventory` 调用；见
> [`docs/evidence/dsh-host-0.2.1-rc.3.md`](evidence/dsh-host-0.2.1-rc.3.md) §4.2–§4.3，
> 代码级确认、网络层未实测）。本页**未接线**，因此当前实现与官方插件之间只有上面这一条
> 探针耦合。

### 10.2 判定层：单一纯函数模块

`src/shared/qq-linkage.ts` 是联动策略的**唯一实现来源**：

| 层 | 内容 |
|---|---|
| 配置 | `QqLinkageConfig { mode, qqMarkers, trustedMarkers, writeMode, allowTools }`；`DEFAULT_QQ_LINKAGE` = `off` + 空标记 + `inbox-only` + `allowTools:false` |
| 事实读取 | `readSessionFacts()` 统一兼容 `context.agent` / `session/event` 的 session / 工具上下文的 `exec.agent` 三种形状，读不到一律 `null`，不用默认值假装读到 |
| 来源判定 | `classifyProvenance()`：QQ 标记优先于受信标记；`cwd` 在 Windows 下大小写不敏感并忽略尾部分隔符 |
| 决策 | `decideRead()`（常驻注入 + 每步检索）、`decideWrite()`（是否允许直接落盘）、`decideTools()`（四个记忆工具是否可用） |
| 能力说明 | `describeLinkageRuntime(config, sessionAwareStanding)` 生成页面要显示的 `notes` |

客户端页面与宿主端执行**import 同一个模块**，所以「页面预览的结果」与「后端真正执行
的结果」不可能不一致；页面不自己再推导一套策略。

### 10.3 四个执行点的接线

```text
standing : systemPrompt.section 的 text()      → decideRead   → 不注入常驻记忆块
recall   : 每步检索（enablePerStepRecall 路径）  → decideRead   → 跳过检索注入
write    : session/event(turn/end) 的候选提取    → decideWrite  → 强制只进收件箱
tools    : ctx.tools.register 的四个记忆工具     → decideTools  → 工具对该会话不可用
```

- **常驻注入能否按会话拦截**取决于宿主是否以带会话上下文的形式求值提示词分区的
  `text` 回调：宿主 `0.2.1-rc.3` 的 `systemPrompt.assemble({agent, scope})` 会把同一
  context 传给 `text`，`QqLinkageRuntime` 只在运行时真的看到 `agent` 时才把
  `sessionAwareStanding` 置为 true；为 `false` 时页面必须如实说明「只能拦截每步检索
  与工具」。
- 每次拦截计入 `QqLinkageCounters`（`standingBlocked` / `recallBlocked` /
  `writesForcedInbox` / `toolsBlocked`），并保留最近判定样本（`QqSessionSample`），
  用于证明策略确实在跑而不是只改了界面。

### 10.4 数据形状与 RPC

`src/shared/protocol.ts` 新增两个方法 `qqLinkage` / `setQqLinkage`，返回
`QqLinkageReport`：

```ts
interface QqLinkageReport {
  config: QqLinkageConfig
  runtime: LinkageRuntimeStatus   // 含 sessionAwareStanding 与 notes
  enforcement: QqEnforcementReport // 四个执行点是否已注册 + registeredTools
  host: QqHostFacts                // profile / profileDir / dshHome / platform / nodeVersion
  vaultPath: string | null
  sessions: QqSessionSample[]      // 最近判定样本
  counters: QqLinkageCounters      // 本次进程生命周期内，重启归零
}
```

### 10.5 新增模块

| 文件 | 职责 |
|---|---|
| `src/shared/qq-linkage.ts` | 联动契约与纯函数（配置、判定、四执行点决策、运行能力说明） |
| `src/shared/protocol.ts` | `qqLinkage` / `setQqLinkage` RPC 与报告类型 |
| `src/host/qq/linkage.ts` | 宿主端 `QqLinkageRuntime`：四执行点判定、`sessionAwareStanding` 运行时观测、计数器与会话样本、报告组装 |
| `src/host/core/service.ts` | 持有 `QqLinkageRuntime`，暴露 `qqLinkage()` / `setQqLinkage()`；配置来自 `settings.qqLinkage` |
| `src/host/dsh/inject.ts` / `tools.ts` / `routes.ts` | 在既有提示词、每步检索、提取写回、工具与 RPC 路径上调用判定函数，不新增任何 QQ 协议实现 |
| `src/client/qq-channel.ts` | 官方插件同源探针（4 s 超时）+ 诊断 / 隔离矩阵组合的纯函数 |
| `src/client/views/qq.tsx` | 第 6 个一级页签「QQ 接入」的 6 张卡片 |

### 10.6 安全边界

本插件**不 import 官方包、不复制官方连接代码、不读写任何凭据**。AppSecret 由官方插件
明文写入 `<profile>/cordis.patch.yml`（证据文档 §4.3），本插件不读取、不保存、不回显；
也不自动修改任何 profile。策略默认关闭，升级不改变既有行为。
