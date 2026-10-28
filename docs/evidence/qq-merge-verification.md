# 连续消息智能合并：验收证据（隔离宿主 A/B）

| 项 | 值 |
|---|---|
| 验证时间 | 2026-10-28 12:02–12:08 +08:00 |
| 宿主 | DSH Desktop **0.2.1-rc.3**（`dsh.cmd --version` → `0.2.1-rc.3`），真实 CLI 进程 + 真实 web 服务 |
| 隔离根 | `D:\dsh-memory-vault\.scratch\merge-e2e-home`（独立 `DSH_HOME`，不触碰真实 profile） |
| 被测 Memory Vault | `dsh-longterm-memory-0.1.6.tgz`（含本次「连续消息智能合并」控制面；验证后随 0.1.6 发布） |
| 被测扩展 | `dsh-qqbot-merge-0.1.0.tgz`（`extensions/dsh-qqbot-merge`，282 files / 1,109,795 B） |
| 真实桌面应用 | 未重启、未替换插件、未改 profile（真实 QQ Bot 仍运行官方 0.5.3） |

## 1. 两个隔离 profile

| profile | bundles（除 base/web-app） | 用途 |
|---|---|---|
| `qqA` | `dsh-longterm-memory` + **`@tencent-connect/dsh-qqbot@0.5.3`** | 复现当前真实状态：官方插件在跑、无扩展 |
| `qqB` | `dsh-longterm-memory` + **`dsh-qqbot-merge@0.1.0`** | 扩展在线：`qqbotMerge` 由运行中的扩展提供 |

两个 profile 都**没有配置 QQ 凭据**（避免用真实 `appId` 建立第二条网关连接），因此 QQ 侧处于
待绑定状态；这不影响本证据要证明的两件事：**服务是否存在**、**配置是否被运行期接收**。

启动命令（各自独立进程，端口由 `--port 0` 分配）：

```powershell
$env:DSH_HOME = 'D:\dsh-memory-vault\.scratch\merge-e2e-home'
& 'D:\dsh\resources\runtime\cli\bin\dsh.cmd' --profile qqA --no-open --port 0
# dsh web: http://127.0.0.1:49371/?token=…
& 'D:\dsh\resources\runtime\cli\bin\dsh.cmd' --profile qqB --no-open --port 0
# dsh web: http://127.0.0.1:64962/?token=…
```

## 2. profile A（官方 0.5.3）——必须显示 BLOCKED

```console
POST /dsh-longterm-memory/api/qqMerge
{"available":false,
 "reason":"当前运行的 QQ Bot 插件没有提供 qqbotMerge 服务：官方 @tencent-connect/dsh-qqbot 0.5.3 不注册
           任何 cordis 服务、也没有第三方扩展点，它的「合并」只是把新消息排队到当前轮结束后的下一轮
           （concurrencyGuard strategy=merge），不是非打断式 steering。要实现真正的连续消息智能合并，
           需要安装受支持的扩展包 dsh-qqbot-merge 并重启 DSH。",
 "officialVersion":"0.5.3"}

POST /dsh-longterm-memory/api/setQqMerge {"config":{"enabled":true}}
{"ok":false,"error":{"code":"unsupported",
 "message":"未连接到支持连续消息合并的 QQ Bot 扩展（qqbotMerge 服务不存在），本次修改不会被任何运行时读取，因此未保存。"}}
```

页面：`docs/evidence/12-qq-merge-blocked.png`，卡片文本存档
`docs/evidence/qq-merge-blocked-text.txt`。

- 卡片位置：「记忆联动」之后、「会话隔离与权限」之前（DOM 卡片顺序实测）。
- Badge：**未生效**；检测到官方版本 `0.5.3`；控件全部禁用；无保存按钮。
- 结论：**没有假开关**——扩展缺席时写配置被后端拒绝，不会悄悄存进 Vault 设置。

## 3. profile B（扩展在线）——服务真实注册、配置真实生效

```console
POST /api/qqMerge
{"available":true,"compatible":true,
 "status":{"contract":{"name":"qqbot-merge","version":1},
   "config":{"enabled":false,"windowMs":800,"maxBatchMessages":8,"maxBatchChars":4000,
             "scope":{"c2c":true,"group":false},"busyPolicy":"steer","replyMode":"single-message"},
   "applied":{"revision":0,"appliedAt":"2026-10-28T04:06:19.708Z","activeBatches":0,"pendingMessages":0},
   "runtime":{"steerSupported":true,
     "steerMechanism":"agent.steer(input)（DSH 0.2.1-rc.3 公开 Agent API：inbox next-step，不取消当前轮）",
     "integration":"dsh-qqbot 0.5.3 fork + concurrencyGuard urgentPredicate bypass + agent/turn-stopping 收尾并入",
     "streamingRevision":true,"note":"真实 QQ 端到端未验证…"},
   "counters":{"batchesMerged":0,"messagesSteered":0,"messagesFollowedUp":0,"messagesOverflowed":0,
               "steerFallbacks":0,"replyRewrites":0,"repliesCompleted":0,"batchesAborted":0},
   "lastBatch":null}}

POST /api/setQqMerge {"config":{"enabled":true,"windowMs":900}}
→ ok:true；config.enabled=true、windowMs=900；applied.revision 0 → 1；appliedAt 刷新
```

扩展把配置写进隔离 profile 的 `cordis.patch.yml`（真实磁盘证据）：

```yaml
- id: qqbot-merge
  config:
    qqbotMerge:
      enabled: true
      windowMs: 900
      maxBatchMessages: 8
      maxBatchChars: 4000
      scope:
        c2c: true
        group: false
      busyPolicy: steer
      replyMode: single-message
```

写盘触发 HMR 重载后再次 `qqMerge` 读回 `enabled=true / windowMs=900`。
注意：`applied.revision` 与 `appliedAt` 是**运行期实例**级证据，重载/重启后归零，不代表配置丢失。

页面：`docs/evidence/13-qq-merge-available.png`，卡片文本存档
`docs/evidence/qq-merge-available-text.txt`。Badge 为 **已启用** + **支持非打断式 steering**，
显示运行期能力、8 项计数与「最近一批合并」（空时明确「本页不伪造」）。

## 4. 回归与清理

- Memory Vault：`npm run build` / `tsc --noEmit` / `lint` 全通过；**vitest 46 files / 709 tests passed**。
- 扩展：`tsc -p tsconfig.json` 0 error；**vitest 17 files / 210 tests passed**；`npm pack` 282 files。
- 隔离宿主进程按 PID 停止（单独核对命令行含 `--profile qqA/qqB/qqv`），真实桌面进程
  （`--profile desktop`，端口 63908）**未被触碰**；隔离端口 49371 / 64962 / 52560 / 52592 / 52657 已关闭。

## 5. 明确未验证（BLOCKED）

真实 QQ 会话端到端（用户在同一任务执行期间连发多条消息 → 只收到一条持续修订的回复）。
原因：需要把扩展装到**正在运行的** QQ Bot profile 并重启 DSH，这属于用户明确保留的授权边界；
且同一 `appId` 不能同时建立两条 QQ 网关连接，无法与真实运行实例并行验证。
启用步骤与回滚见 [`docs/qq-merge.md`](../qq-merge.md) §7。

