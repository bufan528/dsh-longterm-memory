# 在 DSH Go 手机端使用长期记忆插件

本文档说明 `dsh-longterm-memory` 在 [DSH Go](https://github.com/ccch1mneyyy/dsh-Go)
（把 DeepSeek Harness 装进口袋的 Android / iOS 客户端）上的适配范围、安装方式和已知边界。

> 插件本体是 MIT；DSH Go 是 AGPL-3.0。本插件以独立 npm 包 + bundle patch 组合进宿主，
> 不修改 DSH Go 源码，两者许可证互不传染。

## 一、为什么能直接用

DSH Go 的 Android 版在 App 内跑一套完整的 Ubuntu + Node.js + DSH 引擎（PRoot，免 Root），
iOS 版跑 NodeMobile 运行时；两者加载的都是**标准 DSH 引擎**，并通过 `dsh web` 在
`127.0.0.1` 起 Web 服务。也就是说，本插件依赖的一切宿主能力在手机上都是齐全的：

| 插件依赖 | DSH Go 本机引擎 | 结论 |
|---|---|---|
| Node `fs` / `path` / `crypto` | 完整 Node 运行时 | 可用，仓库照常落在应用内的 Linux 文件系统 |
| `ctx.webServer` (59 个 RPC) | `dsh web` 提供 | 可用，Web 管理页可打开 |
| `ctx.tools` / `ctx.systemPrompt` | 标准 DSH 引擎 | 可用，9 个工具与常驻记忆注入照常工作 |
| `session/event` 自动提取 | 标准事件总线 | 可用，轮次结束自动产生候选记忆 |
| `ctx.provide` 五个服务 | Cordis 支持 | 可用 |

**结论：核心功能不需要为新宿主重写。** 本次适配真正做的是三件宿主差异化的事——
版本口径、原生前端、以及手机上的触控与身份门禁。

## 二、安装的阻断项与解决

原插件 `engines.dsh` 上界是 `<0.2.2`，而 DSH Go 当前内置 DSH `0.2.2-rc.1`，
会被安装器直接拒绝。本次把范围放宽为：

```
engines.dsh: >=0.2.1-rc.3 <0.3.0-0
```

- 桌面 `0.2.1-rc.3`（**已实测**）与 DSH Go 的 `0.2.2-rc.1`（**静态兼容声明**）都满足；
- `0.3.x` 不在范围内，避免把未验证的破坏性版本纳入支持。

> ⚠️ 诚实边界：`0.2.2-rc.1` 的兼容性来自 API 静态比对，**没有在真机上跑过**。
> 桌面 `0.2.1-rc.3` 的实测结论不变，详见 [compatibility.md](compatibility.md) §13。

在 DSH Go 的 App 内终端执行（路径是引擎所在环境内的路径）：

```sh
dsh plugin --profile web add dsh-longterm-memory
```

装好后重启引擎，在「全部功能 › 插件」里应能看到「长期记忆」面板。

## 三、适配了什么

### 1. 原生前端（DSH Go 专有）

DSH Go 的 App 不执行插件的 JS，而是读取插件声明的 JSON 视图、用 Flutter 原生组件画出来。
因此新增了一层 `host/dshgo/`，通过 `ctx.dshGo` 提供：

- **3 个原生面板**（`package.json` 的 `dshGo.contributes.panels`）：
  - `记忆总览` —— 记忆/待确认/异常计数、最近更新、刷新与搜索入口；
  - `待确认` —— 就地确认或拒绝候选记忆（写操作走同一个 `MemoryService`，与网页端一致）；
  - `提醒` —— 查看提醒、插入创建提醒的提示词。
- **1 条状态条**：输入框上方显示记忆条数，有待确认时高亮 `+N`，点击打开总览。
- **2 个胶囊 + 1 个消息菜单**：`记下来`、`查记忆`（带输入框草稿）、`存入记忆`（带长按的消息正文）。
- **9 张原生工具卡**：`memory_search` / `memory_get` / `memory_save` / `memory_forget` /
  `reminder_list` / `reminder_create` / `reminder_complete` / `sticker_pick` / `sticker_ingest`
  的结果在对话里画成原生卡片，模型看到的文本结果不变。

面板数据是内存快照（`src/host/dshgo/bridge.ts`）：15 秒刷新一次，并在写操作后主动刷新；
视图函数只读缓存、保持同步，不会阻塞桥接的 3 秒回调窗口。宿主侧完全可选——
`ctx.inject(['dshGo'])` 在没有桥接的桌面端不会触发，桌面行为零变化。

### 2. Web 管理页的手机触控适配

完整的 7 个管理页（检索/管理/收件箱/QQ 接入/伙伴中心/设置等）继续走 DSH Go 的
WebView「网页版」。针对手机做了：

- 粗指针下自定义控件命中区提升到 **44px**，与宿主原生按钮一致；
- 支持 `env(safe-area-inset-*)`，避开刘海与手势条；
- 保留原有的 ≤720px 单列布局与 `hover:none` 时操作常显规则。

### 3. 本机信任门禁

个人记忆的 Owner Gate 默认 fail-closed：没有 QQ 身份服务时一律拒绝，防止把个人记忆
暴露给不明会话。手机本机引擎没有 QQ 插件，因此需要在插件设置里显式打开本机信任：

```
设置 → 伙伴中心 → 隐私 → 本机信任模式
```

打开后，仅「无 live 来源、且不属于任何已知 QQ 会话」的本机会话可以读写个人记忆；
QQ 会话矩阵与注册表异常仍然一律拒绝。这是**有意保留**的安全默认值，不是适配缺陷。

## 四、已知边界与风险

| 项 | 说明 |
|---|---|
| 真机未验证 | 0.2.2-rc.1 与 DSH Go 原生视图均通过静态检查与本地单测，没有 Android/iOS 真机运行记录。首次装到手机上请按第五节核对。 |
| 原生面板是精简视图 | 只覆盖高频读写；人格进化、QQ 接入、索引重建等完整能力在「网页版管理页」里。 |
| 工具卡只读 | DSH Go 的工具卡第 0 期不支持按钮；要交互请用面板或网页版。 |
| 远程主机 | 通过 SSH / 中转连接电脑上的 DSH 时，App 不加载原生桥，只有工具卡和网页版可用；个人记忆读的是**电脑**上的仓库。 |
| `openVault` | 手机没有系统文件管理器可跳转，该操作在网页版里会返回失败提示，不影响记忆读写。 |
| 仓库位置 | 在 App 内的 Linux 文件系统里，卸载 App 或清除数据会丢失；请用网页版的导出/备份功能另存。 |

## 五、真机验收清单

装好后逐项确认，任何一项不符请先查日志再反馈：

1. 插件列表显示 `dsh-longterm-memory`，无 `pluginCompatibilityWarning`；
2. 「全部功能」里有 3 个面板，输入框上方出现 `记忆 N` 状态条；
3. 让模型调用 `memory_save` 写一条记忆，对话里出现原生工具卡；
4. 总览面板计数 +1，状态条同步更新；
5. 打开网页版管理页，7 个 tab 都能打开，按钮可点（≥44px）；
6. 开本机信任后，`memory_search` 能读到第 3 步写入的记忆；
7. 关本机信任后，`memory_search` 应明确拒绝（fail-closed 生效）。

## 六、相关文件

- 原生桥接：`src/host/dshgo/{bridge,views,types,index}.ts`
- 工具卡注入：`src/host/dsh/tools.ts` 的 `installNativeToolCards`
- 清单声明：`package.json` 的 `dsh.dshGo`
- 触控样式：`src/client/styles.ts`
- 契约测试：`tests/unit/dshgo-native.test.ts`
