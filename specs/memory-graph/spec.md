# Memory Graph 规格说明（DSH 长期记忆插件）

## 1. 背景与问题

当前「双向链接」页面已被实现，但存在三个阻断验收的问题：

1. **视觉不达标**：页面仍是「一块 960×560 的固定比例画布 + 下方列表」，没有形成三栏记忆工作台；空关系时整块画布只显示空状态，17 条真实记忆完全不可见。
2. **布局错误**：右侧 288px 焦点栏与固定比例画布并列，窗口较窄时右栏被挤出容器并裁切（用户截图为 1024×716）。
3. **数据表达不足**：节点只按「状态」着色，关系只有「手动/自动」两种线型；没有类型、时间、标签、孤立/枢纽/桥接、集群、路径等探索能力。

本规格在现有插件内重做该页面，不新建记忆系统，不改 DSH 宿主，不写 Markdown 文件，不伪造节点或关系。

## 2. 已确认的现状（实现依据）

### 2.1 导航与页面

- 导航在 `src/client/memory-page.tsx` 的 `SECTIONS` 数组注册。
- 当前顺序：`overview → search → links → manage → inbox → qq → life → settings`。
- 页面切换逻辑已存在；`LinksView` 由 `section === 'links'` 渲染。
- 其他页面调用 `PageApi.openLinks(id)` 可直接带焦点进入链接页。

### 2.2 真实数据

- 记忆唯一标识：`Memory.id` / `IndexRecord.id`。
- 原始文件定位：`IndexRecord.path`（相对 Vault），打开详情用 `PageApi.openMemory(id)`。
- 真实关系来源（唯一合法边来源）：
  - 正文 `[[wikilink]]`；
  - `## 相关记忆` 中用户手写条目；
  - 插件写入的 `<!-- dsh-auto-links:start/end -->` 自动区块。
- 索引已保存：`IndexRecord.links`、`linkContexts`、`autoLinks`；`Memory.relatedAuto` 在磁盘上带 `reason`。
- 当前索引版本 `INDEX_FORMAT_VERSION = 6`，但没有把自动关系的 `reason` 放进索引。
- 真实标签存在且质量高（`campuslink`、`hfut`、`preference` 等），可作为主题/项目筛选；没有「记忆→项目」的显式成员字段，因此不得伪造项目成员关系。
- 用户 Vault：`C:\Users\bf410\Documents\DSH Memory`，17 条记忆、当前 0 条已记录关系、17 个孤立节点。

### 2.3 前端约束

- React 18 + 手写 SVG/CSS；客户端只能 `require('react')` / `react/jsx-runtime`。
- CSS 颜色只能来自 `var(--dsw-alias-*)` 或由 `color-mix()` 从 token 派生；`tests/unit/client-bundle.test.ts` 会拒绝 `var()` 外的 hex/rgba。
- 不引入 d3 / Sigma / Cytoscape / React Flow；17 条记忆规模下 SVG + 自写布局足够，且避免新依赖。
- `.lmv-page` 是全高 flex 列，`.lmv-fade` 是 `flex:1;min-height:0;flex-direction:column`；新页面必须占满该空间且内部不产生整页滚动。

## 3. 目标与非目标

### 3.1 目标

- 打开页面第一眼：深色/浅色主题下都高级、克制、可读，像专业的知识图谱工作台。
- 17 条 0 关系的记忆也必须以完整星图呈现，而不是空状态。
- 任何筛选、搜索、局部探索都真实作用于画布数据。
- 能从任意节点看到真实关系、关系理由和关联记忆，并跳转原始记忆。
- 能识别真实图结构：孤立、枢纽、桥接、连通分量、集群。
- 能选择两个节点探索已记录关系路径；没有路径时明确说明。

### 3.2 非目标

- 不做 3D 默认视图、不做图谱编辑器、不做新数据库。
- 不把内容相似度当成真实关系，不在本模块新建向量检索。
- 不在本模块上传记忆到外部服务。
- 不改动记忆文件、不改变保存/检索/写入流程。

## 4. 功能规格

### 4.1 导航

- `nav.links` 中文改为「记忆图谱」，英文 `Memory Graph`。
- `SECTIONS` 顺序改为：`overview → links → search → manage → inbox → qq → life → settings`。
- 图标继续使用现有 `links` 图标。

### 4.2 页面结构

工作台占满 `.lmv-fade`：

```
┌──────────────────────────────────────────────────────────────┐
│ 记忆图谱   探索你的记忆网络   [搜索框]   [全局|局部] [路径]   │  topbar
├───────────────┬───────────────────────────────┬──────────────┤
│ 左：探索筛选  │ 中：图谱画布（唯一视觉中心）  │ 右：记忆详情 │
│ 240px         │ minmax(0,1fr)                 │ 320px        │
└───────────────┴───────────────────────────────┴──────────────┘
```

- 三栏高度全部为 `min-height:0`，内部各自滚动，禁止右栏被挤出。
- 宽度 < 1240px：左栏隐藏为「筛选」抽屉（absolute 覆盖画布，带关闭）。
- 宽度 < 980px：右栏隐藏为「详情」抽屉，选中节点时自动打开，带关闭。
- 不出现横向滚动条；画布始终保留最大可用宽度。

### 4.3 顶部栏

- 标题「记忆图谱」+ 说明「探索你的记忆网络」。
- 搜索框：按标题/标签匹配；输入时显示最多 6 条下拉结果；点击结果选中并居中；Enter 选第一条；Esc 关闭。
- 全局/局部切换：全局显示筛选后的全部节点；局部以当前选中节点为中心按 1/2/3 层展开。
- 「路径」按钮：进入/退出路径探索模式。
- 窄屏时显示「筛选」按钮。

### 4.4 中央画布

必须实现：

1. **尺寸**：用 `ResizeObserver` 读取舞台像素尺寸，`viewBox` 与实际尺寸一致，画布填满中栏，不使用固定宽高比。
2. **布局**：确定性 Fruchterman–Reingold；初始位置用黄金角螺旋 + id 哈希，避免全部堆在中心；迭代 200 次后停止，不做持续动画；焦点在局部模式固定在中心。
3. **交互**：
   - 滚轮缩放（0.35–3.2，围绕指针位置）；
   - 空白拖拽平移；
   - 节点拖拽只改变布局位置，不改任何数据；
   - 双击节点打开原始记忆；
   - 单击空白清除选择；
   - 缩放 +/−、适配全部、居中选中、重置视图；
   - 程序化视图变化有 300ms 过渡，指针操作无过渡。
4. **节点**：
   - 半径 = `5 + sqrt(degree) * 2`，范围 5–18；选中 +3；
   - 颜色按类型族：profile/preference=蓝、project/project-state=绿、decision=琥珀、task=橙红、knowledge=青、experience=蓝紫；只使用现有 token 的 `color-mix`；
   - 孤立节点（全图真实度为 0）用空心虚线描边；
   - 选中节点：实心高亮 + 外环；悬停节点：光环增强；
   - 标签：n≤24 时全部显示；否则显示选中/悬停/邻接/匹配 + 度数前 18；缩放 <0.55 时只显示选中与悬停；标题最多 13 字加省略号。
5. **边**：
   - 手动链接：实线 1px，低对比；
   - 自动关联：虚线 `3 4`；
   - 共享标签派生边：点线 `1 5`，默认关闭，开启后明显更淡；
   - 默认不画箭头，避免线团；仅悬停/选中节点的邻接边显示小箭头；
   - 悬停或选中时，邻接边使用品牌色加粗，其余边降到 10% 透明度。
6. **悬停聚光灯**：高亮自身 + 直接邻接 + 相关边；无关节点降到 16%；不触发布局重算。
7. **零关系状态**：节点照常绘制（孤立空心），画布上方显示一条非阻断提示「尚未记录任何关系」+「自动补全」按钮；不得用空状态盖住画布。
8. **集群轮廓（P1）**：仅当存在真实边且集群 ≥2 个节点时，用凸包绘制极淡轮廓；点击轮廓筛选该集群。无真实边时没有集群，不得用标签凑数。
9. **性能**：布局与统计用 `useMemo`；悬停不重算布局；全图渲染上限 320 个节点（按度数降序），超出显示「另有 N 个节点未显示，请筛选」；卸载时断开 ResizeObserver、wheel 监听与指针捕获。

### 4.5 左栏筛选

所有筛选立即作用于画布：

- **记忆类型**：只列真实存在的类型，含计数与色点；多选，空=全部。
- **主题 / 项目标签**：真实标签按出现次数排序，最多 10 个 + 「全部」；多选；标签来自 `IndexRecord.tags`，不构造项目成员关系。
- **最近更新**：全部 / 30 天 / 90 天 / 1 年，基于 `updatedAt`。
- **关系显示**：全部 / 仅手动 / 仅自动；只影响边的显示，不改变节点。
- **派生关系开关**：显示共享标签派生边；默认关闭；说明「仅辅助布局，不代表真实关系」。
- **结构筛选**：全部 / 孤立 / 枢纽 / 桥接；基于全图真实边计算。
- **局部深度**：局部模式下显示 1 / 2 / 3；全局模式隐藏。
- **统计**：节点、已记录关系、自动关系、孤立、悬空。
- **操作**：自动补全（调用现有 `relink`）、刷新；兼容模式时禁用并说明。
- 左栏底部固定操作区，筛选项区域独立滚动。

### 4.6 右栏详情

选中节点后显示：

- 标题、类型、状态徽章、置顶标记；
- 摘要（截断）、更新时间、标签列表（点击标签立即筛选用该标签）；
- 度数统计：出链 / 入链 / 自动 / 共享标签；
- 「打开原始记忆」→ `page.openMemory(id)`；
- 「以此为中心探索」→ 切到局部模式、depth=2、选中该节点并适配视图；
- 「在图中定位」→ 居中该节点；
- 关联列表分组：
  - 出链（手写）：关系上下文行；
  - 自动关联：显示 `reason`（来自索引新增 `autoLinkReasons`）；
  - 反向链接；
  - 共享标签（派生）：显示共享标签名，明确标注「派生」；
- 点击任意关联行切换选中，并更新高亮与详情；
- 没有选中时显示「点击任意节点查看记忆详情」。

### 4.7 路径探索（P1）

- 顶部「路径」进入模式；提示「选择起点」→「选择终点」。
- 点击节点依次设置起点/终点；再一次点击重置终点。
- 使用已记录边（手动 + 自动，忽略方向）做 BFS 最短路径；派生边不参与。
- 有路径：高亮路径节点和边，显示「经过 N 层」，路径节点可点击查看详情。
- 无路径：明确显示「没有找到已记录的关联路径」。
- Esc 或「清除」退出。

### 4.8 图结构分析

全部基于真实边（不含派生边）：

- 度数：无向度数 = 入+出。
- 孤立：度数 0。
- 枢纽：度数 ≥ 3。
- 桥接：割点（去掉后连通分量增加）且度数 ≥ 2。
- 连通分量：无向 BFS。
- 集群：标签传播（最多 10 轮，确定性），只保留 ≥2 节点的社区；与「项目/标签分组」不同，UI 文案必须写明是「算法社区」。

## 5. 数据层改动

### 5.1 `src/shared/search.ts`

- `INDEX_FORMAT_VERSION` 从 6 升到 7。
- `IndexRecord` 增加可选 `autoLinkReasons?: Record<string, string>`（自动链接目标 → 理由）。
- 其他字段不变。

### 5.2 `src/host/core/indexing.ts`

- `recordFromDocument`：
  - 从 `memory.relatedAuto` 构建 `autoLinkReasons`，排除与手动链接同目标（大小写/宽度归一后）的条目；
  - 理由截断 300 字；
  - 仅在非空时写入记录。
- 索引反序列化：新增 lenient 解析 `autoLinkReasons`（只接受 string→string、值截断 300、最多 32 项），格式错误丢弃，不拒绝整份索引。
- 升级版本会导致旧索引重建一次，这是预期行为。

### 5.3 `src/shared/links.ts`

- `LinkGraphNode` 增加 `createdAt: string`。
- `LinkGraphEdge` 增加可选 `reason?: string`；仅自动边且有理由时写入。
- 新增纯函数与类型：
  - `analyseLinkGraph(graph): LinkGraphAnalysis`
    - `degree: Record<string, number>`
    - `isolated: string[]`
    - `hubs: string[]`
    - `bridges: string[]`
    - `components: string[][]`
    - `clusters: GraphCluster[]`（`{ key: number; nodeIds: string[] }`）
    - `avgDegree: number`
  - `shortestLinkPath(graph, from, to): string[] | null`
  - `buildTagDerivedEdges(nodes, limitPerNode = 2): DerivedTagEdge[]`
    - 忽略 `TYPE_DESCRIPTORS` 的默认标签与全局常见标签（df ≥ max(5, 45%)）；
    - 每个标签内按 id 排序后连成链，单节点最多 2 条；
    - 输出 `{ source, target, tag }`，去重。
  - `selectLinkGraph(graph, options): LinkViewResult`
    - options：`query, types, tags, since, relation, derived, special, scope, focusId, depth`
    - 先按类型/标签/时间过滤节点；
    - `special`：isolated/hubs/bridges 基于全图分析后取交集；
    - `scope=local`：以 focus 在真实边上 BFS 到 depth，保留焦点（即使被类型筛选排除）与通过筛选的邻域；
    - 边：两端都在可见集合，并按 relation 过滤；
    - `derived=true` 时附带派生边；
    - 返回 `matched`（搜索命中的可见 id，用于高亮）、`totalNodes`、`hiddenByCap`。
- 保留 `buildLinkGraph` / `buildLinkGraphFromRecords` 的现有行为与签名。

## 6. 前端文件改动

### 6.1 `src/client/views/links.tsx`（整体重写）

导出：

- `LinksView(props: { focus: string | null }): ReactElement`
- `computeLayout(input): LayoutResult`（纯函数，供单测）
  - input：`nodes, edges, width, height, focusId`
  - 返回：`{ nodes: PlacedNode[]; edges: PlacedEdge[]; hidden: number }`
- `MAX_LAYOUT_NODES = 320`

内部组件：

- `WorkbenchHeader`：标题、说明、搜索、全局/局部、路径、筛选按钮。
- `FilterRail`：类型、标签、时间、关系、派生、结构、深度、统计、relink。
- `GraphStage`：尺寸测量、布局、视图变换、节点/边/集群渲染、hover、drag、zoom、路径高亮、图例、缩放控件、零关系提示、兼容横幅。
- `DetailRail`：详情、关联分组、操作、路径结果。
- `SearchMenu`：搜索下拉。

删除旧导出 `computeScene`、`GRAPH_LIMITS`、`SceneNode/SceneEdge/SceneGhost` 等；同步重写布局测试。

### 6.2 `src/client/styles.ts`

替换旧 `/* links */` 段（约 343–465 行）为：

- `.lmv-wb` 全高三列 grid；
- `.lmv-wb-top`、`.lmv-wb-left`、`.lmv-wb-stage`、`.lmv-wb-right`、`.lmv-wb-facets`、`.lmv-wb-foot`；
- 画布背景：品牌色 4% 径向光 + 4% 点阵，`mask-image` 收边；没有霓虹、粒子；
- 节点/边/标签/集群/路径样式；
- 缩放控件、图例、零关系提示、兼容横幅；
- 抽屉与窄屏媒体查询（1240/980/720）；
- `prefers-reduced-motion` 下关闭所有非必要过渡；
- 所有颜色只用 `var(--dsw-alias-*)` 与 `color-mix`，不得出现裸 hex/rgba。

### 6.3 `src/client/ui.tsx`

`IconName` 增加并实现：`minus`、`fit`、`target`、`route`、`filter`、`close`（已有 close）。线条风格与现有图标一致。

### 6.4 `src/client/i18n.ts`

- 中英同步替换旧 `links.*` 键，新增本规格所需键（搜索、范围、筛选、结构、详情、路径、视图控制、零关系、派生、兼容短提示等）。
- 保持 ZH/EN 键完全一致、占位符一致。
- 不使用旧的误导文案「还没有任何链接」作为画布空状态。

## 7. 视觉与交互约束

- 深/浅色主题都成立：所有中性色由 label token 混合派生，避免写死黑/白。
- 只允许一种强调色（品牌蓝）+ 状态色族；选中关系用品牌色，路径用品牌色加粗，不用霓虹。
- 不在所有节点上发光；不常驻全部标签；不让边盖过节点。
- 动画只用于状态变化：抽屉、视图适配、hover 过渡；布局稳定后不播放循环动画。
- 文字排版：12–13px 正文、10.5–11px 辅助信息、标题 15–20px；数字用 `tabular-nums`。

## 8. 测试与验收

### 8.1 自动化

- `npm run typecheck`
- `npm run build`
- `npm run lint`
- `npx vitest run tests/unit/links.test.ts tests/unit/links-layout.test.ts tests/unit/i18n-parity.test.ts tests/unit/client-bundle.test.ts`
- `npx vitest run tests/unit`
- `npx vitest run tests/integration/service.test.ts -t "links"`

新增/更新测试：

- `tests/unit/links.test.ts`：
  - 自动边携带 reason；
  - 分析：孤立、枢纽、桥接、连通分量、集群；
  - BFS 路径存在/不存在；
  - `buildTagDerivedEdges` 不含默认标签、无重复边、单节点上限；
  - `selectLinkGraph`：类型/标签/时间/关系/结构/局部深度/派生。
- `tests/unit/links-layout.test.ts`：
  - 所有坐标有限且落在画布内；
  - 焦点在局部模式居中；
  - 0 边时节点仍全部布点且不重叠；
  - 超过 `MAX_LAYOUT_NODES` 时 `hidden` 正确；
  - 同一输入两次布局完全一致（确定性）。

### 8.2 手工视觉状态

1. 17 条 0 关系初始全局图；
2. 自动补全后有多条边；
3. 选中高连接节点；
4. 局部 depth=2；
5. 类型/标签/时间筛选后；
6. 仅孤立；
7. 0 条记忆的空状态；
8. 深色与浅色主题；
9. 1024px 与 <980px 窄窗（抽屉）；
10. 路径探索成功与无路径。

### 8.3 运行验收

- 构建产物 `lib/client.js` 的构建号变化。
- 插件在真实 DSH 中加载，导航进入「记忆图谱」。
- 节点数、关系数与 Vault 实际一致；无虚构关系。
- 打开原始记忆跳转 `DetailView`。
- 离开页面后其他功能无回归。
- 不使用独立 HTML 演示页或静态稿代替。

## 9. 交付报告必须包含

1. 功能清单；
2. 布局与交互说明；
3. 技术选择理由（SVG + 自写布局，不引入图库）；
4. 节点/关系数据来源；
5. 修改文件清单；
6. 新增依赖（预期 0）；
7. 构建与测试真实结果；
8. 已知问题与未完成 P1（如图片导出）；
9. 关键页面截图。

## 10. 风险与限制

- 运行中的 DSH 宿主必须完全重启，新增的 `links`/`relink`/索引 v7 才会生效；否则页面走兼容模式，自动关系为空、无理由。
- 旧索引会因版本升级重建一次；不迁移用户文件。
- 用户当前 0 条手写关系，自动补全结果取决于 `autolink.ts` 的真实阈值；不得为了「好看」降低阈值或伪造边。
- 超过 320 节点时只渲染前 320 个，必须显示未显示数量；后续如需更大规模再评估 WebGL。
