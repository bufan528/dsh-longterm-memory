# 兼容性与冻结契约

## 1. 支持的 DSH 版本

| 项 | 值 | 证据 |
|---|---|---|
| 已验证的 DSH 版本 | **`0.2.1-rc.2`** | `app.asar` 内 `@deepseek-ai/dsh/package.json` 的 `version` |
| 本包 `engines.dsh` 声明 | `>=0.2.1-rc.2 <0.2.2` | 宿主自带 `semver@7.8.5`：`0.2.1-rc.2`→true，`0.2.2`/`0.3.0`/`0.2.0-rc.2`→false |
| 安装器接受结果 | **exit 0，无 `pluginCompatibilityWarning`，无需版本豁免** | 隔离 profile `r9a` 真实安装 + 启动日志扫描（0 条警告） |
| 官方包清单 | 236 个 `@deepseek-ai/*` 包 | `app.asar` 内 `node_modules/@deepseek-ai/` |
| 客户端 bundle 契约 | `window.__ModuleLoader__.load({id, factory})` | 87 个官方 `lib/client.js` 首行 |
| 平台 seed 模块表 | 9 个固定词 | `dsh-web-frontend/dist/assets/index-5SrrfWpU.js:126` |
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

**本包声明 `engines.dsh = ">=0.2.1-rc.2 <0.2.2"`**，不声明任何 `@deepseek-ai/*` peerDependency
（`scripts/lint.mjs` 作为硬规则检查后者）。选择该范围的理由：

- 宿主实际版本 `0.2.1-rc.2` 必须满足（已用宿主自带 `semver@7.8.5` 验证为 `true`）；
- 预发布范围的 SemVer 行为：只有当比较器带同样的 `major.minor.patch` 元组及预发布号时才匹配
  预发布版本，因此显式写 `>=0.2.1-rc.2` 而不是 `^0.2.0`（后者对 `0.2.1-rc.2` 为 `false`）；
- 上界 `<0.2.2` 表示**只声明 0.2.1 这一条已实测的线**，不把 0.2.2 / 0.3.x 纳入未验证的支持范围。

> 不要为了"能装上"而放宽这个范围：真实安装器（隔离 profile `r9a`）在本范围下 exit 0、
> 无警告、无需豁免，已实测。

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
