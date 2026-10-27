# QQ 接入与长期记忆联动

> 一句话定位：本插件的「QQ 接入」页只做**状态展示 + 导航指引 + 联动策略 + 诊断**，
> 不重新实现 QQ 协议，不复制官方连接代码，也不替官方插件保管凭据。QQ 的连接、扫码、
> 网关与凭据全部由官方插件 `@tencent-connect/dsh-qqbot` 负责。

本文所有事实分三类标注：**已实测**（本机跑过，附命令/文件）、**依据源码**（读官方
0.5.2 tarball 或其实现）、**未验证**（不写断言）。证据主库是
[`docs/evidence/qq-official-plugin.md`](evidence/qq-official-plugin.md)（下称「证据文档」），
宿主版本与运行事实见 [`docs/compatibility.md`](compatibility.md) §12。

---

## 0. 结论速览

| # | 结论 | 依据 |
|---|---|---|
| 1 | 官方插件没有跨插件 API、没有 cordis 服务、没有导航 API，所以本插件**无法**「调用官方插件发消息/打开绑定页」 | 证据文档 §2.1、§2.3、§8.3 |
| 2 | 判断官方插件是否加载，**不能**用 `ctx.get('im-qqbot')`（永远 `undefined`）；只能用同源探针 `GET /qqbot/im-qqbot/bind`（200=已加载 / 404=未加载）或宿主 `pluginInventory/list` | 证据文档 §6.1、§6.2 |
| 3 | 官方只「验证」过 DSH `0.1.0-rc.8` / `0.2.0-rc.2`，**不含本机 `0.2.1-rc.3`**；宿主按 peer 范围会放行，但「能装 ≠ 官方验证」 | 证据文档 §5.1–§5.3 |
| 4 | QQ 会话识别**只能**靠用户在联动策略里声明的 `origin` / `agentPreset` / `cwd` 标记；没有声明就一律是「未识别来源」，绝不猜测 | `src/shared/qq-linkage.ts` §`classifyProvenance` |
| 5 | 官方插件内部知道私聊/群聊（`scope: c2c \| group`），但**不写进 DSH 会话 header**，因此本插件**无法区分私聊与群聊**，故不做「群聊隔离」这种假能力 | 证据文档 §2（导出面）+ 官方 `dist/session/session-manager.js:406-408,418-426` |
| 6 | AppSecret 由官方插件**明文**写入 `<profile>/cordis.patch.yml`；本插件不读取、不保存、不回显 AppSecret | 证据文档 §4.3 |
| 7 | 同 Profile / 独立 Profile / 配置不一致三种运行方式共享记忆的边界不同，见 §7；本插件**不自动修改任何 profile** | 本文 §7 |

---

## 1. 官方插件是什么（事实基线）

| 项 | 值 | 依据 |
|---|---|---|
| npm 包名 | `@tencent-connect/dsh-qqbot`（MIT，上游 <https://github.com/tencent-connect/dsh-qqbot>） | 证据文档 §1.1 |
| 最新版 | **0.5.2**（`dist-tags.latest`，2026-10-12T07:04:31Z；GitHub `main` 已到 0.5.3 但未发布） | 证据文档 §1.1、§5.1 |
| cordis entry 名 | `im-qqbot`（`package.json` 的 `dsh.bundle.patch` loader entry id；**不是** ctx 服务名） | 证据文档 §2.1 |
| 客户端 UI | **0.5.1 起才有**（`lib/client.js`、`dsh.client`、`exports["./client"]`）；0.1.0–0.5.0 只有终端二维码 | 证据文档 §3.1 |
| 设置页入口 | `settings.section`：`id:"qqbot"`、`order:7`、`label:"QQ 机器人"` | 证据文档 §3.2 |
| 右侧栏入口 | `sidebarRightTabs.register({id:"im-qqbot/bind", kind:"qqbot-bind"})` + `sidebar.right.pane.tab`（`key:"im-qqbot/bind"`） | 证据文档 §3.2 |
| 独立页面 / URL | **没有**。绑定页是客户端渲染的侧栏/设置面板，没有 HTML 页面路由 | 证据文档 §3.1 |
| 跨插件 API | **没有**。全包无 `ctx.provide` / `ctx.set` / Service 注册；`BindingService` 内部 `new` 且未导出 | 证据文档 §2.1 |
| 导航 API | **官方插件自身没有**：绑定页只是它自己的 slot，没有 `navigate/openPanel/selectPanel` 一类公共方法（宿主有通用导航，但见 §2 第 4 条的边界） | 证据文档 §2.3、§8.3；[`docs/evidence/dsh-host-0.2.1-rc.3.md`](evidence/dsh-host-0.2.1-rc.3.md) §3.4 |
| 对外状态面 | 仅 5 条注册在 `ctx.webServer` 上的 HTTP JSON 路由：`/qqbot/im-qqbot/bind`（GET）、`bind/refresh`、`bind/manual`、`bind/unbind`、`/qqbot/im-qqbot/config` | 证据文档 §2.2 |
| 安装 | `npx @deepseek-ai/dsh plugin --profile <profile> add @tencent-connect/dsh-qqbot` | 证据文档 §4.1 |
| 绑定方式 | 终端二维码（CLI）或应用内「设置 → QQ 机器人」/ 右侧栏「QQ 机器人绑定」面板扫码、手动填 `appId`/`appSecret` | 证据文档 §3.2、§4.2 |
| 必填配置 | `appId`、`appSecret`（也支持 env `QQBOT_APPID` / `QQBOT_SECRET`） | 证据文档 §4.3 |

> ⚠️ 官方 README 的安装示例用的是**独立 profile**（`--profile qqbot`）。装进现有
> `desktop` profile 走应用内「插件」页或 `plugin_manager`（与 CLI 同一安装机制），
> CLI 安装后需要**重启**才会让导航与 Host 状态一致。依据：证据文档 §4.1 的备注 +
> [`docs/compatibility.md`](compatibility.md) §9、§11。

---

## 2. 「QQ 接入」页做什么、不做什么

新页签是第 6 个一级页签，导航顺序：

```text
记忆总览 | 记忆检索 | 记忆管理 | 收件箱 | QQ 接入 | 设置
（英文界面：Overview | Search | Manage | Inbox | QQ access | Settings）
```

页面结构（5 张卡片，沿用现有 `Card` / `Button` / `Badge` / `Notice` / `KvList` 等控件）：

| 卡片 | 内容 |
|---|---|
| 1. 接入状态 | 探测官方插件是否已加载、绑定处在哪个 `phase`；给出「打开官方绑定页」的**文字指引**与未安装时的安装命令；已绑定时显示官方回显的非机密 `appId`；不伪造二维码、不显示任何 Secret |
| 2. 记忆联动 | 编辑 `mode`、`qqMarkers` / `trustedMarkers`（`origin` / `preset` / `cwd`）、`writeMode`、`allowTools`；展示四个执行点的实际注册状态与 `runtime.notes` |
| 3. 会话隔离与权限 | 用 `decideRead` / `decideWrite` 展示「当前策略下各类会话会得到什么结果」，并明说**私聊与群聊无法区分**；展示判定计数与最近样本 |
| 4. 记忆写入与收件箱 | 说明 QQ 会话沿用既有「提取 → 收件箱 → 人工确认」流程；显示待确认数量并跳转收件箱 |
| 5. 诊断 | 逐行列出探测 / RPC / 宿主 Profile / 能力 / 策略的真实状态（ok / warn / error / unknown + 依据） |
| 6. 安全与凭据 | AppSecret 明文落盘事实（只告诉用户文件位置，不读取）、本插件不接触凭据、官方包事实与「官方声明 ≠ 本机验证」 |

**明确不做的事**（都是能力边界，不是待办遗漏）：

1. **不实现 QQ 协议**：不建 WebSocket、不扫码、不缓存 token、不发消息。
2. **不复制官方连接代码**：不 import 官方包、不调用其内部模块。
3. **不伪造二维码**：二维码由官方插件宿主侧生成 SVG 经状态路由返回，本插件不生成。
4. **不跳转官方绑定页**：宿主本身有通用导航能力（`ctx.layout.selectPanel(key)` 可打开
   main 页；`ctx.sidebarRight.openTab(kind)` 只在有「在屏会话」时可用；设置页分区**没有**
   公开打开 API）。但官方绑定 UI 是它自己的 `settings.section` 与右侧栏 Tab，第三方
   无法可靠选中/打开（见 [`docs/evidence/dsh-host-0.2.1-rc.3.md`](evidence/dsh-host-0.2.1-rc.3.md)
   §3.1–§3.4）。因此页面只给准确指引（应用内「设置 → QQ 机器人」，或右侧栏
   「QQ 机器人绑定」），不做一个时好时坏的跳转按钮。
5. **不读/不存/不回显 AppSecret**：见 §6。

页面与后端的关系：页面上的策略预览与宿主端真正执行**共用同一套纯函数**
（`src/shared/qq-linkage.ts`），因此「页面显示会拦截」与「后端真的拦截」不可能不一致。

---

## 3. 如何检测官方插件（探针语义与证据）

### 3.1 同源探针 `GET /qqbot/im-qqbot/bind`

| 响应 | 含义 | 页面结论 |
|---|---|---|
| `200` + JSON `{phase:"bound", appId}` | 官方插件**已加载且已绑定** | 已绑定 |
| `200` + JSON `{phase:"waiting", url, qrSvg?, issuedAt}` | 已加载，等待扫码 | 已加载未绑定 |
| `200` + JSON `{phase:"starting"}` / `{phase:"saving"}` | 已加载，正在启动 / 正在保存凭据 | 已加载未绑定 |
| `200` + JSON `{phase:"failed", reason}` | 已加载，但绑定/连接失败 | 连接异常 |
| `404` | 路由不存在 = **未安装或未加载**（也可能是该 profile 没有 `webServer`） | 未安装 / 未加载 |
| 其它（`401`、超时、非 JSON） | 认证层拦截、服务不可达或响应不可解析 | **无法确认**（不猜） |

依据：路由只在插件 `apply()` 中注册，未绑定与已绑定两种 fiber 都会注册（证据文档
§6.2 来源 #2）；`phase` 取值与 wire 类型见证据文档 §2.2；客户端每次加载、页面可见时
3 s、隐藏时 5 s 轮询它，非 2xx 退避 30 s（证据文档 §3.3）。

本插件的探针是**同源 `fetch` + `AbortController` 4 s 超时**（`src/client/qq-channel.ts`
的 `probeOfficialChannel()`）：只解析 `phase`；`bound` 状态另取官方状态响应里回显的
`appId`（**非机密**，仅作诊断展示）。不读取 `qrSvg` / `url` 的内容，也不带任何凭据。
探测结论只有五类：`bound` / `unbound` / `not-loaded` / `failed` / `unknown`——不会把
「不知道」说成「没安装」或「已连接」。**本机实测**：`GET http://127.0.0.1:<port>/qqbot/im-qqbot/bind`
→ `404`，同端口 `GET /` → `401`（服务存活、路由不存在），见证据文档 §6.2、§7。
**`200` 分支未在本机实测**（本机未安装官方插件），已在 §9 记为未验证项。

### 3.2 为什么不能用 `ctx.get('im-qqbot')`

官方插件**不注册任何 cordis 服务**（全包无 `ctx.provide` / `ctx.set`），所以
`ctx.get('im-qqbot')` / `ctx.get('dsh-qqbot')` 在它**已安装且已加载**时同样返回
`undefined`。用「取不到服务」推断「没装」是错误结论——这是本条最重要的否定结论
（证据文档 §2.1、§6.1）。

### 3.3 其它判据及为什么没有采用

| 判据 | 结论 | 原因 |
|---|---|---|
| 宿主 `pluginInventory/list` | **已接线，作为 404 的交叉验证判据** | Host 侧 `ctx.get('pluginInventory').list()`；Client 侧 `inject: ['remote', 'remote.pluginInventory']` 后 `ctx.remote.pluginInventory.list()`（返回 `{ok, value:{entries}}`），见 [`docs/evidence/dsh-host-0.2.1-rc.3.md`](evidence/dsh-host-0.2.1-rc.3.md) §4.2–§4.3。判据是 `moduleName === '@tencent-connect/dsh-qqbot'` 或 `entryId === 'im-qqbot'`，并读 `enabled` / `fiberPhase`。**本机已实测可用**（见 §3.4 与 [`docs/evidence/qq-verification.md`](evidence/qq-verification.md)） |
| profile 静态清单（bundles / `node_modules` / lockfile） | 仅作**辅助** | 只能证明「装没装」，不能证明「加载成功 / 已启用」（证据文档 §6.2 来源 #3） |
| 客户端 slots 标识 | 不采用（本页未接线） | 宿主确有公开枚举能力（`ctx.slots.entries(key)`，可查看 `settings.section` 的 `id:"qqbot"`、`sidebar.right.pane.tab` 的 `key:"im-qqbot/bind"`），见 [`docs/evidence/dsh-host-0.2.1-rc.3.md`](evidence/dsh-host-0.2.1-rc.3.md) §1.2、§3.1。但它只能证明**客户端半边**已注册，不能证明宿主网关已启动；bind 探针同时覆盖 host 半边的加载状态，因此主判据仍是探针 |
| tools 注册（`qqbot_send_file`） | 不采用 | `qqbot_describe_image` 默认关闭、tools 服务缺失时都不注册，不能作主判据（证据文档 §6.2 来源 #5） |
| 安装日志 / 市场 discovery 缓存 | **禁止使用** | 历史日志非权威，本机该缓存检索 `qqbot` 为 0 命中（证据文档 §6.2） |

### 3.4 探针 + 插件清单的交叉验证（已实现）

单看 `404` 无法区分「没装」和「装了但没加载 / 被停用 / 该版本不注册状态路由」。因此
页面在探测之后再用宿主插件清单交叉验证一次（`src/client/host-inventory.ts`、
`src/client/qq-channel.ts` 的 `probeOfficialChannelDetailed()` / `refineOutcome()`）：

| 探针结果 | 插件清单结果 | 页面结论 |
|---|---|---|
| `404` | `state=absent`（清单里没有该包） | **未加载**，依据写明「已由插件清单确认未安装」 |
| `404` | `state=installed` / `disabled` | **无法确认**：路由缺失可能来自停用、加载失败或版本不注册路由，因此不宣称「未安装」 |
| `404` | 清单不可用 | **未加载**（沿用原始 404 语义，并说明清单不可用） |
| `200` 系列 | 任意 | 以官方 `phase` 为唯一结论，清单只作为附加事实行 |

插件清单只证明「装没装 / 启没启用 / 加载阶段」，**从不**被当作连接状态；连接状态
永远只来自官方插件自己的 `phase`。本机实测：清单返回 `state=absent`，页面显示
「未加载 / 清单中未找到」（见 [`docs/evidence/qq-verification.md`](evidence/qq-verification.md)）。

---

## 4. 兼容性：官方「已验证」≠ 本机「能跑」

### 4.1 官方声明原文

官方插件的 `package.json` → `dsh.compatibility`（0.5.1 / 0.5.2 相同，0.5.3 未发布的
`main` 也相同）：

```json
"dshReleases": {
  "0.1.0-rc.8": "compatible",
  "0.2.0-rc.2": "compatible"
}
```

note 原文要点：「0.1.0-rc.8 为 CLI（dsh web）已验证……0.2.0-rc.2 为 Desktop 内嵌运行时
已验证……宿主大版本升级后请重新验收席位行为」。这是**逐版本验证记录**，不是范围承诺
（证据文档 §5.1）。

### 4.2 本机宿主为什么仍会放行

| 环节 | 事实 | 依据 |
|---|---|---|
| 本机宿主版本 | **0.2.1-rc.3** | `D:\dsh\resources\app.asar` → `/dsh/package.json` 的 `version`；`D:\dsh\resources\runtime\primary-runtime\runtime.json` 的 `desktopVersion`（证据文档 §7；[`docs/compatibility.md`](compatibility.md) §12） |
| 是否在官方验证列表 | **不在**。0.2.1 线（比 0.2.0-rc.2 更新）未获任何声明 | 证据文档 §5.1 |
| 宿主安装/启动判定 | `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility` **只读 `engines.dsh`**，否则回退 `peerDependencies` 的 `@deepseek-ai/dsh*` 范围；**完全不读 `dsh.compatibility`** | 证据文档 §5.2 |
| 官方包的实际门槛 | 官方包**没有 `engines.dsh`** → 回退 peer 下限 `>=0.1.0-rc.6`；宿主用 `semver.satisfies(..., {includePrerelease:true})`，对 `0.2.1-rc.3` 实测为 `true` → 不产生 `pluginCompatibilityWarning` | 证据文档 §5.2（宿主自带 `semver@7.8.5` 实测） |
| 0.2.1 线已知风险 | 社区 issue **#60**（open，`qqbot_send_file` 在 0.2.1-rc.2 下失败）、**#58**（open，`settings-reader` 硬编码路径）；均为第三方报告、官方未修 | 证据文档 §5.3 |

### 4.3 结论

> **宿主 0.2.1-rc.3 可以通过安装门槛（peer 范围放行），但官方未验证 0.2.1 线，且社区
> 有 open 回归报告。** 因此任何地方都**不要**写「官方声明兼容本机 0.2.1-rc.3」——
> 那是不成立的表述。正确表述是：「能装 ≠ 官方验证；席位行为需自行验收」。

本插件自身的 `engines.dsh` 只声明 0.2.1 这一条已实测的线（上界 `<0.2.2`），按同一
semver 语义**包含** `0.2.1-rc.3`（已用宿主自带 `semver@7.8.5` 复核，见
[`docs/compatibility.md`](compatibility.md) §12）；这是本插件与官方插件的两件事，
不要混为一谈。

---

## 5. 记忆联动（QQ ↔ 长期记忆）

### 5.1 设计原则

1. **默认零变化**：`mode: 'off'` 时本插件行为与「未接入 QQ」完全一致，升级不会改变任何
   既有用户的记忆注入结果（`DEFAULT_QQ_LINKAGE`）。
2. **判定与执行同源**：三种模式、四个执行点的决策全部来自
   `src/shared/qq-linkage.ts` 的纯函数（`classifyProvenance` / `decideRead` /
   `decideWrite` / `decideTools`）。页面用它们展示「若现在执行会怎样」，宿主端用它们
   做真正拦截。
3. **不猜来源**：没有配置任何标记时，所有会话都是「未识别来源」，QQ 策略不会命中
   任何会话；页面会明确提示这一点（`runtime.notes`）。
4. **安全收紧优先**：同时命中 QQ 标记与受信标记时，按 **QQ** 处理（宁可收紧）。

### 5.2 三种模式

| 模式 | 语义 | 常驻注入 / 每步检索 | QQ 会话写回 | QQ 会话记忆工具 |
|---|---|---|---|---|
| `off`（默认） | 完全不拦截，行为与未接入 QQ 相同 | 全部放行 | 沿用既有规则 | 全部放行 |
| `deny-qq` | 命中 QQ 标记的会话不读取记忆 | QQ 会话被拒绝；其余放行 | 由 `writeMode` 决定（默认 `inbox-only`） | 仅当 `allowTools: true` 时允许 |
| `allowlist` | 只有命中**受信标记**的会话才读取记忆 | 仅 `trusted` 放行；QQ 与未识别一律拒绝 | QQ 按 `writeMode`；**未识别**会话强制只进收件箱 | 仅 `trusted`；未识别与 QQ（除非 `allowTools`）拒绝 |

补充：

- `writeMode: 'inbox-only'`（默认）表示 QQ 会话产生的候选记忆**只进收件箱**，需要人工
  确认后才成为长期记忆；`writeMode: 'direct'` 才允许按既有规则直接落盘。
- `allowTools` 默认 `false`：QQ 会话默认不能调用 `memory_search` / `memory_get` /
  `memory_save` / `memory_forget`。
- 三种模式的判定都**只作用于会话**，不改变记忆文件、不迁移数据。

### 5.3 四个执行点（真正在哪里拦截）

| 执行点 | 宿主能力 | 本插件的行为 | 报告字段 / 计数器 |
|---|---|---|---|
| 常驻注入 `standing` | `ctx.systemPrompt.section({text})` | `decideRead` 拒绝时不注入常驻记忆块；**只有宿主把 `text` 以 `{agent, scope}` 调用时才能按会话区分** | `enforcement.standing`、`counters.standingBlocked`、`runtime.sessionAwareStanding` |
| 每步检索 `recall` | 可选 `enablePerStepRecall` 路径 | `decideRead` 拒绝时跳过每步检索 | `enforcement.perStepRecall`、`counters.recallBlocked` |
| 写回 `write` | `session/event` 的 `turn/end` 提取 | `decideWrite` 拒绝时把候选强制送收件箱，不直接落盘 | `enforcement.extraction`、`counters.writesForcedInbox` |
| 工具 `tools` | `ctx.tools.register` 的四个记忆工具 | `decideTools` 拒绝时工具对 QQ 会话不可用 | `enforcement.tools`、`registeredTools`、`counters.toolsBlocked` |

**诚实边界**：常驻注入能否按会话拦截，取决于宿主是否把提示词分区的 `text` 回调以带
会话上下文的形式求值。实现依据是宿主 `0.2.1-rc.3` 的 `systemPrompt.assemble({agent,
scope})` 会把同一 context 传给 `text`；宿主端只有在**运行时真的看到** `agent` 时才把
`runtime.sessionAwareStanding` 置为 true（`markStandingContextSeen()`），页面据此如实
显示。为 `false` 时必须说明「常驻注入无法按会话拦截，只能拦截每步检索与工具」。这是
运行时观测值，不是静态承诺；本机未做单独 E2E 验收（见 §9.2）。

### 5.4 QQ 会话如何被识别（只能靠标记）

可匹配的会话 header 字段只有三个（`SessionMarkers`）：

| 标记 | 匹配字段 | 匹配规则 |
|---|---|---|
| `origins` | `session.header.origin` | 精确字符串相等 |
| `presets` | `session.header.agentPreset` | 精确字符串相等 |
| `cwds` | `session.header.cwd` | 绝对路径；Windows 下大小写不敏感，忽略尾部分隔符 |

判定顺序：先匹配 QQ 标记 → 再匹配受信标记 → 都不命中则是 `unidentified`。页面会展示
命中种类（`origin` / `preset` / `cwd`）与命中值，便于核验。

**哪些值值得填**（都来自官方插件可配置项，见证据文档 §4.3）：

- `presets`：在官方插件配置里设置专用 `preset`（如 `qq`），所有 QQ 会话的
  `agentPreset` 都会带上它——这是最稳定的标记。
- `cwds`：在官方插件配置里设置专用 `cwd`（如 `C:\qq-workspace`）。⚠️ **不要**依赖
  默认值：官方默认 `cwd = config.cwd || process.cwd()`，即宿主进程 cwd，不是可靠标记。
- `origins`：若某宿主为 QQ 会话写入 `origin`，可填该值；本插件不假设它一定存在。

> 为什么只能靠标记：官方插件创建 DSH 会话时只写 `meta: { cwd, ...(agentPreset) }`
> （fork 出的子会话另带 `parentSession`/`seedLength`），**不写来源/渠道字段**
> （官方 `dist/session/session-manager.js:239-243`、`:406-408`，证据文档 §2.3 的挂载点
> 列表亦无来源写入）。因此「哪些会话来自 QQ」只能由用户显式声明。

### 5.5 私聊与群聊目前无法区分（受限模式）

官方插件**内部**是知道会话类型的：它的内存记录里有 `scope: 'c2c' | 'group'` 与
`peerId`（`session-manager.js:418-426`），并按 scope 注入自己的提示词段
（`:63-76`）。但：

1. 这些信息只存在于官方插件自己的进程内记录，**不写入 DSH 会话 header**；
2. 本插件能观察到的只有会话 header 与工具执行上下文。

所以**本插件无法区分 QQ 私聊与 QQ 群聊**。页面把这一点写死，不提供「按群聊隔离」这种
看起来有、实际做不到的开关。当前能力边界：**所有 QQ 会话（私聊 + 群聊）作为一个整体
被策略处理**；`deny-qq` / `allowlist` 作用于这个整体。未来若官方版本把会话来源写入
header，需要重新核验后才会增加更细的隔离。

### 5.6 写回与收件箱

QQ 会话的候选记忆走**与桌面会话完全相同的既有流程**：`turn/end` → 规则提取 →
去重/冲突判定 → 自动执行或进收件箱。`inbox-only` 由**后端强制**，不是只把界面开关
藏起来；页面上的「待确认数量」与「跳转收件箱」按钮只是入口。被强制送收件箱的次数
计入 `counters.writesForcedInbox`，用于证明策略确实在跑。

---

## 6. 凭据与安全边界

### 6.1 官方插件：AppSecret 明文落盘

- 安装后必填 `appId` / `appSecret`（或 env `QQBOT_APPID` / `QQBOT_SECRET`）。
- 扫码或手动绑定成功后，官方插件把凭据写进 **`<profile>/cordis.patch.yml`**：
  `persistCredentialsToProfile()` 取 `resolve(dir, 'cordis.patch.yml')`，把
  `{id:'im-qqbot', config:{appId, appSecret}}` 用 `yaml.dump` **整份写回**，文件头注释
  「QQ 机器人凭据（扫码绑定自动生成）」。
- **没有**走 `@deepseek-ai/dsh-credentials`，**没有**系统密钥库 / 加密 / 脱敏；全包检索
  `dsh-credentials|credentials.yaml|keychain|safeStorage` 无命中。HTTP 层不泄露 secret
  （状态响应只含 `appId`，`GET /qqbot/im-qqbot/config` 显式剔除 `appSecret`），但
  **明文落盘是事实**。

依据：证据文档 §4.3（含 `dist/setup/persist.js:18-57` 等行号）。

### 6.2 本插件：不读取凭据、不保存凭据、不显示 AppSecret

| 行为 | 本插件 |
|---|---|
| 读取 `cordis.patch.yml` 中的凭据 | ❌ 不读取 |
| 保存 / 搬运 / 备份凭据 | ❌ 不做 |
| 展示 `appId` / `appSecret` | `appId` 仅在「已绑定」状态作为**非机密**诊断信息显示（官方状态响应本身只回传 `appId`）；`appSecret` 永不读取、永不显示，也没有 Secret 输入框 |
| 请求官方插件的配置/凭据路由 | ❌ 不请求；只读 `GET /qqbot/im-qqbot/bind` 的状态（不调用 bind/refresh/manual/unbind/config） |
| 生成或展示二维码 | ❌ 不做 |
| 打开官方绑定页 / 跳转 | ❌ 不做（宿主无可靠公开路径，见 §2 第 4 条），只给文字指引 |

**给用户的建议**（页面安全说明同款）：`<profile>` 目录含明文凭据，请按操作系统的
文件权限收紧；不要把该目录提交进任何版本库或同步到不受控的位置。本插件不会替用户
写入或搬运凭据，也不会把「记住凭据」做成自己的功能。

> 注意：`appId` 不是机密，官方状态响应本身就会回传它，页面只在已绑定时显示用于核对；
> `appSecret` 则既不读取也不显示。本插件从不把这两项当作自己的配置项。

---

## 7. 同一 Vault 与 Profile 的三种运行方式

先明确两个独立概念：

- **Profile**：DSH 的安装/配置单元（`<DSH_HOME>/profiles/<name>`），决定「哪些插件
  被加载」。
- **Vault**：本插件的 Markdown 记忆仓库（`vaultPath`），决定「记忆存在哪」。

官方 QQ 插件运行在**某个 profile** 里；本插件也运行在**某个 profile** 里。二者可以
在同一个 profile，也可以在不同 profile。共享记忆的前提是**两边都加载本插件，且
`vaultPath` 指向同一个目录**。

> 补充事实：未显式设置 `vaultPath` 时，本插件的发现逻辑在用户 `Documents` 下找/建
> `DSH Memory`（`src/host/core/discover.ts` 的 `DEFAULT_VAULT_FOLDER`），**不在 profile
> 目录内**。因此两个 profile 若都不配置 `vaultPath`，默认会落到同一个 Vault（跨
> profile 共享）；只有显式配了不同路径才会分叉。不要依赖「profile 隔离就自动隔离
> Vault」这一错误直觉。

### 7.1 模式 A：同一 Profile（QQ 会话与桌面会话在同一个 profile）

- **安装**：本插件与官方 QQ 插件装进**同一个** profile 即可；无需第二份本插件。
- **共享**：QQ 会话与桌面会话**共用同一份记忆**——同一个 Vault、同一套索引、同一套
  提取与收件箱。这是默认且最简单的做法。
- **联动策略有意义**：因为共用一个进程/一份 Vault，`deny-qq` / `allowlist` 才能把
  「QQ 会话」从读取里排除出去；策略靠 §5.4 的标记识别。
- **并发**：同一 Host 进程内由既有的 `MemoryService` 协调，写入走既有原子写与 journal，
  不新增并发面。
- **限制**：QQ 会话与桌面会话**共享同一份记忆**意味着——在 `off` 模式下，QQ 会话能
  读到桌面会话写下的记忆（这正是为什么建议至少用 `deny-qq` 或 `allowlist`）；反过来
  桌面会话也能看到 QQ 会话产生的记忆。

### 7.2 模式 B：独立 Profile（QQ 用独立 profile，但共用同一个 Vault）

- **安装**：在 **QQ 的 profile** 里**单独安装本插件**（本插件不会自动安装、也不改任何
  profile 配置）。同时官方 QQ 插件装在该 profile。
- **共享**：把两边的 `vaultPath` 配到**同一个 Vault 路径**，即可共享同一份记忆。
- **并发**：两个 DSH 进程（桌面 profile + QQ profile）可能同时写同一批文件；安全性
  **依赖既有的 journal、原子写、按文件锁与乐观 checksum**（本插件的既有机制，不因 QQ
  而改变）。跨进程同时改同一条记忆仍可能得到「写入冲突 / 需重载」的结果——这是既有
  设计，不是 QQ 特有缺陷。
- **配置独立**：两个 profile 的 QQ 联动策略（模式、标记、写回方式）各自保存、互不
  影响；需要分别配置。
- **本插件不做的事**：不自动修改任何 profile（不写 `cordis.patch.yml`、不改
  `plugin` 清单、不创建 profile）；不搬运凭据；不合并两个 Vault。

### 7.3 模式 C：配置不一致（各自独立 Vault）

- **情形**：只在其中一个 profile 装了本插件；或两边 `vaultPath` 指向不同目录；或其中
  一边指向了另一个盘/另一台机器上的路径。
- **结果**：两个 Vault **互不共享**。QQ 会话看到的记忆与桌面会话看到的记忆是两套，
  各自独立提取、独立收件箱、独立 journal。
- **这不是 bug，而是配置结果**：本插件不会「猜」用户想共享哪个 Vault，也不会跨 Vault
  合并数据。页面诊断区会显示本进程实际的 `vaultPath` 与 Profile 事实，便于对齐配置。

### 7.4 一眼结论

| 想达到的效果 | 需要做什么 | 当前是否支持 |
|---|---|---|
| QQ 与桌面共享同一份记忆、且 QQ 不读桌面记忆 | 同一 Profile + 本插件 + `deny-qq` / `allowlist` + 配置标记 | ✅ 支持（标记需正确填写） |
| QQ 与桌面共用 Vault，但跑在两个 Profile | 两边各装本插件 + `vaultPath` 指向同一目录 | ✅ 支持；并发依赖既有 journal/原子写，可能需人工处理冲突 |
| QQ 与桌面各用各的记忆 | 不同 `vaultPath`（或只在一侧装插件） | ✅ 自然结果（互不共享） |
| QQ 群聊与私聊分别隔离 | — | ❌ 不支持（官方不提供会话来源，见 §5.5） |
| 由本插件自动给 QQ profile 装插件 / 配 `vaultPath` / 搬凭据 | — | ❌ 不做（不自动修改任何 profile） |

---

## 8. 诊断清单与故障排查

页面「诊断」卡片逐行给出真实结果，而不是一句「一切正常」：

| 检查项 | ok | warn | error / unknown | 依据 |
|---|---|---|---|---|
| 官方插件探测 | `200` + 可解析 `phase` | `404`（未安装/未加载） | 其它状态 / 超时 / 非 JSON → unknown | §3.1 |
| 后端 RPC | `qqLinkage` / `setQqLinkage` 返回报告 | 策略已启用但标记为空（不会命中任何会话） | RPC 失败 / 方法不存在 | `src/shared/protocol.ts` 的 `QqLinkageReport` |
| 宿主 Profile | 读到 `profile` / `profileDir` / `dshHome` | 部分环境变量缺失 | 全部未知 | 报告 `host` 字段 |
| 执行点能力 | 四个执行点均已注册 | `runtime.sessionAwareStanding = false`（常驻注入无法按会话拦截） | 工具/提取未注册（配置关闭） | 报告 `enforcement`、`runtime.notes` |
| 策略是否在跑 | 命中计数 > 0 且有会话样本 | 已启用但计数为 0（可能没有 QQ 会话，或标记不匹配） | 未启用（`mode: off`） | 报告 `counters`、`sessions` |

常见问题：

1. **探针一直 `404`，但我确实装了官方插件。**
   先确认它装在了**当前运行的这个 profile** 里；CLI 安装后需要重启；若该 profile 没有
   `webServer`（纯 CLI），探针不适用，页面只能显示「未加载」。不要用 `ctx.get` 复查。
2. **`200` 但 `phase: waiting`。**
   官方插件已加载、等待扫码。去应用内「设置 → QQ 机器人」或右侧栏「QQ 机器人绑定」
   面板完成绑定；本页不生成二维码。
3. **已绑定但 QQ 侧不回消息。**
   这是官方插件与宿主版本的问题域，不是本插件。0.2.1 线有 open 回归报告（#60/#58），
   见 §4.2；本插件无权也无法修它。
4. **策略已启用，但 QQ 会话照样读到记忆。**
   检查 §5.4：`qqMarkers` 是否为空（空则没有会话会被识别为 QQ）；`presets`/`cwds` 是否
   填了真实值；若诊断显示 `runtime.sessionAwareStanding = false`，则常驻注入无法按会话
   拦截，只能拦每步检索与工具。
5. **想按群聊隔离。**
   当前不支持（§5.5），页面不会提供假开关。
6. **QQ 和桌面的记忆对不上。**
   对照 §7：多半是 Profile / `vaultPath` 配置不一致；诊断区显示本进程的 `vaultPath`
   与 Profile 事实，先对齐再谈共享。

---

## 9. 证据、未验证项与变更点

### 9.1 证据

| 事实 | 证据位置 |
|---|---|
| 官方插件版本、导出面、客户端 UI、绑定路由、凭据落盘、兼容声明、检测方式 | [`docs/evidence/qq-official-plugin.md`](evidence/qq-official-plugin.md) §1–§6 |
| 本机宿主版本 0.2.1-rc.3、官方插件未安装、探针 404、服务存活 | 同证据文档 §7 |
| **本页在真实宿主上的验收**（构建产物 + 隔离 Profile + 真实浏览器、RPC、持久化、截图） | [`docs/evidence/qq-verification.md`](evidence/qq-verification.md) |
| 本插件 `engines.dsh` 对 0.2.1-rc.3 的 semver 结果、本插件在该宿主上真实加载 | [`docs/compatibility.md`](compatibility.md) §12 |
| 三种模式 / 四个执行点 / 标记判定 / 默认值 | `src/shared/qq-linkage.ts`（唯一实现来源） |
| 报告结构（`QqLinkageReport` / `counters` / `sessions` / `host`） | `src/shared/protocol.ts` |
| 官方会话只写 `meta.cwd` / `agentPreset`、scope 不写入 header | 官方 0.5.2 `dist/session/session-manager.js:239-243, 406-408, 418-426, 63-76` |
| 宿主导航能力、跨插件探测（`pluginInventory`）、Profile 与默认 Vault 发现、`engines.dsh` 判定 | [`docs/evidence/dsh-host-0.2.1-rc.3.md`](evidence/dsh-host-0.2.1-rc.3.md) §1–§6（代码级静态核实，未真机 HTTP） |

### 9.2 未验证项（不作为断言）

1. **官方插件探针 `200` 分支**：本机未安装官方插件，只实测了 `404` 与「服务存活」。
2. **官方插件在 0.2.1-rc.3 上的实际运行**：本机未安装、未运行；只有社区 issue 报告。
3. **常驻注入的按会话拦截**：取决于宿主 `text` 回调是否携带会话上下文；本机未单独
   验证，页面以 `runtime.sessionAwareStanding` 如实显示为准。
4. **`pluginInventory/list` 的次要分支**：客户端可用性已在真机实测（隔离宿主上返回
   `{entries:[…]}`，页面据此把 404 修正为「清单确认未安装」），但「清单显示已安装而探针
   仍 404」这一分支**没有真实环境可复现**（本机未装官方插件），只有单元测试覆盖
   （`tests/unit/qq-channel.test.ts`）。
5. **「QQ 接入」页的端到端验收**：已在隔离宿主（DSH 0.2.1-rc.3 + `npm pack` 产物）上用
   真实 Chrome 完成：导航六项顺序、6 张卡渲染、既有 5 个页签切换、RPC 回路、配置持久化
   与非法值拒绝；证据见 [`docs/evidence/qq-verification.md`](evidence/qq-verification.md)
   与 `docs/evidence/07-…11-qq-*.png`。**未**在真实 `desktop` profile 的桌面窗口内截图
   （运行同一构建产物，但需重启桌面应用才会加载新宿主代码）。
6. **官方 0.5.3（未发布）**：`main` 与本机 0.5.2 的兼容字段一致，但未发布版本不作为依据。

> 宿主证据文件 `docs/evidence/dsh-host-0.2.1-rc.3.md` 是**代码级静态核实**（明确未做
> 真机 HTTP），本文「本插件在 rc.3 上真实加载」的 200 响应是本机 HTTP 实测
> （见 [`docs/compatibility.md`](compatibility.md) §12），两者互补、不要互相替代。

### 9.3 本文对应的代码契约

| 文件 | 作用 |
|---|---|
| `src/shared/qq-linkage.ts` | 配置形状、默认值、会话事实读取、来源判定、四个执行点决策、运行时说明 |
| `src/shared/protocol.ts` | `qqLinkage` / `setQqLinkage` 两个 RPC、`QqLinkageReport` 及 `QqEnforcementReport` / `QqLinkageCounters` / `QqSessionSample` / `QqHostFacts` |
| `src/host/qq/linkage.ts` | 宿主端 `QqLinkageRuntime`：四执行点判定、`sessionAwareStanding` 观测、计数器、会话样本、报告 |
| `src/host/core/service.ts` | 持有运行时并暴露 `qqLinkage()` / `setQqLinkage()`；配置合并与校验 |
| `src/client/qq-channel.ts` | 同源探针（4 s 超时）+ 探针与插件清单的交叉修正 + 诊断 / 隔离矩阵的纯函数 |
| `src/client/host-inventory.ts` | 可选宿主桥：`remote.pluginInventory.list()` 的归一化与「装没装/启没启用」判定 |
| `src/client/views/qq.tsx` | 「QQ 接入」页签的 6 张卡片 |

> 安全默认值（升级即生效、无需迁移）：`mode: 'off'`、`writeMode: 'inbox-only'`、
> `allowTools: false`、`qqMarkers` / `trustedMarkers` 为空。也就是说，**不做任何配置时，
> 本插件的行为与未接入 QQ 时完全相同**。
