# WP-2A-R1 交付报告

状态：**`WP2A-R1 COMPLETED`**  
日期：2026-11-04  
范围：Owner Gate 权限模型收尾（R1–R4）、历史路径调查、fail-closed 回归。  
**未**进入 WP-2B；未改生产 Vault / 凭据 / 部署。

---

## 1. R1 — `trusted-pc` 判定审查

### 1.1 修改前的隐式授权（已确认存在）

| 位置 | 旧逻辑 | 问题 |
|---|---|---|
| `owner-access.classifySessionProvenance` | `!serviceAvailable → trusted-pc` | 服务缺失被当成纯 PC（**R2 违规**） |
| 同上 | 无 live 来源且 `!knownQqSession → trusted-pc` | 「不在注册表」被当成可信 PC（**R1 违规**） |
| `owner-gate.createOwnerGate` | 服务缺失 → `return null` | null=跳过门禁 → 旧 linkage 可放行 |
| `tools.assertToolsAllowed` | `owner !== null && !allowed` 才拒 | null 被当作放行 |

### 1.2 注册表五问

| 问题 | 结论 |
|---|---|
| Q1 登记是否完整？ | **不保证**。仅 `noteSource(sessionId)` 登记；FIFO 上限 256；`profileDir` 缺失时仅内存 |
| Q2 QQ 会话能否未登记进记忆？ | 可能：identity 服务缺失、HMR 清空且清单失败、首次消息前异常路径 |
| Q3 历史/恢复会话？ | 重启后依赖 `qqbot-known-sessions.json`；文件缺失则未知 → **现改为 DENY** |
| Q4 读取失败/损坏/不兼容？ | **旧代码** catch→当空清单→未登记→（旧）trusted-pc **绕过**；**本轮** `isHealthy=false` → **DENY** |
| Q5 HMR/重启一致性？ | 清单文件跨重启；损坏/无 profileDir → fail-closed |

**裁定落实：** 未登记 **只能** `unknown` → DENY，**禁止** trusted-pc。

### 1.3 trusted-pc 正向证明机制

| 项 | 结论 |
|---|---|
| live `source.platform ∈ {desktop,pc,local,trusted-pc}` | **唯一 ALLOW 路径**（`decideOwnerMemoryAccess` / `classify`） |
| 生产代码是否存在 producer？ | **否**。`grep` 全仓无 `platform: 'desktop'|'pc'|'local'|'trusted-pc'` 赋值；QQ `getContext` 只产出 `qq` 或 null |
| 宿主 API？ | **无**。禁止发明；`SessionHeader.origin` 仅 `'subagent'`（A1 已证） |
| 测试中的 `platform:'desktop'` | **仅 mock**，验证「有正向证据时 ALLOW」路径，**不**声称生产已具备 |

**明确：当前不存在独立可信 PC 正向证明机制（无宿主 API、无生产 producer）。**

---

## 2. R2 — 服务缺失处理

| 条件 | 旧 | 新 |
|---|---|---|
| `qqbotContext` 不存在 / `getContext` 不可调用 | skip 门禁（null） | **DENY**「服务缺失，无独立可信 PC 证明」 |
| `ctx.get` 抛错 | catch→null（部分路径） | **DENY** |
| 服务暂时不可用 | 同左 | **DENY** |

**依据：** 服务缺失 ≠ 纯 PC 环境；无宿主/清单级「纯 PC 正向证明」可引用。

---

## 3. R3 — 最终权限矩阵

| 情况 | 结果 |
|---|---|
| 有可靠正向证据的可信 PC（live TRUSTED_PC_PLATFORMS） | **ALLOW** |
| 已绑定 QQ C2C（live ownerId≠null） | **ALLOW** |
| 未绑定 QQ C2C | **DENY** |
| QQ 群聊 | **DENY** |
| 已登记 QQ，live 上下文消失 | **DENY**（qq-missing） |
| 未知来源（无 live、未登记） | **DENY**（unknown） |
| 来源缺失（无 sessionId / 查询失败） | **DENY** |
| QQ 服务缺失且无独立可信 PC 证明 | **DENY** |
| 注册表读取失败 | **DENY** |
| OwnerBinding 不存在 / 解绑（live ownerId=null） | **DENY** |
| 解绑后旧 QQ Session | **DENY**（sources 保留但 resolveOwner=null） |
| 解绑后缓存上下文 | **DENY**（getContext **每次** resolveOwner，不缓存授权） |

**判定流程（`createOwnerGate`，始终返回 decision，无 null 跳过）：**

```
getService()
  缺失/无 getContext     → DENY（服务缺失）
  无 sessionId           → DENY
  getContext 抛错        → DENY
  classify({serviceAvailable:true, source, knownQq, registryHealthy})
    trusted-pc (live)    → ALLOW
    qq                    → decideOwnerMemoryAccess（群/未绑/未确认 DENY，绑定 ALLOW）
    qq-missing            → DENY
    unknown               → DENY（含注册表失败、未登记、无正向 PC）
```

**旧 linkage：** 不再是「无 Owner 证据时的放行通道」；Owner Gate 先于/独立于 linkage，DENY 时 linkage 无权放行。

---

## 4. R4 — A3/A4 深度回归（断言 ALLOW/DENY）

### 单元（`owner-access.test.ts` 36 项 + gate 集成）

| 场景 | 断言 |
|---|---|
| live QQ 已绑定 | ALLOW |
| live QQ 未绑定 / 群聊 | DENY |
| 已登记无 live | DENY |
| 未登记无 live | DENY |
| 服务缺失 | DENY |
| 注册表不健康 | DENY |
| 无 sessionId | DENY |
| getContext/getService 抛错 | DENY |
| 解绑后 live ownerId=null | DENY |
| gate 返回值 | **永不 null** |

### 集成（`qq-injection-guard` + `dsh-adapters`）

| 场景 | 结果 |
|---|---|
| standing：绑定 QQ + linkage off | 返回常驻文本 |
| standing：未绑定 QQ | 空串 DENY |
| standing：无服务 / 未登记 | 空串 DENY |
| turn 写回：未登记 | forceInbox（非 active） |
| turn 写回：有正向 PC 证据 | active 落盘 |
| tools：未绑定 / 无服务 / 未登记 / 无 sessionId | **throws refused** |
| tools：已绑定 + linkage off | 可 search |

**同一 `createOwnerGate`** 供 standing / per-step / turn / 四工具（`inject.ts` + `tools.ts`）。

---

## 5. 历史路径错误调查

| 项 | 结论 |
|---|---|
| 错误路径 | `...\wp15-home\profiles\wp15\node_modules\@deepseek-ai`（**无** `.pnpm` 层） |
| 原始命令 | 早期 `Glob`/`Get-ChildItem` 探索 dsh-session 类型时的**辅助**查找 |
| 工作目录 | 会话默认 cwd（`D:\dsh-qqbot-merge` / `D:\dsh-memory-vault`） |
| 历史环境 | WP-1.5 隔离 profile **wp15** 的 node_modules 布局（pnpm nested） |
| 是否影响 A1？ | **否** |
| A1 实际加载路径 | `.pnpm\@deepseek-ai+dsh-session-fo_456516d7aafccee18a9510f8b8dec5cc\node_modules\@deepseek-ai\dsh-session` |
| A1 宿主版本 | **`@deepseek-ai/dsh-session@0.2.1-rc.3`**（package.json 已核） |
| 坏路径是否存在 | `Test-Path` → **False**（从未被 A1 require） |
| EXIT 0 是否掩盖解析失败 | **否**。脚本 `require(join(pkgRoot,'lib/index.js'))` 失败会非 0 退出；证据含真实 throw 文案 `session header origin must be "subagent"` |
| A1 证据文件 | `docs/wp2a-origin-evidence.txt`（**存在**）；错误路径指向 scratch 下同名文件**不存在**，属记录笔误 |

**结论：** 过期路径仅用于非关键辅助检查，**不构成 A1 证据链缺陷**，无需重跑 A1。

---

## 6. 修改前后 Owner Gate 调用链

### 修改前

```
ownerGate(agent)
  → service missing → null → 跳过 → 旧 linkage（可放行）     ← fail-open
  → !knownQq && no source → trusted-pc → null → 跳过        ← fail-open
  → knownQq && no source → DENY
  → live qq → 矩阵
assertToolsAllowed: null 不拒
```

### 修改后

```
createOwnerGate(ctx.get('qqbotContext'))   // 始终 OwnerAccessDecision
  → 无服务/无 getContext / 无 sessionId / 异常 → DENY
  → classify(serviceAvailable, source, knownQq, registryHealthy)
       trusted-pc(仅 live TRUSTED_PC) → ALLOW
       qq → 矩阵（群/未绑 DENY；绑定 ALLOW）
       qq-missing / unknown → DENY
  → 无「返回 null 跳过」分支
inject(standing/per-step/turn): !allowed → withhold/forceInbox
tools: !allowed 或 null → throw refused
```

---

## 7. 测试 / typecheck / build

| 项 | 结果 | 性质 |
|---|---|---|
| QQ `npm test` | **443/443**（34 files） | 单元 |
| QQ `tsc` + `build` | **通过** | — |
| MV `owner-access` | **36/36** | 单元 |
| MV `qq-injection-guard` + `dsh-adapters` + owner | **105/105** | 集成/单元 |
| MV `npm test` 全量 | **736/738**；2 失败=**既有** engines.dsh（rc.2 vs rc.3） | 单元 |
| MV `typecheck` + `build` | **通过** | — |

**未**将单元/集成通过表述为真实桌面端验收。

---

## 8. 文件变更与 SHA-256

清单：`docs/wp2a-r1-sha256.txt`

| 文件 | SHA-256（前 16） |
|---|---|
| `mv/src/shared/owner-access.ts` | `F86A9C215EEAAF2C…` |
| `mv/src/host/owner-gate.ts` | `1DDE687628B16CCB…` |
| `mv/src/host/dsh/inject.ts` | `0FFD99EFAE8E2C49…` |
| `mv/src/host/dsh/tools.ts` | `628CE084301A3923…` |
| `mv/tests/unit/owner-access.test.ts` | `23D9C25C7C8CD735…` |
| `mv/tests/integration/qq-injection-guard.test.ts` | `AFA8537DA8BE18E0…` |
| `mv/tests/unit/dsh-adapters.test.ts` | `4C4F510254195FAC…` |
| `qq/src/identity/session-registry.ts` | `270C004C887C0E17…` |
| `qq/src/identity/service.ts` | `5B469EC108556C3D…` |
| `qq/src/identity/contract.ts` | `6BF18074E3EC4789…` |

（完整哈希见 `wp2a-r1-sha256.txt`。）

---

## 9. 剩余风险 / 真实桌面端未验证

1. **无生产 trusted-pc producer** → 无正向证据的会话（含正常桌面模型会话）在门禁下为 **DENY**；PC 模型记忆在具备正向 PC 证明之前 **不可用**（安全优先，符合 R 矩阵）。管理页 loopback RPC **不经** Owner Gate，不受影响。
2. **注册表 FIFO 256 / profileDir 缺失** → 极老 QQ 会话可能掉出清单 → 无 live 时 DENY（安全向，可能误伤）。
3. **未做** 真实 DSH 桌面端在线 Gate 验收。
4. MV 2 个既有 engines 测试失败未修（非本轮）。
5. 同 appId 双连接风险仍在后续真实验收处理。

---

## 10. 关键安全判定（停止条件）

> **是否已经证明：任何无法获得可靠来源证明的 Session，都不可能通过 PC 分支访问个人记忆？**

### **YES**（就当前代码路径而言）

依据：
1. `createOwnerGate` **不再返回 null 跳过**；无正向证据 → **DENY**。  
2. trusted-pc **仅** live `TRUSTED_PC_PLATFORMS`；服务缺失 / 未登记 / 注册表失败 → **unknown → DENY**。  
3. tools / standing / per-step / turn 共用该门禁；`assertToolsAllowed` 对 null/未 allowed **throw**。  
4. 36+ 集成断言覆盖服务缺失、未登记、解绑、无 sessionId 等路径均为 **DENY**。  
5. 旧 linkage **不能**在 Owner DENY 后放行。

**前提说明：** YES 指「无可靠来源证明 → 不能经 PC 分支 ALLOW」。不表示桌面产品在无正向 PC producer 时记忆可用——当前生产 **尚未** 提供该 producer（见 §1.3），属剩余产品缺口，须在后续工作包以**不发明宿主 API** 的方式解决。

---

**最终状态：`WP2A-R1 COMPLETED`**  
立即停止；**不**启动 WP-2B。等待项目负责人审查与下一阶段授权。
