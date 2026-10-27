# QQ 接入（0.1.5）真机验证记录

| 项 | 值 |
|---|---|
| 验证时间 | 2026-10-27 13:27–13:43 +08:00 |
| 宿主 | DSH Desktop **0.2.1-rc.3**（`dsh.cmd --version` → `0.2.1-rc.3`） |
| 运行方式 | 隔离 `DSH_HOME`：`D:\dsh-memory-vault\.scratch\qq7-home`，profile `qqv`，`--no-open --port 0` |
| 被测物 | `npm pack` 产物 `dsh-longterm-memory-0.1.5.tgz`（安装进隔离 profile，不是 `link:` 开发链接） |
| Vault | `D:\dsh-memory-vault\.scratch\qq7-home\vault\DSH Memory`（隔离，不触碰真实 Vault） |
| 浏览器 | Chrome headless（`scripts/ui-verify.mjs`，CDP） |
| 未做 | 安装/绑定真实 QQ 机器人；写真实 `desktop` profile；任何 AppSecret 操作 |

> 说明：本文件只记录**实际执行过**的验证。官方 `bind` 路由的 `200` 分支因本机未安装
> 官方插件而没有实测，已在 `docs/qq-integration.md` §9 记为未验证项。

---

## 1. 构建与测试门禁

```console
$ npm run build
build-client: wrote D:\dsh-memory-vault\lib\client.js (270010 bytes, id dsh-longterm-memory)

$ npm run typecheck      # tsc --noEmit：0 error
$ npm run lint
lint: OK (51 source files checked)
version consistency: OK (0.2.1-rc.3 in >=0.2.1-rc.3 <0.2.2)

$ npx vitest run
Test Files  45 passed (45)
Tests       695 passed (695)
```

> 695 = 既有 595 + QQ 联动新增 93（`tests/unit/qq-linkage.test.ts` 52、
> `tests/integration/qq-linkage-service.test.ts` 27、
> `tests/integration/qq-injection-guard.test.ts` 14）+ 本次补的
> `tests/unit/qq-channel.test.ts` 7。

## 2. 隔离宿主的 RPC 回路（真实 HTTP，不是 mock）

登录同源会话后（`GET /?token=…`，用 cookie 保持认证），POST 插件自己的路由：

```console
POST /dsh-longterm-memory/api/status      → ok:true, vault = …\.scratch\qq7-home\vault\DSH Memory
POST /dsh-longterm-memory/api/qqLinkage   → ok:true
     host.profile = "qqv"        host.profileSource = "module-path"
     config.mode  = "off"        runtime.enforcing  = false
     enforcement: standing=true  extraction=true  tools=true  perStepRecall=false
     registeredTools = memory_search, memory_get, memory_save, memory_forget
POST /dsh-longterm-memory/api/setQqLinkage {"mode":"deny-qq","qqMarkers":{"origins":["qq"]}}
     → ok:true, runtime.qqIdentifiable = true
     → 落盘：<vault>\.dsh-memory\config.json 的 settings.qqLinkage.mode = "deny-qq"、origins = ["qq"]
POST /dsh-longterm-memory/api/setQqLinkage {"mode":"nonsense"}
     → ok:false, error.code = "invalid-request"（原配置不被破坏）
POST /dsh-longterm-memory/api/setQqLinkage {"mode":"off", markers:[]}  → ok:true（还原）
```

**结论**：新 RPC 在真实宿主上可用；配置走既有 Vault 设置持久化机制；非法值在边界被拒。

## 3. 页面与导航（真机浏览器）

| 断言 | 结果 |
|---|---|
| 侧边栏点击「长期记忆」后渲染管理页（`.lmv-page`） | ✅ |
| 顶部导航顺序 | ✅ `记忆总览 \| 记忆检索 \| 记忆管理 \| 收件箱 \| QQ 接入 \| 设置` |
| 点「QQ 接入」后渲染 6 张卡 | ✅ 接入状态 / 记忆联动 / 会话隔离与权限 / 记忆写入与收件箱 / 诊断 / 安全与凭据 |
| 既有 5 个 Tab 切换仍正常（各页 `.lmv-main` 均挂载） | ✅ 记忆总览、记忆检索、记忆管理、收件箱、设置 |
| 切回「QQ 接入」 | ✅ |
| 页面切换不触发重新索引 | ✅ 只调用 `qqLinkage` 读取报告与一次只读探针，没有 `rebuildIndex` / `syncIndex` |

### 3.1 接入状态（官方插件未安装的真实场景）

页面实际文本（`docs/evidence/qq-page-text.txt` 摘录）：

```text
接入状态
未加载
探测地址: /qqbot/im-qqbot/bind
探测时间: 2026-10-27 13:40
同源 GET /qqbot/im-qqbot/bind 返回 404，且宿主插件清单确认未安装（宿主插件清单中没有 @tencent-connect/dsh-qqbot。）。
官方插件未安装，或未在本 Profile 启用（探测路由只在插件加载时注册）。
phase            未知
插件清单         清单中未找到
Profile          qqv
如需接入，请先在本 Profile 安装官方插件，安装后重新打开本页：
npx @deepseek-ai/dsh plugin --profile qqv add @tencent-connect/dsh-qqbot
```

诊断区同时给出六行真实结果：插件探测（需注意）/ 后端 RPC（正常）/ 宿主 Profile
（正常，`Profile 依据 = 插件安装路径（最可信）`）/ 能力（3–4 个执行点已注册）/ 策略是否
在跑（`mode=off`，不拦截）/ 插件清单（`state=absent`）。

## 4. 联动执行点（代码级 + 集成测试）

| 执行点 | 验证方式 | 结果 |
|---|---|---|
| 常驻记忆注入 | `tests/integration/qq-injection-guard.test.ts`：假 `ctx.systemPrompt` 捕获 `text(context)`，QQ 上下文 → `''`，桌面上下文 → 既有文本 | ✅ |
| 每步检索 | 同上（guard 在拼接任何消息前返回 decision，连失效提醒也不追加） | ✅ |
| 写回 | `tests/integration/qq-linkage-service.test.ts`：`processTurn({forceInbox:true})` → `applied=[]`、候选只在收件箱；对照实验证明差异只来自 `forceInbox` | ✅ |
| 模型工具 | 同上：`memory_search` 在 QQ 会话上下文被拒，桌面会话正常 | ✅ |
| 计数与样本 | `service.linkage` 的四点计数分别增长；无 sessionId 不写样本 | ✅ |

未在真机上跑到「真实 QQ 会话」的拦截计数，因为本机没有安装官方 QQ 插件、也没有真实
QQ 会话；这一点在 `docs/qq-integration.md` §9 已如实列为未验证项，不写成已实现。

## 5. 证据文件

| 文件 | 内容 |
|---|---|
| `docs/evidence/07-qq-tab-overview.png` | 记忆总览页 + 新导航（QQ 接入在设置前） |
| `docs/evidence/08-qq-access.png` | 「QQ 接入」页顶部：接入状态 + 记忆联动 |
| `docs/evidence/09-qq-isolation.png` | 会话隔离与权限（私聊/群聊不可区分的说明、判定矩阵、计数） |
| `docs/evidence/10-qq-diagnostics.png` | 诊断六行 + 宿主事实 + 三种 Vault/Profile 模式 |
| `docs/evidence/11-qq-security.png` | 安全与凭据（AppSecret 边界、官方兼容性） |
| `docs/evidence/qq-page-text.txt` | 整页文本（3200 字），便于 grep 复核 |

## 6. 复现命令

```powershell
# 1) 构建 + 打包
npm run build
npm pack

# 2) 隔离 DSH_HOME 并安装（不要用 $home，那是只读自动变量）
$verifyHome = "D:\dsh-memory-vault\.scratch\qq7-home"
$env:DSH_HOME = $verifyHome
& "D:\dsh\resources\runtime\cli\bin\dsh.cmd" plugin --profile qqv add ".\dsh-longterm-memory-0.1.5.tgz"

# 3) 启动（记下打印的 URL/token）
& "D:\dsh\resources\runtime\cli\bin\dsh.cmd" --profile qqv --no-open --port 0

# 4) 浏览器验证（脚本见 .scratch/qq-final.mjs，使用 scripts/ui-verify.mjs 的 BrowserHarness）
node .scratch/qq-final.mjs
```

> 注意：`pnm add` 若提示 `ERR_PNPM_IGNORED_BUILDS koffi`，安装其实已完成；该提示会让
> `dsh plugin` 退出码为 1，因此 `dsh.profile.bundles` 可能需要手动补上
> `dsh-longterm-memory`（本次即如此，已在隔离 profile 内修正）。
