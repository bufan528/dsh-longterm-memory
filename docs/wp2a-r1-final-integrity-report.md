# WP-2A-R1-FINAL 交付完整性报告

状态：**核查通过（无需再改测试）**  
日期：2026-11-04  
范围：只读核查 R1 最终交付与一次 `String to replace not found`；**不**进入 WP-2B。

---

## 1. 替换失败裁定

### 裁定：**`ALREADY_SATISFIED`**

### 1.1 根因

| 项 | 内容 |
|---|---|
| 失败操作 | 对 `tests/integration/qq-injection-guard.test.ts` 中用例 **`installTools 把 Owner Gate + linkage 传到注册后的工具定义上`** 的文本替换 |
| 原意图 | 将 `qqbotContext: mockQqContext()` 改为 `mockQqContext({ qqOwnerId: null })`，使 `qq-unbound-installed` 走 **未绑定 DENY**（默认 mock 绑定 `owner-test` 时会 ALLOW，断言 `rejects` 会失败） |
| 失败原因 | 首次 `old_string` 过长且含 `rejects.toThrow` 段，与文件实际块不完全一致（模糊匹配截断在 `qqbotContext: mockQqContext(),`） |
| 后续处理 | 已用**更小、精确**的 `old_string` 成功写入 `mockQqContext({ qqOwnerId: null })` |

### 1.2 当前源码（真实结构）

`qq-injection-guard.test.ts` L477–L497：

```ts
it('installTools 把 Owner Gate + linkage 传到注册后的工具定义上', async () => {
  await enableDenyQq()
  const registered: ToolDefinition[] = []
  const ctx = fakeCtx({
    qqbotContext: mockQqContext({ qqOwnerId: null }),   // ← 目标状态已存在
    tools: { register: ... },
  })
  const result = installTools(ctx, service, service.linkage)
  expect(result.registered).toEqual(['memory_search', 'memory_get', 'memory_save', 'memory_forget'])
  await expect(
    search.execute({ query: 'PowerShell' }, { agent: agentFor('qq-unbound-installed', {}) }),
  ).rejects.toThrow(/refused/)                            // ← ALLOW/DENY 断言存在
})
```

**结论：** 目标测试已存在且断言实际 DENY（throw refused）；失败仅为中间态 `old_string` 不匹配，**无需再改**。

---

## 2. 最终工作区状态（只读汇总，未覆盖/未清理）

### dsh-qqbot-merge（dirty，含本轮与既有）

```
 M src/index.ts
 M src/session/session-manager.ts
 ?? src/identity/          （contract/service/store/pair-gate/session-registry + tests）
（另有既有 M 若干 transport/security 等，未动）
```

### dsh-longterm-memory

```
 M package.json                          （既有：engines.dsh rc.2，非本轮）
 M src/client/i18n.ts, views/qq.tsx      （既有 WP-1 UI）
 M src/host/dsh/inject.ts, routes.ts, tools.ts
 M src/shared/protocol.ts
 M tests/integration/qq-injection-guard.test.ts
 M tests/unit/dsh-adapters.test.ts
 ?? src/shared/owner-access.ts
 ?? src/host/owner-gate.ts
 ?? tests/unit/owner-access.test.ts
 ?? docs/wp2-cross-device-memory-design.md
 ?? docs/wp2a-delivery-report.md
 ?? docs/wp2a-origin-evidence.txt
 ?? docs/wp2a-r1-delivery-report.md
 ?? docs/wp2a-r1-sha256.txt
 ?? docs/wp2a-sha256.txt
```

未执行 `git reset` / `clean` / 覆盖式 checkout。

---

## 3. 八项权限测试是否真实存在（断言 ALLOW/DENY）

| # | 要求 | 测试位置 | 断言 |
|---|---|---|---|
| 1 | 服务缺失无可信 PC → DENY | `owner-access.test.ts`「R2: service missing」+ gate「R2: service missing → DENY」；`qq-injection-guard` standing/tools R2 用例 | `allowed=false` / 空串 / `throws refused` |
| 2 | 不在 KnownSessionRegistry → DENY | 「R1: NOT in registry → unknown → DENY」+ gate「not registered」+ integration「未登记 → DENY / forceInbox」 | DENY / inbox 非 active |
| 3 | 注册表损坏/读取失败 → DENY | 「registry unhealthy → DENY」；QQ `session-registry.test` corrupt/wrong-shape → `isHealthy false` | DENY + healthy=false |
| 4 | Unknown / Missing → DENY | 「missing provenance」「unknown platform」 | DENY |
| 5 | live context 消失 → DENY | 「A3: known QQ, live source gone」 | DENY |
| 6 | 解绑后旧 Session → DENY | 「A4: bound then unbound (live ownerId null)」 | DENY |
| 7 | 解绑后缓存上下文 → DENY | 同上：`getContext` **每次** `resolveOwner`（`service.ts`）；缓存 facts 的 `ownerId` 取自 live binding，解绑后为 null → 同 A4 断言 | DENY |
| 8 | 四条路径不能绕过 | **standing** `inject.ts:132/143`；**per-step** `:358`；**turn 写回** `:273`；**四工具** `tools.ts` `assertToolsAllowed`×4（176/281/359/466），均经 `createOwnerGate`，**永不返回 null 跳过** | 集成：standing 空串、turn forceInbox、tools throw |

### 生产 PC identity producer

- 源码检索 `platform: 'desktop'|'pc'|'local'|'trusted-pc'`：**src 下 0 处生产赋值**。
- 测试中的 `platform:'desktop'` 仅在 `mockQqContext` / 单测白名单中，**不得**视为生产能力。

---

## 4. 测试结果（最终工作区实测）

| 项 | 结果 | 性质 |
|---|---|---|
| QQ `npm test` | **443/443**（34 files） | 单元 |
| QQ `tsc --noEmit` | **0** | — |
| MV `owner-access` + `qq-injection-guard` | **57/57** | 单元+集成 |
| MV 全量 `npm test` | **736/738**；2 失败=既有 `engines.dsh` rc.2 vs 测试期望 rc.3 | 单元 |
| MV `typecheck` | **0** | — |

与 R1 报告一致（R1 报告中全量 736/738、QQ 443）。

---

## 5. SHA-256 一致性

对照 `docs/wp2a-r1-sha256.txt` **全部 10 条**与当前文件 **逐条一致**（无 DRIFT）：

| 文件 | SHA-256（前 16） | 一致 |
|---|---|---|
| `mv/src/shared/owner-access.ts` | `F86A9C215EEAAF2C` | ✅ |
| `mv/src/host/owner-gate.ts` | `1DDE687628B16CCB` | ✅ |
| `mv/src/host/dsh/inject.ts` | `0FFD99EFAE8E2C49` | ✅ |
| `mv/src/host/dsh/tools.ts` | `628CE084301A3923` | ✅ |
| `qq/src/identity/session-registry.ts` | `270C004C887C0E17` | ✅ |
| `qq/src/identity/service.ts` | `5B469EC108556C3D` | ✅ |
| `qq/src/identity/contract.ts` | `6BF18074E3EC4789` | ✅ |
| `mv/tests/unit/owner-access.test.ts` | `23D9C25C7C8CD735` | ✅ |
| `mv/tests/integration/qq-injection-guard.test.ts` | `AFA8537DA8BE18E0` | ✅ |
| `mv/tests/unit/dsh-adapters.test.ts` | `4C4F510254195FAC` | ✅ |

**R1 最终报告、测试结果、SHA-256 对应同一份最终文件状态。**

---

## 6. 本轮动作

- **只读核查** + **测试复跑** + **SHA 复核**  
- **未**再改源码/测试（裁定 ALREADY_SATISFIED）  
- **未**生产部署 / 生产凭据 / 生产 Vault / WP-2B  

---

**结论：交付完整，与 R1 报告一致。**  
停止；等待项目负责人审查。
