# 官方 QQ 接入插件事实核查：`@tencent-connect/dsh-qqbot`

| 项 | 值 |
|---|---|
| 核查对象 | npm 包 `@tencent-connect/dsh-qqbot`（私有作用域 `@tencent-connect`，发布者 `tencentconnectqqbot`） |
| 核查时间 | 2026-10-27 13:00–13:10 +08:00（Asia/Shanghai） |
| 本机宿主 | DSH Desktop **0.2.1-rc.3**（`D:\dsh\resources\app.asar` → `/dsh/package.json` 的 `version`，经 asar 解析实测；另有 `D:\dsh\resources\runtime\primary-runtime\runtime.json` 的 `desktopVersion`） |
| 本机 profile | `C:\Users\bf410\.dsh\profiles\desktop` |
| npm latest | **0.5.2**（`dist-tags.latest`，发布时间 2026-10-12T07:04:31Z） |
| 上游仓库 | <https://github.com/tencent-connect/dsh-qqbot>（存在，`main` 分支，MIT；核查时 `main` 上 `package.json` 已写成 **0.5.3**，但 npm 未发布、GitHub Release 最新仍为 0.5.2） |
| 写入范围 | 仅本文件与 `.scratch/qqbot/**`；未修改 `src/`、`lib/`、`package.json`、profile 或任何实现文件 |

> 核查方式：下载 registry JSON → 下载全部 7 个 tarball 并 `tar -xzf` 解包 → 读 `package.json` / `dist/**/*.d.ts` / `dist/**/*.js` / `lib/client.js` / README / CHANGELOG → 用宿主自带 `@deepseek-ai/dsh-app-boot` 与 `semver@7.8.5` 复核兼容性判定 → 对运行中的 Host Web 端口做只读 GET 探针。证据文件见文末 §9。

---

## 0. 结论摘要（TL;DR，逐条对应任务问题）

1. **版本**：npm 共 7 个版本 `0.1.0 → 0.5.2`，latest = **0.5.2**。所有版本 `main=./dist/index.js`、`types=./dist/index.d.ts`；`dsh.bundle.patch=./cordis.patch.yml` 从 0.1.0 起就有；**`dsh.client` 段与客户端 bundle（`lib/client.js`）只存在于 0.5.1 / 0.5.2**；`dsh.compatibility` 同样只在 0.5.1+ 出现；**所有版本都没有 `files` 字段、没有 `engines.dsh`**。
2. **导出面 / 服务**：包入口只导出 `name`（值 `"im-qqbot"`）、`inject`（值 `["agents"]`）、`Config`、`apply(ctx, config)`。**插件没有 `ctx.provide` / `ctx.set`，不注册任何 cordis 服务，不扩展 ctx**；因此**不存在供其他插件调用的状态查询 / 导航 / 控制接口**。唯一的对外状态面是它注册在 `ctx.webServer` 上的 5 条 HTTP JSON 路由（绑定/配置协议，`BindStateWire`）。
3. **客户端 UI**：**有，0.5.1 起**。客户端半边 `lib/client.js`（49,472 B，`window.__ModuleLoader__.load({id:"@tencent-connect/dsh-qqbot"})`，插件名 `im-qqbot-client`）注册：设置页 `settings.section`（`id:"qqbot"`, `order:7`, `label:"QQ 机器人"`）、右侧栏 Tab（`sidebarRightTabs.register({id:"im-qqbot/bind", kind:"qqbot-bind"})`）、以及 `sidebar.right.pane.tab` 席位（`key:"im-qqbot/bind"`）。**没有独立页面路由，也没有 HTML 页面**；绑定页是客户端渲染的侧栏/设置面板，数据来自 `/qqbot/im-qqbot/bind` 等 JSON 路由。0.1.0–0.5.0 **无客户端 UI**，只有终端二维码（`runQrSetup`）。
4. **安装 / 绑定 / 凭据**：安装走 `npx @deepseek-ai/dsh plugin --profile qqbot add @tencent-connect/dsh-qqbot`；必填 `appId`/`appSecret`（或 env `QQBOT_APPID`/`QQBOT_SECRET`）。绑定成功后**凭据以明文 YAML 写入 `<profile>/cordis.patch.yml`**（`appId`/`appSecret` 字段，`yaml.dump` 整份写回），**没有走 `@deepseek-ai/dsh-credentials`、没有系统密钥库/加密**；HTTP 路由只回显脱敏后的 config（`appSecret` 永不回传）。README/CHANGELOG **没有兼容性声明**；兼容声明只在 `package.json` 的 `dsh.compatibility`。
5. **兼容性**：官方声明为 **逐版本「已验证」记录**（`{"0.1.0-rc.8":"compatible","0.2.0-rc.2":"compatible"}` + note 原文「0.1.0-rc.8 为 CLI（dsh web）已验证…0.2.0-rc.2 为 Desktop 内嵌运行时已验证…宿主大版本升级后请重新验收席位行为」），**不是范围承诺**；本机 **0.2.1-rc.3 不在声明内**。宿主安装/启动门槛**仍会放行**（官方包无 `engines.dsh` → 回退 peerDeps 的 `@deepseek-ai/dsh-*` 范围 `>=0.1.0-rc.6`；宿主用 `semver.satisfies(..., {includePrerelease:true})` 判定，`0.2.1-rc.3` 实测为 `true`）。但「装得上」不等于「官方验证过」：0.2.1 线已有社区报告的已知回归（GitHub issue #60，open）。
6. **安全检测**：**不能**用 `ctx.get('im-qqbot')` / `ctx.get('dsh-qqbot')` 判断——官方插件不 provide 服务，即使已加载也返回 `undefined`。可安全使用的证据源（按推荐度）：① 宿主 `pluginInventory/list` Remote（`@deepseek-ai/dsh-host-plugin-inventory` 0.2.1-rc.3，只读快照，行含 entry id / module specifier / 生效使能 / fiber phase）；② 同源 `GET /qqbot/im-qqbot/bind`：`200` JSON（`phase: bound|waiting|…`）= 已加载，`404` = 未安装/未加载（官方客户端自己就用这个探针，见 `lib/client.js:944-946`；本机实测 404，同端口 `/` 返回 401 说明服务存活）；③ profile `package.json` 的 `dsh.profile.bundles`/`dependencies`、`node_modules/@tencent-connect`、`pnpm-lock.yaml`（本机三者均无）；④ 客户端 slots 标识 / tools 注册（辅助判据）。

---

## 1. npm 版本与 `package.json` 关键字段

### 1.1 版本清单（registry）

命令（可复现）：

```powershell
Invoke-WebRequest https://registry.npmjs.org/@tencent-connect%2Fdsh-qqbot -OutFile .scratch/qqbot/registry.json
```

`registry.json` → `dist-tags = {"latest":"0.5.2"}`；`versions` / `time`（UTC 发布时刻）：

| version | 发布时间 | unpackedSize | 关键变化（由 tarball 内 `package.json` 核对） |
|---|---|---|---|
| 0.1.0 | 2026-08-14T13:44:51Z | 189,963 | 首版；只有 `dsh.bundle.patch`；无 `engines`、无 `dsh.client`、无 `compatibility` |
| 0.2.0 | 2026-08-14T15:46:16Z | 206,047 | 字段同 0.1.0 |
| 0.3.0 | 2026-08-15T20:21:40Z | 250,856 | 字段同 0.1.0 |
| 0.4.0 | 2026-08-16T02:05:01Z | 256,227 | 字段同 0.1.0 |
| 0.5.0 | 2026-09-08T15:17:15Z | 1,009,323 | 首次出现 `engines.node=">=18"` 与 `repository`；**仍无** `dsh.client` / `dsh.compatibility`；peerDeps 增加 `@deepseek-ai/dsh-user-approval` |
| 0.5.1 | 2026-10-12T04:34:48Z | 1,221,402 | **首次出现 `dsh.client`、`exports["./client"]`、`lib/client.js`、`dsh.compatibility`**；`engines.node=">=20.3.0"`；deps 增加 `qrcode` |
| **0.5.2（latest）** | 2026-10-12T07:04:31Z | 1,222,989 | 同 0.5.1，仅 `@tencent-connect/qqbot-nodejs` 从 `^1.0.4` → `^1.0.5`（修「全新安装无法启动」，见 CHANGELOG） |

> `registry` 元数据与各 tarball 内真实 `package.json` 已做逐字段深比较（`main`/`exports`/`dsh`/`engines`/`peerDependencies`/`dependencies`）：**7 个版本全部一致**（`.scratch/qqbot/versions-summary.json` 的 `registryMatchesTarball: true`）。

### 1.2 latest（0.5.2）`package.json` 原文要点

路径：`.scratch/qqbot/extract-0.5.2/package/package.json`

| 字段 | 值 | 行号 |
|---|---|---|
| `name` / `version` | `@tencent-connect/dsh-qqbot` / `0.5.2` | 2–3 |
| `type` | `module` | 5 |
| `main` | `./dist/index.js` | 6 |
| `types` | `./dist/index.d.ts` | 7 |
| `exports` | `{".":{"types":"./dist/index.d.ts","import":"./dist/index.js"},"./client":{"default":"./lib/client.js"}}` | 8–16 |
| `engines` | `{"node":">=20.3.0"}` —— **没有 `engines.dsh`** | 36–38 |
| `dsh.bundle.patch` | `./cordis.patch.yml` | 47–50 |
| `dsh.client` | `{"platform":"web"}`（**无 `inject`、无 `immediately`**） | 51–53 |
| `dsh.compatibility.dshReleases` | `{"0.1.0-rc.8":"compatible","0.2.0-rc.2":"compatible"}` | 54–58 |
| `dsh.compatibility.note` | 见 §5 原文引用 | 59 |
| `dependencies` | `@tencent-connect/qqbot-connector@1.2.0`、`@tencent-connect/qqbot-nodejs@^1.0.5`、`js-yaml@^4.1.0`、`qrcode@^1.5.4` | 62–67 |
| `peerDependencies` | `@deepseek-ai/cordis>=4.0.1`、`@deepseek-ai/dsh-agent>=0.1.0-rc.6`、`@deepseek-ai/dsh-llm>=0.1.0-rc.6`、`@deepseek-ai/dsh-session>=0.1.0-rc.6`、`@deepseek-ai/dsh-user-approval>=0.1.0-rc.6`（optional）、`@deepseek-ai/schemastery>=3.18.1`、`@tencent-connect/qqbot-connector@1.2.0` | 68–76 |
| `files` | **不存在**（registry JSON 中亦为 `null`）→ 发布 tarball 含 251 个文件（含 `.js.map`、`docs/`、`scripts/`、`tsconfig.client.json`、`tsdown.client.config.ts`） | — |

补充：0.5.2 **没有** `dsh.manifestVersion` / `icon` / `meta` / `locale` 字段。上游 `main`（0.5.3，未发布）才补了 `icon`、`./locale/*.json` 导出、双语 `description` 与更多 keywords；`dsh.manifestVersion` 与 `meta` 在 `main` 上也没有。

```powershell
# 解包与查看（已执行，产物在 .scratch/qqbot/extract-<version>/package/）
Invoke-WebRequest https://registry.npmjs.org/@tencent-connect/dsh-qqbot/-/dsh-qqbot-0.5.2.tgz -OutFile .scratch/qqbot/dsh-qqbot-0.5.2.tgz
tar -xzf .scratch/qqbot/dsh-qqbot-0.5.2.tgz -C .scratch/qqbot/extract-0.5.2
```

---

## 2. latest 的导出面：没有 cordis 服务，没有跨插件 API

### 2.1 包入口只导出 4 个符号

`.scratch/qqbot/extract-0.5.2/package/dist/index.d.ts`（全文 15 行）：

```ts
10  export declare const name = "im-qqbot";
11  export declare const inject: string[];
12  export declare const Config: import("@deepseek-ai/schemastery").default<ImQQBotConfig>;
13  export type { ImQQBotConfig } from './config.ts';
14  export declare function apply(ctx: Context, config: ImQQBotConfig): Promise<void>;
```

对应实现 `.scratch/qqbot/extract-0.5.2/package/dist/index.js:6-8`：

```js
6   export const name = 'im-qqbot';
7   export const inject = ['agents'];
8   export const Config = ConfigSchema;
```

- `name = "im-qqbot"` 是 **Cordis fiber/loader entry 名**，不是 ctx 服务名。
- `inject = ["agents"]` 表示**消费**宿主的 `agents` 服务，而非提供。
- **全包没有任何 `ctx.provide(...)` / `ctx.set(...)` / `Service` 注册**：对 `dist/**/*.js` 全文检索 `ctx.provide|ctx.set|provide(|defineService|ctx.[A-Za-z]+ =` **零命中**（仅命中 `service` 变量名、`ctx.get(...)`、`ctx.inject(...)`、`ctx.effect(...)`）。
- 内部确有 `BindingService` 类（`.scratch/qqbot/extract-0.5.2/package/dist/setup/binding-service.d.ts:52-86`，含 `currentPhase` / `wireState()` / `subscribe()`），但：① 它由 `ensureCredentials()` 在函数内部 new，未挂到 ctx；② 包的 `exports` 只有 `"."` 与 `"./client"`，**没有导出 `dist/setup/*` 子路径**，Node ESM 下 `import '@tencent-connect/dsh-qqbot/dist/setup/binding-service.js'` 会因 exports 隔离而失败；③ `index.d.ts` 也未转出它。→ **不是公共接口**。

**结论：官方插件没有对外状态查询接口、没有导航接口、没有控制接口（cordis 层面一律「无」）。** 逐条：

- **状态查询接口**：无。唯一状态面是宿主 HTTP 路由 `GET /qqbot/im-qqbot/bind`（JSON `BindStateWire`），见 §2.2。
- **导航接口**：无。客户端侧栏/设置页入口是它自己注册的 slot（§3），没有供第三方调用的 `navigate/openPanel/selectPanel` 一类方法。
- **控制接口**：无。绑定/解绑/配置这 5 条 HTTP 路由只服务它自己的绑定页（刷新二维码、提交凭据、解绑、配置编辑），没有「让其他插件发消息/启停机器人」之类的公共方法。

### 2.2 唯一的对外状态面：注册在宿主 `ctx.webServer` 上的 5 条 HTTP 路由

`ctx.webServer.register({kind:'exact', path, handler})`（`.scratch/qqbot/extract-0.5.2/package/dist/setup/bind-routes.js:58-84`），路径常量唯一来源 `.scratch/qqbot/extract-0.5.2/package/dist/shared/bind-protocol.d.ts:10-18`：

| 路径 | 方法 | 行为 | 证据 |
|---|---|---|---|
| `/qqbot/im-qqbot/bind` | GET/HEAD | 状态查询：`{phase:'bound', appId}` / `{phase:'waiting', url, qrSvg?, issuedAt}` / `{phase:'starting'}` / `{phase:'saving'}` / `{phase:'failed', reason}` | `bind-routes.js:115-131`；wire 类型 `bind-protocol.d.ts:20-35` |
| `/qqbot/im-qqbot/bind/refresh` | POST | 刷新二维码（走状态轮询收敛） | `bind-routes.js:132-146` |
| `/qqbot/im-qqbot/bind/manual` | POST | 手动提交 `appId`/`appSecret` → 持久化到 profile patch → HMR 重载 | `bind-routes.js:175-204` |
| `/qqbot/im-qqbot/bind/unbind` | POST | 解绑：从 profile patch 删除 `appId`/`appSecret`（并要求重新绑定） | `bind-routes.js:206-241` |
| `/qqbot/im-qqbot/config` | GET/POST | 配置读写（GET 剔除 `appSecret`；POST 白名单键校验） | `bind-routes.js:247-310` |

访问约束（`bind-routes.js:96-106`）：`trusted(req)` 仅做同源校验——**无 `Origin` 头的请求直接放行**、同源放行；因此这 5 条是 **JSON API**，不是插件间 API。绑定状态机是模块级单例（`dist/setup/index.js:9,23-37`），也没有通过 ctx 暴露。

### 2.3 其它宿主侧挂载点（非「接口」，但可被宿主观测到）

- **tools 注册**：`qqbot_send_file`（`dist/media/send-file-tool.js:14`，`tools` 服务缺失时优雅降级）；`qqbot_describe_image`（`dist/media/vision-tool.js:18`，仅 `vision.enabled` 且 llm/attachments 服务可用时注册）。注册代码：`gateway/bootstrap.js:129-141`。
- **事件监听**：`ctx.on('session/event', outboundHandler)`（`gateway/bootstrap.js:82-83`）、`ctx.on('system-prompt/assemble')`（`session/session-manager.js:79`）、`ctx.on('approval/request')`（`features/approval-channel.js:63`）。
- **读取的宿主服务**：`ctx.agents`（`index.js:11`）、`ctx.get('tools')`、`ctx.get('llm')`、`ctx.get('attachments')`、`ctx.get('sessions')`、`ctx.get('agentPresets')`、`ctx.get('sessionPersistence')`、`ctx.get('compaction')`、`ctx.get('userQuestions')`、`ctx.get('approval')`；`ctx.inject(['webServer'], ...)`（`dist/setup/index.js:51,77`）。
- 内置 `/bot-status` 等斜杠命令是 **QQ 聊天内命令**（`dist/commands/status.d.ts`），不是给插件调用的 API。

---

## 3. 客户端 UI：0.5.1 起有；给出 slot / key / 路由标识

### 3.1 结论

- **0.5.1 / 0.5.2 有客户端 UI**：`lib/client.js`（`package.json` `exports["./client"]`，`dsh.client.platform = "web"`）。
- **0.1.0–0.5.0 无客户端 UI**：这些版本的 tarball 没有 `lib/` 目录，`package.json` 无 `dsh.client`；绑定只能走终端二维码（`dist/setup.js` / `dist/setup/index.js` 的 `runQrSetup`，如 0.1.0 `dist/index.js:7,22`、0.5.0 `dist/index.js:4,19`）。
- **没有绑定页面「路由」**（没有 HTML 页面路由、没有独立 URL）。绑定页是客户端插件在右侧栏/设置页渲染的 React 面板（`BindPanelBody` / `ConfigPanel`）；**二维码也不是独立页面**，而是宿主侧生成 SVG（`dist/setup/qr-svg.js`，经状态路由以 `qrSvg` 字段返回）后在面板内联渲染。宿主侧只暴露 §2.2 的 JSON API。

### 3.2 客户端 bundle 与注册清单

文件：`.scratch/qqbot/extract-0.5.2/package/lib/client.js`（49,472 B，995 行；首行为宿主模块协议包装）

```js
1  window.__ModuleLoader__.load({
2    id: "@tencent-connect/dsh-qqbot",
3    factory: (require) => { ... }
```

插件元数据与注册（`lib/client.js:872-940`）：

```js
872  const name = "im-qqbot-client";
873  const inject = ["slots", "sidebarRight", "sidebarRightTabs"];
879  const TAB_KIND = "qqbot-bind";
881  const TAB_ID = "im-qqbot/bind";
912  if (slots !== void 0) disposers.push(slots.inject("settings.section", () => slots.register({
913      name: "settings.section",
914      id: "qqbot",
915      order: 7,
916      label: "QQ 机器人"
917  }, QQBotSettingsSection)));
919  disposers.push(tabs.register({
920      id: TAB_ID,                 // "im-qqbot/bind"
921      kind: TAB_KIND,             // "qqbot-bind"
922      title: () => "QQ 机器人绑定",
923      guide: [{ id: "bind", order: 90, title: () => "QQ 机器人绑定",
927               description: () => "扫码或手动填写，绑定 QQ 机器人", icon: BindGuideIcon }]
930  }));
931  disposers.push(slots.inject("sidebar.right.pane.tab", () => slots.register({
932      name: "sidebar.right.pane.tab",
933      key: TAB_ID                  // "im-qqbot/bind"
934  }, BindPanelBody)));
```

| 注册目标 | 标识 | 语义 / 证据 |
|---|---|---|
| `slots` `settings.section` | `id:"qqbot"`、`order:7`、`label:"QQ 机器人"` | 设置页「QQ 机器人」栏目，内容 = 绑定面板 + 配置面板（`lib/client.js:903-906`） |
| `sidebarRightTabs.register` | `id:"im-qqbot/bind"`、`kind:"qqbot-bind"`、`title:"QQ 机器人绑定"`、`guide[{id:"bind",order:90}]` | 右侧栏 Tab 类型 + 引导项 |
| `slots` `sidebar.right.pane.tab` | `name:"sidebar.right.pane.tab"`、`key:"im-qqbot/bind"` | 右侧栏具体面板内容（`BindPanelBody`） |
| 自动打开 | `right.openTab("qqbot-bind")` | 未绑定时自动把绑定页拉到前台（`lib/client.js:950-987`） |

### 3.3 客户端如何取数 / 与宿主交互

- 轮询 `fetch(BIND_STATE_PATH)`（即 `/qqbot/im-qqbot/bind`）：`phase === 'waiting'` 时自动 `right.openTab(TAB_KIND)`，**每次页面加载最多自动打开一次**；页面隐藏时降频到 5 s，正常 3 s；非 2xx（含 404）退避 30 s（`lib/client.js:950-987`；注释「404（已绑定/未安装）时退避到 30s」在 `lib/client.js:944-946`）。
- 手动绑定/解绑/配置保存：POST 到 §2.2 的 `manual`/`unbind`/`config` 路由（同一 bundle 内联了路径常量，`lib/client.js:18-26`）；保存后写 profile patch → 宿主 HMR 重载 → 新 fiber 用新凭据启动网关。

---

## 4. 安装、绑定流程、配置项、凭据存储、兼容性声明

### 4.1 安装方式（README 原文）

`.scratch/qqbot/extract-0.5.2/package/README.md:36-77`（三种方式）：

```bash
# 方式一：手动执行
npx @deepseek-ai/dsh plugin --profile qqbot add @tencent-connect/dsh-qqbot
npx @deepseek-ai/dsh --profile qqbot

# 方式二：本地路径安装（pnpm install && pnpm build 后 add /path/to/dsh-qqbot）

# 方式三：--patch 开发模式
npx @deepseek-ai/dsh web --patch /path/to/dsh-qqbot/cordis.dev.yml
```

README:48-50 原文（首次绑定 + Desktop/Web 行为）：

> 首次启动时，插件检测到凭据未配置会自动进入扫码引导：终端输出二维码 → 手机 QQ 扫码绑定 → 凭据自动保存到 profile，后续启动无需再次扫码。
> DSH **桌面版 / Web** 下会自动打开应用内「QQ Bot 绑定」页（右侧边栏），端内渲染二维码并实时展示绑定状态，扫码成功后自动完成保存与插件重载；CLI 模式保持终端二维码引导。设置 `QQBOT_BIND_OPEN_BROWSER=1` 可在无端内页的环境额外拉起系统浏览器扫码页作为降级通道。

⚠️ 注意：README 的安装示例用 **`--profile qqbot`（独立 profile）**；未描述「安装进现有 Desktop profile（如 `desktop`）」的操作路径（Desktop 侧由插件管理器/`dsh plugin add` 完成，属 host 行为，见 task-2）。

### 4.2 绑定流程（0.5.2 实现）

1. `apply()` 从 `config.appId/appSecret` 或 env `QQBOT_APPID`/`QQBOT_SECRET` 解析凭据（`dist/index.js:13-14`）。
2. 凭据缺失 → `ensureCredentials()`（`dist/index.js:16-54`）：**同步阶段**完成绑定编排（单例 `BindingService`、`ctx.effect` 生命周期、终端/浏览器 presenter、`ctx.inject(['webServer'])` 注册 5 条路由），随后 `service.start()` 挂起等待扫码；**不 await 扫码结果**，避免阻塞 Host ready（`dist/setup/index.js:23-69`）。
3. 扫码成功 → `persistCredentialsToProfile(credentials, getProfileDir())` 写 profile patch → 文件变化触发 HMR 重载 → 新 fiber 带凭据启动 `bootstrapGateway()`（QQ WebSocket 网关）。
4. 手动路径：绑定页 POST `/qqbot/im-qqbot/bind/manual` → 同一 `persist` 路径（`dist/setup/index.js:55-60`）。
5. 解绑：POST `/qqbot/im-qqbot/bind/unbind` → 从 patch 删除 `appId/appSecret` 并清理 `process.env.QQBOT_*`（`bind-routes.js:206-241`）。
6. 已绑定态：`registerBoundCredentialRoutes()` 注册常驻路由（状态回显 + 更换凭据 + 配置编辑），再 `bootstrapGateway()`（`dist/index.js:56-59`；`dist/setup/index.js:76-90`）。

### 4.3 必需配置项与凭据存储机制

- **必填**：`appId`、`appSecret`（`README.md:82-83`；`dist/config.js:14` 起为 Schema 字段）。首选 env `QQBOT_APPID` / `QQBOT_SECRET`（`dist/shared/utils.js:97-102` 的 `resolveEnv`，支持 `__FROM_ENV__` 占位）。
- 其余可选配置见 README `78-99` 表格（`provider`/`model`/`preset`/`cwd`/`requireMention`/`streaming`/`sessionIdleTimeout`/`processingTimeoutMs`/`maxQueue`/`historyLimit`/`askTimeoutMs`/`showToolResults`/`debug` 等），以及 `access`（c2c/group 的 open/allowlist/disabled）、`media`、`vision`、`sendFile`。
- **凭据存储机制 = 明文 YAML 写 profile 的 `cordis.patch.yml`**，证据：
  - `dist/setup/persist.js:18-26`：`persistCredentialsToProfile(credentials, profileDir)` → `const patchPath = resolve(dir, 'cordis.patch.yml')`。
  - `persist.js:34-52`：已有 `im-qqbot` 条目则更新其 `config.appId`/`config.appSecret`，否则 push `{id:'im-qqbot', config:{appId, appSecret}}`。
  - `persist.js:55-57`：`const output = \`# QQ 机器人凭据（扫码绑定自动生成）\n${yaml.dump(entries)}\`;  writeFileSync(patchPath, output, 'utf8')` → **js-yaml 明文 dump，无加密、无脱敏**。
  - 解绑/配置写入同样整份 `yaml.dump` 写回（`persist.js:75-103`、`113-151`）；解析策略见 `persist.js:162-177`。
  - 全包检索 `dsh-credentials|credentials.yaml|keychain|safeStorage|secret` **没有命中任何凭据服务调用**（命中的只是本插件的 `ensureCredentials` 命名与 `appSecret` 字段）；依赖里也没有 `@deepseek-ai/dsh-credentials`。→ **不走 dsh-credentials，不走 OS 密钥库**。
  - 边界：HTTP 层不泄露 secret——状态响应只含 `appId`（`bind-routes.js:124-131`）；`GET /qqbot/im-qqbot/config` 显式剔除 `appSecret`（`bind-routes.js:256-262`）；`manual` 提交体上限 4096 B（`bind-routes.js:41-42`）。**但明文落盘是事实**，与 DSH 的 `.dsh/.credentials.yaml` 属不同机制。
  - `getProfileDir()` 是目录启发式（向上找 `cordis.patch.yml` / `pnpm-workspace.yaml`，跨 node_modules 边界），见 `dist/shared/utils.js:46-93`。

### 4.4 README / CHANGELOG

- README 无「兼容版本」章节（全文检索 `兼容|compatib|0.1.0-rc|0.2.0-rc` **零命中**）。
- **GitHub `main` 的 README 与 npm 0.5.2 的 README 正文一致**（仅图片资源路径从包内 `./docs/assets/...` 变为仓库里的 `./assets/docs/...`），也没有额外兼容性说明（比对 `raw.githubusercontent.com/.../main/README.md` 与 tarball 内 `README.md`）。
- CHANGELOG（`.scratch/qqbot/extract-0.5.2/package/CHANGELOG.md`）记录：0.5.1「端内扫码绑定 / 端内配置面板」（行 16-26）、0.5.2「修复全新安装无法启动；旧 SDK 兼容降级」（行 9-14）、0.5.0 及更早见文件。npm tarball 无 `CHANGELOG.md` 之外的兼容声明。

---

## 5. 兼容性：官方「已验证」vs 本机 0.2.1-rc.3

### 5.1 官方声明原文（`package.json` → `dsh.compatibility`，0.5.1/0.5.2 相同）

`.scratch/qqbot/extract-0.5.2/package/package.json:54-60`：

```json
"compatibility": {
  "dshReleases": {
    "0.1.0-rc.8": "compatible",
    "0.2.0-rc.2": "compatible"
  },
  "note": "0.1.0-rc.8 为 CLI（dsh web）已验证：扫码/手动/解绑全流程、终端二维码与端内绑定页；0.2.0-rc.2 为 Desktop 内嵌运行时已验证：端内绑定页（settings.section 与侧栏）、HMR 重载收敛。客户端依赖 settings.section / sidebarRightTabs / sidebar.right.pane.tab 席位契约与 dsh.client 模块系统，宿主大版本升级后请重新验收席位行为。"
}
```

- 键是**精确版本号**（不是 semver 范围），note 明确写「**已验证**」哪些流程——这是**逐版本验证记录**，不是「0.2.x 全线兼容」的承诺。
- **0.2.1-rc.3（本机）不在列表里**；0.2.1 线（比 0.2.0-rc.2 更新）未获任何声明。
- note 最后一句自认客户端依赖三个席位契约，「宿主大版本升级后请重新验收席位行为」= 明确不承诺跨宿主版本。
- GitHub `main`（0.5.3，未发布）里该字段**与本机 npm 0.5.2 完全一致**（仍只有 0.1.0-rc.8 / 0.2.0-rc.2），说明上游至今未补 0.2.1 验证记录（核查时间 2026-10-27 13:05 +08:00，`raw.githubusercontent.com/.../main/package.json`）。

### 5.2 宿主如何对待这段声明（实测宿主 0.2.1-rc.3 代码）

宿主安装/启动的兼容性判定在 `@deepseek-ai/dsh-app-boot`（版本 **0.2.1-rc.3**，即 `getDshRuntimeVersion()` 的返回值；代码位于 `D:\dsh\resources\app.asar` 内 `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`，只读提取副本在 `.scratch/qqbot/asar/app-boot/lib/index.js`）：

- `.scratch/qqbot/asar/app-boot/lib/index.js:277-300`（asar 内 `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`）：`satisfies(runtimeVersion, range) = semver.satisfies(runtimeVersion, range, { includePrerelease: true })`；`unmetRequirements()` **只读 `engines.dsh`，否则读 peerDependencies 中 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 键的范围**——**完全不读 `dsh.compatibility`**。
- 因此官方插件的 `dsh.compatibility` **在运行时没有任何读取者，只是人类文档**（与本项目 `docs/compatibility.md:15-20` 的既有结论一致）。
- 官方包**没有 `engines.dsh`** → 回退到 peerDeps：`@deepseek-ai/dsh-agent >=0.1.0-rc.6`、`dsh-llm >=0.1.0-rc.6`、`dsh-session >=0.1.0-rc.6`、`dsh-user-approval >=0.1.0-rc.6`（`@deepseek-ai/cordis`/`schemastery` 不匹配 `dsh` 前缀，被忽略）。
- 用**宿主自带的 `semver@7.8.5`** 实测（`.scratch/qqbot/semver-check.cjs`，已执行）：

```text
semver version: 7.8.5
runtime: 0.2.1-rc.3
{"range":">=0.1.0-rc.6","includePrerelease_true":true,"includePrerelease_false":false}
{"range":">=0.2.1-rc.2 <0.2.2","includePrerelease_true":true,"includePrerelease_false":true}
```

（第 1 行是官方包 peer 的范围；第 2 行是本项目 `engines.dsh` 的对照值。默认 `includePrerelease:false` 时 `>=0.1.0-rc.6` 对 `0.2.1-rc.3` 为 false——宿主显式开了 `includePrerelease:true`，所以为 true。）

→ 官方包的 peer 底线 `>=0.1.0-rc.6` 在宿主判定口径（`includePrerelease:true`）下对 `0.2.1-rc.3` **为 true**，**不会**产生 `pluginCompatibilityWarning`/豁免要求；本机 profile 也没有 `compatibility.json`（无豁免记录）。该判定函数在 app-boot 内部被调用（`.scratch/qqbot/asar/app-boot/lib/index.js:1026,2328`）；Desktop 插件管理器的安装链路是否完全复用同一函数，由 task-2 复核（本文件的结论仅就被调用的这段代码成立）。

### 5.3 结论与风险

| 判定 | 结论 |
|---|---|
| 官方是否声明 0.2.1-rc.3 兼容？ | **否**。只声明「0.1.0-rc.8 / 0.2.0-rc.2 已验证」。 |
| 是「承诺」还是「验证记录」？ | **验证记录**（精确版本键 + 「已验证」note），且 note 自认席位契约需在宿主升级后重新验收。 |
| 宿主会不会拦？ | **不会**（无 `engines.dsh` → peer 下限 `>=0.1.0-rc.6` 在 `includePrerelease` 下满足 `0.2.1-rc.3`）。属「能装 ≠ 官方验证」的口子。 |
| 0.2.1 线实际风险 | 有公开回归报告：GitHub issue **#60**（2026-10-24，open）标题「qqbot_send_file 在 dsh 0.2.1-rc.2 下必定失败：findByAgent 依赖对象引用…」，正文明确写「插件 package.json 的 dsh.compatibility.dshReleases 只声明验证过 0.1.0-rc.8 与 0.2.0-rc.2，**没有 0.2.1-rc.2**」；另有 issue **#58**（open，`settings-reader` 硬编码 `~/.dsh/settings.yaml`、不认 `$DSH_HOME`，dsh ≥0.1.7 迁移 settings 后读空）。均为第三方报告、官方未修（截至核查时）。 |

> 上述 issue 是外部数据（GitHub API），本机未安装该插件、未复现其运行行为。

---

## 6. 可安全检测「官方插件是否已安装 / 已启用」的证据来源

### 6.1 明确不可用：`ctx.get('<服务>')`

**官方插件不 provide 任何服务**（§2.1），所以：

- `ctx.get('im-qqbot')`、`ctx.get('dsh-qqbot')`、`ctx.get('@tencent-connect/dsh-qqbot')` 在**已安装且已加载**时同样是 `undefined`；
- 不要用「取不到服务」推断「没装」。**这是本条最重要的否定结论。**

### 6.2 推荐来源（按可靠性排序）

| # | 来源 | 判据 | 证据 / 限制 |
|---|---|---|---|
| 1 | 宿主 `pluginInventory/list` Remote（`@deepseek-ai/dsh-host-plugin-inventory@0.2.1-rc.3`，宿主自带） | 快照中含 `module specifier = @tencent-connect/dsh-qqbot`（bundle patch 的 loader entry `id = im-qqbot`），并给出**生效使能**与 `phase`（`pending/loading/active/failed/unloading/null`） | 包 README 原文：「Clients can call `pluginInventory/list` to display the host's current plugins in load order, including each entry's identifier, module specifier, effective enablement, live phase, and available display text.」另有「read-only snapshot for display and diagnostics: it cannot mutate plugins」。宿主路径 `dsh/node_modules/@deepseek-ai/dsh-host-plugin-inventory`。**第三方客户端插件能否直接调用该 Remote 需 task-2 按其接线方式复核**。 |
| 2 | 同源 HTTP 探针 `GET /qqbot/im-qqbot/bind` | `200` + JSON `{phase:'bound',appId}` / `{phase:'waiting',url,qrSvg,...}` = 官方插件**已加载**；`404` = 未安装/未加载（或 CLI profile 无 `webServer`） | 路由只在插件 `apply()` 中注册（`dist/setup/index.js:51-67,76-90`）；未绑定与已绑定两种 fiber **都会注册**，所以 200 覆盖两种绑定态。官方客户端自己就用它当存活探针：`lib/client.js:944-946` 注释「404（已绑定/未安装）时退避到 30s」。`trusted()` 对无 Origin 的同源请求放行（`bind-routes.js:96-106`）。**本机实测**：`GET http://127.0.0.1:63908/qqbot/im-qqbot/bind → 404`，同端口 `GET / → 401 "dsh web authentication required"`（证明服务存活、路由不存在），记录见 `.scratch/qqbot/probe-host-route.txt`。⚠️ 装好后需再实测一次 200（若被 Host 认证层拦截，改在应用内用同源 `fetch`，与官方客户端一致）。 |
| 3 | profile 静态清单（安装态，非运行时） | `C:\Users\bf410\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 与 `dependencies` 含 `@tencent-connect/dsh-qqbot`；`node_modules/@tencent-connect/dsh-qqbot` 存在；`pnpm-lock.yaml` 有记录 | 本机三处**均为空/不存在**：bundles 见 `package.json:6-16`（9 项，无 QQ 插件）、`node_modules/@tencent-connect` 不存在、`pnpm-lock.yaml` 匹配 `tencent-connect|qqbot` 为 **0 条**。⚠️ 只能证明「装没装」，不能证明「加载成功/已启用」，且依赖宿主安装器是否写入 bundles（task-2 复核）。 |
| 4 | 客户端 slots 标识（客户端半边是否加载） | `settings.section` 存在 `id:"qqbot"`；`sidebar.right.pane.tab` 存在 `key:"im-qqbot/bind"`；`sidebarRightTabs` 存在 `id:"im-qqbot/bind"`/`kind:"qqbot-bind"` | 注册点 `lib/client.js:912-934`。若宿主 `slots` 服务暴露枚举/查询能力，可据此判定客户端插件已注册（能力待 task-2 确认）。 |
| 5 | tools 注册（辅助） | `qqbot_send_file` 恒定注册（`tools` 服务可用时，`dist/media/send-file-tool.js:14,45-49`）；`qqbot_describe_image` 仅 `vision.enabled` | 不能作主判据（视觉工具默认关闭；tools 服务缺失时两者都不注册）。 |
| 6 | 绑定/解绑状态 | 200 的 `phase:"bound"` + 回显 `appId`（非机密）vs `"waiting"` | `bind-routes.js:115-131`；注意 **`appSecret` 永不回传**。 |

**不要使用**：`.plugin-manager/logs/operation-*/pnpm.log`（历史安装日志，非权威）、`.dsh-market/discovery-compatibility-v1.json`（本机该文件检索 `qqbot` 为 0 命中）、猜测进程/端口扫描。

---

## 7. 本机真实状态（2026-10-27 13:03 +08:00 实测）

| 检查项 | 结果 | 证据 |
|---|---|---|
| 宿主版本 | **0.2.1-rc.3** | `D:\dsh\resources\app.asar` → `dsh/package.json`：`name=@deepseek-ai/dsh-desktop-runtime`, `version=0.2.1-rc.3`（用 `.scratch/qqbot/read-asar-pkg.cjs` 只读解析）；`D:\dsh\resources\runtime\primary-runtime\runtime.json` → `"desktopVersion":"0.2.1-rc.3"`；`app-boot/package.json` = `0.2.1-rc.3` |
| desktop profile 是否已装该插件 | **否** | `C:\Users\bf410\.dsh\profiles\desktop\package.json:6-16` 的 bundles 无 `@tencent-connect/dsh-qqbot`；`node_modules/@tencent-connect` 不存在；`pnpm-lock.yaml` 无 `tencent-connect/qqbot`；`cordis.patch.yml` 无 `im-qqbot` 条目；备份 `package.json.bak-20261018-184724` 也无 |
| 已绑定凭据？ | **否**（无 profile patch 条目） | 同上 `cordis.patch.yml` 全文无 `im-qqbot`/`appSecret` |
| 兼容豁免 | **无** | `profiles/desktop/compatibility.json` 不存在 |
| 运行中的 Host 是否已注册 QQ 路由 | **否**（404），且服务存活（`/` → 401） | `.scratch/qqbot/probe-host-route.txt` |
| npm latest / GitHub | 0.5.2 / `main` 已到 0.5.3（未发布；最新 Release 0.5.2，2026-10-13） | registry `dist-tags`；GitHub API `repos/.../releases` |

---

## 8. 对本项目（DSH Memory Vault）的直接含义

1. **不能依赖官方插件提供跨插件 API**：不要设计「调用 QQ 插件 service 发消息/导航」的方案；官方没有这类接口。若要联动，只能：① 消费宿主通用设施（tools / session / agent / 事件）而非 QQ 插件；② 走其 HTTP JSON 路由（同源 + 有限动作）；③ 或由用户/运营侧操作。
2. **不能通过 `ctx.get` 判断其存在**，检测应优先用 `pluginInventory/list` 或 `/qqbot/im-qqbot/bind` 探针（§6）。
3. **导航到「官方 QQ 绑定页」在宿主侧不可靠**：官方绑定页只是它自己的 `settings.section`（`id:"qqbot"`）/ `sidebar.right.pane.tab`（`key:"im-qqbot/bind"`）席位，**没有可被第三方打开的公共路由/导航 API**；第三方插件无法保证能选中或打开它（除非宿主布局服务暴露通用 `selectPanel/openTab`，属 task-2 结论）。若产品需要「打开 QQ 绑定页」按钮，应当降级为文案指引（用户在设置页「QQ 机器人」里操作）。
4. **凭据明文落盘**：如果未来本项目文档要指导用户安装官方 QQ 插件，必须提示 AppSecret 会以明文写入 `<profile>/cordis.patch.yml`，需自行保护 profile 目录权限；不要替用户写入/搬运该凭据。
5. **兼容性表述**：对外文档中不可写「官方声明兼容 0.2.1-rc.3」——官方只写了 0.1.0-rc.8 / 0.2.0-rc.2 的「已验证」；宿主放行 ≠ 官方支持。若要写，应写「宿主 0.2.1-rc.3 可通过安装门槛（peer 下限），但官方未验证 0.2.1 线，且社区有 open 回归报告」。

---

## 9. 复现命令与证据文件清单

### 9.1 证据文件（均在 `.scratch/qqbot/`，gitignore 已忽略）

| 路径 | 内容 |
|---|---|
| `.scratch/qqbot/registry.json` | npm registry 原始 JSON（31,663 字符 / UTF-8 35,133 B；`dist-tags`、7 版本元数据、readme） |
| `.scratch/qqbot/dsh-qqbot-<ver>.tgz` + `extract-<ver>/package/` | 7 个版本 tarball 与解包（0.5.2 共 251 文件） |
| `.scratch/qqbot/versions-summary.json` | 逐版本完整字段汇总（`main`/`types`/`exports`/`dsh`/`peerDependencies`/`dependencies`/`engines`/`files`，以及 `hasClientSection`/`hasClientBundleFile`/`hasCompatibility`/`registryMatchesTarball`） |
| `.scratch/qqbot/probe-host-route.txt` | 本机 Host 路由只读探针输出（404 / 401） |
| `.scratch/qqbot/semver-check.cjs` | 用宿主自带 `semver@7.8.5` 复核 `includePrerelease` 语义 |
| `.scratch/qqbot/read-asar-pkg.cjs` / `extract-asar.cjs` | 只读 asar 解析/提取脚本（校验 `8 + pickleSize` 作为数据起点） |
| `.scratch/qqbot/asar/app-boot/`、`.scratch/qqbot/asar/semver/`、`.scratch/qqbot/asar/host-plugin-inventory/` | 从 `D:\dsh\resources\app.asar` 提取的宿主包（只读） |

### 9.2 关键复现命令

```powershell
# 1) registry
Invoke-WebRequest -UseBasicParsing 'https://registry.npmjs.org/@tencent-connect%2Fdsh-qqbot' -OutFile .scratch/qqbot/registry.json

# 2) 全部版本 tarball（循环）
Invoke-WebRequest -UseBasicParsing "https://registry.npmjs.org/@tencent-connect/dsh-qqbot/-/dsh-qqbot-$v.tgz" -OutFile ".scratch/qqbot/dsh-qqbot-$v.tgz"
tar -xzf ".scratch/qqbot/dsh-qqbot-$v.tgz" -C ".scratch/qqbot/extract-$v"

# 3) 逐版本汇总（生成 versions-summary.json）
node .scratch/qqbot/build-summary.cjs

# 4) 宿主版本（asar 内 package.json）
node .scratch/qqbot/read-asar-pkg.cjs 'D:\dsh\resources\app.asar'

# 5) 宿主兼容性判定代码与 semver 语义
node .scratch/qqbot/extract-asar.cjs 'D:\dsh\resources\app.asar' 'dsh/node_modules/@deepseek-ai/dsh-app-boot' '.scratch/qqbot/asar/app-boot'
node .scratch/qqbot/extract-asar.cjs 'D:\dsh\resources\app.asar' 'dsh/node_modules/semver' '.scratch/qqbot/asar/semver'
node .scratch/qqbot/semver-check.cjs '0.2.1-rc.3' '>=0.1.0-rc.6' '>=0.2.1-rc.2 <0.2.2'

# 6) 运行中 Host 路由探针（只读）
Invoke-WebRequest -UseBasicParsing -SkipHttpErrorCheck 'http://127.0.0.1:63908/qqbot/im-qqbot/bind'
```

### 9.3 上游引用

- npm：<https://www.npmjs.com/package/@tencent-connect/dsh-qqbot>，registry JSON：<https://registry.npmjs.org/@tencent-connect%2Fdsh-qqbot>
- GitHub：<https://github.com/tencent-connect/dsh-qqbot>（org `tencent-connect`，MIT，`main`；核查时 stars 280 / forks 37 / open issues 30）
- 0.5.2 Release：<https://github.com/tencent-connect/dsh-qqbot/releases/tag/0.5.2>（published 2026-10-13T03:41:17Z）
- 上游 `main`（0.5.3，未发布）：<https://raw.githubusercontent.com/tencent-connect/dsh-qqbot/main/package.json>
- 相关 open issue（第三方报告，非官方声明）：#60 <https://github.com/tencent-connect/dsh-qqbot/issues/60>、#58 <https://github.com/tencent-connect/dsh-qqbot/issues/58>

---

## 10. 未决 / 需宿主侧（task-2）复核的点

1. `pluginInventory/list` Remote 对第三方**客户端插件**的可调用方式与鉴权（决定 §6 来源 #1 是否可直接用）。
2. 宿主 `slots` / `sidebarRightTabs` / `sidebarRight` 是否提供枚举能力（决定 §6 来源 #4 是否可编程判定「客户端半边已加载」）。
3. `/qqbot/im-qqbot/bind` 在插件已安装时，经 Host 认证层后是否仍可被同源 fetch 直取 200（本机仅验证了 404 分支）。
4. 若本项目要在 UI 中「打开官方 QQ 绑定页」：需确认 `@deepseek-ai/dsh-client-ui-layout` / `sidebarRight` 是否暴露 `openTab/selectPanel` 给第三方插件（本文件只记录官方的 `right.openTab("qqbot-bind")` 是其自身客户端插件的调用，不是公共 API）。
