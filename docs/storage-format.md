# 存储格式

## 1. 唯一事实来源

**Markdown 文件是记忆的唯一事实来源。** 其余一切都是派生数据：

| 数据 | 位置 | 唯一来源？ | 丢失后果 |
|---|---|---|---|
| 记忆内容 | `<类别>/*.md` | ✅ 是 | 真丢失 |
| 仓库标记 + 设置 | `.dsh-memory/config.json` | ✅ 是（设置） | 需重新初始化 / 回到默认设置 |
| 索引 | `.dsh-memory/index.json` | ❌ 否 | 自动从 Markdown 重建，**零丢失** |
| 变更历史 | `.dsh-memory/journal/*.jsonl` | ❌ 否 | 失去审计轨迹，不影响记忆本身 |
| 隔离清单 | `.dsh-memory/quarantine/` | ❌ 否 | 只影响一次性校验记录 |
| 人类可读索引 | `Index/*.md` | ❌ 否 | 重建时重新生成 |

## 2. 目录布局

```
DSH Memory/
├── README.md                    插件生成；存在即不覆盖
├── Memory Home.md               入口页；存在即不覆盖
├── .obsidian/                   空目录，让 Obsidian 识别为 vault
├── Profile/                      type = profile
├── Preferences/                  type = preference
├── Projects/                     type = project
│   └── State/                    type = project-state
├── Decisions/                    type = decision
├── Knowledge/                    type = knowledge
├── Experiences/                  type = experience
├── Tasks/                        type = task
├── Inbox/                        status = pending
├── Archive/                      status = archived | superseded
├── Conflicts/                    status = conflict
├── Index/                        插件生成的人类可读索引
├── History/                      说明性目录
└── .dsh-memory/                  插件私有
    ├── config.json              仓库标记 + 用户设置
    ├── index.json               可重建索引
    ├── journal/YYYY-MM.jsonl    追加式变更日志
    └── quarantine/              初始化读写校验探针（瞬时）
```

**目录由 `status` 决定移动。** 把一条记忆设为 `archived` 会把文件从
`Decisions/` 物理移动到 `Archive/`——这是有意的：人在 Obsidian 里浏览时能直接看出
哪些不再有效。`stale` 留在原类别目录（它仍属于那个主题，只是过时了）。

`README.md` 与 `Memory Home.md` 是**只在缺失时创建**的，用户编辑后不会被重写。

## 3. 记忆文件格式

````markdown
---
id: mem_20261017t075957_b1c8069b
type: decision
status: active
title: 用 Markdown 作为唯一事实来源
created_at: 2026-10-17T07:59:57.013Z
updated_at: 2026-10-17T07:59:57.013Z
tags:
  - architecture
  - decision
confidence: high
importance: 85
pinned: false
source_sessions:
  - session-<redacted>
aliases:
  - 事实来源
supersedes:
  - mem_20261001t000000_aaaaaaaa
superseded_by: mem_20261101t000000_bbbbbbbb
conflicts_with:
  - mem_20261010t000000_cccccccc
evidence: 用户在验收时明确要求。
schema_version: 1
---

# 用 Markdown 作为唯一事实来源

## 核心内容

长期记忆以 Markdown 文件为核心，索引只是可重建的辅助数据。

## 附加说明（可选，用户可自行添加任意 ## 小节）

内容会原样保留。

## 来源与依据

用户在验收时明确要求。

## 相关记忆

- [[索引重建策略]]
````

### 3.1 Frontmatter 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 稳定唯一 ID，形如 `mem_<UTC紧凑时间>_<8位hex>` |
| `type` | enum | ✅ | `profile` \| `preference` \| `project` \| `project-state` \| `decision` \| `knowledge` \| `experience` \| `task` |
| `status` | enum | ✅ | `active` \| `pending` \| `stale` \| `superseded` \| `conflict` \| `archived` |
| `title` | string | ✅ | ≤300 字符；同时作为 H1 |
| `created_at` | ISO-8601 | ✅ | 首次写入时间，**永不因为编辑而改变** |
| `updated_at` | ISO-8601 | ✅ | 最近一次内容或元数据变化 |
| `tags` | string[] | | 自动小写、去 `#`、空格转 `-`；至少包含类别标签 |
| `confidence` | enum | | `low` \| `medium` \| `high`。`low` 不参与注入 |
| `importance` | int | | 0–100，影响召回排序 |
| `pinned` | bool | | 置顶的记忆进入常驻系统提示词块 |
| `source_sessions` | string[] | | 来源会话 ID（宿主提供时） |
| `aliases` | string[] | | 备用名称，提高精确匹配命中率 |
| `supersedes` | string[] | | 本记忆替代了哪些记忆 |
| `superseded_by` | string | | 替代本记忆的活动记忆 ID |
| `conflicts_with` | string[] | | 与本条存在事实矛盾的其他记忆 |
| `evidence` | string | | 可追溯来源说明 |
| `schema_version` | int | ✅ | 当前为 `1` |

**空集合与空字符串不写出**，让笔记更易读、diff 更干净。

### 3.2 正文结构

| 小节 | 归属 | 说明 |
|---|---|---|
| `# 标题` | 插件（来自 `title`） | 渲染时重写 |
| `## 核心内容` | 插件 | 对应 API 的 `summary` |
| `## <任意>` | **用户** | 插件原样保留并重新写出，可在 Obsidian 中自由添加 |
| `## 来源与依据` | 插件 / 用户 | 对应 `evidence`；缺失时写「（暂无可追溯来源）」 |
| `## 相关记忆` | 用户 | `[[wikilink]]` 列表，索引会解析成双向关系 |

前导段落（第一个 `##` 之前）在没有 `## 核心内容` 时被当作 summary，因此手写的普通
笔记也能被安全解析。

## 4. 解析宽容度

解析器刻意宽容，因为用户会用 Obsidian 手改文件：

| 情况 | 行为 |
|---|---|
| UTF-8 BOM、CRLF | 接受并规范化 |
| `created_at: 2026-10-17`（仅日期） | 补成 `2026-10-17T00:00:00.000Z` |
| `created_at: 2026-10-17 03:12` | 接受 Obsidian 风格，补秒与 Z |
| `created_at: 2026-10-17T11:12:00+08:00` | 归一到 UTC |
| `tags: a, b`（字符串） | 按逗号/空格拆分 |
| 未知 `type` | 修复为 `knowledge`，记录修复说明 |
| 未知 `status` | 修复为 `pending`（**绝不猜成 active**），记录修复说明 |
| 缺少 `created_at` | 补为当前时间并记录 |
| `importance: 999` | 裁剪到 100 |
| 某条 `## 小节` 结构异常 | 丢弃该小节，保留整条记忆 |
| 覆盖层损坏到无法校验（如 `id` 缺失） | 进入 `quarantined` 列表，**其余记忆照常工作** |
| 文件完全没有 frontmatter | 视为普通笔记，忽略（不算错误） |

**一条坏记忆不能拖垮整个索引。** 这是 `docs/verification.md` 里专门测过的一节。

## 5. 索引格式（`.dsh-memory/index.json`）

```json
{
  "version": 3,
  "builtAt": "2026-10-17T07:59:20.596Z",
  "vaultPath": "D:/.../DSH Memory",
  "records": [
    {
      "id": "mem_…",
      "path": "Decisions/用 Markdown 作为唯一事实来源-mem_….md",
      "type": "decision",
      "status": "active",
      "title": "用 Markdown 作为唯一事实来源",
      "tags": ["architecture", "decision"],
      "aliases": [],
      "confidence": "high",
      "importance": 85,
      "pinned": false,
      "createdAt": "…",
      "updatedAt": "…",
      "preview": "长期记忆以 Markdown 文件为核心…",
      "terms": { "长期": 8, "记忆": 8, "markdown": 9 },
      "links": ["索引重建策略"],
      "size": 562,
      "mtimeMs": 1760000000000,
      "checksum": "1a2b3c4d"
    }
  ]
}
```

- `terms` 是字段加权后的词权重：标题 ×8、别名/标签 ×6、摘要 ×3、正文 ×1，重复词用
  `1 + log(n)` 抑制。
- `postings`（倒排表）与双向链接解析结果**不持久化**，加载时从 `records` 重算——文件
  更小，可损坏的面更少。
- `checksum` 是 FNV-1a 内容指纹，用于跳过未改动文件；`size`/`mtimeMs` 用于检测外部修改。

### 5.1 索引失效的判定

以下任一情况，索引被**丢弃并从 Markdown 重建**（不报错、不阻塞）：

- 文件不存在
- 不是合法 JSON
- `version` 不匹配（格式升级）
- 缺少 `records` 数组或 `vaultPath`
- 任一条 `record` 字段类型不对
- `vaultPath` 与当前仓库不一致（防止把别的仓库的索引当自己的）

## 6. CJK 分词

中文没有空格，因此：

- 拉丁/数字串：小写后按非字母数字切分，单字母丢弃（保留单个数字）
- CJK 连续段：同时产出**单字**和**相邻双字**
  - `长期记忆` → `长`、`期`、`记`、`忆`、`长期`、`期记`、`记忆`
- 查询与建索引用同一分词器，所以中文子串查询天然可用
- **相似度判定**只用双字 + 拉丁词（单字过于嘈杂），并用重叠系数
  `|A∩B| / min(|A|,|B|)` 而不是 Jaccard——中文笔记长度差异大，Jaccard 会惩罚短补充

## 7. 变更日志（`.dsh-memory/journal/YYYY-MM.jsonl`）

一行一条 JSON：

```json
{"at":"2026-10-17T07:59:20.630Z","op":"init","id":"*","reason":"首次初始化长期记忆仓库","after":"D:/…/DSH Memory"}
{"at":"…","op":"update","id":"mem_…","before":"[decision/active] 用 Markdown… :: 长期记忆以 Markdown…","after":"[decision/active] 用 Markdown… :: …可随时删除并重建…","reason":"用户在管理页面编辑记忆","source":"session-…"}
```

- `op`：`create` `update` `delete` `archive` `stale` `supersede` `conflict` `merge`
  `confirm` `reject` `index-rebuild` `index-sync` `init` `migrate`
- `before` / `after` 是**有界摘要**（类别/状态/标题/前 160 字），不是全文——日志因此
  很小，也不会变成第二份记忆库
- 追加式：只 append，不重写
- 崩溃时可能留下半行；读取时解析失败的行被跳过，不影响其余

## 8. 配置（`.dsh-memory/config.json`）

```json
{
  "product": "dsh-longterm-memory",
  "schemaVersion": 1,
  "createdAt": "…",
  "updatedAt": "…",
  "settings": { "language": "zh", "recallMaxItems": 5 },
  "notes": []
}
```

- `product` 是仓库归属的唯一判据；`product` 不同即拒绝接管该目录
- `settings` **只保存用户改过的字段**（delta），这样 `cordis.patch.yml` 仍能作为
  组合默认值来源
- **绝不写入任何机密**：设置项只有语言、预算、开关等，没有任何凭据字段

## 9. 重复 ID 的处理

如果两个文件声明同一个 `id`（备份恢复、中断的移动、手工复制），索引只能收录一个。
`scanVault` 会把它们列入 `duplicates`，管理页面通过 `overview.duplicates` 显示，
让用户自己决定保留哪份——**而不是静默挑一个**。

正常的 `status` 变更会**先写新位置、再删旧位置**（同一把文件锁内），因此不会产生
重复；这条路径有专门测试。
