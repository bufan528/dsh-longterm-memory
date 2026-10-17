# DSH Memory Vault · 长期记忆

一个真正可用的 **DeepSeek Harness（DSH）长期记忆插件**：把记忆持久化为本机
**Obsidian 兼容的 Markdown 仓库**，在 DSH 左侧栏提供独立管理页面，并在后续会话中
按 token 预算检索与注入。

- npm 包名：`dsh-longterm-memory`
- 插件显示名：**长期记忆**
- 产品名：**DSH Memory Vault**
- 已验证的 DSH 版本：**`0.2.1-rc.2`**（以 `engines.dsh` 为准）

> ⚠️ **包名说明**：任务书期望的 `dsh-memory-vault` **已被他人占用**（`flymysql`，
> v0.1.5，且是面向 DSH `0.1.0-rc.6` 的同类产品）。本仓库因此使用经过核实未被占用的
> `dsh-longterm-memory`。详见 [`docs/compatibility.md`](docs/compatibility.md#包名冲突)。

---

## 它做了什么

| 能力 | 实现方式 |
|---|---|
| **本地长期记忆** | 每条记忆是一个独立的 Markdown 文件（YAML Frontmatter + 自然语言正文），可直接在 Obsidian 中阅读、编辑、双向链接 |
| **可重建索引** | 索引是 `.dsh-memory/index.json`，**纯粹是派生数据**；删除后从 Markdown 完整重建，不丢任何记忆 |
| **侧边栏入口** | 通过 DSH 官方 Slot `sidebar.panellist` 注册一级入口，`order: 20`（在「插件」「自动化任务」之下，「工作区」之上） |
| **独立管理页面** | 通过官方 `main` keyed slot 注册，点击入口**打开页面而不是新建聊天** |
| **记忆总览 / 检索 / 详情 / 管理** | 全部读取真实 Host 数据（HTTP RPC），无静态假数据 |
| **自动记忆提取** | 在真实的 `session/event` → `turn/end` 边界上提取候选记忆。默认用**确定性本地规则**（零成本、零外发）；可选的模型辅助提取默认关闭，开启后会调用你自己配置的模型 |
| **安全更新** | 去重 → 合并；补充 → 更新并保留来源；矛盾 → 双方都保留；低置信度 → 进 Inbox 待确认 |
| **后续会话使用记忆** | `ctx.systemPrompt.section()` 的 `text` 函数**在每次组装时重新求值**，按预算注入当前记忆；另提供 4 个模型工具做按需检索；`POST /api/previewStanding` 可核验插件真实贡献的提示词文本 |
| **隐私** | 默认拒绝写入密码 / API Key / 令牌 / 私钥；敏感类别强制人工确认；**默认零网络请求、零模型调用** |

## 界面实拍（真实 headless Chrome 验收）

左侧栏顺序与要求一致：**插件 → 自动化任务 → 长期记忆 → 工作区 → 会话列表**。

![左侧栏中的「长期记忆」入口](docs/evidence/02-sidebar.png)

![长期记忆管理页面（真实数据）](docs/evidence/03-page.png)

更多截图（检索 / 管理 / 收件箱 / 设置）见 [`docs/evidence/`](docs/evidence/)，
验收方法与原始 DOM 数据见 [`docs/verification.md`](docs/verification.md#6-侧边栏与页面验收真实浏览器)。

---

## 安装

### 正式发布后（期望形态）

```bash
dsh plugin --profile web add dsh-longterm-memory
```

> **当前并未发布到 npm。** 本仓库是本地开发版本，安装方式见下。

### 本地开发 / 验证（已实际验证）

```bash
# 1. 构建并打包
pnpm install
npm run build
npm pack                      # 产出 dsh-longterm-memory-0.1.0.tgz

# 2. 安装到隔离 profile（不会动真实 profile）
$env:DSH_HOME = "<一个临时目录>"
& "<DSH install>\resources\runtime\cli\bin\dsh.cmd" --profile lmv --from-default-profile web --dump-config
& "<DSH install>\resources\runtime\cli\bin\dsh.cmd" plugin --profile lmv add .\dsh-longterm-memory-0.1.0.tgz

# 3. 配置仓库路径（可选；不配则自动发现）
#    编辑 <DSH_HOME>\profiles\lmv\cordis.patch.yml，加入：
#    - id: longterm-memory
#      name: dsh-longterm-memory
#      config:
#        vaultPath: 'D:/path/to/DSH Memory'

# 4. 启动
& "<DSH install>\resources\runtime\cli\bin\dsh.cmd" --profile lmv --no-open --port 0
```

左侧栏出现 **长期记忆** 后，点击即进入管理页面。首次打开会显示环境探测结果，
可一键初始化仓库或手动选择路径。

---

## 仓库结构

```
DSH Memory/
├── README.md                    # 插件生成的说明（用户可改，不会重写）
├── Memory Home.md               # 入口页
├── .obsidian/                   # 让 Obsidian 识别为 vault（不修改 Obsidian 全局配置）
├── Profile/  Preferences/       # 用户背景 / 长期偏好
├── Projects/  Projects/State/   # 项目 / 项目进展
├── Decisions/  Knowledge/       # 决策 / 知识
├── Experiences/  Tasks/         # 经验教训 / 任务
├── Inbox/                       # 待确认的候选记忆
├── Archive/                     # 已归档 / 被替代
├── Conflicts/                   # 存在事实冲突
├── Index/                       # 人类可读索引（重建时覆盖）
├── History/                     # 变更历史说明
└── .dsh-memory/                 # 插件私有：config.json, index.json, journal/, quarantine/
```

**Markdown 文件是唯一事实来源。** 只删 `.dsh-memory/index.json` 不会丢任何记忆。
完整格式见 [`docs/storage-format.md`](docs/storage-format.md)。

---

## 开发

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # 自定义契约检查（无 @deepseek-ai/* 依赖、bundle 格式、manifest 契约）
npm test             # 运行完整测试套件（数量以本机实际输出为准）
npm run build        # tsc -> lib/host, esbuild -> lib/client.js (__ModuleLoader__ 格式)
npm run check        # 依次跑上面四步
npm run pack:plugin  # build + npm pack
npm run verify:ui    # 真实 headless Chrome 验收（需先 --url <隔离宿主 URL>）
```

浏览器验收脚本（`scripts/ui-verify.mjs` / `scripts/ui-acceptance.mjs`）是**零依赖**的
CDP 实现，只使用 Node 24 自带的 `WebSocket`，不安装 Puppeteer/Playwright。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/precheck.md](docs/precheck.md) | 第一轮 Phase 0 只读预检：环境基线、证据表、边界 |
| [docs/architecture.md](docs/architecture.md) | 架构、DSH 接口依据、模型提取与提示词自证 |
| [docs/storage-format.md](docs/storage-format.md) | Markdown / Frontmatter / 索引 / 日志格式 |
| [docs/privacy.md](docs/privacy.md) | 隐私与安全模型、威胁分析、模型提取的数据流 |
| [docs/compatibility.md](docs/compatibility.md) | 冻结的契约、manifest 字段、包名冲突、desktop 边界 |
| [docs/verification.md](docs/verification.md) | **第二轮**真实执行过的验证与真实输出（本轮证据入口） |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 常见问题与恢复步骤 |
| [docs/evidence/](docs/evidence/) | 真实浏览器截图、页面文本、侧边栏 DOM 数据 |
| [.recon/findings/](.recon/findings/) | 四份只读技术调查报告（DSH 源码证据来源） |

## 授权边界

本仓库**没有**执行 `git commit` / `git push` / `npm publish`，**没有**向真实用户 Obsidian
Vault 写入任何内容，**没有**发起真实模型请求，也**没有**安装到正在运行的真实
`desktop` profile。所有安装与运行验证都在 `DSH_HOME` 指向的临时目录中完成。逐项清单见
[`docs/verification.md`](docs/verification.md#9-本轮未执行的授权边界)。

## License

MIT
