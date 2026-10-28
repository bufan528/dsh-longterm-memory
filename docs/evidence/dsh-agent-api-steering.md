# DSH 0.2.1-rc.3 公开 Agent API 核验（steer / followup / cancel / 生命周期 / 流式事件）

> 调研对象：本机真实宿主 **DSH Desktop 0.2.1-rc.3**（`D:\dsh\resources\runtime\primary-runtime\runtime.json`：`"desktopVersion": "0.2.1-rc.3"`），实现位于 `D:\dsh\resources\app.asar` 内的 `/dsh/node_modules/@deepseek-ai/*`。
> 目的：为「**非打断式 steering + 统一回复**」实现提供可引用的事实依据。
> 方法：只读静态核验（未修改任何源码 / 配置 / 真实 profile），凡未实测处标 **未验证**。
> 行号口径：以**修正后**的 asar 提取物为准（见 §1.2）。该提取物与 npm 官方 `0.2.1-rc.3` tarball 的 JS **SHA256 完全一致**，因此行号同时适用于二者；正文引用统一写「包名 `文件` `:行号`」。

---

## 0. 结论摘要（先看这 9 条）

1. **`agent.steer()` 在 0.2.1-rc.3 上是真实公开 API**：`steer(input)` = `send(input, 'next-step', true)`，把消息持久写入 inbox 的 `next-step` 队列并唤醒驱动；`Agent` 的公开类型声明里 `steer` 是正式方法（非内部实现细节）。证据：`@deepseek-ai/dsh-agent-loop` `lib/index.js:809-811`；`@deepseek-ai/dsh-agent` `lib/types/runtime-types.d.ts:193-200`。
2. **steer 的消费时机 = 下一个 pre-step 边界（即当前轮的下一个 step）**，绝不会进入"正在进行的这一次模型请求"。运行中调用 → 本轮下一步骤；本轮即将收尾（`turnEnds` 已置位）但 `next-step` 非空 → 本轮继续、**同一 turn 再跑一步**。证据：`lib/index.js:906,1000-1008`。
3. **idle 时 steer 也不丢**：`wakeDriver()` 起一轮，该轮第一步的 `claim('next-turn')` 会先取走全部 `next-step`，消息作为新一轮第一步的批次执行。证据：`lib/index.js:103-111,854-868,1037-1041`。
4. **`turn-stopping` 是官方"让轮次继续"的正式机制**：serial（await）派发；监听器在其中 `agent.steer(...)`，机器在派发后**重新读 inbox**，`next-step` 非空就不 break、继续同一 turn。类型文档原文："a listener that objects steers (`agent.steer(...)`) and the machine re-reads its inbox: fresh steering runs another step, none closes the turn."证据：`lib/index.js:1000-1008`；`runtime-types.d.ts:370-391`。
5. **`followup` 与 `steer` 的差别是队列**：`followup` → `next-turn`（作为下一轮的**唯一普通提示**，运行中不唤醒、不并入当前轮）；`steer` → `next-step`（并入最近的步骤边界）；`inject` → `next-step` 但不唤醒。证据：`lib/index.js:800-813`；README `:47`。
6. **`cancel(cause, options)` 默认清空 inbox（含已排队的 steering），`{keepInbox:true}` 只中止当前 turn、保留排队**；不存在"只中止一个 step、保留 turn"的能力。证据：`lib/index.js:815-820`；README `:177`；宿主"停止"按钮 = `cancel({kind:'user'},{keepInbox:true})`（`dsh-api-session-controller/lib/index.js:1065`）。
7. **`agent.status` 只有 `'idle' | 'running'`**（maintenance 期间对外仍报 `idle`）；状态变化通过 `agent/status`（emit，不可阻塞）派发。证据：`lib/index.js:790-799`；`runtime-types.d.ts:83-90,252-255`。
8. **assistant 输出粒度 = 每个 step 一条 `assistant/message`（durable）**，一轮多 step 就有多条；流式是 `agent/assistant-stream`（emit，process-local，start/chunk/end，帧内含 turn/step），**不是 durable 记录**，durable 回放以 `assistant/message.stream` 为准。证据：`lib/index.js:1079-1081,1148-1162`；README `:67`；`dsh-headless/lib/index.js:125-130,153-189`。
9. **turn 收尾竞态（静态推导，未实测）**：steer 若落在 `turn()` 已判定 `!hasPending → return false` 之后、`phase` 转 `idle` 之前的**同一个微任务队列**里，消息会持久停在 `next-step` 但**不会自动唤醒**（不丢、不抛错），直到下一次 followup/steer 等 wake。兜底：`await whenIdle()` 后若 `status==='idle'` 且自己消息仍在 inbox，先 `inbox.remove(id)` 再 `steer(同一消息)` 自唤醒。详见 §8.2。

---

## 1. 证据获取与版本锚点

### 1.1 版本锚点

| 事实 | 证据 |
|---|---|
| 宿主版本 `0.2.1-rc.3` | `D:\dsh\resources\runtime\primary-runtime\runtime.json`：`"desktopVersion": "0.2.1-rc.3"` |
| 包版本一致 | `/dsh/node_modules/@deepseek-ai/dsh-agent{,-loop}/package.json`（asar 内）：`"version": "0.2.1-rc.3"`；`dsh-agent` peer 依赖逐包锁 `0.2.1-rc.3` |
| 宿主实现位置 | `D:\dsh\resources\app.asar` → `/dsh/node_modules/@deepseek-ai/*`（另有 unpacked 原生模块目录） |
| asar 提取物 ≡ npm 官方包 | 修正提取后 `dsh-agent / dsh-agent-loop / dsh-session / dsh-llm` 的 `lib/index.js` 与 `registry.npmjs.org` 的 `0.2.1-rc.3` tarball **SHA256 完全相同**（§1.2） |

### 1.2 提取方法与一个必须注意的偏差（重要）

本调研使用（并在本次修正的）脚本：

- `D:\dsh-memory-vault\.scratch\agent-pkgs.cjs`：批量把 asar 内指定包提取到 `.scratch/agent-pkgs/<pkg>/...`（保留目录结构，只提取 js/cjs/mjs/d.ts/ts/json/md）。
- `D:\dsh-memory-vault\.scratch\asar-grep.cjs`：**不落盘**、直接在 asar 内容上按正则 grep 并打印 `文件:行号`，用于全宿主包扫描（如"谁在调用 steer / turn-stopping"）。

asar 是 Chromium Pickle：`u32@0`=4、`u32@4`=headerSize、`u32@12`=jsonLen，JSON 从偏移 16 开始，**数据区起点 = `8 + u32@4`（= jsonLen + 17）**。旧脚本（`.scratch/x-agent-steer.cjs`、`.scratch/asar.cjs` 等）用 `16 + jsonLen`，比正确值**早 1 字节**：每个文件会"多出前一文件最后 1 字节（通常是换行）、丢掉自己最后 1 字节"，结果 **JS 行号 +1**、JSON 解析失败。本次已把两个脚本改为 `base = 8 + headerSize` 并重新提取；可用下面的命令复核（输出 `IDENTICAL` 即证明 asar 内就是官方 npm 包内容）：

```powershell
cd D:\dsh-memory-vault\.scratch
node agent-pkgs.cjs dsh-agent dsh-agent-loop dsh-session dsh-llm
# 下载同版本 tarball 到 .scratch\dsh-pkgs-npm\ 并解包后：
@('dsh-agent','dsh-agent-loop','dsh-session','dsh-llm') | ForEach-Object {
  $a = "agent-pkgs\$_\lib\index.js"; $b = "dsh-pkgs-npm\$_\package\lib\index.js"
  "{0}: {1}" -f $_, $(if ((Get-FileHash $a).Hash -eq (Get-FileHash $b).Hash) {'IDENTICAL'} else {'DIFF'})
}
```

> 口径提醒：**`.scratch/agent-pkgs/` 现在是修正后的内容（行号 −1 于旧提取物）**。若其他文档引用了 `steer` 在 `:810-812`、`turn-stopping` 在 `:1001-1009` 这类行号，那是旧提取物的 +1 值；准确值是 **`:809-811`** 与 **`:1000-1008`**（以本文和 `agent-pkgs.cjs` 为准）。

### 1.3 公开类型的辅助证据

asar 里**不打包 `.d.ts`**（`files` 字段声明了 `lib/types/**/*.d.ts`，但发行 asar 中只有 `.js`，且 `lib/types/*.js` 是仅含 JSDoc 的空实现）。因此公开类型签名取自 **npm 官方 `0.2.1-rc.3` tarball 的 `lib/types/*.d.ts`**（与 asar 同版本、同实现，见 §1.2 的 SHA256 校验），路径写作 `@deepseek-ai/<pkg>/lib/types/<file>.d.ts`。下载与解包：

```powershell
cd D:\dsh-memory-vault\.scratch\dsh-pkgs-npm
foreach ($p in 'dsh-agent','dsh-agent-loop','dsh-session','dsh-llm') {
  Invoke-WebRequest "https://registry.npmjs.org/@deepseek-ai/$p/-/$p-0.2.1-rc.3.tgz" -OutFile "$p.tgz"
  New-Item -ItemType Directory -Force $p | Out-Null; tar -xzf "$p.tgz" -C $p
}
```

---

## 2. `agent.steer(input)` 的完整语义

### 2.1 签名与调用链

公开类型（`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:193-200`）：

```ts
/**
 * Submit steering for the nearest step. An idle driver starts a turn;
 * a running driver consumes it at its next step boundary.
 * A rejected step leaves steering parked in the inbox until the next
 * wake; cancellation or disposal may discard pending steering.
 * @param message - identified steering content and the source that supplied it.
 */
steer(message: UserMessage): void;
```

实现（`@deepseek-ai/dsh-agent-loop/lib/index.js`，`ReactLoopAgent` 类，`:747` 起）：

```js
800: 	send(message, target, wakeup) {
801: 		const wakingAfterAbort = wakeup && this.phase.kind !== "idle" && this.phase.abort.signal.aborted;
802: 		const resolvedTarget = wakingAfterAbort ? "next-turn" : target;
803: 		this.inbox.splice(resolvedTarget, Infinity, 0, [message]);
804: 		if (wakeup) this.wakeDriver(wakingAfterAbort);
805: 	}
806: 	followup(input) {
807: 		this.send(input, "next-turn", true);
808: 	}
809: 	steer(input) {
810: 		this.send(input, "next-step", true);
811: 	}
812: 	inject(input) {
813: 		this.send(input, "next-step", false);
814: 	}
```

要点：

- `steer` **返回 `void`**：没有 ack、没有 Promise、不告诉你"什么时候被消费"。失败只能靠**同步抛错**感知（见 §2.6）。
- `steer` 是"`next-step` + 唤醒"；`inject` 是"`next-step` + 不唤醒"；`followup` 是"`next-turn` + 唤醒"。
- `wakingAfterAbort` 分支：若**当前 phase 已被 abort**（取消进行中），`steer`/`followup` 的 `wakeup` 会**改投 `next-turn`** 并把唤醒 latched 到"收敛到 idle 之后"（`lib/index.js:801-802,854-858`）。即"取消瞬间的 steer 会退化成 followup 语义"。
- 唤醒逻辑（`:854-868`）：

```js
854: 	wakeDriver(wakeAfterAbort = false) {
855: 		if (this.phase.kind !== "idle") {
856: 			if (abortedCancelCause(this.phase.abort.signal)?.kind !== "disposed" && (this.phase.kind === "maintenance" || wakeAfterAbort)) this.phase.wakeRequested = true;
857: 			return;
858: 		}
859: 		const driver = Promise.withResolvers();
860: 		this.activityDone = driver.promise;
861: 		this.setPhase({ kind: "running", abort: new AbortController(), turn: this.phase.lastTurn, step: 0, wakeRequested: false });
868: 		this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject);
```

结论：**"运行中且未 abort"时 steer 只入队、不额外唤醒**（驱动自己会在 step 边界看到）；`maintenance`/abort 期间则 latch 唤醒。`disposed` 取消不 latch（之后不会自唤醒）。

### 2.2 `input` 形状：怎么构造 `UserMessage`

`steer` 的参数类型是 `UserMessage`（`@deepseek-ai/dsh-agent/lib/types/types.d.ts:11-14` 的 `Agent` 只含 `id`；`Agent` 的运行面在 `runtime-types.d.ts:138-210` 增强）。`UserMessage` 定义（`@deepseek-ai/dsh-llm/lib/types/message.d.ts:124-146`）：

```ts
interface MessageBase {
    readonly id: MessageId;                 // 稳定身份，跨表示边界保留
    readonly content: readonly ContentBlock[]; // 精确的模型可见块
    readonly source: MessageSource;         // 生产者声明的来源（必填）
}
export interface UserMessage extends MessageBase {
    readonly role: 'user';
}
```

- `content` 用 `ContentBlock[]`；文本块是 `{ type: 'text', text }`（`dsh-llm/lib/types/types.d.ts:46-49`），可用块见 `:114-126`（text/reasoning/image/file/tool-call/...）。
- `source` 是**合并可扩展的和类型**（`message.d.ts:101-122`）。标准人类输入是 `{ kind: 'user' }`；第三方可自定义（同类插件的做法：`dsh-cordis-host-runner/lib/index.js:2388-2394` 用 `{ kind: 'cordis-host-runner' }`，QQ 插件用 `{ kind: 'user' }`，`dist/transport/inbound.js:42-45`）。
- **构造必须走 `createUserMessage`**（`message.d.ts:213-216`；实现 `dsh-llm/lib/index.js:37-63`）：它克隆、深冻结并生成 `id: randomUUID()` 与 `role:'user'`。

> **不要照抄 `dsh-agent` README 的示例**（`README.md:50-58` 只写了 `{content, source}`）。类型要求 `UserMessage`；运行时虽只做浅校验，但 inbox 会按 `message.id` 去重（见 §2.6），缺 `id` 的第二个 pending 消息会直接抛 `message "undefined" is already pending`。**用 `createUserMessage` 是唯一稳妥写法。**

### 2.3 消息进入哪个队列（durable，不是内存队列）

inbox 有两条持久队列：`next-turn` 与 `next-step`（`dsh-agent/lib/types/types.d.ts:31-36`；`dsh-agent-loop/lib/index.js:26-62` 定义、`:1581-1589` 注册 `inbox`/`turnBoundary` projection）。每次变更都落一条 durable session 事件 `agent/inbox/spliced`：

```js
204: 		const event = this.session.append("agent/inbox/spliced", splice);
205: 		if (discardRemoved) for (const message of removed) this.dispatch.emit("agent/inbox/discarded", { message });
206: 		for (const message of event.data.inserted) this.dispatch.emit("agent/inbox/inserted", { message });
```

- 事件 schema：`{ target, start, removedCount?, inserted, outcome?: 'canceled' }`（`dsh-agent/lib/types/types.d.ts:79-94`）。
- `ReactLoopInbox` 的公开面（`dsh-agent-loop/lib/types/inbox.d.ts:38-97`，实现 `lib/index.js:70-209`）：`nextTurn` / `nextStep` / `hasPending` 只读；`append/prepend/replace/remove/clear/splice` 可写（宿主"队列编辑"就用 `replace/remove`，见 `dsh-api-session-controller/lib/index.js:1035-1049`）。
- **消息因此可跨进程重启存活**（投影从 stored events 重建；`dsh-agent-loop/lib/index.js:26-62`）。

### 2.4 消费时机（核心答案）

消费发生在**每个 step 提案前的 `preStep()`**：

```js
902: 	async preStep(target, position) {
906: 		const claimed = this.inbox.claim(target, position.turn);   // ← 抽干 inbox
907: 		const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));
909: 		const decision = await this.dispatch.waterfall("agent/pre-step", { messages: claimed, ...position, signal }, () => {
918: 				messages: context === void 0 ? claimed : [...claimed, context]  // ← 进入本 step 的用户批次
```

`claim` 语义（`lib/index.js:103-111`）：

```js
103: 	claim(target, turn) {
104: 		const claimed = this.mutate("next-step", 0, this.nextStep.length, [], false);   // 永远优先抽干 next-step（全部）
105: 		if (target === "next-turn") claimed.push(...this.mutate("next-turn", 0, 1, [], false)); // 再取 1 条 next-turn
```

turn 主循环（`lib/index.js:937-1041`）：

```js
950: 		let turnEnds = null;
951: 		let target = "next-turn";                 // ← 每个 turn 的第一次 preStep 用 "next-turn"
953: 			while (true) {
955: 				const step = phase.step + 1;
956: 				const decision = await this.preStep(target, { turn, step });
960: 				if (decision.kind === "reject") {
961: 					turnEnds = { kind: "blocked" };
962: 					return false;
963: 				}
964: 				if (turnEnds && decision.messages.length === 0) break;
965: 				if (phase.step === 0 && decision.messages.length === 0) {
966: 					turnEnds = { kind: "completed" };
967: 					return false;
968: 				}
970: 				this.session.append("step/start", { turn, step });
...
999: 				signal.throwIfAborted();
1000: 				if (turnEnds && this.inbox.nextStep.length === 0) {
1001-1004: 		await this.dispatch.serial("agent/turn-stopping", { turn, signal });   // 实际跨 4 行
1005: 					signal.throwIfAborted();
1006: 				}
1007: 				if (turnEnds && this.inbox.nextStep.length === 0) break;   // ← 只有"模型不再欠回复且 next-step 为空"才收尾
1008: 				target = "next-step";                                        // ← 本轮后续 steps 只消费 next-step
1009: 			}
```

**精确回答"在什么时机被消费"：**

| steer 到达的时刻 | 被消费的位置 | 结果 |
|---|---|---|
| turn 运行中，任意 step 的模型请求/工具执行期间 | 该 step 结束后，下一轮循环的 `preStep`（`:956`，target=`next-step`） | **同一 turn 的新 step**，本轮不结束 |
| 正好落在 step 结束、`turnEnds` 已置位（如 `completed`）之后，但在 `:1000` / `:1007` 判定之前 | `:1007` 重新读 `nextStep.length !== 0` → 不 break → 回到循环 `:956` | **同一 turn 再跑一步**；且 `:1000` 的 `turn-stopping` 也不会派发 |
| 在 `agent/turn-stopping` 的 serial 派发`await`期间被监听器 steer | 派发返回后 `:1007` 重新判定为"非空" | **同一 turn 继续**（官方机制，见 §5.4） |
| turn 已收尾、`status === 'idle'` | `wakeDriver`（`:854-868`）起驱动 → 第一个 `turn()` 的 `preStep(target='next-turn')`：`claim` 先抽 `next-step`（`:104`） | **新一轮的第一步**（消息不丢） |
| 收尾窗口的同一个微任务队列（§8.2） | 无（没人再读 inbox） | 消息持久 pending，**不自动唤醒**，等下一次 wake |

**不会发生**：steer 插进"已经发出/正在流式返回的那一次模型请求"。`preStep` 里 `claim` 之后才 `assemble` + 发请求（`:906-907,1075-1084`），所以边界非常干净。

补充事实（README 直接确认）：`@deepseek-ai/dsh-agent-loop/README.md:220`——"**No built-in turn budget — tool calls or steering continue the current turn**; a policy that bounds runaway turns must cancel from an existing lifecycle extension point such as `agent/turn-stopping`."`README.md:120`——"At a turn boundary it opens the durable turn, then atomically claims pending next-step input plus one queued prompt; **between steps it claims only next-step input**."

### 2.5 `turn` 已结束 / `agent` 已 dispose 时 steer 会怎样

| 状态 | 行为 | 依据 |
|---|---|---|
| turn 已结束、agent 仍 live（`status==='idle'`） | **不抛错，静默起一轮**：`wakeDriver` 建 driver → `turn()` → `preStep('next-turn')` → `claim` 先抽 `next-step` → 消息作为新一轮第一步的批次执行 | `lib/index.js:854-868,937-968,103-111` |
| agent 正在 `maintenance`（创建/恢复/压缩等） | `phase.kind==='maintenance'`，`wakeRequested=true`（非 disposed），maintenance 结束后 `finally` 里 `wakeDriver()` | `lib/index.js:822-845` |
| agent 已从 registry 移除（dispose 完成） | **没有存活校验**：`steer` 仍会 `inbox.splice` → `session.append`，随后在 idle 相位尝试起驱动。`Session.append` 对 detached session 的具体表现 **未验证**；宿主自己的做法是投递前校验 `ctx.agents.get(agent.id) === agent`（`dsh-api-session-controller/lib/index.js:947`） | `lib/index.js:800-810`；`dsh-agent/lib/index.js:596-597` |
| dispose 进行中 | teardown 先 `machine.cancel({kind:'disposed'})`（**未带 keepInbox → 先清空 inbox**），再 `whenIdle()`，再解 scope、detach session/agent | `lib/index.js:1703-1737`（`:1714-1715` 为 cancel+whenIdle） |
| 创建失败回滚 | `prepared.agent.cancel({kind:'disposed'}, {keepInbox:true})`（保留 durability 证据） | `lib/index.js:1942-1956` |

结论：**不要缓存 `Agent` 引用长期使用**。每次投递前 `const agent = ctx.agents.get(sessionId)`，并（对齐宿主）校验 `ctx.agents.get(agent.id) === agent`。宿主 README 也把这条列为明示限制：`dsh-agent/README.md:175`——"**Ambient identity may outlive liveness** — consumers still check `agent.status`, cancellation, and the owning capability contract before lifecycle-sensitive work."

### 2.6 错误路径与坑（steer 的失败面）

1. **同一 `MessageId` 已在任一 pending 列表 → 同步抛错**（`lib/index.js:190-194`）：

```js
191: 		for (const message of target === "next-turn" ? [...candidate, ...state["next-step"]] : [...state["next-turn"], ...candidate]) {
192: 			if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`);
```

因此：**一次内容只构造一次消息、只 steer 一次**；要重投必须换新消息（或先 `inbox.remove(id)`）。

2. **消息被深冻结**（`createUserMessage` → `deepFreeze(structuredClone(...))`，`dsh-llm/lib/index.js:29-63`）：`inbox.replace` 必须传新的冻结消息（宿主用 `freezeMessage({...message, content:[...]})`，`dsh-api-session-controller/lib/index.js:1035-1039`）。
3. **事件数据必须 lossless JSON**：`agent/inbox/spliced` 要 `session.append`（`lib/index.js:204`），`Session.append` 会对事件数据做 `snapshotJsonValue` 快照/校验（`dsh-session/lib/index.js:1523`；`dsh-session/lib/types/types.d.ts:366-374` 说明 `meta` 等必须 JSON-safe）；消息本身也须可序列化，否则 append 抛错——具体错误文案未枚举，**未验证**。
4. **step 被 `agent/pre-step` 拒绝时，被 claim 的消息"到此为止"**：既不会回 inbox，也不会成为 `user/message`（`runtime-types.d.ts:267-281` 对 `agent/inbox/claimed` 的说明；`lib/index.js:960-962`）。即 **steer 没有投递保证**，只保证入队。
5. 取消/销毁可能丢弃 pending steering（见 §4）。

---

## 3. `followup` 与 `steer` 的区别（含 inbox / keepInbox 关系）

| API | 队列 | wakeup | 消费边界 | 运行中调用会发生什么 |
|---|---|---|---|---|
| `followup(input)` | `next-turn` | 是 | **turn 级**：某轮第一次 preStep（target=`next-turn`）claim **1 条**（`lib/index.js:103-106`） | 不并入当前轮；当前轮收尾且 `!hasPending` 检查处看到它 → 开**下一轮**（`:1037-1041`）；每条 followup 各占一轮 |
| `steer(input)` | `next-step` | 是 | **step 级**：最近一次 preStep claim **全部** next-step（`:103-104`） | 并入本轮的下一步；本轮该收尾但 next-step 非空 → 本轮继续 |
| `inject(input)` | `next-step` | 否 | step 级 | 只排队，不唤醒；idle 时停在 inbox 直到被 followup/steer 唤醒（`runtime-types.d.ts:201-209`） |

`turn()` 收尾判断（决定 followup 何时被处理）：

```js
1037: 		if (!this.inbox.hasPending) return false;   // next-turn 或 next-step 任一非空 → 继续（开下一轮）
1038: 		phase.abort = new AbortController();
1039: 		phase.wakeRequested = false;
1040: 		phase.step = 0;
1041: 		return true;
```

要点：

- `followup` **确实"只在轮结束后才消费"**，准确说是"只在**开新 turn** 的第一次 preStep 被消费"；唯一的例外窗口是"驱动已经醒来、但该轮第一步还没 claim"（例如 `wakeDriver` 之后 kick 尚未跑到 `turn()`），此时 followup 会被那一轮第一步一起 claim。除此之外它不会进入当前轮。
- 两者共用同一个 durable inbox 与同一套 `agent/inbox/*` 事件；`keepInbox` 只属于 `cancel` 的选项（`runtime-types.d.ts:31-39`）。
- 真实调用点参照：宿主 prompt 路由 `request.mode === 'steer' ? agent.steer(m) : agent.followup(m)`（`dsh-api-session-controller/lib/index.js:949-950`）；官方 QQ 插件用 `followup` + `await whenIdle()`（`.../dsh-qqbot/dist/transport/inbound.js:41-58`）。

---

## 4. `agent.cancel(cause, options)` 与 `keepInbox`

实现（`lib/index.js:815-820`）：

```js
815: 	cancel(cause, options = {}) {
816: 		if (!options.keepInbox) {
817: 			this.inbox.clear();                                        // 清 next-step 再清 next-turn（:93-96）
818: 			if (this.phase.kind !== "idle") this.phase.wakeRequested = false;
819: 		}
820: 		if (this.phase.kind !== "idle") this.phase.abort.abort(cause);
821: 	}
```

- `cause` 是封闭联合：`{kind:'user'} | {kind:'parent'} | {kind:'hook', reason}` | `{kind:'disposed'}`（`dsh-session/lib/types/types.d.ts:148-158`）；`turn/end` 记录 `{kind:'aborted', reason:{...}}`（`lib/index.js:1010-1026`；`TurnEndReasonMap` `types.d.ts:166-209`）。
- **默认行为 = 中止当前活动 + 丢弃全部排队/steering**（`inbox.clear()` 会为每条被删消息发 `agent/inbox/discarded` 并以 `outcome:'canceled'` 落 splice，`lib/index.js:93-96,195-206`）。
- `{keepInbox:true}` = **只中止当前 turn，保留 pending**；不产生 cancel 语义的 splice。宿主"停止"按钮即此调用（`dsh-api-session-controller/lib/index.js:1061-1067`）。
- **没有"只中止一个 step、保留 turn"的能力**（README `dsh-agent/README.md:177` 原文："`cancel(cause, { keepInbox: true })` aborts only the turn and preserves pending items, and **there is no step-only abort that keeps the turn running**"）。
- cancel 是**同步、非阻塞**的：它只 abort AbortController；放弃动作由驱动在下一个 `signal.throwIfAborted()` 处完成（`lib/index.js:906-921,1047-1055,1089,1092`）。
- 归档/工作区停止语义：会话被归档时 `agent.cancel({kind:'user'})`（**不带 keepInbox**，排队输入被丢弃而不是留到以后唤醒）（`dsh-agent/lib/index.js:33-36`）。
- 取消后队列是否还活：`keepInbox` + 之后**任意一次新 wake**（followup/steer）才会跑；仅 cancel 不会自动再驱动（`wakeRequested=false`，`:818-819`）。
- 取消瞬间的新输入：`send` 检测到 `phase.abort.signal.aborted` 时改投 `next-turn` 并 latch，等收敛到 idle 后自动起一轮（`lib/index.js:800-804,854-858`）；`disposed` 原因除外（不 latch）——而 dispose 路径本身会先 `cancel({kind:'disposed'})` 清空 pending（见 §2.5），此后新投递不会被自动唤醒。

---

## 5. Agent 生命周期、状态与事件

### 5.1 `agent.status`

```js
790: 	get status() {
791: 		return this.phase.kind === "idle" || this.phase.kind === "maintenance" ? "idle" : "running";
792: 	}
```

公开取值仅 `'idle' | 'running'`（`runtime-types.d.ts:83-90`）。注意：

- `maintenance`（创建/恢复/压缩等非 turn 任务）**对外报 `idle`**；此时 steer 会被 latch 唤醒（`:822-845,854-858`）。
- disposal **不是第三种状态**；dispose 后 agent 从 registry 消失（`runtime-types.d.ts:83-90` 注释原文）。
- 每次真实状态翻转都 `emit('agent/status', { status })`（`:794-799`），payload 里由 dispatcher 自动补 `agent` 字段（`dsh-agent/lib/index.js:242-246`）。

### 5.2 事件总表（派发点 / 模式 / 可否阻塞或否决）

`agent/*` 事件全部经 `agentEvents(ctx, agent)`（`dsh-agent/lib/index.js:242-273`）：`emit` = 逐个调用监听器、异常只记日志（**不可阻塞、不可否决**）；`serial` = `ctx.serial` 串行 await（阻塞且可延后）；`waterfall` = `ctx.waterfall`（可改写/否决）。

| 事件 | 模式 | 派发点（`dsh-agent-loop/lib/index.js`） | payload（自动含 `agent`） | 影响 |
|---|---|---|---|---|
| `agent/created` | serial | registry `announce()`：`dsh-agent/lib/index.js:574-589`（`:581`） | `{agent, source:'startup'\|'resume'\|'clear'\|'compact', signal?}` | **awaited**；抛出=创建失败；listener 不得 await `whenIdle()`（`runtime-types.d.ts:212-231`） |
| `agent/disposed` | emit | registry `emitDisposed()`：`dsh-agent/lib/index.js:549-563` | `{agent}` | fire-and-forget；发生在驱动静默、scope 解绑之后、session detach 之前 |
| `agent/status` | emit | `setPhase()`：`:794-799` | `{status}` | 通知 |
| `agent/inbox/inserted` | emit | `inbox.mutate()`：`:206` | `{message}` | 通知 |
| `agent/inbox/claimed` | emit | `inbox.claim()`：`:106-109` | `{message, turn}` | 通知；被 reject 的 step 里消息"就此终结" |
| `agent/inbox/discarded` | emit | `inbox.mutate()`：`:205` | `{message}` | 通知（cancel/clear/remove） |
| `agent/pre-step` | **waterfall** | `preStep()`：`:909-920` | `{messages, turn, step, signal}` + `next()` | 可 `reject` 本 step、可替换进入 step 的消息；`await next()` 保留原批 |
| `agent/request` | **waterfall** | `prepareRequest()`：`:1191-1196` | `{turn, step, signal}` + `next()` | 改写本次调用配置（不能改消息） |
| `agent/request-error` | **waterfall** | `step()`：`:1136-1143` | `{turn, step, provider, failure, retryPolicy, signal}` | 返回 `{kind:'retry'}` 接管重试 |
| `agent/assistant-stream` | emit | `step()`：`:1079-1081` | `{frame: AssistantStreamFrame}` | 流式呈现（process-local，见 §7） |
| `agent/turn-stopping` | **serial** | `turn()`：`:1000-1008` | `{turn, signal}` | **awaited；让轮次继续的唯一官方钩子**（steer），也可 `cancel` 中止 |
| `agent/error` | emit | `throwError()`：`:876-886` | `{turn, step, error}` | 通知 |

`turn-stopping` 官方类型文档（`runtime-types.d.ts:370-391`）：

```ts
/**
 * The turn is about to close: the model owes no response (no live tool
 * calls, no fresh steering). Awaited before the boundary commits — a
 * listener that objects steers (`agent.steer(...)`) and the machine
 * re-reads its inbox: fresh steering runs another step, none closes the
 * turn. Data decides, so listener order cannot change the outcome.
 * @mode serial
 */
'agent/turn-stopping'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; signal: AbortSignal }): Promise<void> | void;
```

真实使用者：`dsh-workspace-changes/lib/index.js:1067-1069`（await 里完成 git 快照后再让 turn 关闭）——说明"阻塞收尾"是设计内用法。

### 5.3 `step/end`、`turn/end` 不是 agent 事件，是 durable session 事件

| durable 事件 | 落点 | payload | 说明 |
|---|---|---|---|
| `turn/start` | `lib/index.js:944-948` | `{turn}` | 打开一轮（先落事件、再 claim 输入） |
| `turn/end` | `lib/index.js:1027-1036` | `{turn, reason: TurnEndReason}` | **在 `finally` 里**落，任何结束（completed/aborted/blocked/error/max-tokens）都有；`session/event` 后置通知 |
| `step/start` | `lib/index.js:969-974` | `{turn, step}` | 一次模型调用 + 其工具执行 |
| `step/end` | `lib/index.js:992-998`（`finally`） | `{turn, step}` | 失败也落 |
| `user/message` | `lib/index.js:1066-1074` | `UserMessage` | 被 claim 的消息 + runtime-context |
| `assistant/message` | `lib/index.js:1148-1162`（中断版 `:1096-1112`） | `{turn, step, message, stream, usage?, interrupted?}` | **每 step 至多一条** |
| `assistant/attempt` | `lib/index.js:1113-1135` | `{turn, step, stream}` | 失败/重试/取消但未产生可见消息的尝试 |

这些事件通过 `session/event`（emit，post-commit，fire-and-forget）通知（`dsh-session/lib/types/index.d.ts:51-61`）。它们**不可取消**；只能通过 `agent/turn-stopping`（steer）或 `agent.cancel` 影响收尾。

### 5.4 `agent/turn-stopping` 能否让轮次继续？——**能，而且是官方唯一正式机制**

时序（`lib/index.js:999-1008`）：

```js
999: 				signal.throwIfAborted();
1000: 				if (turnEnds && this.inbox.nextStep.length === 0) {
1001: 					await this.dispatch.serial("agent/turn-stopping", {
1002: 						turn,
1003: 						signal
1004: 					});
1005: 					signal.throwIfAborted();
1006: 				}
1007: 				if (turnEnds && this.inbox.nextStep.length === 0) break;
1008: 				target = "next-step";
```

- 触发条件：本 step 返回了终结原因（`completed` / `max-tokens`，`step()` `:1163-1167`）**且** `next-step` 当前为空。有 tool-call 未完成（`step()` 返回 `null`）时不会进入该分支。
- 监听器在其中调用 `agent.steer(msg)` → 同步写 `next-step` → `:1007` 重读判定为"非空" → 不 break → 回到 `:956` 以 `target='next-step'` 跑**同一 turn 的下一 step**。
- 若要**阻止**继续：监听器里 `agent.cancel(...)`；`await` 之后 `:1005` 的 `throwIfAborted()` 会抛出，turn 以 aborted 结束（`cancel` 的 keepInbox 决定是否保留队列）。
- **注意**：该事件只在"自然收尾"路径触发；取消/错误路径在 `catch` 里直接结束 turn，不会派发 `turn-stopping`。
- listener 顺序不改变结果（"Data decides"）：最后的判定读的是 **inbox 状态**，不是监听器返回值。
- README 同级确认：`dsh-agent/README.md:67`——"`agent/turn-stopping` runs before an otherwise completed turn closes and **can steer to keep it open**"。

---

## 6. 外部 cordis 插件如何拿到某个 session 的 agent

### 6.1 服务名与注册

- 服务名：**`agents`**（`dsh-agent/lib/index.js:332` `super(ctx, "agents")`）。cordis `Context` 增强声明 `agents: AgentRegistry`（`dsh-agent/lib/types/index.d.ts:18-22`）。
- `Agent.id === Agent.session.id`（`AgentRegistry.enter` 显式校验：`dsh-agent/lib/index.js:514`）。所以"session id → agent id"是同一个值。
- 外部插件通过 `inject` 或 `ctx.get('agents')` 拿到 registry（首方例：`dsh-cordis-host-runner/lib/index.js:2377-2378` 就是 `this.rootCtx.get("agents")?.get(id)`）。

### 6.2 `ctx.agents` 方法表（0.2.1-rc.3）

来源：`dsh-agent/lib/types/index.d.ts:198-370`、`lib/index.js:322-701`、生成的 API 目录 `dsh-tool-cordis/lib/types/api-catalog.js:157-250`。

| 方法 | 签名 | 用途 |
|---|---|---|
| `get` | `get(id: SessionId): Agent \| undefined` | **按 sessionId 取活 agent**（最常用） |
| `list` | `list(): Agent[]` | 全部活 agent |
| `roots` | `roots(): Agent[]` | 顶层（无 owner）活 agent |
| `isOwnedBy` | `isOwnedBy(id, owner): boolean` | 运行时父子归属 |
| `create` | `create(options: CreateAgentOptions): Promise<AgentHandle>` | 建 agent+session（需已挂 agent-loop 工厂） |
| `resume` | `resume(options: ResumeAgentOptions): Promise<AgentHandle>` | 从持久化恢复（需 sessionPersistence） |
| `register` | `register(agent): ReturnType<Context['effect']>` | 登记已构造 agent（高级） |
| `enter` / `announce` | `enter(agent, owner): () => void` / `announce(agent, source, signal?)` | 工厂用有序生命周期原语 |
| `setFactory` / `requireFactory` | —— | 驱动实现注册工厂 |
| `currentInitiator` / `requireInitiator` | `Agent \| undefined` / `Agent` | 当前异步链的发起 agent（进程内归因，非鉴权） |
| `withInitiator` / `withoutInitiator` | 包裹操作 | 建立/清除发起者边界 |

> 外部插件**通常只用 `get/list/roots`**；`create/resume` 在已挂 `dsh-agent-loop` + `dsh-session-persistence` 的宿主里可用（QQ 插件正是 `get → resume → create` 三段式，`.../dsh-qqbot/dist/session/session-manager.js:381-417`）。

### 6.3 从 `session/event` 反查 agent

可以。`session/event` 的签名是 `(session: Session, event: SessionEvent)`（`dsh-session/lib/types/index.d.ts:51-61`），`session.id` 即 agent id：

```js
ctx.on('session/event', (session, event) => {
  const agent = ctx.agents.get(session.id);   // 可能为 undefined（冷 session / 未激活）
  if (!agent) return;
  if (event.type === 'assistant/message') { /* ... */ }
});
```

- 首方例：`dsh-agent-instructions/lib/index.js:1399-1405` 在 root ctx 上监听 `session/event` 并用 `session` 反查自己的 agent 投影；`dsh-workspace-changes/lib/index.js:1055-1063` 以 `session` 为 key。
- **scope 语义**：未打 scope 标签的 listener 是全局的（能收到所有 agent/session）；在 `agent.ctx` 上注册的 listener 只收到该 agent 的（`dsh-scope/README.md:43,76`；loop 自身在 agent scope 里监听 `session/event`：`dsh-agent-loop/lib/index.js:976-978`）。宿主在多 agent 观察者上还会显式写 `{ global: true }` 绕过过滤（`dsh-api-session-controller/lib/index.js:1453-1460`），需要绝对全局时可用。
- `agent/created`（payload.agent）是"拿到 agent 引用"的另一条路，但它是 serial 且**创建期间不得 await `whenIdle()`**（`runtime-types.d.ts:212-231`）。

### 6.4 外部插件能否 import 宿主包？

能。宿主在 profile 层做了 peer-dependency 拦截：当插件在自己 `package.json` 的 `peerDependencies` 里声明了某个 `@deepseek-ai/dsh-*`，解析器把该裸导入路由到**安装目录里的宿主包**（`dsh-app-boot/lib/worker/profile-resolution-bootstrap.js:448-456` 的 interception 路由；`:460-514` 的 `routeLinked`，判断依据 `:468` `readPeerNames(directory).has(name)`）。

现存示例：官方 QQ 插件在 `peerDependencies` 里声明 `@deepseek-ai/dsh-llm` 并 `import { createUserMessage } from '@deepseek-ai/dsh-llm'`（`.../dsh-qqbot/package.json`；`dist/transport/inbound.js:1`）。本机 profile 的 `node_modules/@deepseek-ai/` 下**没有** `dsh-llm` 的物理副本（只有 `cosmokit`、`schemastery`），说明这类导入只能来自宿主包的解析路由——这就是"第三方插件用公开 API 构造消息"的现存先例。（该插件当前会话是否已加载是另一事实，不影响解析器结论，见 `docs/evidence/qq-official-plugin.md` §6 的检测说明。）

**推论（实现要求）**：你的插件若要 `import { createUserMessage } from '@deepseek-ai/dsh-llm'`，必须在 `package.json` 里把 `@deepseek-ai/dsh-llm`（以及 `@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-session` 等用到的）写进 `peerDependencies`，否则解析器不会路由到宿主副本。

---

## 7. 统一回复相关：assistant 输出粒度、流式事件、事件边界

### 7.1 粒度：**每个 step 一条 `assistant/message`**（不是每 turn 一条）

`step()` 在一次模型尝试成功收尾时提交**恰好一条** `assistant/message`（`lib/index.js:1148-1162`），随后：

```js
1163: 				if (finish.kind === "max-tokens") return { kind: "max-tokens" };
1164: 				const toolCalls = message.content.filter((block) => block.type === "tool-call");
1165: 				if (toolCalls.length === 0) return { kind: "completed" };
1166: 				const { concluded } = await executeToolCalls(..., (context) => this.inbox.splice("next-step", ..., [context]));
1167: 				return concluded ? { kind: "completed" } : null;
```

- 一次工具循环 = 多 step = 多条 `assistant/message`（每 step 一条）。
- 被取消的 step 若有已交付文本，也会提交一条 `assistant/message`，带 `interrupted: true`（`:1096-1112`）。
- 失败/重试且没有可见内容的尝试 → `assistant/attempt`（`{turn, step, stream}`，`:1113-1135`）。
- durable 事件定义与语义：`dsh-session/lib/types/types.d.ts:321-349`（原文："Assembled assistant message for one step (derived history uses this)"）。

**统一回复该怎么取文本**：监听 `session/event`，在 `turn/end` 前把本 turn 最后一个 `assistant/message` 的 `content` 里 `type:'text'` 块拼起来。首方参考实现（headless）：`dsh-headless/lib/index.js:120-135`：

```js
120: 		if (event.type === "turn/start") {
121: 			started = true;
122: 			continue;
123: 		}
124: 		if (!started) continue;
125: 		if (event.type === "assistant/message") {
126: 			const joined = event.data.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
127: 			if (joined !== "") text = joined;
128: 		}
129: 		if (event.type === "turn/end") reason = event.data.reason;
```

（它取的是"最后一条有文本的 assistant/message"，正好对应"统一回复"想要的"最终答复"。）

### 7.2 流式事件：`agent/assistant-stream`（emit / process-local / 帧内含 turn+step）

- 存在，按 chunk 派发：`lib/index.js:1079-1081`：

```js
1079: 			const live = new AssistantStreamAttempt(this.session.id, ++this.assistantAttemptCounter, () => ++this.assistantStreamRevision, turn, step, (frame) => {
1080: 				this.dispatch.emit("agent/assistant-stream", { frame });
1081: 			});
```

- 帧形状（`runtime-types.d.ts:107-137`）：`{type:'start', attemptId, revision, turn, step}` | `{type:'chunk', attemptId, revision, index, time, chunk: StreamChunk}` | `{type:'end', attemptId, revision, index, outcome:{kind:'committed', eventType, seq}|{kind:'abandoned'}}`。
- `StreamChunk`（`dsh-llm/lib/types/types.d.ts:434-464`）：`block-start / text-delta / reasoning-delta / tool-call-delta / block-end / usage / finish`。
- **可"按 step 订阅"**：`start` 帧携带 `turn`/`step`；`chunk`/`end` 帧只带 `attemptId`/`revision`，用 `attemptId` 映射回该 attempt 的 start 帧即可得到 turn/step。
- 语义边界（官方说明 `runtime-types.d.ts:357-369`、README `dsh-agent/README.md:67`）：chunk 帧是**瞬态呈现数据**；一个 attempt 恰好 1 个 `start`、N 个 `chunk`、1 个 `end`；`end` 的 `committed` 紧跟在 durable `assistant/message`（或 `assistant/attempt`）之后——**回放/统一回复请以 durable 事件为准，不要把流式帧当事实源**。
- 首方消费者：`dsh-headless/lib/index.js:153-189`（按 `subject !== agent` 过滤 + 处理 `start/end/reasoning-delta/...` 的完整样例）；`dsh-api-session-controller/lib/index.js:1453-1460`（按 `agent.session.id` 累积后广播给 Web 客户端）。

### 7.3 `session/event` 与 agent 事件的边界

| 维度 | `session/event`（durable） | `agent/*`（live） |
|---|---|---|
| 载体 | `Session`（按 `session.id` 索引） | `Agent`（payload 自动注入 `agent`） |
| 内容 | transcript 事实与 turn/step 边界（`turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、`assistant/message`、`assistant/attempt`、`tool/call`、`tool/result`、`agent/inbox/spliced` 等） | 进程内的生命周期/拦截/流式通知 |
| 持久性 | 入 log，可恢复/回放/跨进程 | 进程本地，重启即无 |
| 派发 | emit（post-commit、fire-and-forget，失败只记日志） | emit / serial / waterfall 三种模式 |
| 用途 | 统一回复、审计、投影、UI 历史 | 拦截（pre-step/request/request-error）、收尾干预（turn-stopping）、流式、inbox 同步、状态 |

一句话：**"事实看 `session/event`，干预看 `agent/*`"**。

---

## 8. 结论表（Q7）与 turn 收尾竞态

### 8.1 结论表

| # | 问题 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | steer 能否让新消息在**当前轮的下一步骤**得到处理 | **能**。运行中入 `next-step`，下一个 preStep claim 后作为该 step 的 user 批次进入请求；若本轮已到收尾判定，则本轮继续再跑一步 | `dsh-agent-loop/lib/index.js:809-811,906,956,1000-1008`；README `:220` |
| 2 | steer 是否会插进"正在流式返回的那次请求" | **不会**。claim 发生在请求构造之前 | `:906,1075-1084` |
| 3 | steer 在 idle 时 | 不丢；唤醒开新一轮，消息作为该轮第一步批次 | `:854-868,1037-1041,103-104` |
| 4 | followup 是否只在 turn 结束后消费 | 是（"下一个开 turn 的第一次 preStep"）；运行中不唤醒、不并入当前轮 | `:806-808,1037-1041` |
| 5 | cancel 是否丢弃 inbox/steering | **默认丢弃**；`keepInbox:true` 保留；无 step-only abort | `:815-820`；README `:177` |
| 6 | agent.status 取值 | `idle`/`running`；maintenance 报 idle；dispose 不是状态 | `:790-792`；`runtime-types.d.ts:83-90` |
| 7 | turn-stopping 能否让轮次继续 | **能**（serial + 事后重读 inbox + steer） | `:1000-1008`；`runtime-types.d.ts:370-391` |
| 8 | 外部插件怎么拿 agent | `ctx.get('agents').get(sessionId)`；或 `session/event` 里 `session.id` 反查；或 `agent/created` | §6；`dsh-agent/lib/types/index.d.ts:18-22,198-370` |
| 9 | assistant 粒度 / 流式 | 每 step 一条 `assistant/message`；流式 `agent/assistant-stream`（emit，瞬态） | §7 |
| 10 | 统一回复边界 | `turn/end`（durable）为"本轮彻底结束"信号；在其之前可能有 N 条 assistant/message（取最后一条文本） | `:1027-1036`；`dsh-headless/lib/index.js:120-135` |

### 8.2 turn 收尾竞态：steer 恰好在 turn 结束瞬间到达

**代码事实**（`:1037-1041`）：`turn()` 返回 `false` 前最后一次读 inbox 是 `:1037` `if (!this.inbox.hasPending) return false;`。之后到 `phase` 转 idle 之间，只有 kick 的 `finally`（`:887-900`），**没有任何 await**：

```js
887: 	async kick() {
888: 		try {
889: 			while (await this.turn());
890: 		} catch (_error) {} finally {
892: 			if (this.phase.kind === "running") {
893: 				const { turn, wakeRequested } = this.phase;
894: 				this.setPhase({ kind: "idle", lastTurn: turn });
                   // （895-897：字段赋值，省略）
898: 				if (wakeRequested && this.inbox.hasPending) this.wakeDriver();
```

而 `wakeDriver` 在 phase 仍为 `running` 且未 abort 时**只入队、不置 `wakeRequested`**（`:854-858`）。

**静态推导（未实测）**，三种可能落点：

| steer 落点 | 结果 |
|---|---|
| `:1000` 判定之前 / `turn-stopping` 派发期间 | 本轮继续（同一 turn 的下一 step）——完全安全 |
| `:1007` 判定之后、`:1037` 之前（只可能是 `turn/end` 的同步 listener 里同步调用） | `:1037` 看到 pending → `return true` → **下一轮**（新 turn）；安全 |
| `:1037` 判定之后、kick 的 `finally` 把 phase 转 idle 之前（**同一个微任务队列**内的调用，例如某个 listener 里 `queueMicrotask(() => agent.steer(...))`，或同一轮 microtask drain 里更早排队的投递） | 消息**持久**停在 `next-step`；`wakeDriver` 不 latch；kick 转 idle 时 `wakeRequested=false` → **不自动醒来**，直到下一次 followup/steer 等任意 wake。消息不丢、不抛错 |

> 为什么网络 I/O（QQ 的 WebSocket 消息）**几乎打不中**这个窗口：macrotask 只在微任务队列排空后才执行，而"`return false` → kick 继续 → 转 idle"全在同一个 microtask drain 里完成。可命中的来源是**在 turn 收尾的同步/微任务路径上主动投递**的代码（典型：`session/event('turn/end')` 监听器里 `Promise.resolve().then(() => agent.steer(...))`）。

**兜底配方（推荐写进实现）**：

```ts
// 投递后等本活动静默；若发现消息还 pending 且 agent 已 idle，说明撞上了收尾竞态 → 自唤醒
await agent.whenIdle();
if (agent.status === 'idle' && agent.inbox.nextStep.some((m) => m.id === msg.id)) {
  agent.inbox.remove(msg.id);   // 同一 MessageId 不能重复 pending（否则 steer 抛错，见 §2.6）
  agent.steer(msg);             // 此时 status 已 idle → wakeDriver 会真的起一轮
}
```

- `whenIdle()` 语义：等"当前整段活动"到静默（`:870-875`，会跟踪唤醒链直到稳定）。
- 若 `whenIdle()` 之后 `ctx.agents.get(id)` 已取不到该 agent，说明被 dispose（inbox 已被 `cancel({kind:'disposed'})` 清空），**不要重投**，按失败上报。

---

## 9. 最小可照抄用法示例：外部 cordis 插件构造 `UserMessage` 并 steer

> 依赖的每一个公开 API 在示例后逐条标注（含来源行号）。示例为 TypeScript；JS 插件删掉类型注解即可。

```ts
// package.json 必须声明（宿主 profile 解析器据 peerDependencies 把裸导入路由到宿主包，§6.4）：
//   "peerDependencies": {
//     "@deepseek-ai/cordis": ">=4.0.1",
//     "@deepseek-ai/dsh-agent": ">=0.2.1-rc.3",
//     "@deepseek-ai/dsh-llm": ">=0.2.1-rc.3",
//     "@deepseek-ai/dsh-session": ">=0.2.1-rc.3"
//   }

import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'my-steering-plugin';
/** ① cordis 服务注入：拿到 `ctx.agents`（AgentRegistry） */
export const inject = ['agents'];

export function apply(ctx: Context): void {
  // ② 按 sessionId 取"当前活着的" agent（Agent.id === Session.id）
  //    sessionId 来源任选：插件配置、自己建会话时的返回值、或 session/event 里的 session.id
  const steerInto = (sessionId: SessionId, text: string): boolean => {
    const agent: Agent | undefined = ctx.agents.get(sessionId); // ③ AgentRegistry.get(id)
    if (agent === undefined) return false;                      // 冷会话/未激活 → 交给上层决定是否 resume

    // ④ 构造合法 UserMessage：深冻结 + 自动 id/role（不要手写 {content, source}）
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },        // 标准人类来源；也可自定义 kind（合并可扩展的 MessageSourceMap）
    });

    // ⑤ 判定时机：running → steer（并入本轮下一步）；idle → steer 也能起新一轮，
    //    但这里显式分流，语义更清楚（与宿主 prompt 路由、官方 QQ 插件的建议改法一致）
    if (agent.status === 'running') {
      agent.steer(message);      // ⑥ 非打断式 steering：下一个 step 边界消费
    } else {
      agent.followup(message);   // ⑦ 已 idle：作为下一轮的唯一普通提示
    }
    return true;
  };

  // ⑧ 示例入口 A：从任何 session 事件反查 agent（这里演示 session/event 的 (session, event) 签名）
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return;           // 只在本轮收尾后演示
    const agent = ctx.agents.get(session.id);        // ⑨ 反查：session.id 即 agent.id
    if (agent !== undefined) {
      // ⑩ 收尾竞态兜底：见 §8.2（演示用，实际请把"待投递消息"存起来，按 id 比对）
      void agent.whenIdle().then(() => {
        if (agent.status === 'idle' && agent.inbox.nextStep.length > 0) {
          // 消息还 pending 且已 idle → 先 remove 再重投，避免重复 id 抛错
          const [pending] = agent.inbox.nextStep;
          if (pending !== undefined) {
            agent.inbox.remove(pending.id);
            agent.steer(pending);
          }
        }
      });
    }
  });

  // ⑪ 示例入口 B：拿到 agent 之后在 turn 收尾边界"再续一步"（非打断式合并回复的关键钩子）
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (!shouldContinue(agent, turn)) return;        // 你的合并/去抖策略
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: '（用户刚发来的新消息…）' }],
      source: { kind: 'user' },
    }));
    // 返回即让机器重读 inbox：next-step 非空 → 同一 turn 再跑一步，turn 不会结束
  });
}

declare function shouldContinue(agent: Agent, turn: number): boolean;
```

**该示例依赖的公开 API 清单（逐条）**

| # | API | 来源（类型 / 实现） |
|---|---|---|
| ① | `inject = ['agents']` / `ctx.agents` | `dsh-agent/lib/types/index.d.ts:18-22`；`dsh-agent/lib/index.js:332` |
| ②③ | `AgentRegistry.get(id): Agent \| undefined` | `dsh-agent/lib/types/index.d.ts:343`；`lib/index.js:596-597` |
| ② | `Agent.id === Session.id` | `dsh-agent/lib/index.js:514`（`enter` 校验） |
| ④ | `createUserMessage({content, source}): UserMessage`（深冻结 + `randomUUID` id + `role:'user'`） | `dsh-llm/lib/types/message.d.ts:213-216`；实现 `dsh-llm/lib/index.js:29-63` |
| ④ | `ContentBlock` / `TextBlock` | `dsh-llm/lib/types/types.d.ts:46-49,114-126` |
| ④ | `MessageSourceMap` / `source.kind`（可合并扩展） | `dsh-llm/lib/types/message.d.ts:101-122` |
| ⑤ | `Agent.status: 'idle' \| 'running'` | `dsh-agent/lib/types/runtime-types.d.ts:83-90,146-147`；`dsh-agent-loop/lib/index.js:790-792` |
| ⑥ | `Agent.steer(message: UserMessage): void` | `runtime-types.d.ts:193-200`；`dsh-agent-loop/lib/index.js:809-811` |
| ⑦ | `Agent.followup(message: UserMessage): void` | `runtime-types.d.ts:187-192`；`lib/index.js:806-808` |
| ⑧ | `session/event` 监听签名 `(session, event)` | `dsh-session/lib/types/index.d.ts:51-61` |
| ⑨ | 反查 `ctx.agents.get(session.id)` | 同上 + `dsh-agent-instructions/lib/index.js:1399-1405`（首方范例） |
| ⑩ | `Agent.whenIdle(): Promise<void>` | `runtime-types.d.ts:158-164`；`lib/index.js:870-875` |
| ⑩ | `Agent.inbox.nextStep`（只读） / `inbox.remove(id)` | `dsh-agent-loop/lib/types/inbox.d.ts:44-46,76-82`；`lib/index.js:80-86,145-151` |
| ⑪ | `agent/turn-stopping`（serial；payload `{agent,turn,signal}`） | `runtime-types.d.ts:370-391`；`dsh-agent-loop/lib/index.js:1000-1008` |
| — | `MessageId` 唯一性约束（重复 pending 抛错） | `lib/index.js:190-194`；README `dsh-agent-loop/README.md:71` |

**最小版本（只要 5 行核心）**：

```ts
const agent = ctx.agents.get(sessionId);          // 必须每次重新取，不要缓存
if (!agent) return;
agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
```

---

## 10. 给实现方的落地建议（非打断式 steering + 统一回复）

1. **投递策略**：`agent.status === 'running'` → `steer()`；`'idle'` → `followup()`（或同样 `steer()`，两者都会起新一轮；分流的价值在于语义与"下一轮唯一提示"的灰度）。不要"先 cancel 再投递"——那会丢队列且打断当前工作。
2. **合并回复的边界用 `turn/end`，不要用 `assistant/message`**：一轮可能多 step、多 assistant/message（§7.1）。取 `turn/end` 前最后一条有 text 的 `assistant/message`（`dsh-headless` 范例）。若产品要求"流式"，用 `agent/assistant-stream` 只做呈现，不要当事实源。
3. **turn-stopping 用作"最后一刻并入"**：若你的去抖缓冲里还有新用户消息，监听 `agent/turn-stopping` 并在其中 `steer()`，让本轮继续、回复合并；这是官方声明"can steer to keep it open"的唯一钩子。
4. **必须写竞态兜底**（§8.2）：`whenIdle()` 后检查 `status==='idle' && inbox.nextStep` 是否有自己的消息 → `remove` + 重投自唤醒。否则极小概率消息滞留到下一次用户消息才执行。
5. **不要缓存 `Agent` 引用**；每次 `ctx.agents.get(id)` 并（对齐宿主）校验 `ctx.agents.get(agent.id) === agent`（`dsh-api-session-controller/lib/index.js:947`）。
6. **一条消息只投一次**：`MessageId` 全局唯一 pending（重复即同步抛错）；需要重投/编辑用 `inbox.replace/remove`。
7. **`/stop` 语义**：若要"停止但保留排队"，必须 `cancel({kind:'user'},{keepInbox:true})`；默认 `cancel` 会清空你刚 steer 进去的消息（§4）。
8. **队列可见性**：`inbox.nextTurn/nextStep/hasPending` 是公开只读的，可用于"已读/排队 UI"和幂等判断（宿主 `dsh-desktop-host/lib/index.js:100-102` 就用它判断"是否还有活"）。

---

## 11. 未验证清单（明确标注）

| 事项 | 状态 |
|---|---|
| steer 对**已 dispose** agent 的具体失败点（是 `Session.append` 抛错、还是对 detached session 静默 append 后起一个无人收尸的驱动） | **未验证**（静态看 steer 无存活校验；正确做法见 §2.5） |
| turn 收尾竞态（§8.2）的"微任务窗口"是否真能命中 | **静态推导，未实测**（没有启动真实 Host 做注入实验，避免影响正在运行的桌面实例） |
| `session.append` 对非 JSON-safe 消息的确切错误类型/文案 | **未验证**（只确认 append 侧有 JSON 校验并会抛错） |
| `agent/created` 里"不得 await whenIdle()"的实测表现 | 仅文档声明（`runtime-types.d.ts:212-231` / README `:176`），未实测 |
| `agent/pre-step` 里 `reject` 后 steering 消息的 UI 呈现 | 未验证（durable 上消息仅存在于 `agent/inbox/spliced` 的 claimed 删除记录中） |

---

## 12. 引用文件索引（便于复核）

**宿主实现（asar 内，`D:\dsh\resources\app.asar` 前缀）**
- `/dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js`
- `/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`
- `/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js`
- `/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js`
- `/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js`
- `/dsh/node_modules/@deepseek-ai/dsh-cordis-host-runner/lib/index.js`
- `/dsh/node_modules/@deepseek-ai/dsh-headless/lib/index.js`
- `/dsh/node_modules/@deepseek-ai/dsh-workspace-changes/lib/index.js`
- `/dsh/node_modules/@deepseek-ai/dsh-agent-instructions/lib/index.js`
- `/dsh/node_modules/@deepseek-ai/dsh-goal-round-driver/lib/index.js`
- `/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`
- `/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/worker/profile-resolution-bootstrap.js`
- `/dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js`（宿主生成的公开 API 目录：`agents` 服务 `:157-250`，agent/session 事件 `:3948-4043`）

**公开类型与文档（npm `0.2.1-rc.3`，`.scratch/dsh-pkgs-npm/<pkg>/package/`）**
- `dsh-agent/lib/types/runtime-types.d.ts`、`types.d.ts`、`index.d.ts`、`README.md`
- `dsh-agent-loop/lib/types/agent.d.ts`、`inbox.d.ts`、`README.md`
- `dsh-session/lib/types/types.d.ts`、`index.d.ts`
- `dsh-llm/lib/types/message.d.ts`、`types.d.ts`
- `dsh-scope/README.md`（scope 事件过滤语义）

**本机第三方使用者**
- `C:\Users\bf410\.dsh\profiles\desktop\node_modules\@tencent-connect\dsh-qqbot\dist\transport\inbound.js`（`:41-58` 当前 `followup`+`whenIdle` 用法）
- `...\dsh-qqbot\dist\session\session-manager.js`（`:381-417` `get → resume → create`）

**本调研脚本**
- `D:\dsh-memory-vault\.scratch\agent-pkgs.cjs`（asar→`.scratch/agent-pkgs/` 批量提取，已修正数据区偏移）
- `D:\dsh-memory-vault\.scratch\asar-grep.cjs`（不落盘的 asar 内容 grep，带行号）
