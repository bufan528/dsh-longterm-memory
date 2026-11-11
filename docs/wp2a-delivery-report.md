# WP-2A 交付报告

状态：**`WP2A COMPLETED`**  
日期：2026-11-04  
范围：origin 实测、来源识别修正、统一 Owner Gate、权限矩阵测试。  
**未**进入 WP-2B～2E；未改生产 Vault / QQ 凭据 / 生产 profile。

---

## 1. 工作区基线

| 仓 | 分支 | 既有未提交 | 本轮改动 |
|---|---|---|---|
| dsh-qqbot-merge | main | 60 项（含 identity/、安全加固等） | **保留**；另改 session-manager/types，增 session-registry |
| dsh-longterm-memory | main | package.json 引擎范围、QQ UI 等 | **保留**；另改 owner-access/inject/tools，增 owner-gate |

未执行 `git reset` / `clean` / 覆盖式 checkout。

---

## 2. A1 — 宿主 origin 实测

**证据文件：**
- `docs/wp2a-origin-evidence.txt`（实测输出）
- `D:\dsh-memory-vault\.scratch\wp2a-origin-store4.mjs`（脚本）
- 宿主：`@deepseek-ai/dsh-session@0.2.1-rc.3`（wp15 profile node_modules）

| 检查 | 结果 |
|---|---|
| `types.d.ts` `origin?:` | **仅 `'subagent'`** |
| 运行时 | `origin !== "subagent"` → **`throw new Error('session header origin must be "subagent"')`** |
| 实测 `meta.origin='qqbot-merge'` | **THREW**（A1_VERDICT.rejectQq=true） |
| 实测缺省 origin | **OK** |
| 实测 `'subagent'` | **OK** |

**结论：** 宿主**拒绝** `origin: 'qqbot-merge'`。WP-1.6 写入该字段会在 `SessionStore.prepare` 抛错（若 meta 流入 header）。

**已修复：** `session-manager.ts` create/fork **删除** `origin: 'qqbot-merge'`；`session/types.ts` meta 类型同步去掉 `origin`。

---

## 3. 修改前后调用链对比

### 修改前（WP-1.6）

```
ownerAccessForAgent/Session
  → getContext(sessionId)
  → requiresOwnerGate({ source, sessionOrigin })
       live qq → true
       sessionOrigin === 'qqbot-merge' → true   // 实际永远进不了 header
       否则 → false → 返回 null → 跳过门禁 → 交旧 linkage
  → decideOwnerMemoryAccess(view|null)
```

**漏洞：** 无 live 来源且 origin 无效 → **fail-open**（旧 linkage mode=off 时放行）。

### 修改后（WP-2A）

```
createOwnerGate(ctx.get('qqbotContext'))   // host/owner-gate.ts 统一入口
  → classifySessionProvenance({ serviceAvailable, source, knownQqSession })
       无服务                    → trusted-pc（纯 PC profile）
       live platform=qq          → qq
       live 非 qq 非 trusted-pc  → unknown
       无 live + isKnownQqSession → qq-missing   // A3 历史 QQ
       无 live + 未登记           → trusted-pc    // 桌面会话
  → decideByProvenance
       trusted-pc → allow（gate 返回 null，不进门禁）
       qq         → decideOwnerMemoryAccess 矩阵
       qq-missing / unknown → deny
```

**调用点：** `inject.ts`（standing / per-step / turn 写回）、`tools.ts`（四工具）均改走 `createOwnerGate`。

**QQ 侧：** `isKnownQqSession` = 进程内 sources ∪ `KnownSessionRegistry`（profile 目录 `qqbot-known-sessions.json`，**不走 cordis.patch**，避免每条消息 HMR）。

---

## 4. 统一 Owner Gate 接口

| 文件 | 职责 |
|---|---|
| `src/shared/owner-access.ts` | 纯函数：`classifySessionProvenance` / `decideByProvenance` / `decideOwnerMemoryAccess` / `requiresOwnerGate` |
| `src/host/owner-gate.ts` | `createOwnerGate(getService)` + `sessionIdOfAgent`；inject/tools 共用 |

**权限矩阵（与裁定一致）：**

| 来源 | 决策 |
|---|---|
| 已证明可信 PC（无服务 或 非 QQ 登记） | 允许 |
| QQ C2C 已绑定 | 允许 |
| QQ C2C 未绑定 / 未确认 | 拒绝 |
| QQ 群聊 | 拒绝 |
| QQ 已知会话缺 live 来源（重启/HMR） | 拒绝 |
| Unknown | 拒绝 |
| Missing provenance（无 sessionId / 服务异常） | 拒绝 |

**「不能证明 QQ ≠ 可信 PC」：** 服务在且会话**曾被 QQ 登记** → 无 live 来源时 **deny**，不落入旧 linkage。

---

## 5. 测试结果（性质标注）

### 单元测试

| 套件 | 结果 | 性质 |
|---|---|---|
| QQ `npm test` 全量 | **439/439 通过**（34 files） | 单元 |
| QQ identity 专项 | 25 通过（含 session-registry 4、service 3） | 单元 |
| MV `owner-access.test.ts` | **24/24 通过**（矩阵 + Gate 集成 + A2/A3/A4） | 单元 |
| MV `npm test` 全量 | **717/719**；2 失败为**既有** `engines.dsh` rc.2 vs 测试期望 rc.3 | 单元 |
| A1 origin 实测脚本 | **EXIT 0**（rejectQq/acceptNo/acceptSub 全真） | **隔离宿主包实测** |

### 验收门槛对照

| 门槛 | 证据 |
|---|---|
| **A1** origin 行为 | `docs/wp2a-origin-evidence.txt` + 类型/运行时 throw + 脚本 EXIT 0 |
| **A2** 未知/缺失拒读 | `owner-access.test.ts`：missing/unknown/群/未绑定全 deny |
| **A3** 重启/上下文丢失不绕过 | `qq-missing` + `KnownSessionRegistry` 持久化测试；`service.test.ts` isKnownQqSession |
| **A4** 解绑后拒绝 | live `ownerId=null` → Gate deny（`createOwnerGate` A4 用例）；解绑保留 known 登记 |

**说明：** 以上为**单元测试 + 宿主包隔离实测**，**不是**真实桌面端 DSH 在线验收。

### typecheck / build

| 项 | 结果 |
|---|---|
| QQ `tsc --noEmit` | **通过** |
| QQ `npm run build` | **通过** |
| MV `typecheck` | **通过** |
| MV `npm run build` | **通过** |
| MV `lint` | 源码 lint OK；version consistency **失败=既有** engines.dsh（非本轮引入） |

---

## 6. 修改文件及 SHA-256

完整列表：`docs/wp2a-sha256.txt`

| 文件 | SHA-256（前 16 位） |
|---|---|
| `dsh-qqbot-merge/src/identity/contract.ts` | `E4D2BF0292F0A8EE…` |
| `dsh-qqbot-merge/src/identity/service.ts` | `709CE3EEAC93CEEB…` |
| `dsh-qqbot-merge/src/identity/session-registry.ts` | `72AE411163203CD7…` |
| `dsh-qqbot-merge/src/session/session-manager.ts` | `2DA34DAB62B21D08…` |
| `dsh-qqbot-merge/src/session/types.ts` | `4BE8AB634BBB399F…` |
| `dsh-memory-vault/src/shared/owner-access.ts` | `8F6E7663AEB5FD79…` |
| `dsh-memory-vault/src/host/owner-gate.ts` | `1F3D55B6DE8DE546…` |
| `dsh-memory-vault/src/host/dsh/inject.ts` | `4F084351D87085D7…` |
| `dsh-memory-vault/src/host/dsh/tools.ts` | `DCE7A32BEF333FEC…` |
| `dsh-memory-vault/tests/unit/owner-access.test.ts` | `ED5DE0B17503472E…` |

（全量哈希见 `wp2a-sha256.txt`。）

---

## 7. 未解决风险

1. **非 origin 的 QQ 会话持久标记** 依赖 `KnownSessionRegistry` 文件；若用户删除该文件且 HMR 清空 sources，历史 QQ 会话在首条新消息前会被判为 trusted-pc（首条消息会先 `noteSource` 再进模型，正常路径可覆盖）。
2. **MV 全量 2 失败** 为既有 `package.json` engines.dsh 与测试不一致，非 WP-2A 引入。
3. **未做** 真实 DSH 桌面端在线加载验收（WP-1.6 同限制）。
4. **未做** WP-2B～2E（未授权）。
5. 同 appId 双连接风险仍在后续真实验收时处理。

---

## 8. WP-2B 是否具备启动条件

**条件具备（代码层），但建议先满足：**

| 条件 | 状态 |
|---|---|
| 统一 Owner Gate + A1–A4 单测 | ✅ 已完成 |
| 两仓 typecheck/build | ✅ 通过 |
| origin 误用已消除 | ✅ |
| 真实隔离 DSH 在线加载验证 Gate | ⬜ 建议在 2B 第一项做（验证 tools 可见 + Gate 行为） |
| 独立测试 Bot + 独立 Vault | ⬜ 2B 验收必需 |

**判断：** 具备启动 **WP-2B** 的代码前提；正式 2B 验收仍需隔离运行时与专用测试 Bot（不自动进入，等你批准）。

---

## 9. 架构裁定落实情况

| 裁定 | 落实 |
|---|---|
| live qqbotContext 为主 | ✅ `classifySessionProvenance` 优先 live source |
| 不依赖 origin='qqbot-merge' | ✅ 已删除写入 + A1 实测拒绝 |
| 不能证明 QQ ≠ 可信 PC | ✅ `knownQqSession` 且无 live → `qq-missing` → deny |
| 无效 origin 不得证明 PC | ✅ 不再读取 origin 做放行 |
| 隔离验证后再改实现 | ✅ 先 A1 实测，再改 Gate/删 origin |

---

**最终状态：`WP2A COMPLETED`**  
停止于此，等待审查；**不**自动进入 WP-2B。
