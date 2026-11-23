# Memory Graph 实施任务

> 依据：`specs/memory-graph/spec.md`
> 原则：先数据真实性，再工作台布局，再视觉，再 P1 结构分析；每步可构建、可测试。

## [x] T1 数据层：自动关系理由进入索引

**文件**：`src/shared/search.ts`、`src/host/core/indexing.ts`

- `INDEX_FORMAT_VERSION` 6 → 7。
- `IndexRecord` 增加可选 `autoLinkReasons?: Record<string, string>`。
- `recordFromDocument` 从 `memory.relatedAuto` 生成理由表，排除手动同目标，理由截断 300 字。
- 索引反序列化新增 lenient 解析：只收 string→string，值截断 300，最多 32 项。
- 不改 `relatedAuto` 的写盘格式，不改 `markdown.ts`。

**验收**：`npx vitest run tests/unit/markdown.test.ts tests/unit/autolink.test.ts` 仍通过；旧索引因版本不匹配被重建，不崩溃。

## [x] T2 数据层：图谱模型与图分析

**文件**：`src/shared/links.ts`

- `LinkGraphNode` 增加 `createdAt`。
- `LinkGraphEdge` 增加 `reason?`，仅自动边且有理由时写入。
- 新增 `analyseLinkGraph`：degree、isolated、hubs（degree≥3）、bridges（割点且 degree≥2）、components、clusters（标签传播 ≥2 节点）、avgDegree。
- 新增 `shortestLinkPath`（忽略方向，BFS）。
- 新增 `buildTagDerivedEdges`（忽略默认/常见标签，标签内链式连接，单节点上限 2）。
- 新增 `selectLinkGraph`：类型/标签/时间/关系/派生/结构/局部深度筛选，返回可见节点、边、派生边、matched、hiddenByCap。
- 保持 `buildLinkGraph` / `buildLinkGraphFromRecords` 签名与既有行为。

**验收**：`tests/unit/links.test.ts` 新增用例覆盖 reason、分析、路径、派生边、筛选；原有分辨率/悬空/去重用例继续通过。

## [x] T3 导航与文案

**文件**：`src/client/memory-page.tsx`、`src/client/i18n.ts`

- `SECTIONS` 顺序：overview → links → search → manage → inbox → qq → life → settings。
- `nav.links`：记忆图谱 / Memory Graph。
- 中英同步更新 `links.*`：标题、说明、搜索、范围、筛选、结构、详情、路径、视图控制、零关系、派生、兼容提示。
- 删除不再使用的旧 `links.*` 键，保证 ZH/EN 键与占位符完全一致。

**验收**：`tests/unit/i18n-parity.test.ts`、`tests/unit/client-bundle.test.ts` 通过。

## [x] T4 图标

**文件**：`src/client/ui.tsx`

- `IconName` 增加 `minus`、`fit`、`target`、`route`、`filter`。
- 用 24×24 线性图标实现，风格与现有图标一致。

**验收**：`npm run typecheck` 通过；图标在缩放/适配/居中/路径/筛选按钮中可复用。

## [x] T5 画布布局纯函数

**文件**：`src/client/views/links.tsx`

- 删除旧 `computeScene` 场景模型。
- 新增 `computeLayout({ nodes, edges, width, height, focusId })`：
  - 黄金角螺旋初始位置 + id 哈希扰动；
  - Fruchterman–Reingold 200 次；
  - 焦点局部模式固定中心；
  - fit 到画布（顶部 76、底部 64 留白）；
  - 返回节点坐标、半径、标签策略、边路径、hidden；
  - 确定性：同输入同输出；
  - 上限 `MAX_LAYOUT_NODES = 320`，按度数降序，其余计入 hidden。
- 渲染层再消费该结果。

**验收**：`tests/unit/links-layout.test.ts` 重写并通过：坐标有限、在画布内、焦点居中、0 边仍布点、上限与确定性。

## [x] T6 工作台骨架与顶部栏

**文件**：`src/client/views/links.tsx`、`src/client/styles.ts`

- 页面根 `.lmv-wb` 占满高度，三栏 grid：240 / minmax(0,1fr) / 320。
- 顶部栏：标题、说明、搜索框、全局/局部、路径、窄屏「筛选」。
- 搜索下拉最多 6 条；点击选中并居中；Enter/Esc 行为。
- 左/右栏内部滚动，底部操作固定。
- <1240px 左栏抽屉；<980px 右栏抽屉；选中自动打开右栏。

**验收**：1024px 截图无右栏裁切、无横向滚动、画布占据主空间。

## [x] T7 左栏筛选

**文件**：`src/client/views/links.tsx`

- 类型多选（真实类型 + 计数 + 色点）。
- 标签多选（真实标签 + 计数，最多 10 个 + 全部）。
- 时间：全部/30/90/365 天。
- 关系：全部/手动/自动。
- 派生开关（默认关 + 说明）。
- 结构：全部/孤立/枢纽/桥接（真实图计算，显示计数）。
- 局部深度 1/2/3（仅局部模式）。
- 统计：节点/关系/自动/孤立/悬空。
- 自动补全 + 刷新；兼容模式禁用并解释。
- 所有控件通过 `selectLinkGraph` 立即作用于画布。

**验收**：每个筛选在 17 条数据上改变节点/边数量；空结果有明确说明而不是空白。

## [x] T8 画布交互与视觉

**文件**：`src/client/views/links.tsx`、`src/client/styles.ts`

- ResizeObserver 测量尺寸，`viewBox` 跟随。
- 滚轮缩放、空白平移、节点拖拽（仅布局）、双击打开。
- 视图控制：+/−、适配、居中、重置；程序化过渡 300ms。
- 类型色族、孤立空心、选中环、hover 聚光灯、邻接边高亮。
- 标签策略与截断；缩放阈值。
- 手动实线 / 自动虚线 / 派生点线；仅邻接边显示箭头。
- 集群凸包轮廓（有边时）+ 点击筛选。
- 零关系提示条；兼容模式短提示。
- 卸载清理监听、观察者与指针捕获。

**验收**：完整图、密集图、选中态、局部态、筛选态、孤立态、空数据态、深浅主题、窄窗 10 个状态均可用。

## [x] T9 右栏详情

**文件**：`src/client/views/links.tsx`

- 标题、类型/状态、摘要、时间、标签、度数统计。
- 打开原始记忆、以此为中心探索、在图中定位。
- 出链 / 自动关联（含 reason）/ 反向链接 / 共享标签（派生）分组。
- 点击关联行切换选中。
- 无选中时引导文案。
- 点击标签直接筛选用该标签。

**验收**：任意节点可查看完整信息；关联行点击后画布高亮与详情同步。

## [x] T10 路径探索

**文件**：`src/client/views/links.tsx`

- 顶部路径模式：起点 → 终点。
- BFS 最短路径（真实边、忽略方向、不含派生边）。
- 成功：高亮节点/边 + 「经过 N 层」+ 路径节点可点。
- 失败：「没有找到已记录的关联路径」。
- 清除/Esc 退出并恢复普通高亮。

**验收**：在自动补全后的数据上路径成功与失败各验证一次。

## [x] T11 样式收口

**文件**：`src/client/styles.ts`

- 替换旧 links 段为工作台样式。
- 深/浅主题：中性色由 label token 混合派生。
- 背景点阵/径向光只用 token + color-mix。
- 抽屉、窄屏、`prefers-reduced-motion`。
- 检查无裸 hex/rgba。

**验收**：`npm run build && npm run lint` 通过；`client-bundle.test.ts` 的 CSS 检查通过。

## [x] T12 构建、测试与真实运行

- `npm run typecheck`
- `npm run build`
- `npm run lint`
- `npx vitest run tests/unit/links.test.ts tests/unit/links-layout.test.ts tests/unit/i18n-parity.test.ts tests/unit/client-bundle.test.ts`
- `npx vitest run tests/unit`
- `npx vitest run tests/integration/service.test.ts -t "links"`
- 记录真实通过/失败数量，不伪造。
- 完全重启 DSH，打开「记忆图谱」，点一次「自动补全」，确认 17 条记忆与真实关系数。
- 截图：初始、选中、局部、筛选、孤立、空状态、窄窗。

> 说明：自动化构建、单测、集成测试已全部通过；运行中的 DSH 缓存了旧客户端包，完全重启并重新打开「记忆图谱」这一真实宿主验证需由用户在本机执行（未擅自重启用户应用）。渲染验收使用真实 `LinksView` + 真实 Vault 数据夹具完成，截图见 `.scratch/graph-preview2/shots/`。

## [x] T13 交付报告

- 功能清单、布局交互说明、技术选择、数据来源、修改文件、依赖（0）、构建测试结果、已知问题、截图。
- 明确说明：自动关系需重启宿主并回填；未完成项（如图片导出）。
