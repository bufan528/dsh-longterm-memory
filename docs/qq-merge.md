# 连续消息智能合并：非打断式 Steering 与统一回复

> 状态：**PARTIAL**（Memory Vault 控制面与服务契约 COMPLETED；真实 QQ 会话端到端 BLOCKED）
> 核验与实现时间：2026-10-27
> 相关证据：[官方 0.5.3 消息链路](evidence/qqbot-0.5.3-message-flow.md) ·
> [DSH Agent API（steer/followup/生命周期）](evidence/dsh-agent-api-steering.md) ·
> [扩展实现记录](evidence/qqbot-merge-implementation.md)（由扩展包维护）

本文件回答三件事：**为什么必须做扩展而不是排队**、**实现由哪几层组成**、**当前到底哪部分真的生效**。

---

## 1. 结论速览

| 问题 | 结论 | 证据 |
|---|---|---|
| 当前真实运行环境 | DSH Desktop **0.2.1-rc.3**；`@tencent-connect/dsh-qqbot` **0.5.3**（npm latest 也是 0.5.3）；SDK `@tencent-connect/qqbot-nodejs` **1.0.5** | profile `package.json`、`dsh.cmd --version`、包内 `package.json` |
| 官方插件现在的「合并」是什么 | `concurrencyGuard({strategy:'merge'})` = 忙碌时缓冲，**等当前轮彻底结束后**才合并并由幸存者 followup → 只是排队到下一轮 | `dist/gateway/middleware-setup.js:61-65`；SDK `concurrency-guard.js:137-...` |
| 官方插件能否被第三方扩展 | **不能**：全 dist 无 `ctx.provide` / `ctx.set` / `onExpose`，只导出 `name/inject/Config/apply`；唯一 HTTP 面是绑定页 | `docs/evidence/qqbot-0.5.3-message-flow.md` §6 |
| 宿主是否支持真正的中途并入 | **支持**：`agent.steer(input)` 把消息写入 inbox 的 `next-step`，在**当前轮的下一个 step 边界**消费；轮次收尾时 `next-step` 非空会让**同一 turn 继续跑一步**；`agent/turn-stopping` 是官方「让轮次继续」的正式机制 | `docs/evidence/dsh-agent-api-steering.md` §0 条 1–5 |
| 每 step 一条回复的问题 | 官方出站每个 `assistant/message` 就 `flush → finish → StreamSession.complete()` 并删 buffer，下一步重新 `openStream`（新 msg_seq）→ 一轮 N step = N 条 QQ 消息 | `dist/transport/outbound.js:117-134`、`streaming-writer.js:48-69`；SDK `streaming.d.ts` |
| 我们做了什么 | 维护分支 **`dsh-qqbot-merge`**（官方 0.5.3 源码 + 约 35 行核心 patch + merge 模块）实现 steer 合并与单条回复修订，并对外 `provide('qqbotMerge')`；Memory Vault 的「QQ 接入」页通过**版本化契约**消费它 | [`dsh-qqbot-merge`](https://github.com/bufan528/dsh-qqbot-merge)（独立插件/npm 包）、`src/shared/qqbot-merge-contract.ts` |
| 现在生效了吗 | **没有**：真实 profile 仍运行官方 0.5.3（没有 `qqbotMerge` 服务），所以页面如实显示 **未生效 / BLOCKED**，所有开关禁用。安装扩展并重启后才能启用 | `tests/integration/qq-merge-bridge.test.ts`、真实宿主 RPC |

> 重要：**不允许**把「官方 0.5.3 的排队合并」说成已经实现了智能合并。官方能力边界见
> §2；本功能真实生效的前提是扩展包被安装到运行 QQ Bot 的那个 profile。

---

## 2. 官方 0.5.3 的真实行为与边界

### 2.1 入站（收到的消息）

```
QQ WebSocket → SDK 中间件链 → handleInbound()
  → manager.getOrCreate()            # 按 peer 取/建 DSH session
  → agent.followup(userMessage)      # 写入 inbox 的 next-turn 队列
  → await agent.whenIdle()           # 阻塞到本轮 turn 结束
```

- 整条链都在 `concurrencyGuard` 的锁内；`strategy:'merge'` 的合并发生在**锁释放时**，
  也就是本轮结束之后。
- `handleInbound` 里没有任何 steer 调用（全 dist 无 `steer` 命中）。
- 因此官方行为 = 「**排队到下一轮**」，不是「并入当前轮」。

### 2.2 出站（回复消息）

- 宿主每个 step 恰好产生一条 durable `assistant/message`；流式是瞬态
  `agent/assistant-stream`（start/chunk/end）。
- 官方 `OutboundRouter.onMessage()` 只要有流式 buffer 就 `flush()` → `finish()` →
  `StreamSession.complete()`，然后删掉 buffer；下一步的 chunk 会重新 `openStream`，
  QQ 侧是**另一条消息**。
- SDK 的 `StreamSession.update(fullText)` 是**全量替换**语义，可以无限次调用（节流
  ≥300ms），但 `complete()` 之后 `update()` 变成 no-op（单向门）。
- 群聊不支持流式（`shouldStream` 要求 `scope==='c2c'` 且有 `msgId`）。

### 2.3 结论

想做到「任务不被打断、补充消息并入当前轮、最终只有一条统一回复」，必须在**官方插件
源码层面**改动入站路由与出站收尾时机。官方没有 provide 任何跨插件服务，也没有
middleware 钩子可以让第三方在 `concurrencyGuard` 之前接管消息，所以：

- 方案 A（本实现）：维护一个官方 0.5.3 的 fork（MIT 允许），把 steer 与单条回复做进去，
  并 provide `qqbotMerge` 给 Memory Vault 消费；
- 方案 B（不可接受）：改 `node_modules` 里的 dist —— 不是可交付的成果；
- 方案 C（不可接受）：在 Vault 设置里存一个值，声称 QQ 已生效 —— 没有任何运行时读取它。

---

## 3. 架构

```
QQ 用户连续发消息
  │
  ├─(A) 入站协调层（dsh-qqbot-merge: src/merge/coordinator.ts）
  │     ├─ 空闲：窗口内合并 → agent.followup(一条)
  │     └─ 运行中：窗口内合并 → agent.steer(一条结构化补充消息)
  │            └─ 不 cancel、不 abort、不重复 followup
  │
  ├─(B) 聚合层（同一文件）
  │     ├─ 按 sessionKey 隔离：c2c:<openid> / group:<groupid>
  │     ├─ 保留原始消息顺序、时间、发送者、附件与引用（由官方 inbound 组装）
  │     ├─ 上限：maxBatchMessages / maxBatchChars；溢出 → 明确告知用户 + 转下一批
  │     └─ 群聊默认不合并跨发送者；启用后按发送者分组
  │
  ├─(C) 统一回复层（dsh-qqbot-merge: src/transport/outbound*.ts）
  │     ├─ 私聊流式：同一 StreamSession 跨 step 全量 update（同一条 QQ 消息被重写）
  │     ├─ turn/end 才 complete（只结束一次）
  │     ├─ 群聊/非流式：turn 结束前只缓存，最终只发一条
  │     └─ 保留工具结果、交付文件、错误提示、审批/问答通道
  │
  └─(D) 控制面（Memory Vault「QQ 接入」页 + 版本化契约）
        ├─ 扩展 provide `qqbotMerge` 服务（契约 qqbot-merge@v1）
        ├─ Memory Vault 以 `ctx.inject(['qqbotMerge'])` 探测；缺席 = BLOCKED（禁用开关）
        └─ 配置只能写进扩展；页面显示 revision/appliedAt 证明运行期真的读了
```

### 3.1 为什么这样分层

- **入站与出站必须一起改**：只 steering 不改回复，会得到「一次统一输入、多条半成品输出」；
  只改回复不 steering，则新消息仍要等到下一轮。
- **控制面必须走服务而不是配置文件**：官方 0.5.3 没有任何扩展点，Vault 写配置无法证明
  「运行中的 QQ Bot 读了它」。服务在/不在本身就是唯一可信的生效证据。

---

## 4. 跨插件契约（`qqbot-merge@v1`）

真相来源：独立插件 [`dsh-qqbot-merge`](https://github.com/bufan528/dsh-qqbot-merge) 的 `src/merge/contract.ts`；Memory Vault 侧镜像
在 `src/shared/qqbot-merge-contract.ts`，两边通过 `version` 互相校验。

### 4.1 服务 `qqbotMerge`

```ts
interface QqbotMergeService {
  contract: { name: 'qqbot-merge'; version: 1 }
  getStatus(): QqbotMergeStatus
  getConfig(): QqbotMergeConfig
  setConfig(patch: Partial<QqbotMergeConfig>): Promise<QqbotMergeStatus>
}
```

### 4.2 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `false` | 总开关。关闭时行为与官方 0.5.3 完全一致 |
| `windowMs` | `800` | 静默合并窗口（100–10000）。**800 是待测试默认值，不是最优值承诺** |
| `maxBatchMessages` | `8` | 单批条数上限（1–50） |
| `maxBatchChars` | `4000` | 单批字符上限（200–20000） |
| `scope.c2c` | `true` | 私聊是否启用 |
| `scope.group` | `false` | 群聊是否启用（默认不合并跨发送者） |
| `busyPolicy` | `'steer'` | 运行中收到新消息：`steer`=非打断式续航并入；`queue`=旧行为 |
| `replyMode` | `'single-message'` | `single-message`=同一条消息持续修订；`per-step`=旧行为 |

### 4.3 状态与诊断

`QqbotMergeStatus` 含：`applied.revision/appliedAt`（证明运行期真的应用了配置）、
`runtime.steerSupported/steerMechanism/integration/streamingRevision/note`、
`counters`（batchesMerged / messagesSteered / messagesFollowedUp / messagesOverflowed /
steerFallbacks / replyRewrites / repliesCompleted / batchesAborted）、`lastBatch`。

### 4.4 Memory Vault 的两个 RPC

| RPC | 返回 |
|---|---|
| `qqMerge` | `{available:false, reason, officialVersion}` 或 `{available:true, status, compatible, compatibilityNote}` |
| `setQqMerge` | 同上；扩展缺席时抛 `unsupported`，**不会**把配置悄悄写进 Vault 设置 |

---

## 5. 消息生命周期（steering 路径）

1. 用户发 A → 中间件链 → `followup(A)` → Agent 开始 turn（step 1 模型请求 + 工具）。
2. 用户发 B、C（800ms 窗口内）→ 扩展的 `urgentPredicate` 让它们**跳过**官方排队
   （否则会等本轮结束）→ 到扩展的 inbound 分支。
3. 扩展判定 `agent.status === 'running'` → B、C 进入该会话的批次缓冲，不调用 followup。
4. 窗口结束（800ms 静默）→ 合并为**一条**结构化补充消息 → `agent.steer(补充消息)`。
5. Agent 在当前 step 结束后、下一个 pre-step 边界消费它：结合 A、已完成工具结果与
   会话历史继续；**不取消**正在进行的请求，不重复已完成的副作用操作。
6. 若恰逢轮次收尾：`turn-stopping` 阶段重读 inbox，`next-step` 非空 → 同一 turn 继续跑。
7. 出站：所有 step 的文本在同一条 QQ 消息上全量重写；`turn/end` 才 `complete` 一次。

### 5.1 明确的任务边界（保持官方语义）

| 用户行为 | 处理 |
|---|---|
| `/stop` | 官方 slash 命令，`agent.cancel({kind:'user'})`（默认清 inbox）。**已并入但未消费的批次会被丢弃**，这是显式停止的预期语义 |
| `/new` `/reset` `/clear` | 保持官方会话重建语义，不进合并批次 |
| 明确要求放弃原任务 | 按最新意图执行（steering 消息会包含该指令） |
| 普通补充/纠正/细化 | 默认**不**取消任务，并入当前轮 |
| 任务结束后才到达的新消息 | 正常下一轮 followup（不是修改已结束任务） |

---

## 6. 验证现状（如实）

| 层级 | 状态 | 说明 |
|---|---|---|
| 官方链路与 API 证据 | **COMPLETED** | 两份证据文档，逐条源码/行号（[qqbot 0.5.3](evidence/qqbot-0.5.3-message-flow.md)、[Agent API](evidence/dsh-agent-api-steering.md)） |
| 跨插件契约 + Memory Vault 控制面 | **COMPLETED** | 14 项契约/桥测试（`tests/integration/qq-merge-bridge.test.ts`）；Memory Vault 全套 **709 项**测试通过 |
| 扩展实现（steer / 统一回复 / 服务） | **COMPLETED（代码级）** | 独立插件 [`dsh-qqbot-merge`](https://github.com/bufan528/dsh-qqbot-merge)：`tsc` 0 error；**210 项**测试通过；已发布 npm `dsh-qqbot-merge@0.1.0` |
| 隔离宿主上的契约联调（真实 cordis） | **COMPLETED** | 两个隔离 profile（`qqA` 官方 0.5.3 / `qqB` 扩展 0.1.0）真机启动 DSH 0.2.1-rc.3；见 §6.1、§6.2 |
| **真实 QQ 会话端到端**（用户连发消息 → 同一条回复） | **BLOCKED** | 需要把扩展安装到**正在运行的** QQ Bot profile 并重启 DSH；本任务授权边界明确禁止替换用户正在运行的插件、禁止改真实 Profile。另外同一 `appId` 不能同时建立两条网关连接，无法并行验证 |

### 6.1 隔离宿主 A：官方 0.5.3（= 当前真实状态）

隔离 `DSH_HOME`、profile `qqA`，bundles = base + web-app + Memory Vault 0.1.6 + **官方
`@tencent-connect/dsh-qqbot@0.5.3`**；真实启动 `dsh --profile qqA --no-open --port 0`。

```json
POST /dsh-longterm-memory/api/qqMerge
{ "available": false,
  "reason": "当前运行的 QQ Bot 插件没有提供 qqbotMerge 服务：官方 @tencent-connect/dsh-qqbot 0.5.3
             不注册任何 cordis 服务、也没有第三方扩展点，它的「合并」只是把新消息排队到当前轮
             结束后的下一轮（concurrencyGuard strategy=merge），不是非打断式 steering。…",
  "officialVersion": "0.5.3" }

POST /dsh-longterm-memory/api/setQqMerge {"config":{"enabled":true}}
{ "ok": false, "error": { "code": "unsupported",
  "message": "未连接到支持连续消息合并的 QQ Bot 扩展（qqbotMerge 服务不存在），本次修改不会被任何运行时读取，因此未保存。" } }
```

页面表现（`docs/evidence/12-qq-merge-blocked.png`）：卡片位于「记忆联动」与「会话隔离」之间，
Badge **未生效**、显示检测到的官方版本 `0.5.3`、原文原因、旧行为说明、所有控件禁用
（`fieldset disabled`，显示内置默认值且明确「保存不会写入任何地方」），**没有**保存按钮。

### 6.2 隔离宿主 B：扩展在线（真实 cordis 服务注册）

同一隔离 `DSH_HOME`，profile `qqB`，bundles 换成 **`dsh-qqbot-merge@0.1.0`**（未配置 QQ
凭据——故意如此，避免用真实 `appId` 建立第二条网关连接；扩展在凭据判断**之前**就 provide
`qqbotMerge`，见独立插件的 `dist/index.js`）。

```json
POST /api/qqMerge →
{ "available": true, "compatible": true,
  "status": {
    "contract": { "name": "qqbot-merge", "version": 1 },
    "config": { "enabled": false, "windowMs": 800, "maxBatchMessages": 8, "maxBatchChars": 4000,
                "scope": { "c2c": true, "group": false },
                "busyPolicy": "steer", "replyMode": "single-message" },
    "applied": { "revision": 0, "appliedAt": "2026-10-28T04:06:19.708Z", "activeBatches": 0, "pendingMessages": 0 },
    "runtime": { "steerSupported": true,
                 "steerMechanism": "agent.steer(input)（DSH 0.2.1-rc.3 公开 Agent API：inbox next-step，不取消当前轮）",
                 "integration": "dsh-qqbot 0.5.3 fork + concurrencyGuard urgentPredicate bypass + agent/turn-stopping 收尾并入",
                 "streamingRevision": true, "note": "真实 QQ 端到端未验证…" },
    "counters": { "batchesMerged": 0, … },
    "lastBatch": null } }

POST /api/setQqMerge {"config":{"enabled":true,"windowMs":900}}
→ ok:true，config 生效，applied.revision 0 → 1，appliedAt 刷新
→ 扩展把配置写进 profile 的 cordis.patch.yml（`- id: qqbot-merge` / `qqbotMerge: {…}`），
  随后 HMR 重载，读回 enabled=true / windowMs=900（revision 因新进程归零——
  **revision/appliedAt 是「运行期实例」级证据，重启后归零，不代表配置丢失**）
```

页面表现（`docs/evidence/13-qq-merge-available.png`）：Badge **已启用** + **支持非打断式
steering**；可编辑 enabled / windowMs / 批量上限 / 私聊·群聊 / busyPolicy / replyMode；
显示 `已生效 revision` 与 `应用时间`、运行期能力（steer 机制、集成方式、扩展原文说明）、
8 项计数与「最近一批合并」（空时明确写「本页不伪造」）。

### 6.3 仍未验证（不作为断言）

- 真实 QQ 用户端到端：多 step 一轮是否真的只有一条消息（客户端呈现）、steer 在真实轮次
  边界的可感知效果、`agent/turn-stopping` 在真实宿主上的触发时序。
- 群聊统一回复的投递时机、流式频率限制下的修订体验。
- 扩展在 Windows 桌面端与官方插件热切换（替换 bundle + 重启）的完整流程。

---

## 7. 授权后如何启用（人工步骤）

执行侧是**独立插件** [`dsh-qqbot-merge`](https://github.com/bufan528/dsh-qqbot-merge)
（npm 包 `dsh-qqbot-merge@0.1.0`），它替换官方 QQ 插件（两者不能共存）。

```powershell
# 1) 备份 profile 配置（回滚用）
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\package.json" "$env:USERPROFILE\.dsh\profiles\desktop\package.json.bak"
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml.bak"

# 2) 安装独立插件并移除官方插件
dsh plugin --profile desktop add dsh-qqbot-merge
dsh plugin --profile desktop remove @tencent-connect/dsh-qqbot

# 3) 编辑 profile 的 package.json：bundles 里把 "@tencent-connect/dsh-qqbot" 换成 "dsh-qqbot-merge"
#    编辑 cordis.patch.yml：把原 `im-qqbot` 行的 appId/appSecret 移到 `qqbot-merge` 行
#    （或删除凭据后重启，走重新扫码绑定；不要把凭据同时留在两行）

# 4) 重启 DSH 桌面端
# 5) 打开 长期记忆 → QQ 接入 → 「连续消息智能合并」，启用并保存；
#    页面应显示 已生效 revision / appliedAt；随后连发消息观察 counters 与回复形态
```

回滚：把 `package.json` / `cordis.patch.yml` 恢复成备份（即换回
`@tencent-connect/dsh-qqbot@0.5.3`），重启 DSH 即可。


---

## 8. 剩余风险

1. **`/stop` 丢弃已并入批次**：显式停止的预期语义，但需要在 UI 文案里说清。
2. **turn 收尾微任务窗口**：steer 可能停在 `next-step` 不自唤醒；扩展实现了
   `whenIdle` 后 remove + re-steer 的兜底（见 agent 证据 §8.2），真实环境未实测。
3. **群聊统一回复**：群聊不支持流式，扩展改为「轮末才发第一条」，若模型在中间步骤
   提问/交付文件，投递时机与官方略有差异（审批、问答、文件通道本身不变）。
4. **上游漂移**：fork 基于 0.5.3；上游后续版本若改动链路，需要重新 rebase。
5. **官方注释不准确**：`maxProcessingMs` 的 abort 并不会中断 LLM（`handleInbound` 不读
   `ctx.signal`），本功能不依赖它。





