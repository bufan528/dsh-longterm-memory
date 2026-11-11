# WP-2：PC ↔ QQ 共享长期记忆系统 — 实施方案设计

状态：**设计稿（待批准，未实施）**  
基线：WP-1 身份绑定 + WP-1.5 真实验收 E1–E8 PASS + WP-1.6 fail-closed / 构建产物  
范围：仅设计；本轮不改代码、不改配置、不迁数据、不进 WP-2A。

---

## A. 现有系统架构及真实调用链

### A.1 双插件同宿主单 Vault

```
┌─ PC 管理页 (Memory Vault client) ─┐     ┌─ QQ 私聊 (dsh-qqbot-merge) ─┐
│ POST /dsh-longterm-memory/api/*   │     │ SDK 中间件 → handleInbound  │
└──────────────┬────────────────────┘     │ → agents.followup/steer     │
               │ loopback fence           └──────────────┬──────────────┘
               ▼                                         │ 模型轮次内
┌─ Memory Vault host ───────────────┐                    │ memory_* 工具
│ MemoryService（唯一写/读协调点）    │◄───────────────────┤ standing / pre-step
│ repository → Markdown + index     │   ctx.get('tools') │ turn/end 提取
│ Owner Gate + qq-linkage 四执行点   │                    │
└──────────────┬────────────────────┘                    │
               │ ctx.get('qqbotContext')                 │ provide
               ▼                                         ▼
        qqbotContext@v1 ◄────────────────── dsh-qqbot-merge identity
        (ownerBinding 持久化在 QQ row config)
```

**同一套后端**：一个 `MemoryService`、一个 Markdown Vault、一个索引、一套质量管理（confidence/inbox/supersede/conflict）、一套 Owner Gate。**不建第二套 QQ 记忆库。**

### A.2 已证实宿主机制（禁止发明）

| 机制 | 证据 | WP-2 用途 |
|---|---|---|
| `ctx.provide(name, svc)` / `ctx.get(name)` | QQ `index.ts` provide `qqbotMerge`/`qqbotContext`；MV `installTools`/`installStandingSection` 用 `ctx.get` | 跨插件身份与（若需）记忆门禁 |
| `systemPrompt.section({text(context)})` | `inject.ts` `installStandingSection` | PC/QQ 共用 standing 注入 |
| `session/event` + `turn/end` | `inject.ts` `installTurnExtraction` | 轮末提取写回 |
| `agent/pre-step`（per-agent 注册） | `inject.ts` `installPerStepRecall` | 可选每步召回 |
| `ctx.get('tools').register(def)` | `tools.ts` `installTools`；QQ vision/send-file 同模式 | 四个 `memory_*` 全局注册 |
| Session `meta` | QQ create/fork 写 `origin:'qqbot-merge'` + `cwd`/`agentPreset`/`parentSession`（`session-manager.ts`） | **见 A.5**：宿主 `SessionHeader.origin` 仅允许 `'subagent'`，自由串可能 throw；可靠标记应以 `cwd`/`agentPreset` + live `qqbotContext` 为准 |
| Session header `origin/agentPreset/cwd` | `readSessionFacts`、session meta | linkage 标记 + Owner Gate |

**不存在、不得依赖**：跨插件消息总线、DSH 官方 Owner API、会话级 per-user 记忆命名空间、宿主级「当前用户」对象。

### A.3 当前真实调用链（源码事实）

**PC 保存（管理页）**  
`client` → `POST save` → `routes.dispatch` → `MemoryService.save`（journal stage → write → commit）→ `refreshAfterWrite` 索引更新。

**QQ 模型读/写记忆（工具）**  
模型轮内调用 `memory_*` → `assertToolsAllowed`（`ownerGate` + `linkage.tools`）→ `MemoryService.search/get/save/setStatus`。  
工具由 **Memory Vault** 在宿主 `ctx.tools` 全局注册；QQ 插件 **零** `memory_*` 注册代码（已核实）。

**Standing / 每步召回**  
`system-prompt/assemble` / `agent/pre-step` → `linkage.read/standing` → `ownerAccessForAgent` → `service.standing()` / `recallForInjection`。

**轮末自动提取**  
`session/event` `turn/end` → `linkage.write` + `ownerAccessForSession`（拒绝则 `forceInbox`）→ `service.processTurn`（幂等 turnKey）。

**身份**  
QQ 入站 `noteSource` → `onSessionReady` 补 sessionId → `getContext` 实时 `resolveOwner`（解绑即 null）。  
MV Owner Gate：`requiresOwnerGate`（live qq 或 `sessionOrigin==='qqbot-merge'`）→ `decideOwnerMemoryAccess` fail-closed。

### A.4 关键缺口（相对 WP-2 目标）

1. **MemoryService / RPC 层无 Owner 过滤**——门禁只在 tools + inject；管理页 RPC 仅靠 loopback 围栏（本机可信，可接受）。
2. **QQ 模型是否见到 `memory_*` 取决于宿主全局 tools + 会话 setup**——已注册即全局可见；Owner Gate 拦截未绑定/群聊。
3. **QQ 自动提取** 已走 `processTurn`，但 `writeMode` 默认 `inbox-only` 且 linkage mode 默认 `off` 时按既有规则；跨端「QQ 明确保存 → PC 可搜」需保证 `memory_save` 路径（工具）与确认后的 inbox 路径都落同一索引（**已同一索引**）。
4. **`qqbotContext.sources` 为进程内 Map（128）**——重启后依赖会话标记 fail-closed；**不能**在无 live 来源时放行；首条新消息 `noteSource` 后恢复。

### A.5 宿主 `SessionHeader.origin` 硬约束（explore 核实，**设计级风险**）

| 事实 | 证据 |
|---|---|
| `origin?: 'subagent'` 字面量类型 | `dsh-session/lib/types/types.d.ts` |
| 运行时 `origin !== "subagent"` **throw** | `dsh-session` types 校验 `index.js` |
| `CreateAgentOptions.meta.origin` 同样仅 `'subagent'` | `dsh-agent` types |
| WP-1.6 写入 `origin: 'qqbot-merge'` | QQ `session-manager.ts` create/fork |

**影响**：`requiresOwnerGate` 中 `sessionOrigin === 'qqbot-merge'` 在「sources 丢失 + 无 live 上下文」时**可能永远匹配不到**（header 根本没写入该值，或 create 已失败）。  
**设计立场（ADR-008）**：WP-2 **不得**把自由串 `header.origin` 当作唯一 fail-closed 依据；改用：

1. **首选 live**：`qqbotContext.getContext(sessionId)`（每次 `resolveOwner`）——已绑定/未绑定判定不依赖 origin。  
2. **重启后无 sources**：在 `getContext === null` 时，对「疑似 QQ」会话 **保守拒绝** 或仅当能通过 `cwd`/`agentPreset`/会话 id 派生规则（`qqbot:${appId}:…` 的 SHA 派生 sessionId **可从 header.id 复算**）确认是 QQ 会话才进 Gate 拒绝分支；**确认不了来源 → 按矩阵 Missing provenance 拒绝**（与「PC 不得误伤」的张力见下）。  
3. **PC 保护**：本机 PC 会话无 QQ 来源时 `requiresOwnerGate` 应为 false——在 origin 不可用后，改为：**`getContext==null` 且 sessionId 无法证明来自 QQ → 视为非 QQ（不进 Gate，交既有 linkage）**；**仅当** live context 为 qq 或（可选）sessionId 满足 QQ 派生规则时进 Gate。  
4. **WP-2A 必做**：在隔离环境实测 `meta.origin='qqbot-merge'` 是否被宿主拒绝；若拒绝，**停止写入该字段**（避免 create 失败），改依赖 live context + sessionId 派生。  
5. **安全下限不变**：**有 live qq 上下文时必须 Gate**；未绑定/群聊/缺 ownerId 一律拒——这条不依赖 origin。

---

## B. 复用与新增接口清单

### B.1 直接复用（不改签名）

| 接口 | 位置 | 用途 |
|---|---|---|
| `MemoryService.save/search/get/setStatus/remove/merge/...` | `host/core/service.ts` | 全部跨端 CRUD |
| `memory_search/get/save/forget` | `host/dsh/tools.ts` | QQ/PC 模型工具（同一套） |
| `processTurn` + inbox 确认 | service + RPC confirm | 轮末提取与低置信度 |
| `standing` / `recallForInjection` | service + inject | PC/QQ 召回 |
| `decideOwnerMemoryAccess` / `requiresOwnerGate` | `shared/owner-access.ts` | 统一权限判定 |
| `qqbotContext.getContext/resolveOwner/getStatus/noteSource` | QQ identity | 来源与 Owner |
| `linkage` 四执行点 | `host/qq/linkage.ts` | 既有 QQ 策略叠加 |
| RPC `ownerBinding*` | `host/dsh/routes.ts` | 配对/解绑 UI |
| Vault 写后 `syncIndex` | repository/indexing | 双端即时可搜 |

### B.2 新增（最小）

| 新增 | 原因（不可复用说明） | 层 |
|---|---|---|
| **（可选）`ownerOfSession` 一次性解析助手** | 现有 `ownerAccessForAgent/Session` 私有且分散在 inject/tools；WP-2A 可抽到 `shared` 或 `host/owner-gate.ts` **纯移动**，不改语义 | MV host |
| **（可选）`memory_*` 工具描述/错误文案区分来源** | 非功能必需；仅当验收要求「QQ 侧错误可读」时改 description | tools |
| **无** 第二服务、**无** 第二索引、**无** QQ 专用 DB、**无** 新 RPC 包装 save/search | 既有 RPC + 工具已覆盖 | — |

**明确不做**：不把 `memory_*` 再包一层「QQ 专用工具」；不在 QQ 仓复制 `MemoryService`；不新增分布式同步。

### B.3 若需「Owner 过滤检索结果」

当前模型：单机单 Owner Vault，**整库即该 Owner 的记忆**；PC 与绑定 QQ 看到同一库。  
因此 **不需要** 在 `search` 结果里按 ownerId 过滤行——权限问题是「能不能进库」，不是「库内多租户切片」。  
未知/未绑定 QQ **进不了库**（Gate 拒绝），即不会泄漏。

---

## C. Owner 权限模型

### C.1 统一矩阵（个人记忆）

| 操作 | 可信 PC | 已绑定 QQ C2C | 未绑定 QQ | QQ 群聊 | Unknown / Missing |
|---|---|---|---|---|---|
| 搜索 | 允许 | 允许 | 拒绝 | 拒绝 | 拒绝 |
| 读取详情 | 允许 | 允许 | 拒绝 | 拒绝 | 拒绝 |
| 保存 | 允许 | 允许 | 拒绝 | 拒绝 | 拒绝 |
| 更新 | 允许 | 允许 | 拒绝 | 拒绝 | 拒绝 |
| 删除/归档 | 允许 | 允许 | 拒绝 | 拒绝 | 拒绝 |
| 轮末自动提取直接落盘 | 允许* | 按 linkage/Owner | 拒绝→forceInbox | 拒绝→forceInbox | forceInbox |

\*PC 自动提取仍走既有 `enableAutoExtraction` 与规则；拒绝时与 QQ 相同进 Inbox。

### C.2 硬性规则（与需求逐条对应）

1. **同一授权入口**：一切非管理页 RPC 的模型侧路径先过 `ownerGate`（`assertToolsAllowed` / inject 同源）。  
2. **不只在 prompt 拦**：standing、per-step、四工具、turn 写回 **四处** 都接 Gate（WP-1.6 已接；WP-2 保持并补测）。  
3. **工具不可绕过**：`assertToolsAllowed` 在 `execute` 最前；拒绝抛普通 `Error`，**不返回记忆内容**。  
4. **可追溯真实来源**：QQ 仅用 `senderId/appId/kind`；`noteSource` 为准；会话标记见 **A.5**（不依赖自由串 origin）；审计 `pair-attempt` 已有。  
5. **解绑立即失效**：`resolveOwner` 读 live binding；unbind 后 `getContext.ownerId=null` → Gate 拒。  
6. **禁止过期 Session 缓存绕过**：`getContext` **每次** `resolveOwner`，不缓存 ownerId；sources 只存 facts 不存授权。  
7. **Unknown ≠ PC**：`TRUSTED_PC_PLATFORMS` 白名单；否则 deny。  
8. **错误不泄内容**：Gate 拒绝仅 reason 文案（「未绑定/群聊/缺来源」），无 title/summary。

### C.3 管理页 RPC

本机 loopback + Origin 围栏已存在；**PC 管理页视为可信 PC**。不把管理页 RPC 再绑到 QQ binding（避免解绑后无法在 PC 解绑/清理）。

---

## D. 五条跨端调用链设计

### D.A PC → Memory Vault（保存）

```
用户在管理页/PC 模型
  → (页) RPC save | (模型) memory_save
  → [若模型] ownerGate(agent)  // PC 会话: origin 非 qq → 不进 Gate 或 trusted 放行
  → scanSecrets / validateSaveRequest
  → MemoryService.save (journal→file→commit)
  → syncIndex → 立刻可 search
```

- **可信 PC**：无 QQ origin 的本机会话；`requiresOwnerGate=false` 时不拦（不破坏现有 PC）。  
- **Owner**：本机单 Owner；`ownerId` 仅在 QQ 绑定时由 `randomUUID` 写入 `ownerBinding`，**PC 记忆不依赖 ownerId 字段过滤**。  
- **不退化**：不改 `save` 语义、不改 journal、不改 RPC 面。

### D.B QQ → 检索 PC 已有记忆

```
QQ 私聊消息 → noteSource(senderId, appId, c2c) → getOrCreate（meta 尽量标 QQ；见 A.5）
  → onSessionReady 补 sessionId
  → 模型调用 memory_search / standing / pre-step
  → ownerGate:
       getContext(sessionId)          // live，每次 resolveOwner
       → facts(platform=qq, senderId) + resolveOwner(appId, senderId)
       → decideOwnerMemoryAccess
         未绑定/群/缺来源 → 拒绝（无内容）
         已绑定 → allow
       getContext==null → 按 A.5：仅能证明 QQ 的会话进 Gate 拒；否则交 linkage（PC 不误伤）
  → MemoryService.search/recall  // 同一索引 → 含 PC 已存记忆
  → 结果仅该 Vault（单 Owner）
```

- **每次** `resolveOwner`，不用未验证缓存身份。  
- **不**把 Owner 放进用户消息正文。  
- 搜索结果不按第二 Owner 过滤（单 Owner 模型）；未绑定根本进不了 search。

### D.C QQ → 写入（PC 可检索）

**路径 1 — 显式工具（主路径，推荐验收用）**  
用户在 QQ 明确要求记住 → 模型 `memory_save` → Gate 通过 → `service.save` → 同步索引 → PC `search` 立即可读。  
`confidence=low` → `status=pending` → Inbox，PC 确认后 `active`。

**路径 2 — 轮末自动提取（既有）**  
`turn/end` → Gate + linkage → `processTurn`（幂等 `sessionId#turn#checksum`）→ 候选进 Inbox 或按 `writeMode=direct` 落盘。  
**不**把整段闲聊自动变成长期记忆：沿用现有规则提取 + `maxCandidatesPerTurn` + redactSecrets。

- 元数据：`sourceSessions` 已含 sessionId；**可选**（WP-2D 再议）`evidence` 追加「来自 QQ 会话」，**不**强制新 frontmatter 字段。  
- PC 可见：同一 `syncIndex` 路径，无第二套写入。

### D.D PC 记忆 → QQ 召回

| 通道 | 职责 | 成本控制 |
|---|---|---|
| **standing**（默认开） | 会话级常驻事实（budget `standingBudgetTokens`） | 每请求一次 section；QQ Gate 通过才注入 |
| **per-step recall**（默认关） | 按 query 注入检索块 | token 高；开启时同样过 Gate |
| **memory_search 工具** | 模型主动查 | 按需；Gate 在 execute |

- **重复注入**：standing 与 per-step 是不同通道；默认只开 standing，避免与工具结果双份堆叠。开启 per-step 时由用户显式配置，文档标明成本。  
- **记忆不存在 / Owner 不可用**：standing 返回 `''`；工具抛 `memory tool refused...`；不编造内容。  
- PC 保存后：索引已更新 → QQ 下一轮 standing/search 即可见（standing 文本来自 `service.standing()` 实时读 index）。

### D.E 跨端修改与删除

| 操作 | PC | QQ 模型 | 存储 |
|---|---|---|---|
| 更新 | RPC `save`/`writeRaw` | `memory_save` 带 `id` 或 `writeRaw`（若暴露） | 同一 `id` 文件 |
| 删除 | RPC `delete` confirm | `memory_forget` → `setStatus archived/stale` | 同一文件状态机 |
| 归档 | `setStatus` | `memory_forget status=archived` | Archive 目录 |
| 搜索/详情 | RPC `search`/`get` | `memory_search`/`memory_get` | 同一 index |

- **同一记忆身份**：`id` 全局唯一（`newMemoryId`）；两端只操作同一 id，**不生成副本**。  
- **并发双改**：依赖既有 journal/checksum（`writeRaw` `expectedChecksum`）与 `save` 的 stage-commit；冲突进 `conflict` 状态/`resolveConflict`——**不引入** OT/CRDT。  
- **删除传播**：状态迁移 + `syncIndex`；对端下次 search/get 即见 archived/不存在于 active。  
- **索引时机**：每次写后 `refreshAfterWrite`（已有）；失败则 `syncIndex` 手动/启动 `loadOrRebuildIndex`。

---

## E. Markdown 数据结构方案

### E.1 结论：第一阶段 **零 schema 迁移**

现有 frontmatter 已足够跨端：

```
id, type, status, title, created_at, updated_at, tags,
confidence, importance, pinned, source_sessions,
aliases, supersedes, superseded_by, conflicts_with,
evidence, schema_version
```

| 需求 | 现有字段 | 结论 |
|---|---|---|
| 同一 Owner 统一身份 | 单 Vault 单库 | 不需要 per-memory ownerId |
| 来源会话 | `source_sessions` | 复用 |
| 审计「谁改的」 | `evidence` + History journal | 复用；可选在 evidence 追加 `via=qq|pc` 字符串 |
| 重复保存 | `save` 更新同 id / 提取去重 `sameCandidateSubject` | 复用 |
| 双端同时改 | journal + checksum + conflict 状态 | 复用 |
| 删除传播 | status 迁移 + index | 复用 |

### E.2 仅当验收提出审计缺口时的最小扩展（默认不做）

- 可选 frontmatter：`updated_via: pc|qq`（单字符串）。  
- **不做**：`source_message` 全量消息 id、多 Owner 分区、版本向量、影子副本。

### E.3 重复与冲突策略（轻量）

1. 工具 `memory_save` 无 id → 新建；有 id → 更新（模型需先 search）。  
2. 自动提取 → 既有 merge/conflict 引擎。  
3. 两端同时写同一 id → 后写 checksum 失败 → 用户重试或 conflict 流程（已有）。  
4. **禁止** 为 WP-2 新建「同步日志表」。

---

## F. 异常处理策略

| # | 场景 | 处理 | 原则 |
|---|---|---|---|
| 1 | QQ 插件未加载 | `ctx.get('qqbotContext')` 缺失 → Gate 对「非明确 PC」fail-closed；PC 管理页/本机会话不受影响（无 qq origin） | 明确失败，不猜 |
| 2 | Memory Vault 未加载 | QQ 模型无 `memory_*` / 无 standing；聊天照常；用户可见「记忆不可用」 | 不崩聊天 |
| 3 | qqbotContext 不可用 | 同 1；`ownerAccessFor*` catch → `decide(null)` 拒 | fail-closed |
| 4 | Owner 查询失败 | `resolveOwner` throw → Gate 拒 | fail-closed |
| 5 | 用户解绑 | binding=null 立即生效；后续 Gate 拒；已有记忆 **不删** | 撤销访问≠删数据 |
| 6 | Session 来源丢失 | live `getContext==null`：能证明 QQ → 拒（A.5）；不能证明 → 交 linkage，**禁止**用无效 origin 放行；下一条 QQ 消息 `noteSource` 恢复 | 不靠过期缓存放行 |
| 7 | DSH 重启 | binding 在 row config；sources 空 → 首条消息前 QQ 会话 fail-closed；PC 正常 | E6 已验 binding 持久 |
| 8 | QQ 消息重复投递 | `messageFilter` 去重 + `processTurn` 幂等 turnKey | 已有；测 9 |
| 9 | 两端几乎同时 save 新记忆 | 两 id 并存或去重靠提取；工具路径由模型 search 减少重复 | 可接受；不加锁服务 |
| 10 | 同时改同一条 | checksum/journal → conflict 或后写失败重试 | 复用 |
| 11 | Vault 写失败 | `save` 抛错；工具返回失败；不假装成功 | 已有 |
| 12 | 索引更新失败 | 写文件已成功则 `syncIndex`/启动 rebuild；search 可能短暂旧 → 手动 rebuildIndex | 已有 |

**不堆**：跨进程文件锁集群、两阶段提交、消息队列重试框架。

---

## G. 分批实施计划

### WP-2A — 统一 Owner-aware Memory Access 接口

| 项 | 内容 |
|---|---|
| **目标** | 单一入口解析「当前 agent/session → Owner 决策」，tools/inject 共用，语义与现矩阵一致；**并落地 ADR-008** |
| **修改** | ① **先**隔离实测 `meta.origin='qqbot-merge'` 是否被宿主拒绝（A.5）；② MV 抽 `host/owner-gate.ts` 包装 `getContext`+`requiresOwnerGate`+`decideOwnerMemoryAccess`；`tools.ts`/`inject.ts` 改调用；③ 若 origin 被拒：QQ 侧停止写入该字段，`requiresOwnerGate` 改为 live qq **或** 可证明的 QQ 会话（sessionId 派生，可选） |
| **复用** | `owner-access.ts` 纯函数、`qqbotContext` |
| **新增** | Gate 解析函数（可测）；**不**新服务 |
| **调用链** | Gate(session|agent) → {allowed, reason, ownerId} |
| **测试** | 单测矩阵全分支；origin 实测记录；tools/inject 行为回归 |
| **验收** | owner-access 测试 + 全量 MV/QQ 测试不降；origin 结论写入 docs |
| **风险** | 抽取语义漂移；origin 实测失败需改 `requiresOwnerGate`（见 ADR-008） |

### WP-2B — QQ 个人记忆搜索与读取

| 项 | 内容 |
|---|---|
| **目标** | 绑定 QQ C2C 经模型工具/standing 读到 PC 已写入记忆；未绑定/群聊拒 |
| **修改** | 通常 **零或极少**（工具已全局注册）；验收脚本 + 可选工具 description；确认 preset/全局 tools 在 QQ 会话可见 |
| **复用** | `memory_search`/`memory_get`、standing、Owner Gate |
| **新增** | 无服务 |
| **调用链** | D.B |
| **测试** | 集成：预置 Vault 记忆 → 绑定 QQ search 命中；未绑定 search 拒；群聊拒 |
| **验收** | 测试一（查询召回）+ 测试八 |
| **风险** | QQ 会话 preset 未挂载全局 tools——需在验收环境确认 `ctx.tools` 对 agent 可见；若不可见，仅改 preset/文档，不新造工具通道 |

### WP-2C — QQ 记忆保存及 PC 召回

| 项 | 内容 |
|---|---|
| **目标** | QQ 显式 `memory_save`（及/或确认后的提取）→ PC 立即 search 可见 |
| **修改** | 无核心改；验收 + 若 `enableAutoExtraction`/`writeMode` 需在测试 profile 打开则 **只改测试配置** |
| **复用** | `memory_save`、`processTurn`、inbox confirm、`syncIndex` |
| **新增** | 无 |
| **调用链** | D.C |
| **测试** | 测试二；重复消息测试九；low confidence → inbox → PC confirm |
| **验收** | PC search 命中新 id；frontmatter `source_sessions` 含 QQ sessionId |
| **风险** | 模型不调用 save——验收用明确指令「请记住…」；不强制改 prompt 大改 |

### WP-2D — 跨端修改、删除与归档

| 项 | 内容 |
|---|---|
| **目标** | 一端改/删，另一端看到；同一 id |
| **修改** | 无核心改；确认 `memory_save` 带 id 更新路径与 `memory_forget`；必要时工具 description 补「先 search 再 save」 |
| **复用** | `save(id)`、`setStatus`、`remove`、History |
| **新增** | 无（可选 `updated_via` 不在本批默认做） |
| **调用链** | D.E |
| **测试** | 测试三～五 |
| **验收** | 双端 get 一致；删除后 active search 不命中 |
| **风险** | 模型更新时丢 id——靠 search 工具纪律 + description；不做自动 merge 服务 |

### WP-2E — 解绑撤销、异常与端到端回归

| 项 | 内容 |
|---|---|
| **目标** | 解绑即拒；重启保持；全矩阵回归；专用测试 Bot |
| **修改** | 无核心改；隔离 profile 配置；验收脚本 |
| **复用** | unbind RPC、Gate、E6 类重启 |
| **新增** | 验收文档/脚本（可放 `docs/`，不进运行时） |
| **测试** | 测试六～九 + WP-1.5 E1–E8 回归 |
| **验收** | 见 H 矩阵全绿 |
| **风险** | 同 appId 双连接——**必须独立测试 Bot**（已知限制） |

**依赖**：2A → 2B/2C（可并行）→ 2D → 2E。  
**每批可独立验收**；不跳过 2A（统一 Gate 是 2B–2E 的安全底座）。

---

## H. 自动化测试与真实端到端验收矩阵

### H.1 自动化（每批）

| 层 | 内容 |
|---|---|
| 单元 | `decideOwnerMemoryAccess` 全矩阵；pair/unbind 持久化（已有）；`processTurn` 幂等（已有） |
| 组件 | Gate 拒绝时 `memory_*` execute 不触达 service（mock service 断言未调用） |
| 回归 | MV 全量 vitest + QQ 全量 vitest + 双 typecheck/build |

### H.2 真实 E2E（独立测试 Bot + 独立 Vault，如 wp15 演进）

| # | 步骤 | 预期 |
|---|---|---|
| 1 | PC 保存「我正在开发 MiMo Context Insight」→ QQ 问该内容 | search/standing 召回正确 |
| 2 | QQ 明确「记住：今天确定了新项目决策」→ PC 搜索 | 同 id 命中 |
| 3 | PC 更新该记忆标题/正文 → QQ get | 新内容 |
| 4 | QQ `memory_save` 更新 → PC get | 新内容 |
| 5 | PC 删除/归档测试记忆 → QQ search | 不作为 active 命中 |
| 6 | PC 解绑 → QQ 任意记忆操作 | 全拒，无内容 |
| 7 | 重启 DSH → ownerId+记忆 | 与绑定前一致；历史可搜 |
| 8 | 未知来源/群聊/未绑定 | 拒读（含 standing 空、工具 error） |
| 9 | 重复投递同一 QQ 消息 | `skippedAsDuplicate` 或不双写 |

**禁止**：生产 appId、生产 Vault、模拟结果冒充 E2E。

---

## I. 预计修改文件及影响范围

| 批次 | 预计文件 | 影响 |
|---|---|---|
| 2A | `MV: host/dsh/inject.ts`, `host/dsh/tools.ts`, 新 `host/owner-gate.ts`（或 shared） | 纯重构，行为不变 |
| 2B | 通常无运行时；或 `tools.ts` description / 测试 profile | 极小 |
| 2C | 无运行时核心；测试配置与文档 | 极小 |
| 2D | 可选 `tools.ts` description；无 schema | 极小 |
| 2E | `docs/*` 验收；隔离 profile | 无生产 |

**不改**：`MemoryService` 核心存储、索引算法、Markdown 引擎、QQ 合并/Steering、Host 核心、生产 cordis.patch。

---

## J. 技术风险与成本评估

| 风险 | 等级 | 缓解 |
|---|---|---|
| QQ 会话看不到全局 `memory_*` | 中 | 2B 第一项验收即验证；必要时查 preset mount，不新造通道 |
| 模型不主动 save/search | 中 | 验收用明确话术；不强制大改 system prompt |
| 同 appId 顶线 | 高（流程） | **专用测试 Bot** |
| Gate 抽取引入回归 | 低 | 2A 纯移动 + 全量测试 |
| **`origin:'qqbot-merge'` 被宿主拒绝 / Gate 失效** | **高（A.5）** | **WP-2A 第一项实测**；改 live+派生方案（ADR-008） |
| standing token 成本 | 低 | 默认 budget 已有；per-step 默认关 |
| 双端并发写 | 低 | 既有 journal/checksum |

**成本**：以复用为主；2A 为唯一「结构」工作，其余以接线验证 + E2E 为主。预计 **无新依赖、无新存储、无 Host 改造**。

---

## K. 架构决策记录（ADR）

### ADR-001 单 Vault 单 MemoryService 跨端共享  
**决定**：PC 与 QQ 共用现有 Memory Vault，不建 QQ 专用库。  
**理由**：产品即本机单用户记忆；双库破坏「同一索引/同一质量规则」。  
**后果**：权限=能否进入该库（Owner Gate），不是库内多租户。

### ADR-002 权限在 Gate 层，不在 Service 层做多租户  
**决定**：`MemoryService` 保持无 Owner 过滤；Gate 在 tools+inject。  
**理由**：单 Owner；RPC 本机围栏已够；避免每次 search 打 ownerId 标签。  
**后果**：管理页 RPC 不绑定 QQ 状态（解绑后仍可 PC 管理）。

### ADR-003 身份只信 qqbotContext 实时 resolve  
**决定**：`getContext` 每次 `resolveOwner`；不缓存授权。  
**理由**：解绑立即失效（WP-1.6）。  
**后果**：进程内 sources 仅存 facts；重启后靠 origin fail-closed。

### ADR-004 写入复用 save + processTurn，不加同步总线  
**决定**：显式工具 + 既有轮末提取；索引写后刷新。  
**理由**：最小改动；幂等 turnKey 已防重复。  
**后果**：极低概率双端同时新建可能两条记忆，靠后续人工/merge，不做分布式锁。

### ADR-005 数据模型第一阶段零迁移  
**决定**：不新增强制 frontmatter；`source_sessions`/`evidence` 足够。  
**理由**：避免 schema_version 迁移与 Obsidian 兼容风险。  
**后果**：细粒度「最后操作端」审计若未来需要再加可选字段。

### ADR-006 QQ 显式保存以 `memory_save` 为主路径  
**决定**：验收以模型工具保存为准；自动提取为辅（inbox）。  
**理由**：可控、可测、符合「用户明确表达才保存」。  
**后果**：验收话术需引导模型调用工具；不默认全量聊天入库。

### ADR-007 不发明宿主 API  
**决定**：只用已证实的 provide/get、systemPrompt.section、session/event、pre-step、tools.register、session `cwd`/`agentPreset`/`parentSession`。  
**理由**：WP 任务硬约束。  
**后果**：无「官方 current user」可用时，本机 PC=默认可信会话 + QQ=显式 Gate。

### ADR-008 不依赖自由串 `header.origin`  
**决定**：`SessionHeader.origin` 宿主仅允许 `'subagent'`；**停止**把 `origin:'qqbot-merge'` 当作可靠持久标记（WP-2A 实测后删除或不再写入）。QQ 识别以 **live `qqbotContext.getContext`** 为主，辅以 sessionId 派生规则（可选）；`requiresOwnerGate` 语义改为「live qq **或** 可证明的 QQ 会话」。  
**理由**：宿主类型与运行时校验已证实（A.5）；错误 origin 可能导致 create 失败或 Gate 永不命中。  
**后果**：重启后 sources 空窗期内，**无法证明来源的会话不因 origin 被误判为 QQ**；安全下限仍由 live 路径保证（有 qq 上下文必 Gate）。

---

## 附录：与需求五条链的对照索引

| 需求 | 章节 |
|---|---|
| A PC→MV | D.A |
| B QQ→读 | D.B + C |
| C QQ→写 | D.C + ADR-006 |
| D PC→QQ 召回 | D.D |
| E 修改删除 | D.E |
| 权限矩阵 | C |
| 数据模型 | E |
| 异常 | F |
| 分批 | G |
| E2E | H |
| ADR | K |

---

**设计结论候选**：在独立测试 Bot 与批次批准前提下，本方案具备进入 **WP-2A** 实施条件（**第一项必须完成 origin 实测 + ADR-008 落地**）；完整 E2E 需 WP-2B–2E 完成后按 H.2 执行。
