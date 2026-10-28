# 官方 @tencent-connect/dsh-qqbot 0.5.3 消息链路核验

> 核验时间：2026-10-27　核验人：qqbot-recon（task-7）
> 方法：只读本机安装包 + 上游 tag 源码副本；未修改 node_modules / profile / 运行中实例。
> 所有行号均对应当前磁盘文件真实行号，引用格式 `文件:起-止行`。

---

## 0. 结论摘要（先看这 5 条）

1. **入站是「一轮一消息、按 peer 串行」的老实实现**：中间件链末端 `bot.on('message')` → `handleInbound()` → `manager.getOrCreate()` → `record.agent.followup(message)` → **阻塞 `await record.agent.whenIdle()`**（`dist/transport/inbound.js:46`、`:52-58`）。followup 进的是宿主 inbox 的 `next-turn` 队列，所以第二条消息**必然等本轮彻底结束**才被处理，绝不可能并入当前轮。
2. **`concurrencyGuard(strategy:'merge')` 不是 steering，是「本轮结束后的批合并」**：锁的持有期 == 整条中间件链 == `handleInbound` 的全部耗时（含 `whenIdle`）。合并发生在**锁释放时**（`drainMergeBuffer`），此时本轮早已结束。
3. **出站是「每个 `assistant/message` 就收尾一条 QQ 消息」**：`OutboundRouter.onMessage()` 一旦发现 buffer 有文本就 `buffer.flush()` → `StreamingWriter.finish()` → `session.complete()`，然后 `buffers.delete()`（`dist/transport/outbound.js:117-134`、`dist/transport/streaming-writer.js:48-69`）。多 step 的一轮 = 多条独立 QQ 消息（每次 `openStream` 都拿新 `msg_seq`）。
4. **官方插件没有任何第三方扩展点（结论：无）**：`dist/index.js` 只导出 `name/inject/Config/apply`（`dist/index.d.ts:10-14`），全 dist 无 `ctx.provide(` / `ctx.set(` / `onExpose`（grep 0 命中），只 `ctx.get(...)` 消费宿主服务；HTTP 路由仅绑定/配置页，与消息链路无关。**要实现真 steering 必须改源码（fork 或上游 PR）。**
5. **fork 完全可行**：LICENSE 为 **MIT**（`LICENSE:1-3`，Copyright (c) 2026 Tencent Connect），上游 tag `0.5.3` 的 `src/` 与本机 `dist/` 一一对应（dist 每个模块都带 `.js.map`，`sources: ../../src/...ts`）。最小改动 = **4 个源文件 + 1 处接口声明**（inbound 换 steer+去阻塞、streaming-writer/outbound-buffer 支持跨 step 提交、outbound 不在 assistant/message 收尾），**约 35 行**，见 §9.1。

---

## 1. 核验对象与版本锚点

| 对象 | 值 | 证据 |
|---|---|---|
| 本机安装路径 | `C:\Users\bf410\.dsh\profiles\desktop\node_modules\@tencent-connect\dsh-qqbot` | 目录存在 |
| 插件版本 | **0.5.3** | `package.json`: `"version": "0.5.3"` |
| npm latest | **0.5.3**（versions 末尾：0.5.0, 0.5.1, 0.5.2, 0.5.3） | `registry.npmjs.org/@tencent-connect%2Fdsh-qqbot` 查询输出 |
| SDK 依赖 | `@tencent-connect/qqbot-nodejs`：声明 `^1.0.5`，实装 **1.0.5**（npm latest 亦 1.0.5） | `package.json` dependencies；SDK `package.json` `"version": "1.0.5"` |
| 插件入口元数据 | `name = 'im-qqbot'`，`inject = ['agents']`，`Config = ConfigSchema` | `dist/index.js:6-8` |
| 上游源码副本 | `D:\dsh-memory-vault\.scratch\qqbot-053-src\dsh-qqbot-0.5.3\`（codeload tag 0.5.3 zip 1,139,369 bytes 解包） | 本次下载，见 §8 |
| 许可证 | **MIT** | `LICENSE:1-3`；`package.json` `"license": "MIT"` |

> 说明：本机 `dist/` 是唯一被 profile 加载的产物；上游 `src/` 只用于 fork 维护，两者行号不同（src 含类型定义段），本报告**结论以 dist 行号为准**，patch 清单同时给 src 行号。

---

## 2. 入站完整链路（逐层 + 行号）

### 2.1 总图

```
QQ 开放平台 WebSocket
  └─ QQBot.dispatchInbound()                       qqbot-nodejs dist/QQBot.js:399-410
       chain = [...middlewares, downstream]         (downstream = emit('message'))
       runMiddlewareChain(chain, ctx)               dist/middleware/types.js:75-96
         │
         ├─ 1 errorHandler()                         dsh-qqbot dist/gateway/middleware-setup.js:8
         ├─ 2 messageFilter({skipSelfEcho:false})    :10      (回声/去重, 去重窗口 5000ms: SDK message-filter.js:22)
         ├─ 3 accessPolicy(c2c/group)                :12-26
         ├─ 4 historyBuffer(recordOnSkip:true)       :29-39   (群历史，含未 @bot 消息)
         ├─ 5 mentionGate(requireMention)            :41-43
         ├─ 6 contentSanitizer(parseFaceTags)        :45-47
         ├─ 7 rateLimiter()                          :49
         ├─ 8 slashCommand(...) middleware           :51-57   (命中即 ctx.stop，不排队)
         ├─ 8.5 questionAnswer(manager)              :59      (待答问题答案截获，ctx.stop)
         ├─ 9 concurrencyGuard({merge,...})          :61-65   ← 锁在这里，覆盖其后全部下游
         ├─ 10 typingIndicator()                     :67
         ├─ 11 quoteRef({maxSize:500})               :69-72
         ├─ 11.5 attachmentProcessor(config,logger)  :74
         ├─ 12 envelopeFormatter({historyLimit...})  :76-80
         └─ downstream: emit('message') → bot.on('message')  dsh-qqbot dist/gateway/bootstrap.js:52-60
                cacheMsgId(...)                     :55
                handleInbound(mCtx, manager, ...)   :59
                  ├─ replyTarget = {scope,targetId,msgId}       dist/transport/inbound.js:12-18
                  ├─ assembleAgentBody() 5 层组装               :20 / :66-78
                  ├─ manager.getOrCreate()                      :27 / session-manager.js:367-432
                  ├─ createUserMessage({content:[{type:'text'}]}) :41-45
                  ├─ record.agent.followup(message)             :46
                  ├─ 群历史清空 clearGroupHistory(...)          :48-51
                  └─ await record.agent.whenIdle()  ← 阻塞点    :52-58
```

### 2.2 每层中间件职责（结论式）

| 层 | 职责 | 关键副作用 |
|---|---|---|
| errorHandler | 最外层 try/catch 兜底，异常时回一句错误文案 | 最外洋葱皮 |
| messageFilter | bot 自回声 + 按 `messageId` 去重（5s 窗口、最多 1000 条） | `senderIsBot` 时 `ctx.stop` |
| accessPolicy | 私聊/群聊 open/allowlist/disabled 三态门控 | 拦截时 `onBlock` 回调（bootstrap 只 debug 日志） |
| historyBuffer | 把群消息写入共享单例 store（`recordOnSkip:true`，未 @bot 也记） | 供 envelopeFormatter 组包；回复后由 `inbound.js:48-51` 清空 |
| mentionGate | 群聊必须 @bot | 未 @ 时 `ctx.stop`（但历史已记录） |
| contentSanitizer | 去 @marker / 表情标签 / 多余空白 | 改写 `ctx.message.content` |
| rateLimiter | sender/group/global 三层滑动窗口 | 超限丢弃 |
| slashCommand | `/bot-help` `/bot-ping` `/bot-version` `/bot-status` `/stop` `/model` `/preset` `/compact` `/new`(别名 `/reset` `/clear`) 等 | **在 guard 之前**，命中后 `ctx.stop('command:matched:...')`（SDK `slash-command.js:152-184`），因此命令不受排队影响 |
| questionAnswer | 若该 peer 有待答问题，把这条消息当答案交给 questionChannel | `ctx.stop('question-answer')`（`dist/middleware/question-answer.js:9-14`） |
| **concurrencyGuard** | 按 `scope:targetId` 串行 + merge 缓冲 | **锁覆盖下游整条链（含整轮 agent 执行）** |
| typingIndicator | 私聊「正在输入」 | 仅 C2C |
| quoteRef | 记录/解析被引用消息原文 | 写 `ctx.state.quote` |
| attachmentProcessor | 下载当前消息 + 引用消息附件到本地 | 写 `ctx.state.downloadedFiles / downloadedQuoteFiles`（`dist/middleware/attachment.js:5-23`） |
| envelopeFormatter | 把 history + quote + sender 组成 envelope | 写 `ctx.state.envelope` |

### 2.3 组装层（agent 实际看到什么）

`assembleAgentBody()` 五层（`dist/transport/inbound.js:66-78`）：
1. `buildUserContent` 文本 + 语音转录 + 附件类型标签（`:95-114`）
2. `buildQuotePart` 引用原文块（`:118-123`）
3. `buildUserMessage` 群聊加 `[昵称 (openid)]` 与 `(@you)`（`:127-135`）
4. `buildDynamicCtx` 媒体本地路径 / ASR / 引用附件（`:139-184`）
5. `buildAgentBody` 群聊历史 `[Chat history begins]...`（`:208-224`）

→ 最终 **只变成一条 `text` 块的 UserMessage**（`:41-45`）。附件不是多模态 content block，而是本地路径文本 + `qqbot_describe_image` 工具二次读取。

### 2.4 会话映射与会话级状态

- `sessionKey = qqbot:${appId}:${scope}:${peerId}`（`dist/session/session-manager.js:337-339`）
- `sessionId = sha256(sessionKey)` 格式化成 UUID 形状（`:340-343`），可被 `modelResolver` 覆盖（`:344-346`；`/new`（别名 `/reset` `/clear`）走 `remove()` 时 `setSessionId(key, randomUUID())`，见 `:447-450`）
- **同 peer 第二条消息会刷新 `record.replyTarget`**（`:367-374`，`existing.replyTarget = replyTarget`）→ 出站永远回复「最新一条入站消息」，这一点对「统一回复」是有利的。
- 空闲回收：`IdleEvictor` 超时后 `agent.cancel({kind:'user'})` + `handle.dispose()`（`:45-53`；默认 `sessionIdleTimeout: 1800000` 见 `cordis.patch.yml`）

### 2.5 阻塞点的真实含义

`await record.agent.whenIdle()`（`dist/transport/inbound.js:52-58`）等待的是宿主 `AgentLoop.whenIdle()`（宿主 `dsh-agent-loop/lib/index.js:871-876`，循环 await `activityDone`）。它位于 **guard 的 `next()` 之内**，所以：

- 锁被持有 **整个 turn 的时长**（LLM+工具全流程，默认上限 30 分钟 `processingTimeoutMs: 1800000`）；
- 期间同一 peer 的新消息只能进 merge 缓冲或队列（见 §4）；
- 期间 **另一个 peer** 不受影响（key 维度不同）。

---

## 3. `concurrencyGuard`（SDK 1.0.5）merge 实现细节

文件：`qqbot-nodejs/dist/middleware/concurrency-guard.js`（325 行，含大段文档注释）。同目录 `.d.ts` 为类型声明。

### 3.1 状态与 key

```
locks: Map<string, {busy, activeCtx?, queue[], mergeBuffer?, mergeWaiters?}>
key = `${message.replyTarget.scope}:${targetId}`      // :73-76
```
`:51-63` 默认 `strategy='queue'`、`maxQueue=3`；dsh-qqbot 传 `maxQueue=20`、`maxProcessingMs=1800000`（`cordis.patch.yml`）。

### 3.2 空闲路径（拿到锁）

| 行 | 行为 |
|---|---|
| `:80-87` | `busy=true`、`activeCtx=ctx`；merge 策略初始化 `mergeBuffer=[]`、`mergeWaiters=[]` |
| `:92-111` | 若 `maxProcessingMs>0` 起 `setTimeout` 看门狗 |
| `:112-114` | `await next()` —— **整条下游链（含 agent 整轮）都在这里** |
| `:115-133` | `finally`：清定时器；未超时则 `activeCtx=undefined` → merge 策略 `await drainMergeBuffer(...)` → **然后**才 `busy=false` |

### 3.3 忙时 merge 路径

| 行 | 行为 |
|---|---|
| `:138-142` | 确保 `mergeBuffer/mergeWaiters` 存在 |
| `:145-153` | **urgentPredicate**：命中就 `resolve()` 所有 waiters（它们 `isSurvivor=false` → **静默丢弃**）、清空 `mergeBuffer`，本消息 `await next()` **与 active 并行**继续走链 |
| `:154-159` | 溢出：`mergeBuffer.length >= maxQueue` → `onDrop?.(ctx)` + `ctx.stop('concurrency:merge-full')`（**丢弃**） |
| `:160-175` | 正常缓冲：`mergeBuffer.push(ctx)`、`mergeWaiters.push({ctx,resolve,markSurvivor})`，**不调用 `next()`**，在 Promise 上挂起 |
| `:176-179` | 被唤醒后：只有 survivor 才 `await next()`；其余直接 `return`（链条自然终止，不用 `ctx.stop`） |

### 3.4 幸存者选择与默认 onMerge

`drainMergeBuffer()`（`:244-279`）：
- `while (mergeBuffer.length>0)`：`splice(0)` 取整批；
- `survivor = onMerge ? onMerge(buffered) : defaultMerge(buffered)`；**若 `onMerge` 返回值不在批里，回退 `buffered[0]`**（`:250`）；
- 无 `onDispatch`（dsh-qqbot 未传）→ 标记 survivor 的 waiter（`:268-274`）→ 全部 resolve → survivor 走自己的 `next()`；
- 结束后 `mergeBuffer/mergeWaiters = undefined`（`:277-278`）。

`defaultMerge()`（`:299-322`）—— 这是 dsh-qqbot 实际用的合并实现：
```
contentBearingCtxs = buffered.filter(ctx => (ctx.message.content ?? '') !== '')
first.message.content = 各 content join('\n')
first.state.envelope   = 各 state.envelope join('\n\n')
first.message.attachments = 各 ctx.message.attachments 扁平合并
return first
```
→ **只继承 `first` 的 `ctx.state`**（`quote`、`downloadedFiles`、`history`、`mention` 都是 first 的），其余 ctx 的 state 被丢弃。这是 merge 策略的真实语义边界（见 §10 R6）。

### 3.5 urgentPredicate 的真实语义（重要，反直觉）

- urgent 消息**不会**并入当前轮，它只是**绕过锁、与当前处理并行地走完剩余链**（`:151-152`）；
- 同时它会把缓冲里的消息**全部丢弃**（`:147-150` resolve 后 `isSurvivor=false` → 直接 return，且 `mergeBuffer.length=0`）；
- dsh-qqbot 0.5.3 **没有传 `urgentPredicate`**（`middleware-setup.js:61-65` 只有 strategy/maxQueue/maxProcessingMs），所以该分支在本机不会走到。

### 3.6 `maxProcessingMs` 触发 abort 的真实效果（与注释不符，需纠正）

`bootstrap` 传的 `processingTimeoutMs` = `1800000`（30 分钟）。触发时（`:95-110`）：

```js
timedOut = true
ctx.log.warn?.('...aborting active chain ...')
ctx.abort('concurrency:processing-timeout')
state.busy = false; state.activeCtx = undefined
if (merge) drainMergeBuffer(...) else drainQueue(key)
cleanupState(key)
```

而 `ctx.abort()` 的真实实现只是 abort 一个 **per-message 的 AbortController** 并置 `stopped=true`（`dist/middleware/types.js:106-133`）。**它不会调用 `agent.cancel()`**；同时 `handleInbound()` 从不读取 `ctx.signal`（`dist/transport/inbound.js` 全文无 `signal` 引用），`attachmentProcessor` 的下载也不带 signal。

结论：
- `maxProcessingMs` 的真实后果 = **提前释放锁 + 排空 merge 缓冲 + 打一条 warn**，让下一条消息能开新一轮（与仍在跑的那一轮重叠）；
- 它**并不**中断当前 LLM 调用/工具执行（注释 `:88-91` 的 "canceling in-flight LLM calls, tool executions, and streaming" 在当前代码路径上不成立）。
- 因此「超时保护」实际由宿主/上游层（如 `ReplyLimiter` 失效、用户 `/stop`）兜底，而不是这里。

---

## 4. 0.5.3 是否已有「运行中消息并入当前轮」的能力

**结论：没有。** 三种策略的真实后果：

| 策略 | 当前消息 | 后续消息 | 是否并入本轮 |
|---|---|---|---|
| `queue` | 立即执行 | 进 `state.queue`，`busy=false` 后依次唤醒（`:212-235`） | 否，**严格串行排队** |
| `merge`（现用） | 立即执行 | 缓冲到 `mergeBuffer`，**本轮 `next()` 返回后**合并成 survivor 再走链（`:244-279`） | 否，**本轮结束后**批处理 |
| `abort` | 立即执行 | 新消息 `activeCtx.abort()` + 排空队列，自己抢锁（`:187-211`） | 否，**打断**（且只 abort 中间件 ctx，非 agent） |
| `drop` | 立即执行 | 直接丢弃（`:181-186`） | 否 |

再叠加 `handleInbound` 的 `followup`：`followup` 在宿主里固定是 `send(input, 'next-turn', true)`（宿主 `dsh-agent-loop/lib/index.js:807-809`），即**入 next-turn 队列**，本轮的 step 循环永远看不到它。

**它做不到的三件事（必须明确）**
1. 做不到「用户连发的后半句在模型下一步就看到」——followup 只到下一轮；
2. 做不到「不打断地追加」——merge 的合并发生在**本轮已经结束之后**；
3. 做不到「让当前轮继续下去」——本轮是否继续只由宿主 step 循环/`agent/turn-stopping` 决定，SDK 侧无接口。

**它已经具备的、可复用的部分**
- `replyTarget` 每消息刷新（`session-manager.js:371`）→ 统一回复可锚定最新 msgId；
- 中间件 `questionAnswer` / `slashCommand` 在 guard 之前 → 命令与「问题答案」不会被排队，改造后仍应保持这个顺序；
- `merge` 的批处理本身可作为「同一瞬间多条」的兜底批合并（见 §9.1 P2）。

---

## 5. 出站链路（assistant 输出 → QQ 消息）

### 5.1 总图

```
宿主 session/event (durable)            ctx.on('session/event')  bootstrap.js:95-96
  └─ OutboundRouter.route()             outbound.js:40-67
       assistant/chunk   → onChunk    :48-50 / :69-71   (历史兼容；当前宿主不再产)
       assistant/message → onMessage  :51-53 / :117-134
       tool/call         → onToolCall :54-56 / :140-142  (只记不发)
       tool/result       → onToolResult :57-59 / :144-155 (错误必发；成功看 showToolResults)
       deliverables/presented → onPresented :60-62 / :157-171 (收集，轮末发)
       turn/end          → onTurnEnd  :63-65 / :176-207

宿主 agent/assistant-stream (transient, /{global:true})  bootstrap.js:101-106
  └─ parseStreamFrame()                 events.js:89-111
       start  → {kind:'attempt-start'}  → routeStreamFrame :82-100 → buffer.reset()
       chunk  → {kind:'text-delta'}     → appendChunk → buffer.append()
```

### 5.2 各文件职责

| 文件 | 职责 | 关键行 |
|---|---|---|
| `transport/outbound.js` | 出站路由 + 会话级状态（buffers/toolCalls/streamAttempts/presented*/pendingText），决定「何时 flush、发给谁」 | `:11-38` 字段；`:40-67` 分发；`:209-219` `send()`（chunk + 逐条 `sendMarkdown`） |
| `transport/events.js` | 把弱类型 `session/event` 解析为强类型；`parseStreamFrame` 归一化 `agent/assistant-stream`（只认 start / text-delta） | `:13-66`、`:72-80`、`:89-111` |
| `transport/outbound-buffer.js` | 累积文本 + 持有 StreamingWriter；`append/reset/flush/cancel` | `:4` 节流 200ms；`:23-26`；`:31-35`；`:37-61`；`:63-66` |
| `transport/streaming-writer.js` | 真正驱动 QQ 流式：节流 → 串行 `update(fullText)` → `finish()` 里 `complete()`；失败降级静态 | 全文 122 行 |
| `transport/reply-limiter.js` | 被动回复限额（默认 4 次 / 消息，TTL 1h，最多跟踪 1 万条） | `:12-16`、`:18-33`、`:35-48` |
| `transport/chunker.js` | 按行切分，避开代码块与 GFM 表格，`textChunkLimit` 默认 4500（`cordis.patch.yml`；SDK 常量 5000 见 `qqbot-nodejs/src/protocol/utils/text-chunk.ts:11`） | `:15-77` |
| `transport/reply-target.js` | 被动回复三级兜底：显式 msgId → 缓存最近消息/事件 id → 主动推送；区分 `msg_id` 与 `event_id` | `:18-37`、`:43-54` |
| `transport/msgid-cache.js` | 缓存每 peer 最近 msgId/eventId（供兜底） | 被 `bootstrap.js:55`、`:121` 调用 |
| `transport/deliverables.js` | `present` 声明的文件在 turn/end 后投递 | `bootstrap.js:93`、`outbound.js:202-204` |
| `transport/tool-presenter.js` | 工具结果结构化展示 | `outbound.js:151` |

### 5.3 流式 start / update / complete 的**真实时机**

**start（= `bot.openStream`）**：`StreamingWriter.pushUpdate()` 首次被调用且 `!session` 时（`streaming-writer.js:100-110`）。首次 push 由 `append()` 的 200ms 节流定时器（`:41-46`）或 `finish()` 里的 `enqueue()`（`:58`）触发。→ **第一条 text-delta 之后约 200ms**（SDK 侧再被夹到 ≥300ms，见 §6）。

**update**：`session.update(this.fullText)`，**全量替换语义**（QQ `input_mode=replace`），串行 chain 保证顺序（`streaming-writer.js:92-120`）。

**complete**：只有 `finish()`（`:48-69`）与 `abort()`（`:70-91`）会 `session.complete()`，且**只要 session 已打开就 complete，无论是否降级**（`:60-68`）。

**「是否每个 assistant/message 都 complete」→ 是，这是当前碎片化的根因：**

```js
// outbound.js:117-134  onMessage()
const buffer = this.buffers.get(sessionId);
if (buffer !== undefined && buffer.text.trim()) {
    this.trackText(sessionId, buffer.flush());   // flush → writer.finish() → session.complete()
    this.buffers.delete(sessionId);              // ← 关键：buffer 被删掉
    return;
}
... // 无流式（群聊/未开启 streaming）：直接 chunk + sendMarkdown(...) :209-219
this.buffers.delete(sessionId);
```

- 流式成立时每个 `assistant/message` → 一次 `flush()` → 一次 `complete()` → **一条 QQ 消息**；
- `buffers.delete()` 后，下一步的 `agent/assistant-stream` 会**新建** `OutboundBuffer`（`outbound.js:102-109`）→ 新建 `StreamingWriter` → 新 `StreamSession` → `openStream` 再取一个**新的 `msg_seq`**（SDK `routes.js:45-49` `getNextMsgSeq`）→ QQ 侧是**第二条独立消息**；
- 宿主每个 step 恰好产 **1 条** `assistant/message`（宿主 `dsh-agent-loop/lib/index.js:1149-1160`，`live.settle('assistant/message', () => session.append('assistant/message', ...))`；重试 attempt 只落 `assistant/attempt`），所以：**一轮 N 个 step = N 条 QQ 消息**（若每步都有文本）。
- 群聊（`shouldStream` 为 false：`!streaming || scope!=='c2c' || !msgId`，`outbound.js:111-115`）→ 每步 `sendMarkdown`（按 4500 字切块），同样是多条。

### 5.4 `StreamingWriter.reset()` 真实语义

`streaming-writer.js:22-33`：

```js
reset() {
    if (this.finished) return;
    this.fullText = '';       // 只清累积文本
}
```
- **保留** `session`（同一条流式消息不重开）、`sentChunkCount`（防降级重复）、`failed/aborted/finished`；
- 语义：LLM 重试产生新 attempt 时，用新 attempt 的增量**整体重写**同一条消息（因为 update 是 replace）；
- 调用点只有一处：`routeStreamFrame()` 收到 `attempt-start` 帧 → `buffers.get(agentId)?.reset()`（`outbound.js:83-87`）；
- **本次改造的关键**：reset 目前会连「上一 step 已展示的文本」一起清掉，所以必须给它加一个「已提交前缀」概念（见 §9.1 P3）。

### 5.5 `turn/end` 收尾

`onTurnEnd()`（`outbound.js:176-207`）：
1. 若有 buffer 且仍有文本 → `flushTask = buffer.flush()`；否则 `buffer.cancel()`；`buffers.delete()`
2. `streamAttempts.delete()`
3. 取 `presentedFiles` 并清空
4. `await Promise.all([flushTask, pendingText])` —— 保证「回复文本先到、交付文件后到」
5. `reason.kind==='error'` 且 code 不在 `SILENT_TURN_ERROR_CODES`（`STREAM_CLOSED`）时，补一句 `⚠️ 本轮异常结束 ...`
6. `deliverer.deliver(record, files)` 投递 present 文件

→ **`turn/end` 已经天然是「统一回复」的收尾点**，这也是最小改动可以利用的现成钩子。

---

## 6. SDK 1.0.5 `stream_messages` 能力与限制

实现：`qqbot-nodejs/dist/streaming.js:34-207`（`StreamSession`），类型：`dist/streaming.d.ts`，API：`dist/protocol/api/messages.js:87-108`（`POST /v2/users/{openid}/stream_messages`）。

| 问题 | 结论 | 证据 |
|---|---|---|
| 支持范围 | **仅 C2C 私聊**；群聊 `openStream` 直接 `throw new Error("Streaming is only supported for C2C targets")` | `QQBot.js:652-655`；`USAGE.md:483`、`:766` |
| 必须锚定入站消息 | `target.msgId` 必填，否则 `throw new Error("Streaming requires target.msgId from the inbound message")`；且须是 **5 分钟内**的入站消息 | `QQBot.js:656-658`；`USAGE.md:507` |
| 同一 msgid 能否多次 update | **能**。一个 `StreamSession` 内可 update 任意多次；所有帧共享**同一个 `msg_seq`**，`index` 自增 | `streaming.js:42-45` 注释、`:134` `currentIndex = this.index++`、`:142` `msg_seq` |
| 能否为同一 msgid 开多个流 | 能，但**每个 `openStream` 拿新 `msg_seq`**（`getNextMsgSeq`）→ QQ 视为**另一条消息**；`stream_msg_id` 只在同一 session 内复用 | `routes.js:45-49`；`streaming.js:131-132`、`:145-151` |
| 频率限制 | SDK 侧节流 **min 300ms / default 500ms**（`Math.max(opts.throttleMs ?? 500, 300)`）；dsh-qqbot 传 200，**实际被夹到 300** | `streaming.js:12-13`、`:56`；dsh-qqbot `outbound-buffer.js:4` |
| 平台限流重试 | 429 / err_code `50002` → 最多 3 次指数退避（1s/2s/4s），并**推进 index** | `streaming.js:178-205`、`:191` |
| 长度限制 | 流式内容同样受单条上限约束；SDK 常量 `TEXT_CHUNK_LIMIT = 5000`，dsh-qqbot 用 `textChunkLimit: 4500` 切块（静态降级时） | `qqbot-nodejs/src/protocol/utils/text-chunk.ts:11`；`cordis.patch.yml` |
| **complete 后能否再改** | **不能**。`update()` 开头 `if (this.isCompleted) return;` 直接 no-op；`complete()` 幂等 | `streaming.js:63-66`、`:91-95` |
| 是否有「update 次数」硬上限 | SDK **未实现**次数上限；`index` 单调自增无上限。平台侧次数/时长限制未在 SDK 中编码，**本机未验证**（不做断言） | `streaming.js` 全文无 count 上限 |
| cancel | `cancel()` 只停后续自动 flush，**不发 DONE** → 消息停在最后状态 | `streaming.js:106-113`、`USAGE.md:509` |
| 漏帧防护 | `flush()` 发现 `pendingText === lastSentText && state!==DONE` 时跳过；DONE 帧必发；flush 在飞时只留尾帧 | `streaming.js:115-126`、`:161-172` |
| 被动回复配额 | 插件自管 `ReplyLimiter({limit:4})`：同一 msgId 最多 4 次被动回复，TTL 1h，超限/过期降级主动推送 | `bootstrap.js:72`；`reply-limiter.js:12-33`；`reply-target.js:18-37` |

**对本需求最关键的两条**：
1. 同一 `msgId` 内想「一条消息、不断更新」是完全可行的——但**必须复用同一个 `StreamSession`**（不能每步 `openStream`）。
2. `complete()` 是单向门，所以「统一回复」只能把 complete 推迟到 `turn/end`。

---

## 7. 扩展点评估：**无**

**结论（按「有 / 无」二选一）：无第三方扩展点。**

搜索证据（全部在 `C:\Users\bf410\.dsh\profiles\desktop\node_modules\@tencent-connect\dsh-qqbot\dist` 与上游 `src`）：

| 检查项 | 结果 |
|---|---|
| `ctx.provide(` / `ctx.set(` / `onExpose` / `ctx.mixin` / `ctx.plugin(` | **0 命中**（全 dist `.js` grep） |
| 导出面 | 仅 `name = 'im-qqbot'`、`inject = ['agents']`、`Config`、`apply`（`dist/index.d.ts:10-14`；`dist/index.js:6-10`；`package.json` exports 只有 `.`、`./client`、`./locale/*.json`、`./package.json`） |
| 消费的宿主事件 | `system-prompt/assemble`（`session-manager.js:79`）、`approval/request`（`approval-channel.js:63`）、`session/event`（`bootstrap.js:96`）、`agent/assistant-stream`（`bootstrap.js:102`）——**都是订阅，不对外发** |
| 消费的宿主服务 | `agents`（`inject`）、`tools`、`llm`、`attachments`、`sessions`、`agentPresets`、`sessionPersistence`、`compaction`、`userQuestions`（grep `ctx.get(` 共 9 处）——**全部是只读获取，无 expose** |
| 配置里是否有「钩子/自定义中间件/回调 URL」 | 无。`ImQQBotConfig` 全字段见 `dist/config.d.ts:50-95`，无任何扩展注入项 |
| HTTP 路由是否可作扩展点 | 仅绑定/配置：`/qqbot/im-qqbot/...`（`dist/setup/bind-routes.js:52-81`：state/refresh/manual/unbind/config），与消息链路无关 |
| 客户端导出 `./client` | 只是端内绑定/设置 UI bundle（`lib/client.js`），不向外暴露消息能力 |
| 事件被动旁路 | 第三方**可以**自己 `ctx.on('session/event')` / `agent/assistant-stream` 旁听（只读），但**无法拦截、无法改写、无法阻止**官方把消息 followup 进 next-turn，也无法取得 `bot`（QQBot 实例只在 `bootstrapGateway` 闭包内） |

→ 要实现真 steering / 统一回复，**必须改源码**。可维护性判断：MIT + 上游 src 齐全 + dist 与 src 一一对应 → **fork 一个 `@<org>/dsh-qqbot` 独立包是可行且唯一干净路径**（或向 `tencent-connect/dsh-qqbot` 提 PR，改动面见 §9.1）。

---

## 8. 上游 tag 0.5.3 ↔ 本机 dist 对应关系

- 下载：`https://codeload.github.com/tencent-connect/dsh-qqbot/zip/refs/tags/0.5.3` → 1,139,369 bytes → 解包到 `D:\dsh-memory-vault\.scratch\qqbot-053-src\dsh-qqbot-0.5.3\`
- 上游 `package.json`：`name=@tencent-connect/dsh-qqbot`、`version=0.5.3`、`license=MIT` —— 与本机安装一致
- 对应关系证据：本机 `dist/**/*.js.map` 每条 `sources` 指向 `../../src/**/*.ts`（例：`dist/gateway/middleware-setup.js.map` → `sources: ["../../src/gateway/middleware-setup.ts"]`），说明 dist 就是该 tag 的 `tsc` 产物；上游 `src/` 目录结构（`client/ commands/ features/ gateway/ media/ middleware/ model/ session/ setup/ shared/ transport/`）与 dist 子目录完全同构。
- 上游 `src/` 比 dist 多出的只有：13 个 `*.test.ts`（approval-channel / question-channel / bind-routes / binding-service / utils / deliverables / events / msgid-cache / outbound-buffer / outbound / reply-limiter / reply-target / streaming-writer）与 `src/client/**`、`src/types-augment.d.ts`、`src/config.ts`、`src/types.ts`（纯类型，不产 dist 实体）。
- 差异点：上游 `src` 用 `../config.ts` 显式扩展名导入，dist 编译为 `.js`；`src/session/types.ts:23-38` 声明了 `DshAgent` 接口（`status` `:27`、`followup` `:34`、`whenIdle` `:35`，**缺 `steer`，这正是要改的地方**，见 §9.1）。
- LICENSE：`MIT License / Copyright (c) 2026 Tencent Connect`（本机 `LICENSE:1-3` 与上游逐字一致）；`package.json` `"license":"MIT"`。→ **允许 fork、改名、闭源分发（保留版权声明即可）**。

---

## 9. 最小改动方案（fork 内实现「非打断式连续消息合并 + 统一回复」）

### 9.0 为什么必须换 `steer`：宿主语义（本机 0.2.1-rc.3 已核验）

宿主 `@deepseek-ai/dsh-agent-loop`（`.scratch/agent-pkgs/dsh-agent-loop/lib/index.js`）：

```js
send(message, target, wakeup)         // :801-806
followup(input) { this.send(input, 'next-turn', true) }   // :807-809
steer(input)    { this.send(input, 'next-step', true) }   // :810-812
inject(input)   { this.send(input, 'next-step', false) }  // :813-815
cancel(cause, options={}) { if (!options.keepInbox) this.inbox.clear(); ... }  // :816-822
```

- 一轮的 step 循环（`:939-1010`）：第一次 `preStep(target='next-turn')`，之后 `target='next-step'`；
- `inbox.claim(target, turn)` 的定义是 **「先取空全部 next-step，再按 target 取 1 条 next-turn」**（`:104-112`）→ 所以：
  - **running 时 steer** → 插到 next-step → **当前轮的下一步骤就消费**；
  - **idle 时 steer** → `wakeDriver()` 起一轮，第一步 `claim('next-turn')` 仍会先取 next-step → 消息不丢；
- 更关键：step 结束若 `turnEnds && inbox.nextStep.length === 0` 才 `agent/turn-stopping` 并 break（`:1001-1009`）。**只要 next-step 非空，本轮继续** → steer 天然实现「把用户新话并进本轮，不打断、不结束」。
- `Agent` 公开接口已含 `steer` / `followup` / `whenIdle` / `cancel`（`.scratch/agent-pkgs/dsh-api-session-controller/lib/typert.host.js:2192` 的 `interface Agent` 声明）→ 插件 `src/session/types.ts:23-38` 的 `DshAgent` 接口只需补一个 `steer(message: unknown): void`。

### 9.1 补丁清单（5 个必改文件 + 2 个可选）

> 行号：`src/...` = fork 里要改的位置（上游 tag 0.5.3 源码行号）；`dist/...` = 本机当前产物对应位置（便于比对验证）。

#### P1【必改】`src/transport/inbound.ts` — 换成 steer，并去掉阻塞

| 位置 | 现状 | 改为 |
|---|---|---|
| `src:137`（`dist/transport/inbound.js:46`） | `record.agent.followup(message);` | `if (record.agent.status === 'running') record.agent.steer(message); else record.agent.followup(message);`（或统一 `steer`，语义见 §9.0 同样成立） |
| `src:145-150`（`dist/transport/inbound.js:52-58`） | `await record.agent.whenIdle()` + try/catch | **删除该 await**（改为不等待；需要观测可 `void record.agent.whenIdle().catch(...)`） |
| `src/session/types.ts:23-38`（`DshAgent` 接口；`status: 'idle'\|'running'` 已在 `:27`、`followup` `:34`、`whenIdle` `:35`） | **没有 `steer`**；`cancel(cause)` 也无 `keepInbox` 选项 | 增加 `steer(message: unknown): void;`（若要实现 R1 的 `keepInbox`，把 `cancel` 签名放宽为 `cancel(cause, options?: { keepInbox?: boolean })`） |

**副作用**：guard 锁的持有期从「整轮」缩到「一次 getOrCreate + followup 交接」（毫秒级），后续消息立刻进链并被 steer；`whenIdle` 不再阻塞消息链（这也顺带修掉 SDK `USAGE.md:784-785` 警告的反模式）。

#### P2【建议】`src/gateway/middleware-setup.ts` — guard 保序但不再批合并（可选）

| 位置 | 现状 | 改为 |
|---|---|---|
| `src:98-102`（`dist/gateway/middleware-setup.js:61-65`） | `concurrencyGuard({ strategy:'merge', maxQueue, maxProcessingMs })` | 二选一：<br>(a) **不动**（P1 后 merge 只是极小概率下的「同时到达」批合并，行为可接受）；<br>(b) 若要杜绝 `defaultMerge` 丢 state（附件/引用/history 只保留 first），换成 `strategy:'queue', maxQueue` 并**保留** `maxProcessingMs`——queue 也只是排「交接」，不会排队整轮。 |

> 注意：**不要**改成 `abort`/`drop`；也不要用 `urgentPredicate`（它会丢弃缓冲消息，§3.5）。

#### P3【必改·统一回复】`src/transport/streaming-writer.ts` + `outbound-buffer.ts` — 引入「已提交前缀」

目标：同一轮内多个 step 共用**一个** `StreamSession`，只 `update` 全量，**只在 turn/end `complete()` 一次**。

`src/transport/streaming-writer.ts`
```ts
// 新增字段（类字段区 src:24-31）
private committedLen = 0;

// src:56 reset() 改为「只回退到上次提交点」
public reset(): void {
  if (this.finished) return;
  this.fullText = this.fullText.slice(0, this.committedLen); // 原来是 = ''
}

// 新增：提交当前 step 的文本（不关流）
public commit(): void { this.committedLen = this.fullText.length; }
```
- 其余（`append` 的节流块 `:62-74`、`finish` `:77-100`、`abort` `:103-125`、`pushUpdate` `:133-158`）**不动**：`finish()` 仍然是唯一 `complete()` 入口，只是现在只在 turn/end 调。

`src/transport/outbound-buffer.ts`
```ts
private committedLen = 0;                       // 新增
public commit(): void { this.committedLen = this.buffer.length; this.writer?.commit(); }   // 新增
public reset(): void {                          // src:65 改造
  this.buffer = this.buffer.slice(0, this.committedLen);
  this.writer?.reset();
}
```
`flush()` / `cancel()` 不动。

#### P4【必改·统一回复】`src/transport/outbound.ts` — `onMessage` 不再收尾

`src:182-198`（`dist/transport/outbound.js:117-134`）：

```ts
private onMessage(sessionId, record, event) {
  let buffer = this.buffers.get(sessionId);
  if (buffer === undefined) {                       // 群聊/无流式也要累积
    buffer = new OutboundBuffer(record, this.bot, this.config.textChunkLimit,
                                this.logger, this.shouldStream(record));
    this.buffers.set(sessionId, buffer);
  }
  if (!buffer.text.trim()) {                        // 没有流式帧（群聊）→ 用 durable 全文
    const fullText = event.content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n');
    if (!fullText.trim()) return;
    buffer.append(fullText);
  }
  buffer.commit();                                  // ← 只提交，不 flush、不 delete、不 complete
}
```
`onTurnEnd()`（`src:250-...` / `dist:176-207`）**保持原样**：轮末 `buffer.flush()` → `writer.finish()` → 唯一一次 `complete()`；交付文件/错误提示逻辑不变。

**效果**：c2c 一轮 = 1 条 QQ 流式消息，内容为各 step 文本顺次累积；LLM 重试（attempt-start）只回滚当前 step 段；群聊一轮 = 1 次（可能多块的）静态发送，在轮末发生。

#### P5【可选】配置开关
`src/config.ts` 增加 `unifiedReply: boolean`（默认 true）与 `steering: 'auto'|'off'`；`apply` 里读。便于灰度与回退（回退 = 走旧 followup + 每步 flush）。

### 9.2 改动量评估

| 文件 | 增/改行数（估） | 风险 |
|---|---|---|
| `src/transport/inbound.ts` | ~6 | 中（改变并发/时序语义） |
| `src/session/types.ts` | ~1 | 低 |
| `src/transport/streaming-writer.ts` | ~6 | 低 |
| `src/transport/outbound-buffer.ts` | ~8 | 低 |
| `src/transport/outbound.ts` | ~12 | 中（群聊回复延迟到轮末） |
| `src/gateway/middleware-setup.ts` | 0～2 | 低 |
| 合计 | **≈ 35 行** | 无新增依赖、无协议层改动 |

### 9.3 另一种「零改官方包」路径——不可行（说明为什么放弃）

第三方插件可以自己：
- `ctx.get('agents')` 拿到 registry，按 `sessionId = sha256('qqbot:'+appId+':'+scope+':'+peerId)` 格式化后拿到同一个 agent，然后自己 `agent.steer(...)`；
- 但**无法阻止**官方 `handleInbound` 已经执行的 `followup`（消息已进 next-turn 队列），也无法取消它（`cancel({keepInbox:true})` 会中断本轮）→ 会**重复投递同一句话**；且拿不到 `bot` 实例，无法接管出站。→ 只能 fork / 上游 PR。

---

## 10. 风险清单（改策略/改链路后逐条）

> 前提：按 §9 改造（steer + 取消 whenIdle 阻塞 + 轮末统一 complete）。

| # | 场景 | 影响 | 处置建议 |
|---|---|---|---|
| R1 | `/stop`（`dist/commands/misc.js:47-66`） | 命令在 guard 之前，**仍即时生效**；但 `agent.cancel({kind:'user'})` 默认 `keepInbox:false` → **inbox.clear() 会丢弃已 steer 进来但尚未消费的消息**（宿主 `agent-loop:816-822`）。改造后「用户连发 3 条，第 3 条在队列里时按 /stop」→ 第 3 条丢失（今天丢的是 merge 缓冲，性质相同） | 文档明确；或 fork 里 `/stop` 改 `cancel({kind:'user'}, {keepInbox:true})`（会改变语义，需产品决策） |
| R2 | 审批（`approval-channel.js:61-72`、`106-135`） | 审批走 `approval/request` waterfall 挂起 Promise，**不占 guard 锁**；改造后审批期间用户再发消息 → 会被 steer 进 next-step，要等审批 resolve 后才被消费（本轮被阻塞在工具审批） | 可接受；若担心「审批期间误发消息污染上下文」，可在 steer 前判 `manager.approvalChannel.pending.has(key)` → 排队到审批结束 |
| R3 | 待答问题（`question-answer.js:2-18`） | 答案消息在 guard 前被 `questionChannel.tryAnswer()` 截获并 `ctx.stop`，**不受改造影响** | 保持中间件顺序（questionAnswer 必须在 guard 之前） |
| R4 | 附件（`middleware/attachment.js`、`transport/attachment.js`） | 当前消息附件在 guard **之后**下载。改造后每条消息都会正常走一遍 → **每条消息的附件各自下载、各自以本地路径文本进入它自己的 UserMessage**，不再经过 `defaultMerge` 丢附件；但**同一轮里多条带附件消息**会让模型看到多个 `Image: ...` 行，没问题 | 无需处置；反而比 merge 更正确 |
| R5 | 群聊历史（`historyBuffer` + `features/history-store.js`） | `recordOnSkip:true` 记录所有群消息；`handleInbound` 在 followup 后 `clearGroupHistory`（`inbound.js:48-51`）。改造后**每条消息都会清空一次**群历史：一轮内第 2 条消息组包时历史已被第 1 条清空 → 第 2 条看不到第 1 条前后的群聊上下文（但第 1 条本身已作为 agent 消息在会话里） | 建议 fork 里把 `clearGroupHistory` **挪到 turn 结束**（例如 `outbound.onTurnEnd`）或仅在 `status!=='running'` 时清 |
| R6 | `concurrencyGuard` 策略变更本身 | `merge`→`queue`：缓冲语义变化，`onDrop` 不会触发；`maxProcessingMs` 语义仍只是「释放锁」，见 §3.6 | 若保留 merge，注意 `defaultMerge` 只继承 first 的 state（§3.4）；改 queue 可规避 |
| R7 | `maxProcessingMs`（30 分钟） | 改造后锁基本不再长时间持有 → 该看门狗**基本失效**；原先它也只是假中断（§3.6） | 需要「跑飞保护」应在 fork 里加：`turn/start` 后起表，超时调 `agent.cancel()`（真正中断） |
| R8 | 被动回复配额（4 次/msgId，TTL 1h） | 统一回复后每轮只在轮末发 1 条文本（+ 若干交付文件），**配额压力显著下降**，是好方向 | 无需处置 |
| R9 | 5 分钟被动回复窗口 | 长任务（>5min）后 `msgId` 过期 → `resolveReplyTarget` 降级主动推送（`reply-target.js:18-37`）；统一回复把发送推到轮末，**更容易撞上过期** | 保持现状即可（已有主动推送兜底）；或对超长轮次在 4 分钟处先发一条进度占位 |
| R10 | 群聊无流式 | 统一回复后群聊**整轮结束才发第一条**（原先每 step 发一条「边跑边说」）。长任务在群里会「长时间静默」 | 二选一：群里保留旧行为（`shouldStream=false` 时不 commit，仍每步发）；或加「进度提示」消息 |
| R11 | 流式降级 | `StreamingWriter.shouldFallback`（`sentChunkCount===0`）时 `flush()` 走静态 chunk 发送；改造后 flush 只在轮末发生，降级路径仍是「轮末一次性发送」 | 行为等价，无需处置 |
| R12 | 交错并发 | steer 不改变「一个 agent 同时只有一轮」的宿主保证；改造后同一 peer 的多条消息会**在同一轮的不同 step** 被消费，`user/message` 事件按序落盘 | 无需处置 |
| R13 | 与 `session/event` 旁路插件的冲突 | 本仓库的「长期记忆」插件如果也在 `session/event` 上工作，统一回复会让**一轮内 assistant/message 条数不变**（只是出站合并），对记忆抽取无影响 | 无需处置 |
| R14 | HMR / 升级 | fork 包名必须不同（如 `@dsh-memory/dsh-qqbot`），避免 `dsh plugin add` 被官方包覆盖；`cordis.patch.yml` 里 `im-qqbot` 的 id 可保持不变 | 打包时改 `name` 与 `repository`，保留 MIT 声明 |

---

## 11. 复现与验证方法（本次使用的命令）

```powershell
# 1) 版本与许可证
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@tencent-connect\dsh-qqbot\package.json" -Raw
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@tencent-connect\dsh-qqbot\LICENSE" -TotalCount 3

# 2) 扩展点搜索（预期 0 命中）
$d="$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@tencent-connect\dsh-qqbot\dist"
Select-String -Path (Get-ChildItem -Recurse -File -Filter *.js $d).FullName -Pattern '\.provide\(|ctx\.set\(|onExpose|ctx\.mixin'

# 3) steer 搜索（预期仅 misc.js 一处 interrupt 注释命中）
Select-String -Path (Get-ChildItem -Recurse -File -Filter *.js $d).FullName -Pattern 'steer'

# 4) guard 配置
Get-Content "$d\gateway\middleware-setup.js" | Select-Object -Skip 59 -First 8

# 5) 出站收尾点
Get-Content "$d\transport\outbound.js" | Select-Object -Skip 116 -First 20

# 6) SDK 流式限制
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@tencent-connect\qqbot-nodejs\dist\streaming.js" | Select-Object -Skip 60 -First 60

# 7) 上游源码
#   下载 https://codeload.github.com/tencent-connect/dsh-qqbot/zip/refs/tags/0.5.3
#   解包到 D:\dsh-memory-vault\.scratch\qqbot-053-src\dsh-qqbot-0.5.3\
```

**未验证项（明确标注，不做断言）**
- QQ 平台侧对 `stream_messages` 的**次数/时长**硬上限（SDK 未编码，需以开放平台文档/实测为准）；
- 流式消息是否消耗「被动回复 N 次/条」配额（SDK 与插件均未处理该交互）；
- `ctx.abort()` 是否真的能沿下游影响到宿主 LLM 调用（代码路径上不成立，§3.6；如需可作为后续实验）。

---

## 12. 一页备忘：要做的事

1. fork `tencent-connect/dsh-qqbot@0.5.3`（MIT），改名 `@dsh-memory/dsh-qqbot`；
2. `inbound.ts`：`followup` → `status==='running' ? steer : followup`，删掉 `await whenIdle()`（≈6 行）；`session/types.ts` 的 `DshAgent` 补 `steer` 声明（≈1 行）；
3. `streaming-writer.ts` / `outbound-buffer.ts`：加 `committedLen` + `commit()`，`reset()` 回退到提交点（≈14 行）；
4. `outbound.ts::onMessage`：只 `commit()`，不 `flush/delete/complete`；统一在 `turn/end` 收尾（≈12 行）；
5. 群聊历史清空挪到轮末、`/stop` 的 `keepInbox` 与超时取消另立 issue；
6. 不改协议层、不改 SDK、不加依赖；回归验证点：多 step 单条回复、LLM 重试不重复、`/stop`、审批、问答按钮、附件、群聊 @、长任务 >5min 主动推送兜底。




