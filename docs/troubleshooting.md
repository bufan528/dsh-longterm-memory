# 故障排查

## 左侧栏没有「长期记忆」

按顺序检查：

1. **插件真的装上了吗**

   ```powershell
   $env:DSH_HOME = "<你的 DSH_HOME>"
   & "<DSH install>\resources\runtime\cli\bin\dsh.cmd" --profile <name> --dump-config |
     Select-String 'dsh-longterm-memory' -Context 0,6
   ```

   没有输出 ⇒ 安装没成功。检查 profile 的 `package.json` 里
   `dsh.profile.bundles` 是否包含 `dsh-longterm-memory`。

2. **客户端 bundle 构建了吗**

   宿主只服务**已构建**的 `lib/client.js`。仓库里如果只有 `lib/host/`，先跑：

   ```bash
   npm run build
   ```

   然后**重新打包并重装**（pnpm 会把包硬链接进 profile，新增文件必须重装）。
   构建成功的标志：

   ```
   build-client: wrote …\lib\client.js (… bytes, id dsh-longterm-memory)
   ```

3. **入口被别的插件覆盖了吗**

   其它插件如果也注册 `sidebar.panellist` 的 `id: 'longterm-memory'`，会撞 id 抛错。
   改本包的 `PANEL_ID`（`src/client/sidebar-entry.ts`）并在 `package.json` 里确认
   没有重复。

4. **页面注册了但入口没显示**

   入口是 `sidebar.panellist` 的 list slot，`order: 20`。若你的 profile 禁用/移除了
   `@deepseek-ai/dsh-client-ui-sidebar`，入口无处可挂——此时页面仍可通过
   `ctx.layout.selectPanel('longterm-memory')` 打开。

## 页面显示「宿主不可达」或一直转圈

页面通过 `POST /dsh-longterm-memory/api/status` 取数。检查：

1. **`ctx.webServer` 存在吗** —— 纯终端/无界面 profile 没有它。此时状态会显示
   `host 未提供 ctx.webServer`，属预期降级：存储、索引、提示词、工具都不受影响，
   只是没有管理页面。

2. **信任围栏拒绝了请求吗** —— 路由要求 `Host` 是 loopback 或
   `ctx.webRuntime.trustedHosts` 中的授权值。远程访问时用：

   ```bash
   dsh --profile <name> --trusted-host 192.168.1.10:19387
   ```

3. **能力显示 `false`** —— 打开页面 → 设置，看「能力」区块里的 `notes`。每条都会
   说明具体原因（例如「配置已关闭」「宿主未提供」）。

## 仓库没有自动创建

这是**有意的**，不是 bug。`detectEnvironment()` 判定：

| 环境 | 行为 |
|---|---|
| `desktop`（Electron） | 唯一候选时自动创建 |
| `web` / `node` | 需要用户确认 |

在服务器侧运行 `web` profile 时，进程能写的是**服务器**磁盘，不是用户本机。插件不会
在用户看不到的地方静默建库。解决：在管理页面点初始化，或在 profile 的
`cordis.patch.yml` 里显式给出 `vaultPath`（显式路径**总是**会被采用，包括自动创建）。

## 初始化被拒绝：目录已存在且包含其他文件

```
目录已存在且包含其他文件（xxx），为避免覆盖用户数据，拒绝在此初始化。
```

插件只在**空目录**、**尚不存在的目录**、或**确认属于自己的仓库**上初始化。

- 想用这个位置 → 先手动清空，或换一个子目录；
- 目录里已有 `.dsh-memory/config.json` 但 `product` 不是 `dsh-longterm-memory`
  → 那是别的产品的目录，换个位置；
- 标记文件被截断（写到一半崩溃）→ 插件会**修复**它：只要目录里还有本插件生成的
  `Index/all-memories.md`、`Memory Home.md` 或 `.dsh-memory/`。

## 索引损坏 / 索引丢失

不需要处理。加载时会自动发现并**从 Markdown 完整重建**。手动触发：

```
管理页面 → 总览 → 手动重建索引
```

或 `POST /api/rebuildIndex`。

**索引损坏永远不会丢记忆**，因为索引里没有任何 Markdown 之外的事实。

## 我在 Obsidian 里改了文件，页面没变

点击「同步索引」（`POST /api/syncIndex`）。它会：

- 内容指纹变了 → `updated`
- 新文件 → `added`
- 文件被删 → `removed`
- 顺便检测两个文件声明同一 `id` → 出现在 `duplicates`

如果「总览 → 与磁盘不一致」列出了某条，说明该文件的 size/mtime 与索引记录不符。

## 手写的笔记被当成记忆了（或没被当成记忆）

判定规则（`scanVault`）：

- **是**记忆：YAML frontmatter 里有非空 `id`，**或**文件名以 `-mem_…` 结尾
- **不是**记忆：其余所有 `.md` 都忽略（README、Index 页、你自己的普通笔记）

所以手写记忆只要带上 `id` 就会被收录。想让某条永远不被收录：不要写 `id`，也不要让
文件名以 `-mem_` 结尾。

## 我的记忆被写进了 `Inbox/` 且状态是 `pending`

这是设计：**低置信度 / 敏感内容 / 需要人工判断的候选不会被写成事实**。在页面里
「确认」它即可（状态转 `active`、文件移回类别目录、`low` 置信度提升为 `medium`）。

要减少这种情况：更明确地陈述事实（例如以「请记住：…」开头），或调大
`maxCandidatesPerTurn`。

## 出现「已拒绝：包含机密」

说明这条内容**主要是**一个凭据（占比 ≥ 50%）。这是默认的隐私保护。

- 想让它保存 → 不要把真实凭据写进对话（推荐）；
- 确实要关闭 → 设置里关 `redactSecrets`（**不建议**：Markdown 是明文的）。

## `write-conflict` / 「文件已被其他程序修改」

你在编辑 Markdown 视图时，文件在别处（Obsidian、另一个 DSH 窗口）被改了。UI 会给出
提示并提供重新载入。这是**防止静默丢失编辑**的保护。

## `another DSH process is writing …` / `FS_BUSY`

同一仓库上的跨进程写锁超时。通常是另一个 DSH 实例正在写。

- 等几秒重试；
- 如果确定没有别的进程，删掉残留的 `<文件>.lock`（位于被写文件旁边）。锁文件里有
  holder pid，进程已退出时会被自动接管。

## 提示词里没有记忆

按顺序检查：

1. 设置里 `enablePromptSection` 是否为 `true`；
2. 宿主是否提供 `ctx.systemPrompt`（打开页面 → 设置 → 能力）；
3. 有符合条件的记忆吗 —— 常驻块**只**取 `status = active` 的 `profile` / `preference`，
   以及所有 `pinned` 记忆。普通 `knowledge` / `decision` 不进常驻块；
4. 直接看「预览召回」：它显示的就是**会注入的确切文本**（含 token 数与省略条数）。
   注意「预览召回」用的是按需检索通道，与常驻块条件不同。

## 模型不调用 `memory_search`

1. 设置里 `enableTools` 是否为 `true`；
2. 能力里 `registeredTools` 是否列出了 4 个工具；
3. 工具的 `description` 会告诉模型何时使用——若模型不调用，通常是它认为当前任务不需要
   长期记忆，这是正常行为。

## 想彻底重来

```text
1. 管理页面 → 设置 → 查看存储路径
2. 备份需要保留的 Markdown（可选）
3. 删除整个 vault 目录（这会真删记忆！）
4. 重新打开「长期记忆」页面 → 初始化
```

只想重置索引：删除 `<vault>/.dsh-memory/index.json`，无需其它操作。

## 卸载

```powershell
$env:DSH_HOME = "<你的 DSH_HOME>"
& "<DSH install>\resources\runtime\cli\bin\dsh.cmd" plugin --profile <name> remove dsh-longterm-memory
```

**卸载不会删除 vault。** 记忆是你的 Markdown 文件，留在原处。若要同时删除插件私有
数据，手动删 `<vault>/.dsh-memory/`。

重装后插件会通过 `vaultPath` 设置或自动发现重新接上原仓库。

## 已知的日志位置

| 需要看什么 | 去哪 |
|---|---|
| 插件自己的变更审计 | `<vault>/.dsh-memory/journal/YYYY-MM.jsonl` |
| 被隔离的坏文件 | `POST /api/rebuildIndex` 返回的 `quarantined` |
| 插件管理器安装过程 | `<profile>/.plugin-manager/logs/operation-*/pnpm.log` |
| 宿主启动日志 | `dsh --profile <name>` 的标准输出 |

## 模型辅助提取没有生效

1. 设置 → 后端能力里「模型提取」是灰的还是绿的？
   - 灰 + 提示「默认关闭」→ 去设置里打开 `enableLlmExtraction`；
   - 灰 + 提示「无法加载 @deepseek-ai/dsh-llm」/「宿主未提供 ctx.llm」/「未提供
     ctx.agentDefaultModel」→ 这台 DSH 不满足条件，功能自动停用（插件本体不受影响）。
2. 打开后每一轮结束都会调用一次模型，**会产生费用**。不想付费就保持关闭。
3. 提取结果没有立刻变成记忆，是正常的：只有 `high` 置信度且能追溯到对话原文的才自动写入，
   其余进入「收件箱」等你确认。
4. 想看上一次模型提取做了什么：插件会在日志里记录
   `模型辅助提取：采纳 N 条…路由 provider/model`，或失败原因。
5. 如果你不希望对话离开本机，**不要打开这个开关**。默认的规则提取完全本地、零调用。

## `previewStanding` 显示「未注册」

说明系统提示词分区没注册成功，通常是：
- 设置里 `enablePromptSection` 被关掉；
- 宿主没有提供 `ctx.systemPrompt`（纯终端 profile）。

此时记忆仍可通过 `memory_search` 工具与按需召回使用，只是不再常驻系统提示词。
