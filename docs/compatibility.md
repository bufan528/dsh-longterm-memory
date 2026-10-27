# 兼容性与冻结契约

## 1. 支持的 DSH 版本

| 项 | 值 | 证据 |
|---|---|---|
| 已验证的 DSH 版本 | **`0.2.1-rc.3`** | `app.asar` 内 `/dsh/package.json` 的 `version`；`D:\dsh\resources\runtime\primary-runtime\runtime.json` 的 `desktopVersion`（2026-10-27 实测，见 §12） |
| 本包 `engines.dsh` 声明 | `>=0.2.1-rc.3 <0.2.2`（只声明 DSH **0.2.1 线**；0.1.5 起下限随重新核验上移到 rc.3） | 宿主自带 `semver@7.8.5`：`>=0.2.1-rc.3 <0.2.2` 对 `0.2.1-rc.3`→true；`0.2.2`/`0.3.0`/`0.2.0-rc.2`→false |
| 安装器接受结果 | **exit 0，无 `pluginCompatibilityWarning`，无需版本豁免** | 隔离 profile `r9a` 真实安装 + 启动日志扫描（0 条警告；0.2.1-rc.2 时实测） |
| 官方包清单 | 236 个 `@deepseek-ai/*` 包 | `app.asar` 内 `node_modules/@deepseek-ai/` |
| 客户端 bundle 契约 | `window.__ModuleLoader__.load({id, factory})` | 87 个官方 `lib/client.js` 首行 |
| 平台 seed 模块表 | **11 个基线模块**（0.2.1-rc.3 复核；旧记录为 9 个，新增 `zod` 与 `@tanstack/react-virtual`） | `dsh-web-frontend/dist/assets/index-BXV-oxvX.js`（见 [`docs/evidence/dsh-host-0.2.1-rc.3.md`](evidence/dsh-host-0.2.1-rc.3.md) §1.6） |
| 宿主插件导出形态 | `apply` / `inject` / `name`（可选 `Config`） | `cordis-plugin-development/references/host-plugin.md:49-53` |

> ⚠️ **不要**把 `dsh.bundle`、`dsh.client`、`dsh.manifestVersion`、`dsh.compatibility`
> 当成「官方校验过的声明」：`dsh.manifestVersion` 与 `dsh.compatibility` 在已安装的
> `0.2.1-rc.2` 里**没有任何读取者**（grep 证明）。本包保留 `compatibility` 仅作人类
> 文档用途，运行时不生效。
>
> 但 **`engines.dsh` 是真正被读取的**（见 §2），因此它必须存在且正确。

## 2. 真正的安装硬门槛：`engines.dsh`

兼容性判断由 `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)`
执行，判定顺序是：

1. **优先读 `engines.dsh`**（必须是字符串）。存在时**只按它判定**；
2. 否则回退到 `peerDependencies` 中键名匹配 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的条；
3. 两者都没有 → 视为**未满足**（unmet），会给出 `pluginCompatibilityWarning`，并要求用
   `dsh plugin allow-version`（或插件管理器）授予**精确版本豁免**后才能安装/启动。

不匹配的后果：path/registry 安装被拒绝；tarball 安装回滚；已安装的在启动时跳过该 bundle。

**本包只声明 `engines.dsh` 为「DSH 0.2.1 线」**（当前字面量
`>=0.2.1-rc.3 <0.2.2`：下限锁在 0.2.1 的预发布号，上界 `<0.2.2`），不声明任何
`@deepseek-ai/*` peerDependency（`scripts/lint.mjs` 作为硬规则检查后者）。选择该范围的理由：

- 宿主实际版本 `0.2.1-rc.3` 必须满足（已用宿主自带 `semver@7.8.5` 验证为 `true`，见 §12）；
- 预发布范围的 SemVer 行为：只有当比较器带同样的 `major.minor.patch` 元组及预发布号时才匹配
  预发布版本，因此显式写 `>=0.2.1-rc.<n>` 而不是 `^0.2.0`（后者对 0.2.1 预发布版本为 `false`）；
- 上界 `<0.2.2` 表示**只声明 0.2.1 这一条已实测的线**，不把 0.2.2 / 0.3.x 纳入未验证的支持范围。

> **版本一致性检查的硬要求**：`scripts/check-version-consistency.mjs` 用**字符串子串**
> 校验「README 与本文的已验证版本一致、且出现在 `engines.dsh` 字面量里、且列在
> `dsh.compatibility.dshReleases` 中」。因此 `engines.dsh` 的字面量必须包含
> `0.2.1-rc.3`（例如 `>=0.2.1-rc.3 <0.2.2`），否则 `npm run lint` 会失败。

> 不要为了"能装上"而放宽这个范围：真实安装器（隔离 profile `r9a`）在 0.2.1 线范围内
> exit 0、无警告、无需豁免，已实测。

## 3. `package.json` 字段契约

| 字段 | 必需 | 本包取值 | 说明 |
|---|---|---|---|
| `name` | ✅ | `dsh-longterm-memory` | 见 §4 |
| `version` | ✅ | `0.1.0` | |
| `type` | ✅ | `module` | ESM |
| `exports["."]` | ✅ | `./lib/host/index.js` | Host half 入口 |
| `exports["./client"]` | `dsh.client` 存在时必需 | `./lib/client.js` | 缺失会让 `dsh.client` **抛错** |
| `exports["./package.json"]` | 建议 | ✅ | 插件管理器读取 |
| `exports["./locale/*.json"]` | 建议 | ✅ | 插件卡片的多语言文案 |
| `icon` | 建议 | `./icon.svg` | **顶层字段**，不是 `dsh.icon`；≤256 KiB |
| `meta.title` / `meta.description` | 建议 | ✅ | 插件管理器的卡片文案 |
| `dsh.bundle.patch` | ✅（否则不是 bundle） | `./cordis.patch.yml` | 字符串或有序字符串数组 |
| `dsh.client.platform` | `dsh.client` 存在时必需 | `web` | 必须是字面量 `"web"` |
| `dsh.client.inject` | 可选 | `["@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-locale"]` | **只是加载顺序**，不做校验；未知名字被静默跳过 |
| `dsh.client.external` | 可选 | 未使用 | 才真正产生模块图边与循环检测 |
| `dsh.client.immediately` | 可选 | `true` | 立即随应用批次加载 |
| `files` | ✅ | 见 package.json | 白名单；实测产出 46 文件 / 134 kB |

## 4. 包名冲突（重要）

任务书期望的包名 `dsh-memory-vault` **已被占用**：

| 字段 | 实际值 |
|---|---|
| name | `dsh-memory-vault` |
| latest | `0.1.5`（共 6 个版本，2026-08-14） |
| maintainer | `flymysql` |
| description | "Cross-session memory vault for DeepSeek Harness: remember / recall / forget tools, per-turn prompt injection, and a browser management page." |
| peerDependencies | `@deepseek-ai/dsh-*` `^0.1.0-rc.6` |
| `dsh.client.inject` | `["@deepseek-ai/dsh-client-runtime"]` |

两点关键事实：

1. 它是一个**同概念竞品**（remember/recall/forget + 每轮提示词注入 + 浏览器管理页）。
2. 它面向 **DSH 0.1.0-rc.6 世代**，而本机安装的是 **0.2.0-rc.2**；它声明的
   `@deepseek-ai/dsh-client-runtime` 在 `0.2.0-rc.2` 的包清单里**不存在**。按 §2 的
   门槛，它对当前安装很可能连安装都会被拒。

因此沿用该名字会让「可通过官方 Add plugin 流程安装」这句话变成假的。本仓库改用经
`npm view` 核实为 **E404（未占用）** 的名字：

| 候选 | `npm view` 结果 |
|---|---|
| `dsh-memory-vault` | 已占用（0.1.5） |
| `dsh-memory` | 已占用（0.1.0） |
| **`dsh-longterm-memory`** | **未占用** ← 采用 |
| `dsh-memory-vault-plugin` | 未占用 |
| `dsh-obsidian-memory` | 未占用 |
| `dsh-vault-memory` | 未占用 |

**没有发布任何包。** 如果将来你获得了 `dsh-memory-vault` 这个名字，只需改
`package.json` 的 `name` 与 `cordis.patch.yml` 里的 `name:` 两处：

```yaml
- insert:
    - id: longterm-memory
      name: dsh-memory-vault      # ← 与 package.json name 一致
```

## 5. 冻结的接口契约

以下接口在实现中被依赖，均已在已安装的 `0.2.0-rc.2` 中核实：

| 能力 | 真实接口 | 依据 |
|---|---|---|
| 左侧栏一级入口 | `ctx.slots.register({name:'sidebar.panellist', id, order, label}, Icon)` | `dsh-client-ui-sidebar/lib/client.js:503-506`；真实用例 `plugin-manager:3769`、`schedule:6804` |
| 独立主页面 | `ctx.slots.register({name:'main', key:<同 id>}, Page)` | `dsh-client-ui-layout/lib/client.js:609-612,118` |
| 入口点击 | 侧边栏自行调用 `ctx.layout.selectPanel(id)` | `dsh-client-ui-sidebar/lib/client.js:478-481` |
| 槽位注册生命周期 | `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))` | `practices.md:36` |
| 提示词分区 | `ctx.systemPrompt.section({name, order, text, interpolate})`，`text` 可为函数 | `dsh-system-prompt/lib/index.js:240-243,342` |
| 分区排序 | `HARNESS_IDENTITY:-1000 … TOOLS_SDK:5000 … HARNESS_SOURCE:10000 … DEPLOYMENT_PERSONA_SUFFIX:10200` | `dsh-system-prompt/lib/index.js:10-43`；本插件用 `9500` |
| 会话日志事件 | `ctx.on('session/event', (session, event) => …)` | `api-catalog.js:4134`；`turn/end` 在 `dsh-agent-loop:1027` |
| 模型工具 | `ctx.tools.register({name, description, parameters, output:{schema, render}, execute})` | `dsh-tools/lib/index.js:2878-2886`（`register` 只校验 `output`） |
| 支持的 JSON Schema 子集 | `type/oneOf/properties/required/additionalProperties/items/enum/const` + `description/title/default/examples` | `dsh-tools/lib/index.js:34-58,206` |
| 宿主 HTTP 路由 | `ctx.webServer.register({kind:'prefix'|'exact', path, handler})` | `dsh-better-sidebar/lib/index.js:8081` |
| 可信主机 | `ctx.webRuntime.trustedHosts` | `dsh-better-sidebar/lib/index.js:8012` |
| 可选服务注入 | `ctx.inject([...], (scoped) => …)`，服务缺失则回调不运行 | `practices.md:20` |
| 服务读取 | `ctx.get(name)` 返回 `undefined`，**不抛** | `cordis` 源码 |
| 生命周期 | `ctx.effect(fn, label)`，`fn` 可返回 disposer | `cordis/src/fiber.ts:77-80` |
| 安装 | `dsh plugin --profile <name> add <spec>`（自动登记 bundle） | `dsh --help`；本会话实测 |

### 5.1 明确**不存在**的接口（因此没有实现）

| 常见误设 | 事实 |
|---|---|
| `ctx.on('turn/end')` / `ctx.on('step/end')` / `ctx.on('assistant/message')` | **不是 Cordis 事件**；它们是会话日志事件类型 |
| `ctx.on('message/complete')` | 不存在 |
| 第三方新增 `ctx.remote.<ns>` | 命名空间由 app 侧生成式 `@deepseek-ai/dsh-api-remotes` 装配，第三方无法新增 |
| 改写模型请求/消息 | DSH 禁止：`agent/request` 不能改消息，`llm/stream` 拿到的是冻结对象 |
| 「临时系统上下文」通道 | 不存在；除提示词分区外，写入即成为持久 `user/message` 历史 |
| 插件专属模型/凭据/`purpose` | `GenerateOptions.purpose` 是封闭联合 `'compaction' \| 'session-title'` |
| 跨会话注入到另一个活动会话 | 只有父子 `sendMessage`，没有任意会话寻址 |
| `ctx.settings` 当作键值存储 | 它是 profile patch 的**表单投影**，没有 `register/get/set` |
| Obsidian 自动注册接口 | 不存在；本插件只创建 `.obsidian/` 目录，不碰 Obsidian 全局配置 |

## 6. 平台

| 平台 | 状态 |
|---|---|
| Windows（桌面） | ✅ **主要目标，全部验证在此完成** |
| macOS / Linux | 代码路径已实现（`open` / `xdg-open`、`~/Library/Application Support/obsidian`、`~/.config/obsidian`），**未在真机验证** |
| 远程/无头 `web` profile | ✅ 可用，但**不会**擅自创建仓库（见 §7） |

## 7. 运行环境边界

`detectEnvironment()` 返回三种值：

| 值 | 判定 | 自动创建仓库？ |
|---|---|---|
| `desktop` | 存在 `process.versions.electron` 或 `DSH_DESKTOP_NODE_EXECUTABLE` | ✅ 唯一候选时自动创建 |
| `web` | 有 `DSH_WEB_URL` / `DSH_PROFILE` 但不是 Electron | ❌ 必须用户确认 |
| `node` | 都不匹配 | ❌ 必须用户确认 |

理由：在服务器侧运行 `web` profile 时，进程能读写的文件系统**不一定是用户本机的
磁盘**。插件不会把服务器路径说成「你的本地 Obsidian 仓库」，也不会在用户看不到的地方
静默建库。这一条在 `/api/status` 的 `discovery.warnings` 里会明确告知用户。

## 8. 已知限制

1. **没有语义检索。** 本部署没有可验证可用的 embedding 模型。已实现的是：关键词、
   CJK 单/双字、标题/别名/标签、精确 ID、路径、双向链接、时间与状态过滤。伪造向量
   比没有更糟，所以没做。
2. **模型辅助提取是可选路径，默认关闭。** 已实现（`enableLlmExtraction`）：会话结束后
   调用一次用户自己配置的模型，把该轮对话整理成候选记忆。开启后会**把对话内容发送给
   该模型提供者并产生调用费用**，因此默认关闭，且模型输出按不可信输入处理（结构校验、
   字节上限、依据校验、机密/敏感策略）。**本工作区未做真实 provider 往返验证**（会产生
   费用），该链路由注入式假适配器覆盖 47 例测试。
3. **完整系统提示词装配未端到端验证。** 已验证到「注册的 `text` 回调在真实宿主上产出
   含记忆的贡献」；`assemble()` 的完整拼接需要真实会话对象（真实事件日志 + 投影状态），
   伪造 context 就变成模拟装配，故未做。见 `docs/verification.md` §5.2。
4. **`enablePerStepRecall` 有额外成本且未验证真实插入。** 它会写入持久会话历史，本会话
   后续每轮重复计费，因此默认关闭；`@deepseek-ai/dsh-llm` 不可解析时该路径自动跳过。
5. **系统提示词块会让前缀缓存失效。** 任何变化都从第一个变化的 token 起重算。因此
   常驻块只放 profile / preference / pinned 这类慢变内容，默认 700 token。
6. **变更日志只存有界摘要**，不是完整前后全文。设计如此（避免日志变成第二份记忆库）。
7. **重复 id 需人工处理。** 检测并上报，但不自动删除任何一份。
8. **`dsh.manifestVersion` / `dsh.compatibility` 无运行时效果**（见 §1）。
9. **`desktop` profile：可管插件，不可引导。** 准确边界见 §9。
10. **未装进正在运行的真实 `desktop` profile。** 技术上
    `dsh plugin --profile desktop add …` 是被允许的（见 §9），但任务书禁止修改正在运行的
    真实 profile，因此该步骤保留为 **OPEN**，需单独授权。


## 9. `desktop` profile 的真实边界（第二轮更正）

第一轮曾写「真实 profile 无法被 CLI 修改 —— 硬边界」。按源码与实测更正：

`@deepseek-ai/dsh/lib/bin.js` 有**一个**拒绝函数、**两处**调用，门控不同：

```js
function rejectElectronProfile(program, profile) {
  if (profile.toLowerCase() === "desktop")
    program.error('error: profile "desktop" is managed exclusively by the Electron application')
}
```

| 调用点 | 门控 | 实际含义 |
|---|---|---|
| `bin.js:113`（boot / `--dump-config`） | **无条件** | 从 shell **引导或 dump** `desktop` profile 永远被拒 |
| `bin.js:120`（`plugin` 子命令） | `if (!manageDesktopProfile)` | **插件管理是被允许的**，只要载体声明了 `manageDesktopProfile: true` |

`<DSH install>\resources\runtime\cli\bin\dsh.cmd` 每轮启动 Desktop 的安装载体
（`runCli({ manageDesktopProfile: true, packageManager })`），所以它**能**管理 desktop
profile 的插件。实测区分（只解析参数、在写盘前退出）：

```console
$ dsh --profile desktop --dump-config
error: profile "desktop" is managed exclusively by the Electron application

$ dsh plugin --profile desktop
error: plugin needs pnpm arguments to forward (e.g. add <package>)
```

第二条没有触发 desktop 拒绝，而是走到「需要 pnpm 参数」——证明
`dsh plugin --profile desktop add …` 在解析层被允许。

**官方桌面端如何管理插件**：应用内的「插件」页面
（`dsh-client-ui-plugin-manager` + `dsh-plugin-manager`）与面向 agent 的
`plugin_manager` 工具，二者与 CLI 共用同一套安装机制（`runProfilePnpm`
→ 兼容性预检 → pnpm → 校验/回滚 → 自动登记 bundle），并用
`<profile>/.plugin-manager/run.json` 串行化，避免与正在运行的应用互相打断。

**因此**：桌面端安装本插件的官方步骤是「应用内 插件 → 添加 → 搜索/输入包名」，或让
应用内 agent 调用 `plugin_manager` 的 `install_bundle`。命令行 `dsh plugin --profile desktop
add <spec>` 同样可行。本轮**没有执行**任何一种（任务书禁止修改正在运行的真实 profile），
状态 **OPEN**，需单独授权。

## 11. 运行时停用与卸载（真实 UI 实测）

在 DSH `0.2.1-rc.2` + 真实 headless Chrome 中实测（隔离 profile，真实插件构建产物）：

| 操作 | 路径 | 结果 |
|---|---|---|
| 停用 | 应用内「插件」页 → 开关 `启用 dsh-longterm-memory` | **无需重启**：Host 路由 200 → **405**，侧边栏入口 1 → **0**（同页与新页面一致） |
| 重新启用 | 同一开关 | 路由恢复 **200**，入口恢复**恰好 1 个**，测试 Vault 数据仍在（同一记忆 id），无重复注册 |
| **卸载** | **先停用** → 卡片「查看」→「卸载」→ 对话框确认「卸载」 | **成功**：profile `bundles` 与 `dependencies` 均移除该包，路由 405，新页面入口 0，**Vault 的 Markdown 全部保留** |
| 卸载（**未先停用**） | 直接点「卸载」 | **被宿主拒绝**：官方 `removeBundle` 在运行中且 profile 无 HMR 时抛出 `ManagementFailure("stop-profile")`，pnpm 未执行（`.plugin-manager/logs/operation-*/pnpm.log` 为 0 字节，profile 不变） |
| CLI 移除 | `dsh plugin --profile … remove` | 需**重启 DSH** 才能让导航与 Host 状态一致（CLI 为 pnpm 透传，不写 patch、不触发 HMR） |

> **结论**：官方支持的运行时卸载顺序是 **先停用、再卸载**。直接卸载正在运行的插件会被宿主拒绝，这不是插件缺陷。
> 卸载只移除安装与注册，**不会删除用户的 Markdown 记忆仓库**。

## 12. 本机宿主 0.2.1-rc.3 的实际核验（「声明」与「放行」是两件事）

§1 的「已验证的 DSH 版本」在 0.1.5 之前只写过 `0.2.1-rc.2`；**实际运行的宿主是
`0.2.1-rc.3`**。本节记录这一差异与影响，避免把「声明过 rc.2」误读成「没在 rc.3 上跑过」。

宿主实现细节的静态核实见 [`docs/evidence/dsh-host-0.2.1-rc.3.md`](evidence/dsh-host-0.2.1-rc.3.md)
（代码级、明确未做真机 HTTP）；§12.1 的「本插件真实加载」是本机 HTTP 实测，两者互补。

### 12.1 实测事实（2026-10-27）

| 检查项 | 结果 | 证据 |
|---|---|---|
| 宿主版本 | **`0.2.1-rc.3`** | `D:\dsh\resources\app.asar` 内 `/dsh/package.json` 的 `version` = `0.2.1-rc.3`；`D:\dsh\resources\runtime\primary-runtime\runtime.json` 的 `desktopVersion` = `0.2.1-rc.3` |
| `engines.dsh` 对 rc.3 的判定 | **满足**（true） | 宿主自带 `semver@7.8.5` 复核：范围 `>=0.2.1-rc.3 <0.2.2` 对 `0.2.1-rc.3`，`includePrerelease` 取 true/false 均为 `true`（旧范围 `>=0.2.1-rc.2 <0.2.2` 同样为 true） |
| 宿主是否读取 `dsh.compatibility` | **不读取** | `@deepseek-ai/dsh-app-boot` 的判定只读 `engines.dsh`，否则回退 `@deepseek-ai/dsh*` peer 范围（见 §2）；对 rc.3 的 asar 做字节级全量检索，`dshReleases` **0 次命中**（[`docs/evidence/dsh-host-0.2.1-rc.3.md`](evidence/dsh-host-0.2.1-rc.3.md) §6.1） |
| 本插件在 rc.3 上是否真实加载 | **是** | 运行中的桌面宿主上 `POST /dsh-longterm-memory/api/status` → **200**，返回已初始化的 Vault 状态（同一响应中 `/` 为 401，说明认证层正常） |
| 完整真实浏览器 E2E 在 rc.3 上 | **尚未记录** | 此前的 61/61 E2E 是在 0.2.1-rc.2 上跑的；rc.3 上的功能回归验收以 0.1.5 的验收记录为准 |

### 12.2 为什么两件事会分开

宿主安装/启动只做**范围判定**：`engines.dsh` 存在时只按它判定，否则回退
`peerDependencies` 里的 `@deepseek-ai/dsh*` 范围，并用
`semver.satisfies(runtimeVersion, range, { includePrerelease: true })` 求值；
**`dsh.compatibility` 在运行时没有任何读取者**（§1 已述）。因此：

- **声明**（`dshReleases` 里逐版本列出的「已验证」）只是人类可读文档；
- **放行**（装得上、能启动）来自 `engines.dsh` / peer 范围。

`0.2.1-rc.3` 属于「**范围放行、此前未声明**」的情况；0.1.5 起把声明补齐
（`dshReleases` 保留 `0.2.1-rc.2` 并新增 `0.2.1-rc.3`）。

**事实说明（版本下移的历史）**：上一轮发布（0.1.4）的验证目标是 `0.2.1-rc.2`；本轮
（0.1.5）在 `0.2.1-rc.3` 上**重新核验**，因此 `engines.dsh` 的下限随之上移到
`0.2.1-rc.3`。`0.2.1-rc.2` 的验证记录保留在 `dsh.compatibility.dshReleases` 里作为
**历史**，不再作为当前验证目标——「保留历史键」不等于「仍支持 rc.2 之外的更老版本」。

### 12.3 影响与维护要求

1. `README.md` 的 `Verified DSH version`、本文件 §1 的「已验证的 DSH 版本」、`package.json`
   的 `engines.dsh` 与 `dsh.compatibility.dshReleases` **必须一致地覆盖 `0.2.1-rc.3`**。
2. `scripts/check-version-consistency.mjs` 用**字符串子串**判断「已验证版本出现在
   `engines.dsh` 中」，因此 `engines.dsh` 的字面量必须包含 `0.2.1-rc.3`（例如
   `>=0.2.1-rc.3 <0.2.2`），否则 `npm run lint` 失败（见 §2 的硬要求）。
3. 本文件 §1 的「安装器接受结果」一行是 0.2.1-rc.2 时的隔离安装实测记录；范围判定
   在 rc.3 上仍是 true，但**不要**把它改写成「rc.3 上做过安装器实测」——未做过就是未做过。

## 13. 官方 QQ 接入插件与本机宿主的兼容关系

本节只记录**官方插件**（`@tencent-connect/dsh-qqbot`）与本机宿主的兼容事实，与本插件
自身的兼容声明是两件事。完整上下文见 [`docs/qq-integration.md`](qq-integration.md) §4。

| 判定 | 结论 | 依据 |
|---|---|---|
| 官方验证过哪些 DSH 版本 | **只有 `0.1.0-rc.8`（CLI）与 `0.2.0-rc.2`（Desktop）**，是逐版本「已验证」记录，不是范围承诺 | 官方 `package.json` 的 `dsh.compatibility`；证据文档 §5.1 |
| 官方是否声明兼容本机 `0.2.1-rc.3` | **否**（0.2.1 线未获任何声明；上游 `main` 的 0.5.3 也未补） | 证据文档 §5.1 |
| 宿主会不会拦 | **不会**：官方包无 `engines.dsh` → 回退 peer 下限 `>=0.1.0-rc.6`；宿主用 `includePrerelease: true` 判定，`0.2.1-rc.3` 实测为 `true`，不产生 `pluginCompatibilityWarning` | 证据文档 §5.2 |
| 是否存在已知回归 | **有**（第三方报告、官方未修）：issue #60（`qqbot_send_file` 在 0.2.1-rc.2 下失败）、issue #58（`settings-reader` 路径问题） | 证据文档 §5.3 |

> 对外表述必须写成「**宿主 0.2.1-rc.3 可通过安装门槛（peer 范围放行），但官方未验证
> 0.2.1 线，且社区有 open 回归报告**」；**不要**写「官方声明兼容 0.2.1-rc.3」。
> 本机也未安装、未运行该官方插件（探针只实测到 `404` 分支），见证据文档 §7 与
> [`docs/qq-integration.md`](qq-integration.md) §9.2。

## 14. 0.1.5 新增配置：`qqLinkage`

QQ ↔ 长期记忆联动配置保存在本插件既有设置里（不新建数据库、不新建文件格式），
默认值来自 `src/shared/qq-linkage.ts` 的 `DEFAULT_QQ_LINKAGE`，通过管理页保存，也可以在
profile 的 `cordis.patch.yml` 里预设。预设与页面保存的优先级与既有设置一致：**管理页
保存的同名字段会覆盖 `cordis.patch.yml` 里的值**（`mergeQqLinkage(configured, chosen)`）。

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `mode` | `'off' \| 'deny-qq' \| 'allowlist'` | `'off'` | 联动保护模式：不拦截 / 拒绝 QQ 会话读取 / 仅受信会话可读取 |
| `qqMarkers` | `{ origins: string[], presets: string[], cwds: string[] }` | 全空 | 判定为 QQ 会话的标记（`session.header` 的 `origin` / `agentPreset` / `cwd`） |
| `trustedMarkers` | 同上 | 全空 | `allowlist` 模式下判定受信（本机桌面）会话的标记 |
| `writeMode` | `'inbox-only' \| 'direct'` | `'inbox-only'` | QQ 会话候选记忆的写回方式：只进收件箱 / 允许直接落盘 |
| `allowTools` | `boolean` | `false` | 是否允许 QQ 会话调用四个记忆工具 |

```yaml
# <profile>/cordis.patch.yml
- id: longterm-memory
  name: dsh-longterm-memory
  config:
    qqLinkage:
      mode: deny-qq            # off | deny-qq | allowlist（默认 off）
      qqMarkers:
        presets: ['qq']        # 官方 QQ 插件配置里设置的 preset
        cwds: []               # 绝对路径；Windows 下大小写不敏感
        origins: []
      trustedMarkers:
        cwds: []               # allowlist 模式下填写你的桌面工作目录
        presets: []
        origins: []
      writeMode: inbox-only    # inbox-only | direct
      allowTools: false
```

补充约束（均来自 `src/shared/qq-linkage.ts`）：

- `normalizeQqLinkage()` 会把未知的 `mode` / `writeMode` 回落到默认值，空串与重复标记
  被剔除，**不会因为旧配置或手写错误而放宽策略**。
- 每组标记最多 **32** 条、每条最多 **260** 字符（`MAX_MARKERS` / `MAX_MARKER_LENGTH`）。
- 不配置任何 `qqMarkers` 时，`deny-qq` / `allowlist` **不会命中任何会话**（因为没有任何
  会话能被识别为 QQ）；页面 `runtime.notes` 会明确提示。
- `qqLinkage` 只影响四个执行点（常驻注入 / 每步检索 / 写回 / 工具），**不改变任何记忆
  文件**；`mode: 'off'` 时行为与未接入 QQ 时完全一致。语义细节见
  [`docs/qq-integration.md`](qq-integration.md) §5。
