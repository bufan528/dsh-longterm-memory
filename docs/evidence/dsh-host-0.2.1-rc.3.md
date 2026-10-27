# DSH Desktop 0.2.1-rc.3 宿主插件机制调研（长期记忆插件视角）

> 调研对象：本机真实宿主 **DSH Desktop 0.2.1-rc.3**（Electron 桌面壳 + 其自带 Node Host）。
> 结论均为该版本实现代码的静态核实，每条附「包名 + 文件 + 行号 + 关键代码/签名」。
> 未做真机 HTTP 调用（需要桌面壳的鉴权 cookie/token），凡未实测处均标 **未验证**。
> 调研不修改任何实现文件；脚本与中间产物都在 `.scratch/`。

## 0. 环境与证据获取方法

### 0.1 宿主版本

| 事实 | 证据 |
|---|---|
| 桌面版 `0.2.1-rc.3` | `D:\dsh\resources\runtime\primary-runtime\runtime.json`：`"desktopVersion": "0.2.1-rc.3"`；asar 根 `package.json`（`@deepseek-ai/dsh-desktop`）与 `@deepseek-ai/dsh/package.json` 均为 `0.2.1-rc.3` |
| 运行时 Node | 同上 runtime.json：`"node": "24.21.0"`；桌面壳用 `resources/runtime/primary-runtime/dependencies/node/bin/node.exe` 启动 Host |
| 宿主实现位置 | `D:\dsh\resources\app.asar`，其中 `/dsh/node_modules/@deepseek-ai/*` 共 549 个 npm 包（含 `scope` 目录），共 18188 个文件；另有一份 `/node_modules/*` 副本 |

### 0.2 提取方法与一个必须知道的坑（重要）

`read` 工具不能读 asar。本调研新写了通用提取器 `.scratch/asar-x.cjs`（CommonJS，因项目 `type: module`），用法：

```powershell
node .scratch/asar-x.cjs --out .scratch/asar-extract --prefix /dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/
node .scratch/asar-x.cjs --list --prefix /dsh/node_modules/@deepseek-ai/dsh-client-modules/   # 只列文件表
```

**asar 数据区起点是 `8 + headerSize`，不是 `16 + jsonLen`。** 现有脚本 `.scratch/asar.cjs`、`.scratch/read-asar.mjs` 用的是 `16 + readUInt32LE(12)`，比正确值小 1 字节：每个提取出的文件都会**多出前一个文件的最后 1 字节、且丢掉自己的最后 1 字节**。JSON 会因此解析失败（812 个 `@deepseek-ai` JSON 中 377 个失败），JS 只丢末尾一个字符而不易察觉。

正确的 Pickle 布局与校验：

```
u32 @0  = 4            (header-size pickle 的 payload 长度)
u32 @4  = headerSize   (JSON pickle payload 长度；8+headerSize = 数据区起点)
u32 @8  = 8 + jsonLen  (字符串 pickle 长度)
u32 @12 = jsonLen      (JSON 文本真实长度；JSON 从偏移 16 开始)
```

修正后 `node .scratch/asar-x.cjs` 提取的 812 个 `@deepseek-ai` JSON **全部可解析**（invalid 0）。本文所有引用都改用修正后的提取物。

### 0.3 辅助证据：同版本 npm 包的 `.d.ts`

asar 里客户端包**没有** `lib/types/*.d.ts`（`files` 声明有，asar 打包只剩 `lib/*.js`）。为了拿到完整类型签名，从 npm 下载了**完全同版本**（`0.2.1-rc.3`）的包解包到 `.scratch/host-pkgs/`（例如 `@deepseek-ai/dsh-client-ui-slots@0.2.1-rc.3`），只读引用；运行期行为仍以 asar 内的 `lib/*.js` 为准。

---

## 1. 客户端槽位 API（`ctx.slots`）

### 1.1 服务由谁提供

| 事实 | 证据 |
|---|---|
| 客户端 Cordis 服务名 **`slots`**，由 `@deepseek-ai/dsh-client-ui-renderer` 提供 | `dsh-client-ui-renderer/lib/client.js:1348` `super(ctx, "slots")`（`SlotRegistry extends Service`） |
| 纯注册语义在 `@deepseek-ai/dsh-client-ui-slots`（**宿主 asar 内没有这个包**，它被内联进 web 前端壳的「平台模块表」，见 §1.6） | 前端 `dsh-web-frontend/dist/assets/index-BXV-oxvX.js`：`"@deepseek-ai/dsh-client-ui-slots": jI` |
| 槽位目录（103 个 slot 的机读契约）随 `@deepseek-ai/dsh-cordis-client-runner` 的 client bundle 下发 | `dsh-cordis-client-runner/lib/client.js`：`const CLIENT_SLOT_API = [ … ]`（本调研抽取为 `.scratch/slot-catalog.json` / `.scratch/slot-catalog.md`，脚本 `.scratch/extract-slot-catalog.cjs`） |

### 1.2 `ctx.slots` 的方法面（本项目实际只用 `inject` / `register`）

来自 `@deepseek-ai/dsh-client-ui-slots@0.2.1-rc.3` 的 `lib/types/index.d.ts` 与 `dsh-client-ui-renderer/lib/client.js` 的 `SlotRegistry`：

```ts
register(options, component): () => void          // 注册一个条目（可选声明子槽位/Store/inject 面）
registerFactory(options, component): () => void   // 可复用 Component Factory
inject(key, callback): () => void                 // 槽位声明存在时运行回调；声明塌陷时销毁
install(renderer) / installLocale(face) / installScope(scope, adapter)   // 壳内部 boot-once
provideRoot(contribution)                         // 提供 root 级标准 hook 数据
renderSlot('root', owner)                         // 仅壳可渲染 root
entries(key) / entriesOfSlot(key) / spec(key) / snapshot(root?) / subscribe(key, fn) / getVersion(key)
```

- `inject(key, callback)` 的语义（`registry.d.ts:111`）：槽位已声明则**同步**运行回调；未声明则等声明提交后运行；声明塌陷销毁回调产物；插件卸载会取消等待并移除贡献。
- 回调可以返回 **generator**，逐个 `yield` disposer（官方插件就是这么写 main 页的，见 §2.2）。
- 条目的 `disposer` 会**递归塌陷它声明的子槽位**（`SlotCore.register` 文档：`lib/types/index.d.ts` 中 `register` 的 JSDoc）。
- 注册错误**在加载期就抛**（fail loud），例如「注册到未声明槽位」「重复声明子槽位」。

### 1.3 槽位四类与共存规则

`SlotKind = 'single' | 'list' | 'keyed' | 'chain'`，`SlotScope = 'root' | 'session-maybe' | 'session'`（`dsh-client-ui-slots/lib/types/index.d.ts:83-85`）。

共存规则由 `@deepseek-ai/dsh-client-ui-slots@0.2.1-rc.3` 的 `SlotCore.register` 实现（`lib/index.js:167-184`）：

```js
const priority = options.priority ?? 0;
const occupantHint = (occupant) => `at priority ${priority}${...} — register at a different priority to shadow it (lowest renders)`;
// single
if (occupant) throw new Error(`single slot "${options.name}" already has a registration ${occupantHint(occupant)}`)
// keyed
if (occupant) throw new Error(`keyed slot "${options.name}" already has an entry for key "${options.key}" ${occupantHint(occupant)}`)
// list
if (occupant) throw new Error(`list slot "${options.name}" already has an entry with id "${options.id}" ${occupantHint(occupant)}`)
```

结论（**关键**）：

1. **同一「cell」再注册、且 priority 相同（默认 0）→ 加载期抛错**，不是静默覆盖。
2. 想覆盖已占用的 cell 必须显式给**不同 priority**（升序，最小者渲染）→ 这叫 shadowing（`entriesOfSlot` 取每 cell 的最小 priority 存活条目）。
3. **不同 cell 天然共存**：`keyed` 一个 key 一个 cell，`list` 一个 id 一个 cell。
4. 因此「另一个插件也注册 `main`」只有在**用了同一个 key 且都是默认 priority** 时才会炸；不同 key 各占一格，互不影响。

### 1.4 `main` 槽位的 key 语义

目录条目（`.scratch/slot-catalog.json` → `main`）：

```json
{
  "key": "main", "kind": "keyed", "scope": "root",
  "keyDomain": "open: any string the owner dispatches (no compile-time key set), already taken: conversation",
  "declaredBy": "an entry in 'root' (client-ui-layout), so it exists while that entry is mounted",
  "occupants": ["client-ui-conversation ConversationPanel key 'conversation'",
                "client-ui-plugin-manager PluginManagerPage",
                "client-ui-schedule TaskManagerPage"],
  "replaceRisk": "shadows-shipped-ui",
  "registerOptions": [{ "name": "key", "requirement": "required", "type": "string",
    "doc": "Your cell key: the entry renders where the owner dispatches this exact key. Registering an already-occupied key replaces that occupant." }]
}
```

- **允许任意字符串 key**（编译期没有封闭 key 集合）；唯一被占用的保留 key 是 `conversation`（会话本身）。
- key 的消费者是 `ui-layout` 的 `MainPanel`：`renderSlot("main", {}, { entryKey: usePanelInfo(i => i.activePanelId) ?? "conversation" })`（`dsh-client-ui-layout/lib/client.js:118-119`）。
- 目录里 `replaceRisk: "shadows-shipped-ui"` 与 doc 里「占用即替换」是**不精确的简写**：真正的规则是 §1.3 的 priority 槽位遮蔽/抛错。

### 1.5 `sidebar.panellist` 注册项字段语义

目录条目：

```json
{
  "key": "sidebar.panellist", "kind": "list", "scope": "root",
  "declaredBy": "an entry in 'sidebar' (client-ui-sidebar)",
  "occupants": ["client-ui-plugin-manager PluginsPanelIcon", "client-ui-schedule TaskManagerIcon"],
  "replaceRisk": "none",
  "registerOptions": [
    {"name":"id","requirement":"required","type":"string","doc":"Your cell key. Use an id of your own: a fresh id is added beside the shipped entries, while reusing a shipped id puts you in THAT cell and replaces it."},
    {"name":"order","requirement":"optional","type":"number","doc":"Position among the entries, ascending (default 0)."},
    {"name":"label","requirement":"optional","type":"string | (() => string)","doc":"Display text where the owner projects one (nav rows, tabs). A thunk is re-read on every projection, so localized text follows the active locale without re-registering."}
  ]
}
```

宿主侧实际投影（`dsh-client-ui-sidebar/lib/client.js:567-584`）：

```js
const syncPanels = () => {
  const next = ctx.slots.entriesOfSlot("sidebar.panellist").map(({ options }) => {
    const id = options.id;
    return { id, order: options.order ?? 0, label: resolveSlotLabel(options.label) ?? id };
  }).sort((a, b) => a.order - b.order);
  ...
};
ctx.effect(() => ctx.slots.subscribe("sidebar.panellist", syncPanels), "ui-sidebar: panel entries");
ctx.effect(() => ctx.locale.subscribe(syncPanels), "ui-sidebar: panel labels");
```

字段语义：

| 字段 | 语义（宿主实测行为） |
|---|---|
| `id` | 既是 list cell 主键，**又是**该行点击后 `ctx.layout.selectPanel(id)` 的目标 `main` key（见 §2.1）。重复使用同一 id + 同 priority 会抛错；不同 priority 则遮蔽。 |
| `order` | 仅用于侧边栏**显示排序**（升序，缺省 0，`sort` 稳定 → 同 order 按注册先后）。**与 main 无关**。 |
| `label` | 字符串或 thunk；宿主每次投影都 `resolveSlotLabel()` 重新求值（thunk 可跟随语言切换）；缺省回退为 `id`。 |
| （额外）`priority` | 非 kind 专属但也接受，用于遮蔽同 id 条目（§1.3）。 |
| 组件 props | 宿主 owner 面：`{ size: number; active: boolean }`（目录 `ownerProps`：`SidebarPanelIconOwnerProps`）。 |

### 1.6 客户端平台模块表（seed table，2026-10-27 实测）

web 前端壳里冻结的模块表（`dsh-web-frontend/dist/assets/index-BXV-oxvX.js`）：

```js
{react, "react/jsx-runtime", "react-dom", "react-dom/client",
 "@deepseek-ai/cordis", zod, "@tanstack/react-virtual",
 "@deepseek-ai/dsh-client-store", "@deepseek-ai/dsh-client-ui-slots",
 "@deepseek-ai/dsh-client-ui-primitives", "@deepseek-ai/dsh-client-ui-dockkit"}
```

即：第三方 client bundle 在 0.2.1-rc.3 里**可以** `require('@deepseek-ai/dsh-client-ui-slots')` 等 11 个基线模块；本项目仍只用 `react` / `react/jsx-runtime`（更保守，见 `docs/architecture.md` §2.2，该处「只有 2 个」的表述与本版本实测不符，属文档滞后，不影响实现）。

---

## 2. 插件页面如何注册与切换

### 2.1 侧边栏 ↔ 主面板的耦合（唯一的页面切换机制）

1. 点击侧边栏行 → `selectPanel(id)`：`dsh-client-ui-sidebar/lib/client.js:598` `selectPanel: (id) => { ctx.layout.selectPanel(id); }`。
2. `ctx.layout.selectPanel` 的实现（`dsh-client-ui-layout/lib/client.js:452-499`，`LayoutController`）：

```js
selectPanel(panelId) {
  if (panelId !== null && !this.hasMainPanel(panelId))
    throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`);
  this.navigation.abort();
  this.panels.selectPanel(panelId);      // 写 root store 的 panelInfo.activePanelId
}
```

3. `hasMainPanel` 的判定（同文件 `:615-620`）：

```js
ctx.slots.entries("main").some((entry) => entry.options.key === id)
```

4. 渲染：`MainPanel` 用 `activePanelId ?? "conversation"` 去 `renderSlot('main', {}, { entryKey })`。
5. 选中值可通过 `ctx.layout.panelInfo`（`HostObservable<{ activePanelId: MainPanelId | null }>`）订阅。

**所以「页面注册」= 用同一个字符串同时注册 `sidebar.panellist.id` 与 `main.key`**；本项目 `PANEL_ID = 'longterm-memory'`（`src/client/sidebar-entry.ts:16`）正是这么接的（`src/client/index.ts:78-101`）。

### 2.2 官方插件页面的标准写法（可直接照抄）

`dsh-client-ui-plugin-manager/lib/client.js:4411-4484`：

```js
ctx.slots.inject("main", function* () {
  const handle = createNavigationStore(), instance = handle.create();
  ...
  yield ctx.slots.register({
    name: "main", key: PANEL_ID, locale: NS, store, inject: () => face,
    children: { "plugins.add.actions": {kind:"list",scope:"root"}, "plugins.tab": {...}, ... }
  }, PluginManagerPage);
  yield ctx.layout.panelInfo.subscribe(() => {
    if (ctx.layout.panelInfo.getSnapshot().activePanelId !== "plugins") instance.actions.setView({ kind: "list" });
  });
  const disposeNavigation = ctx.reflect.provide("pluginNavigation", {
    openList: () => { ctx.layout.selectPanel(PANEL_ID); instance.actions.setTab("installed"); instance.actions.setView({kind:"list"}); },
    openBundle: (packageName) => { ctx.layout.selectPanel(PANEL_ID); instance.actions.setTab("installed"); instance.actions.setView({kind:"package", name: packageName}); },
  });
  yield () => { disposeNavigation(); };
});
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 0, label: () => t("panel"), locale: NS }, PluginsPanelIcon));
```

要点：`inject` 回调可以是 generator → 一次声明 store + main 条目 + 订阅 + 对外服务；卸载时统一清理。

### 2.3 本项目 main 页与其它插件的冲突分析

- 本项目 `main` key = `longterm-memory`，`sidebar.panellist.id` = `longterm-memory`，priority 缺省 0。
- 其它任何插件只要 **main key ≠ `longterm-memory`**，则各自一个 keyed cell，**共存、互不遮蔽**（`entriesOfSlot('main')` 每 key 取最小 priority 的一条）。
- 只有当另一个插件也用 `key: 'longterm-memory'` **且** priority 0 时才会**加载期抛错**（`keyed slot "main" already has an entry for key "longterm-memory" at priority 0 (registered by …) — register at a different priority to shadow it`）。换言之：**不会互相顶掉，最坏是两边都加载失败（fail loud）**，且错误信息会点名对方 registrant。
- `sidebar.panellist` 同理：id 冲突同 priority → 抛错；order 只影响显示顺序。

---

## 3. 客户端导航 API（重点：能否跳到别的插件的页面）

### 3.1 有公开的导航服务：`ctx.layout`（`ILayout`）

`@deepseek-ai/dsh-client-ui-layout` 通过 `ctx.reflect.provide("layout", layout)` 暴露（`lib/client.js:622`），类型见同版本 npm 包 `lib/types/client/service.d.ts`：

```ts
export interface ILayout {
  readonly panelInfo: HostObservable<PanelInfo>;          // { activePanelId: MainPanelId | null }
  selectPanel(panelId: MainPanelId | null): void;         // null = 回到会话；未注册的 key 抛错
  beginNavigation(): AbortSignal;                         // 异步导航的取消信号
  toggleSidebar(): void;
  openRightbar(track: boolean, fullscreen: boolean): void;
  closeRightbar(): void;
}
```

第三方客户端插件可以 `inject: ['layout']`（官方 `ui-sidebar` 就是这么用：`lib/client.js:598`、`dsh-client-ui-plugin-manager/lib/client.js:4462`）。

**结论 1：可以**。第三方插件能从自己的页面跳到另一个插件注册的 `main` 页面：

```js
// 在自己的 client 插件里
export const inject = ['slots', 'layout']
// key 已知时直接跳；未注册会 throw，务必 try/catch
try { ctx.layout.selectPanel('other-plugin-key') } catch { /* 目标插件未安装/未启用 */ }
```

**发现目标 key 的合法办法**（都是公开面）：

```js
// 1) 枚举当前已注册的 main 条目（含诊断用 registrant）
ctx.slots.entries('main').map((e) => ({ key: e.options.key, by: e.registrant }))
// 2) 读当前选中
ctx.layout.panelInfo.getSnapshot().activePanelId
```

`registrant` 来自 `dsh-client-ui-renderer/lib/client.js:1605`：`const registrant = options.registrant ?? this.ctx.fiber?.name` —— 用插件（client module）名做启发式匹配可行但**不是稳定契约**（属于诊断字段）。

### 3.2 约定式跨插件导航：`pluginNavigation`（Plugins 页专用）

`dsh-client-ui-plugin-manager` 用 `ctx.reflect.provide("pluginNavigation", { openList, openBundle })` 对外提供（`lib/client.js:4465-4480`），**第一方插件 ui-entry-customization 正是消费者**（`dsh-client-ui-entry-customization/lib/client.js:95-115`）：

```js
const inject = ["slots", "locale", "pluginNavigation", "uiWorkspace"]
...
ctx.pluginNavigation.openList()
```

第三方插件可直接 `ctx.get('pluginNavigation')`（无类型合并，返回 `unknown`）或 `inject: ['pluginNavigation']`，用 `openBundle('<npm 包名>')` 打开「插件页 → 该 bundle 的详情页」。**这是本机唯一存在的「跨插件页面跳转」公开服务**。

### 3.3 右侧栏页签：`ctx.sidebarRight` / `ctx.sidebarRightTabs`

`dsh-client-ui-sidebar-right` 用 `ctx.reflect.provide` 暴露两个服务（`lib/client.js:4965-4966`）：

```js
const disposeRegistry = ctx.reflect.provide("sidebarRightTabs", tabs);   // SidebarRightTabRegistry
const disposeService  = ctx.reflect.provide("sidebarRight", controller); // SidebarRightController (跨插件右侧栏面)
```

`SidebarRightController` 的公开导航方法（`lib/client.js:2226-2290`）：

```ts
tabsIn(sessionId): TabRecord[]
openResource(address: `dsh-resource://<type>/…`, options?): void
openTab(kind: string, options?): void          // 按「页类型 kind」打开右侧栏页
// 以及 openResourceIn / openTabIn / closeIn（内部 Tab 域用，需显式 sessionId）
```

**关键约束**（`lib/client.js:2590-2600`）：

```js
require() {
  const sessionId = this.mounted.getSnapshot();
  const actions = sessionId === void 0 ? void 0 : this.actionsFor(sessionId);
  if (sessionId === void 0 || actions === void 0) throw new Error("sidebarRight: no session surface is mounted");
  return { sessionId, actions };
}
```

即 `openTab(kind)` 只在**当前有一个「在屏会话」**（主面板为会话且已选中 session）时才成功，否则抛 `sidebarRight: no session surface is mounted`。因此从长期记忆页（`main` 页，非会话）跳到 QQ 的右侧栏绑定页，需要：`ctx.layout.selectPanel(null)` 回到会话 → 等一次渲染/store 提交 → `ctx.get('sidebarRight').openTab('<qq 的页 kind>')`。**时序脆弱，属于「能但不保证」**。

### 3.4 关于「打开官方 QQ 插件的绑定 UI」——结论

| 目标 | 可行性 | 依据 / 做法 |
|---|---|---|
| `settings.section id=qqbot`（设置页里的 QQ 分区） | **无公开 API**。`settings` 相关槽位是 `settings.section` / `settings.launcher` / `settings.trigger` 等**列表槽位**，宿主只暴露 `ctx.layout.selectPanel('plugins')` 之类的 **main** 级导航；`ctx.layout` 没有 `openSettings(sectionId)`。前端设置页的打开状态属于 `client-ui-settings` 内部 store。 | `ILayout` 方法表（§3.1）无设置入口；`dsh-client-ui-settings` 未 provide 任何导航服务（grep 无 `reflect.provide`） |
| `sidebar.right.pane.tab key=im-qqbot/bind`（若 QQ 注册成右侧栏页类型） | **有条件可行**：`ctx.sidebarRight.openTab('<kind>')`，但必须先在屏会话，且 kind 必须是目标插件注册的 tab 类型（kind 名 = `sidebar.right.pane.tab` 的 key，**未实测 QQ 的注册值**）。 | §3.3 |
| 任何 `main` 页（含第三方注册的 QQ 页面） | **可行**：`ctx.layout.selectPanel(key)`，key 未知时用 `ctx.slots.entries('main')` 枚举（§3.1）。 | §3.1 |
| 把「跳转」做成可靠体验 | **推荐替代**：① 只给文字指引「请在左侧栏点击 X / 在 设置 → 插件 中打开 QQ」；② 若与 QQ 插件有协作关系，约定它 `ctx.reflect.provide('qqbotNavigation', {openBind})`，我方 `ctx.get('qqbotNavigation')?.openBind()`（这正是 plugin-manager → ui-entry-customization 的成熟模式）。 | §3.2 |

**给 lead 的直答**：宿主**有** `ctx.layout.selectPanel(id)` 这一合法 main 级导航 API，也**有** `ctx.pluginNavigation.openBundle(pkg)` 与 `ctx.sidebarRight.openTab(kind)`；但 **settings 分区没有公开打开 API**，右侧栏 `openTab` 依赖「在屏会话」且 kind 未验证。因此对官方 QQ 的绑定 UI：**main 页可跳，右侧栏页「可尝试但不可靠」，设置分区「做不到」，现实做法是提示用户手动点击。**

---

## 4. 跨插件状态查询

### 4.1 宿主 Cordis：`ctx.get` / `ctx.provide` 就是跨插件探测机制

`@deepseek-ai/cordis`（asar 内带源码 `/dsh/node_modules/@deepseek-ai/cordis/src/`）：

```ts
// src/reflect.ts:233
get(name: string, strict = true)      // 服务未提供 / 提供者 fiber 非 ACTIVE → undefined；不抛
// src/reflect.ts:277
provide(name: string, value?, check?) // 用当前 fiber 的生命周期注册服务；重名抛错
```

- `strict` 默认 true：只返回「提供者 fiber 正在 ACTIVE」的服务 —— 这正是**判断「插件已加载/已启用」的可靠语义**。
- `Service` 基类构造即 `self.ctx.reflect.provide(name, self, …)`（`src/service.ts:57`）→ 任何 `Service` 子类（含 Typert Remote 服务）都能被 `ctx.get` 拿到。
- 本项目已在用：`src/host/dsh/routes.ts:58` `ctx.get('webServer')`。

### 4.2 宿主侧两份官方「插件状态」服务

| 服务 | 类型合并 | 方法（读） | 证据 |
|---|---|---|---|
| `pluginManager` | **有** `declare module '@deepseek-ai/cordis' { interface Context { pluginManager: PluginManager } }` | `listPlugins(): Promise<PluginInfo[]>`；`listBundles(): Promise<BundleInfo[]>`；`listVersionExemptions()`；`registries()` | `dsh-plugin-manager/lib/types/index.d.ts:31-36, 82, 88`；`typert.host.js:595,580` |
| `pluginInventory` | **无** Context 合并（README 明说「deliberately declares no same-process Cordis Context merge」），但运行期仍是 `TypertRemoteService`（`super(ctx, "pluginInventory")`）→ `ctx.get('pluginInventory')` **能拿到实例** | `list(): Promise<PluginInventorySnapshot>` | `dsh-host-plugin-inventory/lib/index.js:97,113`；`README.md:29` |

`PluginInfo = PluginInventoryEntry & { patchId } | { readOnlyReason }`（`dsh-plugin-manager/lib/types/types.d.ts:33`），核心字段：

```ts
{ entryId, moduleName, enabled, fiberPhase: 'pending'|'loading'|'active'|'failed'|'unloading'|null, meta?: {title,description,icon} }
```

`BundleInfo`（同文件 `:52`）：`{ name, official, availability:'installation'|'profile'|'missing', version?, enabled, installed, removable, rows: BundleRowInfo[], error? }`。

宿主侧判定示例（第三方 Host 插件可直接用）：

```js
const inventory = ctx.get('pluginInventory')
const snap = await inventory.list()                  // 读 Loader 实时状态（无缓存）
const qq = snap.entries.find((e) => e.moduleName === '@tencent-connect/dsh-qqbot')
const installedAndOn = qq?.enabled === true && qq?.fiberPhase === 'active'
// 或者 bundle 维度：
const bundles = await ctx.get('pluginManager').listBundles()
const b = bundles.find((x) => x.name === '@tencent-connect/dsh-qqbot')   // b.installed / b.enabled
```

### 4.3 客户端插件能否读「已安装/已加载插件清单」——**能**

机制：客户端 `ctx.remote`（`@deepseek-ai/dsh-api-gateway/client` 提供，服务名 **`remote`**）上挂了所有生成的 Remote 命名空间；`@deepseek-ai/dsh-api-remotes` 的 client 半在激活时**一次性** `$mount` 全部贡献（`dsh-api-remotes/lib/client.js:23759-23797`，`inject = ["remote"]`），其中包含 `pluginInventory/list` 与 `pluginManager/listPlugins|listBundles`（`api-remotes/lib/client.js:11828, 10965, 10947`）。

第一方消费者（可直接照抄）：

```js
// dsh-client-ui-settings-plugin-inventory/lib/client.js:726-741
const inject = [ /* slots, locale, */ "remote", "remote.pluginInventory" ];
const result = await ctx.remote.pluginInventory.list();
if (!result.ok) throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`);
const snapshot = result.value;                 // { entries: [...], managementAvailable?, agentPresets? }
```

> 注意返回形状：客户端 unary 调用统一折叠为 `RemoteResult<T> = { ok: true, value } | { ok: false, error }`（`dsh-api-gateway/README.md:61`），**不抛**（carrier 失败也进 `ok:false`）。

`dsh-client-ui-plugin-manager/lib/client.js:4357-4363` 的 inject 列表即完整客户端可用命名空间：

```js
const inject = ["slots", "locale", "layout", "remote", "remote.pluginManager", "remote.pluginInventory", "remote.pluginRegistryProbe", ...]
```

判定示例（客户端，长期记忆页可直接用）：

```js
ctx.inject(['remote.pluginInventory'], async (scoped) => {
  const res = await scoped.remote.pluginInventory.list()
  if (!res.ok) return { known: false }
  const row = res.value.entries.find((e) => e.moduleName === '@tencent-connect/dsh-qqbot')
  // row?.enabled === true && row?.fiberPhase === 'active'  → 已安装且已启用且运行中
})
```

**HTTP 路径（确切）**：unary Remote 走 `connection.rpc.call('/api', endpoint, payload)` → `POST ${channel}/${endpoint}`：

```js
// dsh-client-connection/lib/client.browser.js:1212-1221
async call(channel, endpoint, payload, signal) { ... const response = await send(`${channel}/${endpoint}`.slice(1), {...}) }
// 宿主侧匹配：dsh-client-connection/lib/index.js:14 API_PATH="/api"；:926 endpointFromPath(channel, pathname)
```

即：

| 端点 | HTTP |
|---|---|
| `pluginInventory/list` | `POST /api/pluginInventory/list`（JSON 信封；宿主 `dsh-client-connection` 的 `/api` **prefix** 路由，需桌面壳鉴权） |
| `pluginManager/listPlugins` | `POST /api/pluginManager/listPlugins` |
| `pluginManager/listBundles` | `POST /api/pluginManager/listBundles` |
| Remote 流（含 `$events`） | `WebSocket /api/remote.mux`（`dsh-api-gateway/lib/client.browser.js:106`） |

> 本调研未真机抓包（桌面壳用 `authenticatedUrl` 发一次性 token，未验证手动构造请求的鉴权细节）；**路径来自代码常量与路由拼装，等级为「代码级确定」，网络层未验证**。

### 4.4 变更通知（事件）

宿主 Cordis 事件（`dsh-plugin-manager/lib/types/types.d.ts:228-251`）：`plugin-manager/changed`、`plugin-manager/install-log`、`plugin-manager/install-state`。客户端可 `$on` 订阅（第一方用法 `dsh-client-ui-plugin-manager/lib/client.js:4387-4391`：`ctx.remote.$on("plugin-manager/changed", refresh)`）。

`pluginInventory` **没有**变更订阅（README 明确：point-in-time snapshot，无 history）。客户端插件若 `inject` 了 `remote.pluginManager`，可订阅 `plugin-manager/changed` 后重新 `list()`。

### 4.5 关于 `@tencent-connect/dsh-qqbot` 的检测依据

| 维度 | 判定 | 备注 |
|---|---|---|
| 「装了没有」 | `pluginManager.listBundles()` → `name === '@tencent-connect/dsh-qqbot'` → `installed` / `availability` | 最稳（bundle 维度，即使被禁用也在列表里） |
| 「启用没有」 | 同上 `enabled`；或 `pluginInventory.list()` 的 `entries[].enabled` | `enabled` 已含祖先 group 禁用 |
| 「真的跑起来没有」 | `entries[].fiberPhase === 'active'` | `strict` 语义的服务可用性同理 |
| 宿主侧最轻量 | `ctx.get('<qq 提供的服务名>') !== undefined` | 只要知道它 provide 的服务名；未知服务名时用前两行 |

> QQ 插件到底 provide 什么服务名/是否注册 client 页面，属 task-1（`docs/evidence/qq-official-plugin.md`）范围，本文不推断。

---

## 5. Profile 与 bundle：插件加载链路

### 5.1 组合顺序（代码级）

`@deepseek-ai/dsh-app-boot/lib/index.js:484-505` 的模块文档 + `:1015-1051` 的实现：

```
空 entry 列表
  → 按 profile package.json 的 dsh.profile.bundles 顺序，逐个 bundle：
       读取 bundle 的 package.json → 要求 dsh.bundle.patch（一个文件或文件数组）
       → 先 evaluatePluginCompatibility(bundleManifest, exemptions)，不兼容则**跳过该 bundle**（记 skippedBundles，不 fatal）
       → 读取并逐个应用 patch 文件
  → profile 自己的 cordis.patch.yml
  → 启动器附加层（--patch 文件、命令行派生 patch）
```

```js
// dsh-app-boot/lib/index.js:1015-1049
function loadProfileDirectory(binName, dir, installAnchor, options = {}) {
  const bundles = dropRetiredBundles(dir, readProfileManifest(binName, dir)).dsh?.profile?.bundles ?? [];
  ...
  for (const packageName of bundles) try {
    const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir);   // 两段解析：安装目录优先，再 profile
    const bundleManifest = readProfileManifest(binName, packageDir);
    const bundle = bundleManifest.dsh?.bundle;
    if (bundle === undefined) throw new Error(...declares no dsh.bundle...);
    const issue = evaluatePluginCompatibility(bundleManifest, exemptions);
    if (issue !== void 0 && !issue.exempted) throw new Error(pluginCompatibilityWarning(issue));
    const patchPaths = bundlePatchPaths(packageDir, bundle);
    const patches = patchPaths.flatMap((patchPath) => loadOverlayPatches(binName, patchPath));
    layers.push({ packageName, packageDir, patchPaths, patches });
  } catch (error) { skippedBundles.push({ packageName, reason: String(error) }); }
  const patchPath = join(dir, PROFILE_PATCH_FILENAME);     // cordis.patch.yml:509
  const patches = options.userLayer !== false && existsSync(patchPath) ? loadOverlayPatches(binName, patchPath) : [];
  return { name: basename(dir), dir, layers, patchPath, patches, skippedBundles };
}
```

单行的最终门禁：`prepareProfileEntries` → `preflight`（`:2305-2347`）对**每个组合后的 row** 再算一次 `evaluatePluginCompatibility`，不通过则 `row.disabled = true` 并打印 `disabling profile plugin …`（不是抛错，是禁用该行）。

### 5.2 本项目在真实宿主的链路（本机实证）

1. `C:\Users\bf410\.dsh\profiles\desktop\package.json`：

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
  "@deepseek-ai/dsh-experimental-agent-team-profile", "dsh-whale-widget",
  "dsh-longterm-memory", "dshmarket", "dsh-context", "dsh-better-sidebar", "@linxin666/dsh-liangshen"] } },
"dependencies": { "dsh-longterm-memory": "link:D:/dsh-memory-vault", ... }
```

2. 本项目 `package.json`：`dsh.bundle.patch = "./cordis.patch.yml"`（`cordis.patch.yml` 里 `insert` 出 `id: longterm-memory` 行），`main = ./lib/host/index.js` → Loader 把它当普通 Cordis 插件 import。
3. 浏览器半：`dsh.client = { platform: "web", immediately: true, inject: ["@deepseek-ai/dsh-client-ui-slots","@deepseek-ai/dsh-client-locale"] }` → `dsh-client-modules` 的 node 半扫描 Loader 条目中的 `dsh.client` 声明，把 `lib/client.js` 作为 `/plugins/<id>/client.js` 提供（`dsh-client-modules/lib/index.js:202 PLUGIN_ROUTE = "/plugins"`，`:563-568` 注册 prefix 路由），并把 boot graph 注入 index.html。
4. `cordis.patch.yml` 的**覆盖机制**：patch 是「按 id 定位 + 后层覆盖前层」；且**一行的 `config` 会被整体替换**而不是深合并（`dsh-base/cordis.patch.yml` 顶部注释、`dsh-web-app/cordis.patch.yml` 顶部注释都写明）。用户层在最后 → 用户可在 profile 的 `cordis.patch.yml` 用 `- id: longterm-memory` + `config:` 覆盖本插件默认值，无需改插件文件。

### 5.3 多 profile：是否共享实例/配置目录/Vault 路径

| 维度 | 结论 | 证据 |
|---|---|---|
| Desktop 实际用哪个 profile | **只启动 `desktop`**，`profiles/web`、`profiles/e2e` 不会被桌面壳加载（只有显式 `dsh --profile web` 才用） | `app.asar` 根 `lib/main.js:79-84` `resolveDesktopPaths` → `profile: join(dshHome,"profiles","desktop")`；`dsh-desktop-host/lib/index.js:224-232` `loadProfileDirectory("dsh", projectDir, installAnchor)` → `runProfile({ profile: "desktop", … })` |
| 插件实例 | **每个 profile 独立**：每个 profile 是独立目录、独立 `node_modules`、独立 patch 层，Desktop 与 CLI 各起一个 Host 进程（`spawn(node, [entry, runtimeDir, projectDir, …])`，`lib/main.js:3794-3811`）→ 不共享实例 | 同上；`C:\Users\bf410\.dsh\profiles\{desktop,web,e2e}\` 各自有 `package.json`/`node_modules`/`cordis.patch.yml` |
| 配置目录 | 插件配置在**各 profile** 的 `cordis.patch.yml`（profile 级）；插件自己的持久化设置由本插件写在 Vault 内（跨 profile 共享 Vault 时共享） | §5.2；本项目 `src/host/core/service.ts` 持久化 delta 设置 |
| Vault 路径 | **默认跨 profile 共享**：本插件发现逻辑落在 `<home>/Documents/DSH Memory`（或 `DSH_MEMORY_DOCUMENTS_DIR`、OneDrive Documents），**不在 `$DSH_HOME/profiles` 下**；显式 `vaultPath` 才会分叉 | `src/host/core/discover.ts:175-213`（`homedir()` + `Documents` + `DEFAULT_VAULT_FOLDER`，env 覆盖） |
| DSH home | 桌面与 npm 安装的 dsh 共享 `$DSH_HOME`（缺省 `~/.dsh`）；Desktop 仅新增 `profiles/desktop`、`dsh-runtimes/` 等 | `lib/main.js:25-69` `DSH_HOME` 解析 |
| 并发安全 | 两个 profile 同时指向同一 Vault 时，本插件靠跨进程文件锁 + 原子写串行化（`src/host/core/fsx.ts`），但**没有**宿主级保证 | 本项目实现；宿主未提供跨进程存储 |

---

## 6. 宿主版本兼容性校验

### 6.1 宿主**不读** `dsh.compatibility.dshReleases`

对整个 182 MB 的 `app.asar` 做字节级全量搜索：字符串 `dshReleases` **出现 0 次**；`pluginInventory` 47 次、`engines.dsh` 73 次、`evaluatePluginCompatibility` 23 次（校验方法见 §0.2 脚本法）。

→ **本项目 `package.json` 里的 `dsh.compatibility.dshReleases` 对 0.2.1-rc.3 宿主完全无效**（既不拦安装也不拦加载）；它只能作为文档/市场展示字段（若市场索引确实读它，属市场服务端行为，**未验证**）。

### 6.2 真正生效的是 `engines.dsh`（否则 dsh peerDependencies）

`@deepseek-ai/dsh-app-boot/lib/index.js:252-327`（`lib/types/plugin-compatibility.js`）：

```js
function satisfies(runtimeVersion, range) {
  return range.trim() !== "" && semver.satisfies(runtimeVersion, range, { includePrerelease: true });   // :276-278
}
function unmetRequirements(fields, runtimeVersion) {
  const engines = Object.hasOwn(fields, "engines") ? objectOf$1(fields.engines, "Plugin manifest engines") : {};
  if (Object.hasOwn(engines, "dsh")) {                       // engines.dsh 存在 → 它单独决定，peer 全部忽略
    const range = engines.dsh;
    if (typeof range !== "string") throw new Error("Plugin manifest engines.dsh must be a string");
    return satisfies(runtimeVersion, range) ? {} : { "engines.dsh": range };
  }
  if (!Object.hasOwn(fields, "peerDependencies")) return {};
  for (const [name, range] of Object.entries(dependencies)) {
    if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;   // 只认 @deepseek-ai/dsh*
    if (!satisfies(runtimeVersion, ["workspace:^","workspace:~","workspace:*"].includes(range) ? runtimeVersion : range)) unmet[name] = range;
  }
  return unmet;
}
function evaluatePluginCompatibility(manifest, exemptions = {}, runtimeVersion = getDshRuntimeVersion()) { … }  // :311
```

关键语义：

1. **`engines.dsh` 一旦声明，就由它单独裁决**，同一 manifest 里的 `peerDependencies["@deepseek-ai/dsh*"]` 不再参与。
2. **`includePrerelease: true`** —— 预发布版本参与范围比较（这是本项目能声明 `-rc` 范围的前提）。
3. runtimeVersion 取自 **`dsh-app-boot/package.json` 的 version**（`getDshRuntimeVersion()`，`:272-276`），本机 = `0.2.1-rc.3`。
4. **空字符串 range 视为不满足**（`range.trim() !== ""`）。
5. 不满足时的行为：bundle 层 → **该 bundle 整层被跳过**（`skippedBundles`，stderr 打印原因，插件根本不加载）；row 层 → 该行 `disabled: true`。
6. 另有「精确版本豁免」机制：`<profile>/compatibility.json` / `plugin_manager set_version_exemption`（`dsh-plugin-manager/lib/types/types.d.ts:9-16` `IncompatiblePlugin`、README:72），豁免后仍可运行（风险自担）。

### 6.3 本项目的判定结果

- 本机 runtimeVersion = `0.2.1-rc.3`（§0.1）。
- 本项目声明：`"engines": { "node": ">=20", "dsh": ">=0.2.1-rc.2 <0.2.2" }`。
- 用**宿主自带的 semver 包**（asar 内 `/dsh/node_modules/semver`，version 7.8.5）按宿主的 `{ includePrerelease: true }` 实测：

```
satisfies('0.2.1-rc.3', '>=0.2.1-rc.2 <0.2.2', {includePrerelease:true}) === true
satisfies('0.2.1-rc.3', '>=0.2.1-rc.4',          {includePrerelease:true}) === false
```

（`0.2.1-rc.3 >= 0.2.1-rc.2` 成立；`0.2.1-rc.3 < 0.2.2` 成立，因为 rc.3 < 0.2.1 < 0.2.2。）

**结论：0.2.1-rc.3 + `engines.dsh: ">=0.2.1-rc.2 <0.2.2"` 判定为兼容**，桌面 profile 的 bundle 层不会被跳过、row 不会被禁用。

> 文档矛盾提示：`@deepseek-ai/dsh-package-manifest/README.md`「Known Limitations」写「Current installers and loaders do not enforce … `engines.dsh`」，与 `dsh-app-boot` 的实际代码（本机 0.2.1-rc.3）相反。**以代码为准**：加载期确实强制。

---

## 7. 顺带记录：`dsh-client-ui-secret-mask` 与 `dsh-credentials`

| 包 | 用途（该版本） | 对本插件的含义 |
|---|---|---|
| `@deepseek-ai/dsh-client-ui-secret-mask` | **纯浏览器显示层**：在「已发送的用户消息」里把识别到的凭据（`sk-…`、`ghp_…`、`AKIA…`、JWT、私钥块、URL 密码等）按格式掩码显示（保留前 8 字符，其余画 `*`），提供逐值「眼睛」显隐；**只改绘制，不改消息文本、复制内容、模型输入**（README:12, 28-45, 88）。实现为注册一个 UserText matcher `secret` + keyed 槽位 `conversation.user.text.node` 渲染器。 | **不会**自动遮蔽本插件管理页/记忆正文里的凭据（其 Known Limitations 明说只有 UserText 调用方生效）。本插件必须自己做凭据识别与展示策略（现有 `redactSecrets` 即在入库侧拒绝/脱敏，方向正确）。 |
| `@deepseek-ai/dsh-credentials` | 宿主**凭据存储缝**：`ctx.credentials`。`credentialRef('DEEPSEEK_API_KEY')` 引用 + `resolve/describe/set/unset`；`credentialKey('<owner>/<id>')` 记录 + `readRecord/describeRecord/listRecords/modifyRecord/deleteRecord`。**`describe*` 只返回 `{configured, source?, writable, kind?}`，永不返回值**；本机默认本地存储为 `~/.dsh/.credentials.yaml`（`dsh-credentials-local`，README:39-58, 74-79）。 | 若本插件要保存「第三方凭据类」配置（如别的插件的 AppSecret），**正确做法是 `ctx.credentials`**（`describe` 只显示「已配置/来源/可改」），而不是写进自己的配置文件或页面。展示原则：页面上只显示 `configured/source/writable` 三态，永不回显值；记忆正文中的凭据按 `redactSecrets` 拒绝。 |

---

## 8. 对本项目的结论汇总

| 问题 | 结论 |
|---|---|
| 1. 槽位 API | 服务名 `ctx.slots`，103 个槽位（附录 A），四类 `single/list/keyed/chain`；同 cell 同 priority 重复注册**加载期抛错**，不同 priority 遮蔽；不同 key/id 天然共存。`main` 是 `keyed/root`，**允许任意字符串 key**，保留 `conversation`；`sidebar.panellist` 是 `list/root`，字段 `id`（兼 main key）/`order`（显示序）/`label`（字符串或 thunk）/`priority`。 |
| 2. 页面注册与切换 | 唯一机制：`sidebar.panellist.id` ↔ `main.key` 同值 + `ctx.layout.selectPanel(id)` 写入 `panelInfo.activePanelId`。本项目 `main` key 唯一（`longterm-memory`），**与其它插件注册 main 不冲突**；仅当同 key 同 priority 时抛错（fail loud，不是静默覆盖）。 |
| 3. 导航 API | **有**：`ctx.layout.selectPanel(id)`（未注册抛错）、`beginNavigation()`、`toggleSidebar()`、`panelInfo`；另有约定式 `ctx.pluginNavigation.openBundle(pkg)` 与条件式 `ctx.sidebarRight.openTab(kind)`（需在屏会话）。**能做到**跳其它插件的 `main` 页；**做不到**可靠打开 QQ 的设置分区或右侧栏绑定页（后者时序/kind 未验证）→ 现实替代：文字提示用户手动点击，或与 QQ 插件约定 `reflect.provide` 一个导航服务。 |
| 4. 跨插件状态 | Host：`ctx.get(name, strict=true)` 即探测（未提供/未激活 → `undefined`），`ctx.provide(name, value)` 即发布；成品服务 `ctx.get('pluginManager').listPlugins()/listBundles()`、`ctx.get('pluginInventory').list()`。Client：`inject: ['remote.pluginInventory']` → `await ctx.remote.pluginInventory.list()`（`{ok,value}`），HTTP 为 `POST /api/pluginInventory/list`；`remote.pluginManager.listBundles()` 判「装/启用」，`pluginInventory` 的 `fiberPhase==='active'` 判「真在跑」。可据此判断 `@tencent-connect/dsh-qqbot`。 |
| 5. Profile/bundle | `dsh.profile.bundles` → 每个 bundle 的 `dsh.bundle.patch` → 按序应用 → 用户 `cordis.patch.yml` → 启动器 overlay；patch 按 id 覆盖且**整体替换 config**。Desktop **只用 `desktop` profile**；各 profile 独立进程/独立 node_modules/独立 patch；Vault 默认路径在 Documents 下，**跨 profile 共享**。 |
| 6. 版本校验 | 宿主**完全不读** `dsh.compatibility.dshReleases`（全 asar 0 命中）。真正校验 `engines.dsh`（否则 `@deepseek-ai/dsh*` peers），`semver.satisfies(..., {includePrerelease:true})`，runtime = app-boot 版本；不满足 → bundle 跳过 / row 禁用。`0.2.1-rc.3` vs `>=0.2.1-rc.2 <0.2.2` = **兼容**（宿主自带 semver 7.8.5 实测）。 |
| 7. 凭据 | `dsh-client-ui-secret-mask` 只掩码「会话用户消息」的显示；`dsh-credentials`（`ctx.credentials`）是凭据存储缝，`describe()` 永不返回值。管理页应只显示 configured/source/writable。 |

### 未验证 / 下一步

1. **网络层实测**：未对运行中的 GUI 发 `POST /api/pluginInventory/list`（需桌面壳一次性 token）。路径由代码常量确定，鉴权行为未实测。
2. **QQ 插件具体注册形态**（settings.section id、右侧栏 tab kind、是否注册 main 页）→ task-1 `docs/evidence/qq-official-plugin.md`。
3. `dsh.web.client.external`（动态包请求非基线模块的声明）的作用未逐一验证；本项目未使用。
4. `registrant` 字段的稳定性：它是「诊断标签」（`options.registrant ?? ctx.fiber.name`），用于跨插件按名字找 main key 是启发式，不建议当契约。
5. `dsh.compatibility.dshReleases` 若被插件市场索引读取，属市场侧行为，未验证。

---

## 附录 A：0.2.1-rc.3 客户端槽位完整清单（103 个）

来源：`@deepseek-ai/dsh-cordis-client-runner/lib/client.js` 内的 `CLIENT_SLOT_API`（机读版 `.scratch/slot-catalog.json`，可读版 `.scratch/slot-catalog.md`，抽取脚本 `.scratch/extract-slot-catalog.cjs`）。`declaredBy` 略去；`*` 表示文档标注 `replaceRisk: shadows-shipped-ui`。

| slot key | kind | scope | replaceRisk | occupants |
|---|---|---|---|---|
| `conversation.approval.detail` | single | session | `shadows-shipped-ui`* | `client-ui-chat ApprovalCommand` |
| `conversation.chat.assistant-actions` | list | session | none | `client-ui-message-feedback MessageFeedbackActions id 'feedback'` |
| `conversation.chat.commandview` | keyed | session | none | —（空） |
| `conversation.chat.flow` | single | session | `shadows-shipped-ui`* | `client-ui-chat ChatFlow` |
| `conversation.chat.message.images` | single | session | `shadows-shipped-ui`* | `client-ui-attachment MessageImages` |
| `conversation.chat.node` | keyed | session | `shadows-shipped-ui`* | `client-ui-chat UserMessageNodeView key 'user'`<br>`client-ui-chat UserMessageNodeView key 'steering'`<br>`client-ui-chat ContextMessageNodeView key 'context'`<br>`client-ui-chat TurnTriggerNodeView key 'turn-trigger'`<br>`client-ui-chat SystemPromptNodeView key 'system-prompt'`<br>`client-ui-chat AssistantNodeView key 'assistant-step'`<br>`client-ui-chat CommandNodeView key 'command'`<br>`client-ui-chat ManualCompactionNodeView key 'manual-compaction'`<br>`client-ui-chat CompactionNodeView key 'compaction'`<br>`client-ui-chat RetryNodeView key 'model-retry'`<br>`client-ui-chat TurnErrorNodeView key 'turn-error'`<br>`client-ui-chat TurnMaxTokensNodeView key 'turn-max-tokens'`<br>`client-ui-chat TurnProcessNodeView key 'turn-process'`<br>`client-ui-chat TurnTailNodeView key 'turn-tail'`<br>`client-ui-chat UnknownNodeView key 'unknown'`<br>`client-ui-goal GoalCommandInputView key 'command-input'`<br>`client-ui-tool ToolCallTree key 'tool-call'`<br>`client-ui-user-questions QuestionReplyView key 'question-reply'`<br>`client-ui-workflow-run WorkflowRunPanel key 'workflow-run'` |
| `conversation.chat.reasoning.body` | single | session | `shadows-shipped-ui`* | `client-ui-chat DefaultReasoningBody`<br>`experimental-client-ui-cot-translation TranslationBody` |
| `conversation.chat.turnTail` | list | session | none | `client-ui-deliverables DeliverablesTail id '@deepseek-ai/dsh-client-ui-deliverables'`<br>`client-ui-plan PlanCards`<br>`client-ui-schedule ScheduleTurnCard id 'schedule-created'` |
| `conversation.chat.user.images` | single | session | `shadows-shipped-ui`* | `client-ui-attachment MessageImages` |
| `conversation.composer` | chain | session | none | `client-ui-approval ApprovalPanel`<br>`client-ui-subagent SubagentReadOnlyComposer`<br>`client-ui-user-questions QuestionComposer` |
| `conversation.composer.bar` | single | session-maybe | `shadows-shipped-ui`* | `client-ui-conversation InputBar` |
| `conversation.composer.dock` | list | session | none | `client-ui-chat ActivityPill id 'activity'`<br>`client-ui-chat UsagePill id 'usage'` |
| `conversation.header` | single | session-maybe | `shadows-shipped-ui`* | `client-ui-conversation ConversationHeader` |
| `conversation.header.leading` | single | root | none | —（空） |
| `conversation.hero.agentPreset` | single | session-maybe | `shadows-shipped-ui`* | `client-ui-agent-preset AgentPresetSeat` |
| `conversation.hero.brand.mark` | single | root | none | —（空） |
| `conversation.hero.options` | list | session | none | —（空） |
| `conversation.hero.workspace` | single | root | `shadows-shipped-ui`* | `client-ui-workspace WorkspacePicker` |
| `conversation.hero.workspace.directoryFlow` | single | root | `shadows-shipped-ui`* | `client-ui-directory-picker-browse BrowseDirectoryFlow`<br>`client-ui-directory-picker-native NativeDirectoryFlow` |
| `conversation.input.activity` | single | session | `shadows-shipped-ui`* | `experimental-client-ui-voice-input VoiceInput` |
| `conversation.input.attachments` | single | session-maybe | `shadows-shipped-ui`* | `client-ui-attachment ComposerAttachments` |
| `conversation.input.dock` | list | session | none | `client-ui-conversation QueueDock id 'queue'`<br>`client-ui-conversation TodoDock id 'todo'`<br>`client-ui-goal GoalDock id 'goal'`<br>`experimental-client-ui-claude-code-mods Band id 'claude-code-mods'` |
| `conversation.input.left` | list | session | none | —（空） |
| `conversation.input.model` | single | session | `shadows-shipped-ui`* | `client-ui-model-selection ModelSelect` |
| `conversation.input.model.label` | single | session | `shadows-shipped-ui`* | `client-ui-deepseek-model-label-1017 DeepSeekModelLabel` |
| `conversation.input.overlay` | list | session | none | `client-ui-commands PopupSelectView id 'command-popup'`<br>`client-ui-input-trigger MenuView id 'slash-menu'`<br>`client-ui-message-feedback FeedbackDialog id 'feedback-dialog'` |
| `conversation.input.permission` | single | session | `shadows-shipped-ui`* | `client-ui-permission-presets PermissionSelect` |
| `conversation.input.plan` | single | session | `shadows-shipped-ui`* | `client-ui-plan PlanChip` |
| `conversation.input.right` | list | session | none | —（空） |
| `conversation.plan-review.actions` | list | session | none | `client-ui-plan PlanReviewOpen` |
| `conversation.session` | single | session | `shadows-shipped-ui`* | `client-ui-conversation ConversationSession` |
| `conversation.session.header` | single | session | `shadows-shipped-ui`* | `client-ui-conversation ConversationSessionHeader` |
| `conversation.session.header.actions` | list | session | none | `client-ui-agent-preset AgentPresetLabel id 'agent-preset'`<br>`client-ui-jobs JobListAction id 'job-list'`<br>`client-ui-subagent SubagentCatalogAction id 'subagent-catalog'`<br>`experimental-client-ui-agent-team TeamAction id 'agent-team'` |
| `conversation.session.header.corner` | single | session | `shadows-shipped-ui`* | `client-ui-sidebar-right ExpandButton` |
| `conversation.session.header.lineage` | single | session | `shadows-shipped-ui`* | `client-ui-subagent SubagentHeaderLineage` |
| `conversation.session.header.utilities` | list | session | none | `client-ui-open-in-app SessionOpenInAppAction id 'open-in-app'`<br>`client-ui-schedule ScheduleCatalogAction id 'schedule-catalog'`<br>`session-log-export SessionLogDownloadHeaderAction id 'session-log-download'` |
| `conversation.session.header.views.actions` | list | root | none | `client-ui-entry-customization EntryMenuContent id 'entry-customization'` |
| `conversation.trajectory.images` | single | session | `shadows-shipped-ui`* | `client-ui-attachment MessageImages` |
| `conversation.user.text.node` | keyed | session | `shadows-shipped-ui`* | `client-ui-conversation PlainUserText key 'text'`<br>`client-ui-conversation SessionReference key 'session'`<br>`client-ui-goal GoalCommandReference key 'command'`<br>`client-ui-reference FileReference key 'file'`<br>`client-ui-reference FolderReference key 'folder'`<br>`client-ui-secret-mask SecretText key 'secret'`<br>`client-ui-skill SkillReference key 'skill'` |
| `conversation.view` | list | session | none | `client-ui-chat ChatView id 'chat'`<br>`client-ui-trajectory TrajectoryView id 'trajectory'` |
| `deliverables.file.actions` | list | session | none | `client-ui-open-in-app FileRouteAction id 'open-in-app'` |
| `deliverables.review.file.actions` | list | session | none | `client-ui-open-in-app FileRouteAction id 'open-in-app'` |
| `main` | keyed | root | `shadows-shipped-ui`* | `client-ui-conversation ConversationPanel key 'conversation'`<br>`client-ui-plugin-manager PluginManagerPage`<br>`client-ui-schedule TaskManagerPage` |
| `main.conversation` | single | session-maybe | `shadows-shipped-ui`* | `client-ui-conversation ConversationRoot` |
| `plugins.add.actions` | list | root | none | `client-ui-agent-preset CreatePluginMenuItem id 'create-plugin'` |
| `plugins.bundle.activation` | keyed | root | `shadows-shipped-ui`* | `experimental-client-ui-voice-input VoiceSetupPrompt key '@deepseek-ai/dsh-experimental-voice-input-bundle'` |
| `plugins.bundle.config` | keyed | root | `shadows-shipped-ui`* | `experimental-client-ui-cot-translation TranslationSettings key '@deepseek-ai/dsh-experimental-cot-translation-bundle'`<br>`experimental-client-ui-voice-input VoicePreparation key '@deepseek-ai/dsh-experimental-voice-input-bundle'` |
| `plugins.detail.actions` | list | root | none | —（空） |
| `plugins.detail.badge` | list | root | none | —（空） |
| `plugins.detail.section` | list | root | none | —（空） |
| `plugins.item` | list | root | none | `client-ui-settings-agent-loop AgentLoopCard id 'agent-loop'`<br>`client-ui-settings-shell ShellCard id 'shell'`<br>`client-ui-settings-subagent SubagentCard id 'subagent'`<br>`client-ui-settings-web-search WebSearchCard id 'web-search'` |
| `plugins.row.config` | keyed | root | none | —（空） |
| `plugins.tab` | list | root | none | `client-ui-plugin-market DiscoverSection id 'discover'` |
| `rightbar` | single | root | `shadows-shipped-ui`* | `client-ui-sidebar-right RightbarRoot` |
| `rightbar.session` | single | session | `shadows-shipped-ui`* | `client-ui-sidebar-right RightbarSeat` |
| `root` | single | root | `shadows-shipped-ui`* | `client-ui-layout AppFrame` |
| `settings.action` | list | root | none | `client-ui-settings-general SettingsDocumentAction id 'open-document'` |
| `settings.close` | single | root | `shadows-shipped-ui`* | `client-ui-settings-general CloseLabel` |
| `settings.general.item` | list | root | none | `client-locale LanguageRow id 'language'`<br>`client-ui-chat LinkOpeningRow id 'link-opening'`<br>`client-ui-chat PerformanceUsageRow id 'performance-usage'`<br>`client-ui-chat TranscriptViewRow id 'transcript-view'`<br>`client-ui-conversation EnterBehaviorRow id 'composer-enter'`<br>`client-ui-permission-presets PermissionRow id 'permission'`<br>`client-ui-settings-general DeveloperToolsRow id 'developer-tools'`<br>`client-ui-settings-general CurrentVersionRow id 'current-version'`<br>`client-ui-settings-session-log UploadRow`<br>`client-ui-shortcuts ShortcutsRow id 'shortcuts'`<br>`client-ui-theme AppearanceRow id 'appearance'`<br>`client-ui-theme FontSettingsGroup id 'font-size'` |
| `settings.header` | single | root | `shadows-shipped-ui`* | `client-ui-settings-general HeaderContent` |
| `settings.launcher` | single | root | `shadows-shipped-ui`* | `client-ui-settings-account AccountMenu` |
| `settings.models.footer` | list | root | none | —（空） |
| `settings.models.provider-card` | keyed | root | none | —（空） |
| `settings.models.sign-in` | single | root | `shadows-shipped-ui`* | `client-ui-settings-account AccountOnboarding` |
| `settings.onboarding` | list | root | none | `client-ui-settings-models WelcomeNotice id 'welcome-notice'`<br>`client-ui-settings-models DeepSeekOnboardingDialog id 'deepseek-official'` |
| `settings.plugins.tab` | list | root | none | `client-ui-settings-plugin-inventory PluginInventorySettingsTab id 'all'` |
| `settings.section` | list | root | none | `client-ui-agent-preset AgentPresetSection id 'agent-presets'`<br>`client-ui-settings-account AccountSection id 'account'`<br>`client-ui-settings-general GeneralSection id 'general'`<br>`client-ui-settings-models ModelsSection id 'models'`<br>`client-ui-settings-plugins PluginsSettingsSection id 'plugins'` |
| `settings.trigger` | single | root | `shadows-shipped-ui`* | `client-ui-settings-general TriggerContent` |
| `shell.bottom` | single | root | `shadows-shipped-ui`* | `experimental-inspector InspectorPage` |
| `shell.leading` | single | root | `shadows-shipped-ui`* | `client-ui-sidebar HeaderLeadingControls` |
| `shell.overlay` | list | root | none | `client-ui-chat QuotaNoticeHost id 'chat.quota-notice'`<br>`client-ui-plugin-manager PluginRefreshToast id 'plugin-manager.refresh-toast'`<br>`client-ui-schedule ScheduleDeleteToast id 'schedule.delete-toast'`<br>`client-ui-settings-account DesktopOnboardingEntry id 'desktop-onboarding'`<br>`client-ui-settings-account AccountPlatformHost id 'account.platform-page'`<br>`client-ui-settings-general HostReleasePrompt id 'host-release-change'`<br>`client-ui-settings-session-log UploadToast id 'session-log-upload-toast'`<br>`client-ui-shortcuts ShortcutReference id 'shortcuts'`<br>`client-ui-workspace SessionRenameDialog id 'workspace.session-rename'`<br>`client-ui-workspace SessionArchiveConfirmDialog id 'workspace.session-archive'`<br>`client-ui-workspace RowActionToast id 'workspace.row-toast'` |
| `shell.quota-notice` | chain | root | none | `client-ui-settings-account AccountQuotaNotice` |
| `sidebar` | single | root | `shadows-shipped-ui`* | `client-ui-sidebar SidebarRoot` |
| `sidebar.brand.mark` | single | root | `shadows-shipped-ui`* | `client-ui-brand-official OfficialBrandMark` |
| `sidebar.brand.name` | single | root | `shadows-shipped-ui`* | `client-ui-brand-official OfficialBrandName` |
| `sidebar.chat.conversation` | single | session | `shadows-shipped-ui`* | `client-ui-subagent ConversationSlotPanel` |
| `sidebar.footer.action` | list | root | none | `client-ui-cordis CordisPanel id 'cordis-panel'` |
| `sidebar.panellist` | list | root | none | `client-ui-plugin-manager PluginsPanelIcon`<br>`client-ui-schedule TaskManagerIcon` |
| `sidebar.panellist.actions` | list | root | none | `client-ui-entry-customization EntryMenuContent id 'entry-customization'` |
| `sidebar.right.pane.tab` | keyed | session | none | `client-ui-deliverables ReviewTab`<br>`client-ui-plan PlanPreview`<br>`client-ui-schedule ScheduleTaskTab`<br>`client-ui-sidebar-browser BrowserBody`<br>`client-ui-sidebar-documentpreview TextPreview`<br>`client-ui-sidebar-files FilesBody`<br>`client-ui-sidebar-right GuideBody`<br>`client-ui-sidebar-terminal LazyTerminalBody`<br>`client-ui-subagent SidebarChatTab`<br>`experimental-session-inspector SessionInspectorView` |
| `sidebar.right.pane.tab.title` | keyed | session | none | `client-ui-plan PlanTitle`<br>`client-ui-schedule ScheduleTaskTabTitle`<br>`client-ui-sidebar-browser BrowserTitle`<br>`client-ui-sidebar-documentpreview TextTitle`<br>`client-ui-sidebar-files FilesTitle`<br>`client-ui-sidebar-right GuideTitle`<br>`client-ui-sidebar-terminal TerminalTitle` |
| `sidebar.right.tab.document` | keyed | session | none | `client-ui-sidebar-documentpreview CodeBody`<br>`client-ui-sidebar-documentpreview LazyExcelBody`<br>`client-ui-sidebar-documentpreview HtmlBody`<br>`client-ui-sidebar-documentpreview ImageBody`<br>`client-ui-sidebar-documentpreview MarkdownBody`<br>`client-ui-sidebar-documentpreview OfficeBody`<br>`client-ui-sidebar-documentpreview LazyPdfBody`<br>`client-ui-sidebar-documentpreview TextBody` |
| `sidebar.right.tab.document.action` | keyed | session | none | `client-ui-sidebar-documentpreview OfficeFontAction` |
| `sidebar.right.tab.document.actions` | list | session | none | `client-ui-open-in-app OpenPathAction id 'open-in-app'` |
| `sidebar.right.tab.document.office.pdf` | keyed | session | none | `client-ui-sidebar-documentpreview LazyPdfBody` |
| `sidebar.right.tab.document.unpreviewable` | list | session | none | `client-ui-open-in-app OpenPathEmptyAction id 'open-in-app'` |
| `sidebar.right.tab.files.actions` | list | session | none | `client-ui-open-in-app OpenInAppAction id 'open-in-app'` |
| `sidebar.right.tab.guide` | chain | session | none | —（空） |
| `sidebar.right.tab.guide.actions` | list | root | none | `client-ui-entry-customization EntryMenuContent id 'entry-customization'` |
| `sidebar.right.tab.guide.entry` | keyed | session | none | `client-ui-sidebar-terminal TerminalGuide` |
| `sidebar.right.tab.menu.item` | list | session | none | —（空） |
| `sidebar.session.row.hover` | list | root | none | `client-ui-schedule SessionScheduleHover id 'schedule-tasks'` |
| `sidebar.session.row.leading` | list | root | none | `client-ui-schedule SessionScheduleMark id 'schedule-mark'` |
| `sidebar.settings` | single | root | `shadows-shipped-ui`* | `client-ui-settings-general SettingsRoot` |
| `sidebar.toggle.badge` | single | root | `shadows-shipped-ui`* | `client-ui-settings-general DesktopUpdateBadge` |
| `sidebar.workspaces` | single | root | `shadows-shipped-ui`* | `client-ui-workspace WorkspaceBrowser` |
| `sidebar.workspaces.directoryFlow` | single | root | `shadows-shipped-ui`* | `client-ui-directory-picker-browse BrowseDirectoryFlow`<br>`client-ui-directory-picker-native NativeDirectoryFlow` |
| `sidebar.workspaces.session.menu.item` | list | root | none | `client-ui-workspace PinSessionMenuItem id 'pin'`<br>`client-ui-workspace RenameSessionMenuItem id 'rename'`<br>`client-ui-workspace ForkSessionMenuItem id 'fork'`<br>`client-ui-workspace ArchiveSessionMenuItem id 'archive'`<br>`client-ui-workspace SessionIdMenuItem id 'session-id'` |
| `sidebar.workspaces.session.row.action` | list | root | none | `client-ui-workspace ArchiveSessionRowButton id 'archive'`<br>`client-ui-workspace PinSessionRowButton id 'pin'` |
| `tool.call.images` | single | session | `shadows-shipped-ui`* | `client-ui-attachment MessageImages` |
| `tool.call.toolview` | keyed | session | `shadows-shipped-ui`* | `client-ui-deliverables PresentRow key 'present'`<br>`client-ui-skill SkillRow key 'skill'`<br>`client-ui-tool AskQuestionRow key 'ask_user_question'`<br>`client-ui-tool BashRow key 'bash'`<br>`client-ui-tool DetailsRow key 'create_goal'`<br>`client-ui-tool DetailsRow key 'get_goal'`<br>`client-ui-tool DetailsRow key 'update_goal'`<br>`client-ui-tool DetailsRow key 'schedule_create'`<br>`client-ui-tool DetailsRow key 'schedule_list'`<br>`client-ui-tool DetailsRow key 'schedule_delete'`<br>`client-ui-tool DetailsRow key 'schedule_update'`<br>`client-ui-tool DetailsRow key 'cordis_inspect_list'`<br>`client-ui-tool DetailsRow key 'cordis_inspect_query'`<br>`client-ui-tool DetailsRow key 'cordis_inspect_self'`<br>`client-ui-tool DetailsRow key 'workflow'`<br>`client-ui-tool DetailsRow key 'ralph'`<br>`client-ui-tool DetailsRow key 'session_event_read'`<br>`client-ui-tool DetailsRow key 'session_event_search'`<br>`client-ui-tool DetailsRow key 'session_event_trace'`<br>`client-ui-tool DetailsRow key 'session_search'`<br>`client-ui-tool DetailsRow key 'session_trace'`<br>`client-ui-tool DetailsRow key 'list_subagent_models'`<br>`client-ui-tool DetailsRow key 'subagent'`<br>`client-ui-tool DetailsRow key 'list_agents'`<br>`client-ui-tool DetailsRow key 'send_message'`<br>`client-ui-tool DetailsRow key 'interrupt_agent'`<br>`client-ui-tool DetailsRow key 'job_list'`<br>`client-ui-tool DetailsRow key 'job_output'`<br>`client-ui-tool DetailsRow key 'job_kill'`<br>`client-ui-tool DetailsRow key 'terminal_open'`<br>`client-ui-tool DetailsRow key 'terminal_read'`<br>`client-ui-tool DetailsRow key 'terminal_list'`<br>`client-ui-tool DetailsRow key 'terminal_signal'`<br>`client-ui-tool DetailsRow key 'terminal_close'`<br>`client-ui-tool DetailsRow key 'lsp'`<br>`client-ui-tool DetailsRow key 'spawn_teammate'`<br>`client-ui-tool DetailsRow key 'team_task_create'`<br>`client-ui-tool DetailsRow key 'team_task_get'`<br>`client-ui-tool DetailsRow key 'team_task_update'`<br>`client-ui-tool DetailsRow key 'team_task_list'`<br>`client-ui-tool DetailsRow key 'wait_agent'`<br>`client-ui-tool FileMutationRow key 'edit'`<br>`client-ui-tool FileMutationRow key 'write'`<br>`client-ui-tool ReadImageRow key 'read_image'`<br>`client-ui-tool ReadRow key 'read'`<br>`client-ui-tool SearchRow key 'grep'`<br>`client-ui-tool SearchRow key 'glob'`<br>`client-ui-tool TodoRow key 'todo_write'`<br>`client-ui-tool WebRow key 'web_search'`<br>`client-ui-tool WebRow key 'web_fetch'`<br>`client-ui-cordis CordisDefineRow key 'cordis_define'`<br>`client-ui-cordis CordisRunRow key 'cordis_run'`<br>`client-ui-cordis CordisActionRow key 'cordis_stop'`<br>`client-ui-cordis CordisActionRow key 'cordis_undefine'` |
| `tool.view.cordis` | keyed | session | none | —（空） |
| `workspace.toast` | keyed | root | `shadows-shipped-ui`* | `client-ui-workspace ToastEntry<PropsRuntime<'workspace.toast', 'sessionIdCopi… key 'sessionIdCopied'`<br>`client-ui-workspace ToastEntry<PropsRuntime<'workspace.toast', 'sessionIdCopy… key 'sessionIdCopyFailed'`<br>`client-ui-workspace ToastEntry<PropsRuntime<'workspace.toast', 'pinFailed'>> key 'pinFailed'`<br>`client-ui-workspace ToastEntry<PropsRuntime<'workspace.toast', 'unpinFailed'>> key 'unpinFailed'`<br>`client-ui-workspace ToastEntry<PropsRuntime<'workspace.toast', 'archivedNotOp… key 'archivedNotOpenable'`<br>`client-ui-workspace ToastEntry<PropsRuntime<'workspace.toast', 'defaultWorksp… key 'defaultWorkspaceFailed'`<br>`client-ui-workspace ToastEntry<PropsRuntime<'workspace.toast', 'shortcutForkF… key 'shortcutForkFailed'`<br>`client-ui-workspace ToastEntry<PropsRuntime<'workspace.toast', 'createFailed'>> key 'createFailed'`<br>`client-ui-workspace ToastEntry<PropsRuntime<'workspace.toast', 'forkRequiresO… key 'forkRequiresOpen'`<br>`client-ui-workspace ArchiveToastEntry key 'archived'`<br>`client-ui-workspace ArchiveToastEntry key 'stoppedAndArchived'` |

> 逐条 `registerOptions` / `ownerProps` / `keyDomain` / 示例代码见 `.scratch/slot-catalog.json`（或 `.scratch/slot-catalog.md` 的「Full entries」）。

## 附录 B：证据文件索引

| 路径 | 说明 |
|---|---|
| `.scratch/asar-x.cjs` | 修正后的 asar 通用提取器（`--list` / `--prefix` / `--out`） |
| `.scratch/asar-files.json` | asar 文件表（path/size/offset），来自既有 `.scratch/asar.cjs`；offset 本身正确，仅数据区基点有 off-by-one（见 §0.2） |
| `.scratch/extract-slot-catalog.cjs` + `.scratch/slot-catalog.{json,md}` | 从 `dsh-cordis-client-runner` 的 bundle 里抽出 `CLIENT_SLOT_API`（103 条） |
| `.scratch/asar-extract/**` | 修正后提取的宿主包（`@deepseek-ai/dsh-*`、`cordis`、`semver` 等） |
| `.scratch/host-pkgs/**` | 同版本 npm 包（含 `lib/types/*.d.ts`）与批量下载脚本 `fetch-types.cjs` |
| `.scratch/find-lines.cjs` | 本文行号引用的自动定位脚本（可复现） |
