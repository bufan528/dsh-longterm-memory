/**
 * The plugin's own text dictionary plus the bridge to the *optional* `locale`
 * service.
 *
 * Design: Chinese is the default and the source of truth, English is secondary
 * and kept complete. When `ctx.inject(['locale'], …)` fires, the bound
 * translator is remembered in {@link boundTranslator} and consulted first; a key
 * it does not know falls back to this module's dictionary, so the panel still
 * renders correctly on a build with no locale service at all.
 *
 * @module dsh-longterm-memory/client/i18n
 */

import { useCallback, useEffect, useState } from 'react'

import type { LocaleService } from './context.js'

/** Locale namespace this panel owns. */
export const NS = 'longterm-memory'

/** Languages the host settings allow. */
export type Language = 'zh' | 'en'

/** A translator. */
export type Translate = (key: string, params?: Record<string, unknown>) => string

const ZH: Record<string, string> = {
  panel: '长期记忆',
  'page.title': '长期记忆',
  'page.subtitle': '本地 Markdown 记忆库',

  'nav.overview': '记忆总览',
  'nav.search': '记忆检索',
  'nav.manage': '记忆管理',
  'nav.inbox': '收件箱',
  'nav.settings': '设置',

  'common.loading': '加载中…',
  'common.retry': '重试',
  'common.error': '操作失败',
  'common.cancel': '取消',
  'common.confirm': '确认',
  'common.save': '保存',
  'common.close': '关闭',
  'common.refresh': '刷新',
  'common.reload': '重新读取',
  'common.apply': '应用',
  'common.reset': '重置',
  'common.all': '全部',
  'common.none': '无',
  'common.back': '返回',
  'common.empty': '暂无数据',
  'common.delete': '删除',
  'common.edit': '编辑',
  'common.copy': '复制',
  'common.copied': '已复制',
  'common.unknown': '未知',
  'common.yes': '是',
  'common.no': '否',
  'common.enabled': '已启用',
  'common.disabled': '已停用',
  'common.selected': '已选 {count} 项',
  'common.more': '展开',
  'common.less': '收起',
  'common.never': '从未',
  'common.optional': '可选',
  'common.comma': '（逗号分隔）',
  'common.listSep': '；',

  'state.loadingPage': '正在读取记忆库状态…',
  'state.failedTitle': '无法连接记忆库后端',

  'status.active': '当前',
  'status.pending': '待确认',
  'status.stale': '已过时',
  'status.superseded': '已被取代',
  'status.conflict': '冲突',
  'status.archived': '已归档',
  'confidence.low': '低',
  'confidence.medium': '中',
  'confidence.high': '高',

  'init.title': '初始化记忆库',
  'init.intro': '尚未初始化记忆库。以下是本机探测结果，确认后即可创建或接管一个 Markdown Vault。',
  'init.environment': '运行环境',
  'init.filesystem': '文件系统访问',
  'init.obsidianDetected': '检测到 Obsidian',
  'init.obsidianConfig': 'Obsidian 配置',
  'init.current': '当前生效路径',
  'init.rationale': '判定依据',
  'init.warnings': '警告',
  'init.candidates': '候选路径',
  'init.noCandidates': '没有探测到候选路径，请在下面手动填写。',
  'init.manual': '手动输入路径',
  'init.manualPlaceholder': '例如 D:\\Memory\\ObsidianVault',
  'init.initialize': '初始化记忆库',
  'init.working': '正在初始化…',
  'init.needsChoice': '需要先选定一个路径',
  'init.ready': '可以初始化',
  'init.done': '记忆库已就绪',
  'init.environment.desktop': '桌面应用',
  'init.environment.web': '网页',
  'init.environment.node': 'Node',

  'overview.total': '记忆总数',
  'overview.byType': '分类统计',
  'overview.pending': '待确认数量',
  'overview.problems': '冲突/异常数量',
  'overview.pinned': '置顶数量',
  'overview.stale': '已过时',
  'overview.archived': '已归档',
  'overview.outOfSync': '与磁盘不同步',
  'overview.recentCreated': '最近新增',
  'overview.recentUpdated': '最近更新',
  'overview.pendingList': '待确认的记忆',
  'overview.problemsList': '冲突与异常',
  'overview.tags': '标签',
  'overview.tagsHint': '点击标签可在「记忆检索」中过滤',
  'overview.vaultPath': '存储路径',
  'overview.indexBuiltAt': '索引构建时间',
  'overview.indexCount': '索引条目',
  'overview.indexHealthy': '索引状态',
  'overview.indexHealthyYes': '正常',
  'overview.indexHealthyNo': '已损坏并重建',
  'overview.indexPath': '索引文件',
  'overview.rebuild': '手动重建索引',
  'overview.sync': '同步索引',
  'overview.busy': '索引重建进行中…',
  'overview.rebuildDone': '索引重建完成：{records} 条记录，修复 {repaired} 个文件，用时 {ms} ms',
  'overview.syncDone': '同步完成：新增 {added}，更新 {updated}，移除 {removed}，未变 {unchanged}',
  'overview.capabilities': '后端能力',
  'overview.notes': '限制说明',
  'overview.noStats': '还没有统计信息',
  'overview.outOfSyncList': '以下文件的 Markdown 在磁盘上被改动过，索引尚未跟上：',

  'cap.filesystem': '文件系统',
  'cap.webServer': 'HTTP 服务',
  'cap.systemPrompt': '系统提示词',
  'cap.tools': '模型工具',
  'cap.sessionEvents': '会话事件',
  'cap.llmExtraction': '模型提取',
  'cap.registeredTools': '已注册工具',

  'search.text': '关键词',
  'search.textPlaceholder': '输入关键词、标题或记忆 ID',
  'search.debounceHint': '输入后 250 毫秒自动检索',
  'search.types': '类别',
  'search.statuses': '状态',
  'search.tag': '标签',
  'search.tagPlaceholder': '例如 project',
  'search.since': '起始日期',
  'search.until': '截止日期',
  'search.pinnedOnly': '只看置顶',
  'search.includeNonCurrent': '包含非当前记忆（已归档 / 已过时 / 已取代 / 冲突）',
  'search.limit': '结果上限',
  'search.run': '搜索',
  'search.resultCount': '共 {total} 条结果，用时 {ms} ms',
  'search.indexRefreshed': '（查询前刷新了索引）',
  'search.reasons': '匹配原因',
  'search.score': '得分',
  'search.noResults': '没有匹配的记忆',
  'search.select': '多选',
  'search.merge': '合并重复记忆',
  'search.clearSelection': '清除选择',
  'search.selectHint': '勾选两条以上即可合并',

  'merge.title': '合并重复记忆',
  'merge.hint': '选择一条作为保留项，其余记忆的内容会折叠进它并转为已归档。',
  'merge.survivor': '保留',
  'merge.folded': '将被合并',
  'merge.reason': '合并原因',
  'merge.run': '执行合并',
  'merge.done': '已合并到 {id}',
  'merge.needTwo': '至少选择两条记忆才能合并',

  'detail.title': '记忆详情',
  'detail.notFound': '未找到该记忆',
  'detail.summary': '核心内容',
  'detail.sections': '其他段落',
  'detail.path': '文件路径',
  'detail.absolutePath': '绝对路径',
  'detail.type': '类别',
  'detail.status': '状态',
  'detail.tags': '标签',
  'detail.aliases': '别名',
  'detail.confidence': '置信度',
  'detail.importance': '重要性',
  'detail.pinned': '置顶',
  'detail.createdAt': '创建时间',
  'detail.updatedAt': '更新时间',
  'detail.sourceSessions': '来源会话',
  'detail.evidence': '证据',
  'detail.supersedes': '取代了',
  'detail.supersededBy': '被取代于',
  'detail.conflictsWith': '与之冲突',
  'detail.related': '相关记忆',
  'detail.recallable': '召回资格',
  'detail.recallableYes': '当前可被召回',
  'detail.recallableNo': '当前不会被召回',
  'detail.recallNote': '召回说明',
  'detail.history': '变更历史',
  'detail.historyEmpty': '暂无变更记录',
  'detail.before': '变更前',
  'detail.after': '变更后',
  'detail.source': '来源',
  'detail.reason': '原因',
  'detail.op': '操作',
  'detail.at': '时间',
  'detail.tabFields': '字段编辑',
  'detail.tabRaw': '原文 Markdown',
  'detail.actions': '操作',

  'edit.newTitle': '新建记忆',
  'edit.fieldTitle': '标题',
  'edit.summary': '摘要',
  'edit.tags': '标签',
  'edit.aliases': '别名',
  'edit.evidence': '证据',
  'edit.confidence': '置信度',
  'edit.importance': '重要性（0-100）',
  'edit.status': '状态',
  'edit.pinned': '置顶',
  'edit.type': '类别',
  'edit.saved': '已保存：{id}',
  'edit.repairs': '已自动修正',
  'edit.warnings': '警告',
  'edit.needTitle': '标题不能为空',
  'edit.hint': '摘要支持换行与 `- ` 列表，会按 Markdown 的段落结构渲染。',

  'raw.title': '原文 Markdown',
  'raw.hint': '直接编辑磁盘上的 Markdown。写入时携带读取时的校验和；若文件已被其他程序改动，写入会被拒绝而不会覆盖。',
  'raw.load': '读取原文',
  'raw.write': '写入文件',
  'raw.conflict': '写入冲突：该文件已在磁盘上被其他程序修改，为避免覆盖，插件拒绝写入。请先重新读取。',
  'raw.written': '原文已写入',
  'raw.path': '相对路径',
  'raw.checksum': '校验和',

  'action.confirm': '确认待处理记忆',
  'action.reject': '拒绝',
  'action.archive': '归档',
  'action.stale': '标记过时',
  'action.restore': '恢复为当前',
  'action.pin': '置顶',
  'action.unpin': '取消置顶',
  'action.delete': '删除',
  'action.resolve': '处理冲突',
  'action.done': '操作已完成',
  'action.archived': '已归档：{id}',
  'action.staled': '已标记过时：{id}',
  'action.restored': '已恢复：{id}',
  'action.pinned': '已置顶：{id}',
  'action.unpinned': '已取消置顶：{id}',
  'action.confirmed': '已确认：{id}',
  'action.rejected': '已拒绝：{id}',
  'action.reason': '原因',

  'delete.title': '删除记忆',
  'delete.warning': '删除会把该记忆的 Markdown 文件从 Vault 中移除，且不可撤销。',
  'delete.typePrompt': '请输入该记忆的 ID 以继续：',
  'delete.typePlaceholder': '粘贴记忆 ID',
  'delete.mismatch': '输入的 ID 与目标不一致',
  'delete.final': '二次确认：真的要删除吗？',
  'delete.finalYes': '我确定，删除',
  'delete.archiveOnly': '仅归档（保留文件）',
  'delete.done': '已删除：{id}',

  'conflict.title': '处理冲突',
  'conflict.keep': '保留本条，归档冲突方',
  'conflict.merge': '合并为一条',
  'conflict.both': '两条都保留，仅清除冲突标记',
  'conflict.others': '冲突对象',
  'conflict.none': '没有检测到冲突对象',
  'conflict.done': '冲突已处理，归档 {count} 条',
  'conflict.reason': '处理说明',

  'manage.title': '记忆管理',
  'manage.index': '索引维护',
  'manage.storage': '存储位置',
  'manage.selection': '批量操作',
  'manage.selectionHint': '在「记忆检索」中勾选记忆后，可在这里批量改变状态或合并。',
  'manage.selectionEmpty': '当前没有勾选任何记忆',
  'manage.vaultPath': 'Vault 路径',
  'manage.indexPath': '索引文件',
  'manage.records': '记录数',
  'manage.repaired': '修复文件',
  'manage.quarantined': '隔离文件',
  'manage.took': '用时',
  'manage.openVault': '打开本地 Vault',
  'manage.rebuild': '手动重建索引',
  'manage.sync': '同步索引',
  'manage.journal': '变更日志',
  'manage.journalEmpty': '暂无变更记录',
  'manage.switchVault': '切换 Vault 路径',
  'manage.chooseVault': '使用该路径',
  'manage.bulkArchive': '批量归档',
  'manage.bulkStale': '批量标记过时',
  'manage.bulkRestore': '批量恢复为当前',
  'manage.bulkPin': '批量置顶',
  'manage.bulkUnpin': '批量取消置顶',
  'manage.bulkMerge': '合并选中项',

  'inbox.title': '候选与收件箱',
  'inbox.empty': '没有待处理的候选记忆',
  'inbox.confirm': '确认入库',
  'inbox.reject': '拒绝',
  'inbox.why': '提取原因',
  'inbox.decision': '建议动作',
  'inbox.decision.create': '新建',
  'inbox.decision.update': '更新 {id}',
  'inbox.decision.merge': '合并 {ids}',
  'inbox.decision.conflict': '与 {id} 冲突',
  'inbox.decision.inbox': '需要人工判断',
  'inbox.refused': '已被拒绝入库：{reason}',
  'inbox.createdAt': '生成时间',
  'inbox.related': '相关记忆',
  'inbox.confirmed': '已确认入库：{id}',
  'inbox.rejected': '已拒绝：{id}',
  'inbox.add': '手动添加',
  'inbox.addHint': '选择「候选」会写入收件箱等待确认；选择「正式记忆」会直接创建一条 active 记忆。',
  'inbox.addModeCandidate': '写入为候选',
  'inbox.addModeMemory': '直接创建正式记忆',
  'inbox.addDone': '已添加：{id}',
  'inbox.formTitle': '标题',
  'inbox.formSummary': '摘要',
  'inbox.formTags': '标签',
  'inbox.formEvidence': '证据',
  'inbox.formReason': '添加原因',

  'settings.title': '插件设置',
  'settings.language': '界面语言',
  'settings.languageZh': '简体中文',
  'settings.languageEn': 'English',
  'settings.enableTools': '向模型注册记忆工具',
  'settings.enablePromptSection': '注入常驻记忆段落',
  'settings.standingBudgetTokens': '常驻段落 token 预算',
  'settings.standingMaxItems': '常驻段落最大条数',
  'settings.recallBudgetTokens': '单次召回 token 预算',
  'settings.recallMaxItems': '单次召回最大条数',
  'settings.enablePerStepRecall': '每一步都注入召回结果',
  'settings.enableAutoExtraction': '回合结束时自动提取候选',
  'settings.enableLlmExtraction': '使用模型进行提取',
  'settings.llmPrivacy': '隐私提示：开启后插件会在你已配置的模型上发起一次额外请求，把最近的对话片段发给该模型以抽取记忆，因此会产生额外的 token 消耗与网络请求。关闭时只做本地规则提取，不会发生任何模型请求。',
  'settings.redactSecrets': '拒绝看起来像密钥/口令的内容',
  'settings.sensitiveNeedsConfirmation': '健康 / 财务 / 身份类内容需人工确认',
  'settings.maxCandidatesPerTurn': '每回合最多候选数',
  'settings.saved': '设置已保存',
  'settings.lastIndexRebuild': '上次索引重建',
  'settings.preview': '预览召回',
  'settings.previewHint': '用一段查询预览当前会被注入模型的确切文本。',
  'settings.previewQuery': '预览查询（可选）',
  'settings.previewRun': '预览',
  'settings.previewTokens': '预计 token：{tokens}',
  'settings.previewOmitted': '因预算被省略：{count} 条',
  'settings.previewIncluded': '实际包含：{count} 条',
  'settings.previewEmpty': '当前不会注入任何记忆内容',
  'settings.dirty': '有未保存的修改',
  'settings.vault': 'Vault',
  'settings.initVault': '重新探测并初始化',

  'error.title': '出错了',
  'error.code': '错误码',
  'error.detail': '详情',
  'error.vaultNotInitialized': '记忆库尚未初始化',
  'error.needsChoice': '需要先选定一个 Vault 路径',
  'error.busy': '后台正忙，请稍后重试',
  'error.notFound': '未找到目标',
  'error.conflict': '写入冲突',
  'error.unknown': '未知错误',
}

const EN: Record<string, string> = {
  panel: 'Long-term memory',
  'page.title': 'Long-term memory',
  'page.subtitle': 'Local Markdown memory vault',

  'nav.overview': 'Overview',
  'nav.search': 'Search',
  'nav.manage': 'Manage',
  'nav.inbox': 'Inbox',
  'nav.settings': 'Settings',

  'common.loading': 'Loading…',
  'common.retry': 'Retry',
  'common.error': 'Failed',
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.save': 'Save',
  'common.close': 'Close',
  'common.refresh': 'Refresh',
  'common.reload': 'Reload',
  'common.apply': 'Apply',
  'common.reset': 'Reset',
  'common.all': 'All',
  'common.none': 'None',
  'common.back': 'Back',
  'common.empty': 'Nothing here',
  'common.delete': 'Delete',
  'common.edit': 'Edit',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.unknown': 'Unknown',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.enabled': 'Enabled',
  'common.disabled': 'Disabled',
  'common.selected': '{count} selected',
  'common.more': 'Show more',
  'common.less': 'Show less',
  'common.never': 'Never',
  'common.optional': 'optional',
  'common.comma': '(comma separated)',
  'common.listSep': '; ',

  'state.loadingPage': 'Reading vault status…',
  'state.failedTitle': 'Cannot reach the memory vault backend',

  'status.active': 'Active',
  'status.pending': 'Pending',
  'status.stale': 'Stale',
  'status.superseded': 'Superseded',
  'status.conflict': 'Conflict',
  'status.archived': 'Archived',
  'confidence.low': 'Low',
  'confidence.medium': 'Medium',
  'confidence.high': 'High',

  'init.title': 'Initialize the vault',
  'init.intro': 'No vault is initialized yet. Below is what was detected on this machine; confirm to create or adopt a Markdown vault.',
  'init.environment': 'Environment',
  'init.filesystem': 'Filesystem access',
  'init.obsidianDetected': 'Obsidian detected',
  'init.obsidianConfig': 'Obsidian config',
  'init.current': 'Path in effect',
  'init.rationale': 'Why this decision',
  'init.warnings': 'Warnings',
  'init.candidates': 'Candidate paths',
  'init.noCandidates': 'No candidate path was detected; type one below.',
  'init.manual': 'Manual path',
  'init.manualPlaceholder': 'e.g. D:\\Memory\\ObsidianVault',
  'init.initialize': 'Initialize vault',
  'init.working': 'Initializing…',
  'init.needsChoice': 'A path must be chosen first',
  'init.ready': 'Ready to initialize',
  'init.done': 'The vault is ready',
  'init.environment.desktop': 'Desktop app',
  'init.environment.web': 'Web',
  'init.environment.node': 'Node',

  'overview.total': 'Memories',
  'overview.byType': 'By category',
  'overview.pending': 'Awaiting confirmation',
  'overview.problems': 'Conflicts / anomalies',
  'overview.pinned': 'Pinned',
  'overview.stale': 'Stale',
  'overview.archived': 'Archived',
  'overview.outOfSync': 'Out of sync with disk',
  'overview.recentCreated': 'Recently created',
  'overview.recentUpdated': 'Recently updated',
  'overview.pendingList': 'Awaiting confirmation',
  'overview.problemsList': 'Conflicts and anomalies',
  'overview.tags': 'Tags',
  'overview.tagsHint': 'Click a tag to filter it in Search',
  'overview.vaultPath': 'Storage path',
  'overview.indexBuiltAt': 'Index built',
  'overview.indexCount': 'Indexed records',
  'overview.indexHealthy': 'Index status',
  'overview.indexHealthyYes': 'Healthy',
  'overview.indexHealthyNo': 'Was corrupt, rebuilt',
  'overview.indexPath': 'Index file',
  'overview.rebuild': 'Rebuild index',
  'overview.sync': 'Sync index',
  'overview.busy': 'Index rebuild in progress…',
  'overview.rebuildDone': 'Index rebuilt: {records} records, {repaired} files repaired, {ms} ms',
  'overview.syncDone': 'Sync done: {added} added, {updated} updated, {removed} removed, {unchanged} unchanged',
  'overview.capabilities': 'Host capabilities',
  'overview.notes': 'Limitations',
  'overview.noStats': 'No statistics yet',
  'overview.outOfSyncList': 'These files changed on disk and the index has not caught up:',

  'cap.filesystem': 'Filesystem',
  'cap.webServer': 'HTTP server',
  'cap.systemPrompt': 'System prompt',
  'cap.tools': 'Model tools',
  'cap.sessionEvents': 'Session events',
  'cap.llmExtraction': 'LLM extraction',
  'cap.registeredTools': 'Registered tools',

  'search.text': 'Keywords',
  'search.textPlaceholder': 'Keywords, a title, or a memory id',
  'search.debounceHint': 'Searches automatically 250 ms after you stop typing',
  'search.types': 'Category',
  'search.statuses': 'Status',
  'search.tag': 'Tag',
  'search.tagPlaceholder': 'e.g. project',
  'search.since': 'From',
  'search.until': 'Until',
  'search.pinnedOnly': 'Pinned only',
  'search.includeNonCurrent': 'Include non-current memories (archived / stale / superseded / conflict)',
  'search.limit': 'Result limit',
  'search.run': 'Search',
  'search.resultCount': '{total} results in {ms} ms',
  'search.indexRefreshed': '(the index was refreshed first)',
  'search.reasons': 'Why it matched',
  'search.score': 'Score',
  'search.noResults': 'No matching memory',
  'search.select': 'Multi-select',
  'search.merge': 'Merge duplicates',
  'search.clearSelection': 'Clear selection',
  'search.selectHint': 'Tick two or more to merge them',

  'merge.title': 'Merge duplicate memories',
  'merge.hint': 'Pick the survivor; the rest are folded into it and archived.',
  'merge.survivor': 'Survivor',
  'merge.folded': 'Will be merged',
  'merge.reason': 'Reason',
  'merge.run': 'Merge',
  'merge.done': 'Merged into {id}',
  'merge.needTwo': 'Select at least two memories to merge',

  'detail.title': 'Memory detail',
  'detail.notFound': 'Memory not found',
  'detail.summary': 'Core content',
  'detail.sections': 'Other sections',
  'detail.path': 'File path',
  'detail.absolutePath': 'Absolute path',
  'detail.type': 'Category',
  'detail.status': 'Status',
  'detail.tags': 'Tags',
  'detail.aliases': 'Aliases',
  'detail.confidence': 'Confidence',
  'detail.importance': 'Importance',
  'detail.pinned': 'Pinned',
  'detail.createdAt': 'Created',
  'detail.updatedAt': 'Updated',
  'detail.sourceSessions': 'Source sessions',
  'detail.evidence': 'Evidence',
  'detail.supersedes': 'Supersedes',
  'detail.supersededBy': 'Superseded by',
  'detail.conflictsWith': 'Conflicts with',
  'detail.related': 'Related memories',
  'detail.recallable': 'Recall eligibility',
  'detail.recallableYes': 'Currently recallable',
  'detail.recallableNo': 'Not recallable right now',
  'detail.recallNote': 'Recall note',
  'detail.history': 'Change history',
  'detail.historyEmpty': 'No change recorded yet',
  'detail.before': 'Before',
  'detail.after': 'After',
  'detail.source': 'Source',
  'detail.reason': 'Reason',
  'detail.op': 'Operation',
  'detail.at': 'Time',
  'detail.tabFields': 'Edit fields',
  'detail.tabRaw': 'Raw Markdown',
  'detail.actions': 'Actions',

  'edit.newTitle': 'New memory',
  'edit.fieldTitle': 'Title',
  'edit.summary': 'Summary',
  'edit.tags': 'Tags',
  'edit.aliases': 'Aliases',
  'edit.evidence': 'Evidence',
  'edit.confidence': 'Confidence',
  'edit.importance': 'Importance (0-100)',
  'edit.status': 'Status',
  'edit.pinned': 'Pinned',
  'edit.type': 'Category',
  'edit.saved': 'Saved: {id}',
  'edit.repairs': 'Repairs applied',
  'edit.warnings': 'Warnings',
  'edit.needTitle': 'A title is required',
  'edit.hint': 'The summary accepts line breaks and `- ` bullets and is rendered with Markdown-style paragraph structure.',

  'raw.title': 'Raw Markdown',
  'raw.hint': 'Edit the Markdown file on disk directly. The write carries the checksum read with it; if another program changed the file first the write is refused instead of overwriting.',
  'raw.load': 'Read raw',
  'raw.write': 'Write file',
  'raw.conflict': 'Write conflict: this file was changed on disk by something else, so the plugin refused to overwrite it. Reload first.',
  'raw.written': 'Raw content written',
  'raw.path': 'Relative path',
  'raw.checksum': 'Checksum',

  'action.confirm': 'Confirm',
  'action.reject': 'Reject',
  'action.archive': 'Archive',
  'action.stale': 'Mark stale',
  'action.restore': 'Restore to current',
  'action.pin': 'Pin',
  'action.unpin': 'Unpin',
  'action.delete': 'Delete',
  'action.resolve': 'Resolve conflict',
  'action.done': 'Done',
  'action.archived': 'Archived: {id}',
  'action.staled': 'Marked stale: {id}',
  'action.restored': 'Restored: {id}',
  'action.pinned': 'Pinned: {id}',
  'action.unpinned': 'Unpinned: {id}',
  'action.confirmed': 'Confirmed: {id}',
  'action.rejected': 'Rejected: {id}',
  'action.reason': 'Reason',

  'delete.title': 'Delete memory',
  'delete.warning': 'This removes the memory Markdown file from the vault and cannot be undone.',
  'delete.typePrompt': 'Type this memory id to continue:',
  'delete.typePlaceholder': 'Paste the memory id',
  'delete.mismatch': 'The typed id does not match the target',
  'delete.final': 'Second confirmation: delete permanently?',
  'delete.finalYes': 'Yes, delete',
  'delete.archiveOnly': 'Archive only (keep the file)',
  'delete.done': 'Deleted: {id}',

  'conflict.title': 'Resolve conflict',
  'conflict.keep': 'Keep this one, archive the counterpart',
  'conflict.merge': 'Merge into one memory',
  'conflict.both': 'Keep both, only clear the conflict flag',
  'conflict.others': 'Counterparts',
  'conflict.none': 'No counterpart detected',
  'conflict.done': 'Conflict resolved; {count} archived',
  'conflict.reason': 'Note',

  'manage.title': 'Memory management',
  'manage.index': 'Index maintenance',
  'manage.storage': 'Storage location',
  'manage.selection': 'Bulk actions',
  'manage.selectionHint': 'Tick memories in Search, then change their status in bulk or merge them here.',
  'manage.selectionEmpty': 'No memory is selected',
  'manage.vaultPath': 'Vault path',
  'manage.indexPath': 'Index file',
  'manage.records': 'Records',
  'manage.repaired': 'Files repaired',
  'manage.quarantined': 'Quarantined',
  'manage.took': 'Took',
  'manage.openVault': 'Open local vault',
  'manage.rebuild': 'Rebuild index',
  'manage.sync': 'Sync index',
  'manage.journal': 'Change journal',
  'manage.journalEmpty': 'No change recorded yet',
  'manage.switchVault': 'Switch vault path',
  'manage.chooseVault': 'Use this path',
  'manage.bulkArchive': 'Archive selected',
  'manage.bulkStale': 'Mark selected stale',
  'manage.bulkRestore': 'Restore selected',
  'manage.bulkPin': 'Pin selected',
  'manage.bulkUnpin': 'Unpin selected',
  'manage.bulkMerge': 'Merge selected',

  'inbox.title': 'Candidates and inbox',
  'inbox.empty': 'No pending candidates',
  'inbox.confirm': 'Confirm',
  'inbox.reject': 'Reject',
  'inbox.why': 'Why it was proposed',
  'inbox.decision': 'Proposed action',
  'inbox.decision.create': 'Create',
  'inbox.decision.update': 'Update {id}',
  'inbox.decision.merge': 'Merge {ids}',
  'inbox.decision.conflict': 'Conflicts with {id}',
  'inbox.decision.inbox': 'Needs a human decision',
  'inbox.refused': 'Refused: {reason}',
  'inbox.createdAt': 'Created',
  'inbox.related': 'Related memories',
  'inbox.confirmed': 'Confirmed: {id}',
  'inbox.rejected': 'Rejected: {id}',
  'inbox.add': 'Add manually',
  'inbox.addHint': 'As a candidate it waits in the inbox for confirmation; as a memory it is written straight to the vault as active.',
  'inbox.addModeCandidate': 'Write as candidate',
  'inbox.addModeMemory': 'Create an active memory',
  'inbox.addDone': 'Added: {id}',
  'inbox.formTitle': 'Title',
  'inbox.formSummary': 'Summary',
  'inbox.formTags': 'Tags',
  'inbox.formEvidence': 'Evidence',
  'inbox.formReason': 'Reason',

  'settings.title': 'Plugin settings',
  'settings.language': 'Interface language',
  'settings.languageZh': '简体中文',
  'settings.languageEn': 'English',
  'settings.enableTools': 'Register memory tools for the model',
  'settings.enablePromptSection': 'Inject the standing memory section',
  'settings.standingBudgetTokens': 'Standing section token budget',
  'settings.standingMaxItems': 'Standing section max entries',
  'settings.recallBudgetTokens': 'Recall token budget',
  'settings.recallMaxItems': 'Recall max entries',
  'settings.enablePerStepRecall': 'Recall on every step',
  'settings.enableAutoExtraction': 'Auto-extract candidates when a turn ends',
  'settings.enableLlmExtraction': 'Use the configured model for extraction',
  'settings.llmPrivacy': 'Privacy note: when this is on, the plugin makes an extra request against the model you already configured and sends it the recent conversation excerpt so it can propose memories. That costs extra tokens and produces a network request. With it off, only local rule-based extraction runs and no model request happens.',
  'settings.redactSecrets': 'Refuse content that looks like a secret',
  'settings.sensitiveNeedsConfirmation': 'Health / finance / identity content needs confirmation',
  'settings.maxCandidatesPerTurn': 'Max candidates per turn',
  'settings.saved': 'Settings saved',
  'settings.lastIndexRebuild': 'Last index rebuild',
  'settings.preview': 'Preview recall',
  'settings.previewHint': 'Preview the exact text that would be injected into the model for one query.',
  'settings.previewQuery': 'Preview query (optional)',
  'settings.previewRun': 'Preview',
  'settings.previewTokens': 'Estimated tokens: {tokens}',
  'settings.previewOmitted': 'Omitted for budget: {count}',
  'settings.previewIncluded': 'Actually included: {count}',
  'settings.previewEmpty': 'Nothing would be injected right now',
  'settings.dirty': 'Unsaved changes',
  'settings.vault': 'Vault',
  'settings.initVault': 'Re-detect and initialize',

  'error.title': 'Something went wrong',
  'error.code': 'Code',
  'error.detail': 'Detail',
  'error.vaultNotInitialized': 'The vault is not initialized yet',
  'error.needsChoice': 'A vault path must be chosen first',
  'error.busy': 'The backend is busy; try again shortly',
  'error.notFound': 'Not found',
  'error.conflict': 'Write conflict',
  'error.unknown': 'Unknown error',
}

const DICTIONARIES: Record<Language, Record<string, string>> = { zh: ZH, en: EN }

let activeLanguage: Language = 'zh'
let boundTranslator: Translate | null = null
const languageListeners = new Set<() => void>()

function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  )
}

/**
 * Translate `key` into the active language.
 *
 * The plugin's own `language` setting is authoritative: it is an explicit user
 * choice, so it must win over the host's live locale translator. The bound
 * translator is still consulted for keys this bundle does not ship, which keeps
 * the panel usable if the host adds strings of its own.
 */
export function t(key: string, params?: Record<string, unknown>): string {
  const own = DICTIONARIES[activeLanguage][key]
  if (own !== undefined) return interpolate(own, params)
  if (boundTranslator !== null) {
    const bound = boundTranslator(key, params)
    if (typeof bound === 'string' && bound.length > 0 && bound !== key) return bound
  }
  const fallback = ZH[key]
  return fallback === undefined ? key : interpolate(fallback, params)
}

/** The language currently used by the built-in dictionary. */
export function getLanguage(): Language {
  return activeLanguage
}

/** Switch the built-in dictionary's language and notify subscribers. */
export function setLanguage(language: Language): void {
  if (language !== 'zh' && language !== 'en') return
  if (language === activeLanguage) return
  activeLanguage = language
  notifyLanguage()
}

/** Subscribe to language changes; returns an unsubscribe function. */
export function subscribeLanguage(listener: () => void): () => void {
  languageListeners.add(listener)
  return () => {
    languageListeners.delete(listener)
  }
}

function notifyLanguage(): void {
  for (const listener of [...languageListeners]) {
    try {
      listener()
    } catch {
      /* a broken subscriber must not break the others */
    }
  }
}

/**
 * Remember the translator bound from the optional `locale` service.
 *
 * @param translator - the bound translator, or `null` on teardown.
 */
export function setBoundTranslator(translator: Translate | null): void {
  boundTranslator = translator
  notifyLanguage()
}

/**
 * Bind the optional locale service to this module's namespace.
 *
 * Resolves to `undefined` when the service is absent or does not expose both
 * methods, so the caller can simply do nothing.
 *
 * @param locale - a candidate `locale` service.
 * @returns a disposer, or `undefined` when nothing was bound.
 */
export function bindLocaleService(locale: LocaleService | undefined): (() => void) | undefined {
  if (locale === undefined || locale === null) return undefined
  if (typeof locale !== 'object') return undefined
  const candidate = locale as Partial<LocaleService>
  if (typeof candidate.register !== 'function' || typeof candidate.bind !== 'function') return undefined
  const dispose = candidate.register(NS, { zh: ZH, en: EN })
  const translator = candidate.bind(NS)
  setBoundTranslator(translator)
  return () => {
    setBoundTranslator(null)
    if (typeof dispose === 'function') dispose()
  }
}

/** Re-render a component whenever the active language changes; returns the language. */
export function useLanguage(): Language {
  const [language, setLocal] = useState<Language>(getLanguage)
  useEffect(() => {
    setLocal(getLanguage())
    return subscribeLanguage(() => {
      setLocal(getLanguage())
    })
  }, [])
  return language
}

/** A re-render-safe translator for components. */
export function useT(): Translate {
  useLanguage()
  return useCallback((key: string, params?: Record<string, unknown>) => t(key, params), [])
}
