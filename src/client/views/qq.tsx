/**
 * 「QQ 接入」一级 Tab 的页面。
 *
 * 设计原则（与证据文档一致）：
 * - 只做「状态展示 + 导航指引 + 联动策略 + 诊断」，不重新实现 QQ 协议，
 *   不复制官方插件的连接/绑定代码，也不生成二维码；
 * - 接入状态只来自对官方只读路由的同源探测，五类结论都附真实依据，
 *   无法确认时就显示无法确认；
 * - 页面上的策略开关与宿主端执行点共用 `src/shared/qq-linkage.ts` 的判定函数，
 *   因此「页面显示的结果」与「后端真正执行的结果」不会不一致；
 * - QQ 私聊与群聊无法区分，界面如实说明并只提供通道级策略；
 * - 不读取、不保存、不回显任何凭据。
 *
 * @module dsh-longterm-memory/client/views/qq
 */

import { Fragment, useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { QQ_LINKAGE_MODES, QQ_WRITE_MODES } from '../../shared/qq-linkage.js'
import type { QqLinkageConfig, QqLinkageMode, QqWriteMode } from '../../shared/qq-linkage.js'
import { ERROR_CODES } from '../../shared/protocol.js'
import type { QqLinkageReport } from '../../shared/protocol.js'
import {
  DEFAULT_QQBOT_MERGE_CONFIG,
  QQBOT_MERGE_BUSY_POLICIES,
  QQBOT_MERGE_REPLY_MODES,
  normalizeMergeConfig,
} from '../../shared/qqbot-merge-contract.js'
import type {
  QqbotMergeBusyPolicy,
  QqbotMergeConfig,
  QqbotMergeCounters,
  QqbotMergeReplyMode,
  QqbotMergeReport,
} from '../../shared/qqbot-merge-contract.js'
import type { VaultInfo } from '../../shared/types.js'
import { call, errCode, errMessage, useAsync, useMutation } from '../api.js'
import { useT } from '../i18n.js'
import type { Translate } from '../i18n.js'
import { usePage } from '../page-api.js'
import {
  OFFICIAL_BIND_ROUTE,
  OFFICIAL_CLIENT_SINCE,
  OFFICIAL_CORDIS_NAME,
  OFFICIAL_LATEST_KNOWN,
  OFFICIAL_PACKAGE,
  OFFICIAL_VERIFIED_RELEASES,
  REPO_HOST_COMPAT,
  REPO_HOST_ENGINE_RANGE,
  applyMarkerTexts,
  buildDiagnostics,
  buildIsolationSamples,
  credentialFilePath,
  installCommand,
  linkageMarkersToText,
  probeOfficialChannelDetailed,
} from '../qq-channel.js'
import type {
  LinkageMarkerTexts,
  MarkerTexts,
  QqChannelProbe,
  QqDiagState,
  QqDiagnosticRow,
  QqIsolationSample,
  QqProbeKind,
  QqProbeOutcome,
} from '../qq-channel.js'
import type { OfficialPresence } from '../host-inventory.js'
import { Badge, Button, Card, Checkbox, Empty, ErrorNotice, Field, KvList, Loading, Notice, NumberInput, Select, Stat, TextArea } from '../ui.js'
import type { BadgeKind } from '../util.js'
import { formatTime, shortId } from '../util.js'

/** 标记编辑时的一组。 */
type MarkerGroup = 'qq' | 'trusted'

/** 标记编辑时的一个字段。 */
type MarkerField = keyof MarkerTexts

/** 合并计数字段与对应的文案 key，按契约里的字段顺序展示。 */
const MERGE_COUNTER_FIELDS: readonly { field: keyof QqbotMergeCounters; key: string }[] = [
  { field: 'batchesMerged', key: 'qq.merge.counter.batchesMerged' },
  { field: 'messagesSteered', key: 'qq.merge.counter.messagesSteered' },
  { field: 'messagesFollowedUp', key: 'qq.merge.counter.messagesFollowedUp' },
  { field: 'messagesOverflowed', key: 'qq.merge.counter.messagesOverflowed' },
  { field: 'steerFallbacks', key: 'qq.merge.counter.steerFallbacks' },
  { field: 'replyRewrites', key: 'qq.merge.counter.replyRewrites' },
  { field: 'repliesCompleted', key: 'qq.merge.counter.repliesCompleted' },
  { field: 'batchesAborted', key: 'qq.merge.counter.batchesAborted' },
]

/** 探测结论对应的徽标颜色。 */
function probeBadgeKind(kind: QqProbeKind): BadgeKind {
  if (kind === 'bound') return 'ok'
  if (kind === 'failed') return 'error'
  if (kind === 'unknown') return 'plain'
  return 'warn'
}

/** 探测结论对应的提示条颜色。 */
function probeNoticeKind(kind: QqProbeKind): 'info' | 'warn' | 'error' | 'ok' {
  if (kind === 'bound') return 'ok'
  if (kind === 'failed') return 'error'
  if (kind === 'unknown') return 'warn'
  return 'warn'
}

/** 会话通道对应的徽标颜色。 */
function channelKind(channel: string): BadgeKind {
  if (channel === 'qq') return 'warn'
  if (channel === 'trusted') return 'ok'
  return 'plain'
}

/** 会话通道的本地化名称；未知值原样显示，不猜测。 */
function channelText(translate: Translate, channel: string): string {
  if (channel === 'qq' || channel === 'trusted' || channel === 'unidentified') {
    return translate(`qq.channel.${channel}`)
  }
  return channel
}

/** 诊断状态对应的徽标颜色。 */
function diagBadgeKind(state: QqDiagState): BadgeKind {
  if (state === 'ok') return 'ok'
  if (state === 'error') return 'error'
  if (state === 'warn') return 'warn'
  return 'plain'
}

/**
 * 插件清单证据行。
 *
 * 只有在宿主暴露 `pluginInventory` Remote 时才出现；它证明的是「装没装 /
 * 启没启用 / 加载到哪个阶段」，**不是**连接状态，因此只作为接入状态的附加证据。
 */
function presenceRows(translate: Translate, presence: OfficialPresence | null): { key: string; value: ReactNode }[] {
  if (presence === null || !presence.available) return []
  const stateKey =
    presence.state === 'absent'
      ? 'qq.status.inventoryAbsent'
      : presence.state === 'disabled'
        ? 'qq.status.inventoryDisabled'
        : 'qq.status.inventoryInstalled'
  const rows: { key: string; value: ReactNode }[] = [{ key: translate('qq.status.inventory'), value: translate(stateKey) }]
  const phase = presence.row?.phase
  if (phase !== null && phase !== undefined && phase.length > 0) {
    rows.push({ key: translate('qq.status.inventoryPhase'), value: <span className="lmv-mono">{phase}</span> })
  }
  return rows
}

/** 第 1 张卡：接入状态（只读探测官方插件 + 插件清单交叉验证）。 */
function ProbeCard(props: {
  probe: QqChannelProbe | null
  loading: boolean
  error: unknown
  profile: string | null
  onRefresh: () => void
}): ReactElement {
  const translate = useT()
  const probed = props.probe === null ? null : props.probe.outcome
  const presence = props.probe === null ? null : props.probe.presence
  const profile = props.profile

  return (
    <Card
      title={translate('qq.card.status')}
      actions={
        <Button variant="ghost" disabled={props.loading} onClick={props.onRefresh}>
          {translate('qq.status.refresh')}
        </Button>
      }
    >
      {props.loading && probed === null ? <Loading label={translate('qq.status.probing')} /> : null}
      {props.error === null ? null : <ErrorNotice error={props.error} onRetry={props.onRefresh} />}

      {probed === null ? (
        props.loading ? null : <Empty>{translate('qq.probe.meaning.unknown')}</Empty>
      ) : (
        <>
          <div className="lmv-wrap">
            <Badge kind={probeBadgeKind(probed.kind)}>{translate(`qq.probe.state.${probed.kind}`)}</Badge>
            <span className="lmv-meta">
              {translate('qq.status.route')}: <span className="lmv-mono">{probed.route}</span>
            </span>
            <span className="lmv-meta">
              {translate('qq.status.at')}: {formatTime(probed.at)}
            </span>
          </div>

          <Notice kind={probeNoticeKind(probed.kind)}>
            {translate(probed.evidenceKey, probed.evidenceParams)}
          </Notice>
          <span className="lmv-prose-p">{translate(`qq.probe.meaning.${probed.kind}`)}</span>

          <KvList
            items={
              [
                {
                  key: translate('qq.status.phase'),
                  value:
                    probed.phase === null ? (
                      translate('common.unknown')
                    ) : (
                      <span className="lmv-mono">{probed.phase}</span>
                    ),
                },
                ...(probed.appId === null
                  ? []
                  : [
                      {
                        key: translate('qq.status.appId'),
                        value: <span className="lmv-mono">{probed.appId}</span>,
                      },
                    ]),
                ...presenceRows(translate, presence),
                {
                  key: translate('qq.status.profile'),
                  value:
                    profile === null ? (
                      translate('qq.status.profileUnknown')
                    ) : (
                      <span className="lmv-mono">{profile}</span>
                    ),
                },
              ] as { key: string; value: ReactNode }[]
            }
          />

          {probed.kind === 'not-loaded' ? (
            <>
              <span className="lmv-prose-p">{translate('qq.status.installHint')}</span>
              <pre className="lmv-pre">{installCommand(profile)}</pre>
            </>
          ) : probed.kind === 'bound' ? (
            <Notice kind="ok">{translate('qq.status.boundHint')}</Notice>
          ) : probed.kind === 'unbound' ? (
            <Notice>{translate('qq.status.unboundHint')}</Notice>
          ) : probed.kind === 'failed' ? (
            <Notice kind="error">{translate('qq.status.failedHint')}</Notice>
          ) : (
            <Notice kind="warn">{translate('qq.status.unknownHint')}</Notice>
          )}

          <Notice>
            {translate('qq.status.versionFacts', {
              latest: OFFICIAL_LATEST_KNOWN,
              clientSince: OFFICIAL_CLIENT_SINCE,
              cordis: OFFICIAL_CORDIS_NAME,
              route: OFFICIAL_BIND_ROUTE,
            })}
          </Notice>
          <Notice>{translate('qq.status.noSecrets')}</Notice>
        </>
      )}
    </Card>
  )
}

/** 第 2 张卡：记忆联动配置与四个执行点的实际状态。 */
function LinkageCard(props: {
  report: QqLinkageReport
  draft: QqLinkageConfig
  texts: LinkageMarkerTexts
  dirty: boolean
  saving: boolean
  saveError: unknown
  onPatch: (changes: Partial<QqLinkageConfig>) => void
  onMarkerChange: (group: MarkerGroup, field: MarkerField, value: string) => void
  onSave: () => void
  onReset: () => void
}): ReactElement {
  const translate = useT()
  const draft = props.draft
  const enforcement = props.report.enforcement
  const points: readonly { id: string; labelKey: string; registered: boolean }[] = [
    { id: 'standing', labelKey: 'qq.point.standing', registered: enforcement.standing },
    { id: 'recall', labelKey: 'qq.point.recall', registered: enforcement.perStepRecall },
    { id: 'extraction', labelKey: 'qq.point.extraction', registered: enforcement.extraction },
    { id: 'tools', labelKey: 'qq.point.tools', registered: enforcement.tools },
  ]
  const runtimeNotes = props.report.runtime.notes
  const enforcementNotes = Object.entries(enforcement.notes)

  return (
    <Card
      title={translate('qq.card.linkage')}
      actions={
        <>
          {props.dirty ? <span className="lmv-meta">{translate('qq.linkage.dirty')}</span> : null}
          <Button variant="ghost" disabled={props.saving || !props.dirty} onClick={props.onReset}>
            {translate('qq.linkage.reset')}
          </Button>
          <Button variant="primary" disabled={props.saving} onClick={props.onSave}>
            {translate('qq.linkage.save')}
          </Button>
        </>
      }
    >
      <div className="lmv-toolbar">
        <Field label={translate('qq.linkage.mode')}>
          <Select<QqLinkageMode>
            value={draft.mode}
            options={QQ_LINKAGE_MODES.map((mode) => ({ value: mode, label: translate(`qq.mode.${mode}`) }))}
            onChange={(mode) => {
              props.onPatch({ mode })
            }}
          />
        </Field>
        <Field label={translate('qq.linkage.writeMode')}>
          <Select<QqWriteMode>
            value={draft.writeMode}
            options={QQ_WRITE_MODES.map((mode) => ({ value: mode, label: translate(`qq.write.${mode}`) }))}
            onChange={(writeMode) => {
              props.onPatch({ writeMode })
            }}
          />
        </Field>
      </div>

      <Notice>{translate(`qq.modeHint.${draft.mode}`)}</Notice>
      <span className="lmv-field-label">{translate('qq.linkage.markersHint')}</span>

      <div className="lmv-grid-wide">
        <div className="lmv-qq-group">
          <span className="lmv-card-title">{translate('qq.linkage.qqMarkers')}</span>
          <Field label={translate('qq.linkage.origins')}>
            <TextArea
              value={props.texts.qq.origins}
              rows={3}
              onChange={(value) => {
                props.onMarkerChange('qq', 'origins', value)
              }}
            />
          </Field>
          <Field label={translate('qq.linkage.presets')}>
            <TextArea
              value={props.texts.qq.presets}
              rows={3}
              onChange={(value) => {
                props.onMarkerChange('qq', 'presets', value)
              }}
            />
          </Field>
          <Field label={translate('qq.linkage.cwds')}>
            <TextArea
              value={props.texts.qq.cwds}
              rows={3}
              onChange={(value) => {
                props.onMarkerChange('qq', 'cwds', value)
              }}
            />
          </Field>
        </div>

        <div className="lmv-qq-group">
          <span className="lmv-card-title">{translate('qq.linkage.trustedMarkers')}</span>
          <Field label={translate('qq.linkage.origins')}>
            <TextArea
              value={props.texts.trusted.origins}
              rows={3}
              onChange={(value) => {
                props.onMarkerChange('trusted', 'origins', value)
              }}
            />
          </Field>
          <Field label={translate('qq.linkage.presets')}>
            <TextArea
              value={props.texts.trusted.presets}
              rows={3}
              onChange={(value) => {
                props.onMarkerChange('trusted', 'presets', value)
              }}
            />
          </Field>
          <Field label={translate('qq.linkage.cwds')}>
            <TextArea
              value={props.texts.trusted.cwds}
              rows={3}
              onChange={(value) => {
                props.onMarkerChange('trusted', 'cwds', value)
              }}
            />
          </Field>
        </div>
      </div>

      <Checkbox
        checked={draft.allowTools}
        label={translate('qq.linkage.allowTools')}
        onChange={(checked) => {
          props.onPatch({ allowTools: checked })
        }}
      />
      {props.saveError === null ? null : <ErrorNotice error={props.saveError} />}

      <hr className="lmv-hr" />
      <span className="lmv-card-title">{translate('qq.linkage.execution')}</span>
      <div className="lmv-wrap">
        {points.map((point) => (
          <Badge key={point.id} kind={point.registered ? 'ok' : 'plain'}>
            {translate(point.labelKey)}: {translate(point.registered ? 'qq.point.registered' : 'qq.point.notRegistered')}
          </Badge>
        ))}
      </div>
      <span className="lmv-meta">{translate('qq.point.standingCaveat')}</span>
      <KvList
        items={[
          {
            key: translate('qq.point.registeredTools'),
            value: (
              <span className="lmv-mono">
                {enforcement.registeredTools.length === 0
                  ? translate('common.none')
                  : enforcement.registeredTools.join(', ')}
              </span>
            ),
          },
        ]}
      />

      {runtimeNotes.length === 0 ? null : (
        <>
          <span className="lmv-field-label">{translate('qq.linkage.backendNotes')}</span>
          <div className="lmv-list">
            {runtimeNotes.map((note, index) => (
              <Notice key={`runtime-note-${String(index)}`} kind="warn">
                {note}
              </Notice>
            ))}
          </div>
        </>
      )}

      {enforcementNotes.length === 0 ? null : (
        <>
          <span className="lmv-field-label">{translate('qq.point.notes')}</span>
          <div className="lmv-list">
            {enforcementNotes.map(([key, note]) => (
              <Notice key={`enforcement-note-${key}`} kind="warn">
                {key}: {note}
              </Notice>
            ))}
          </div>
        </>
      )}
    </Card>
  )
}

/** 合并配置的字段组；是否可编辑由外层 fieldset 统一控制。 */
function MergeFields(props: {
  value: QqbotMergeConfig
  onChange: (changes: Partial<QqbotMergeConfig>) => void
}): ReactElement {
  const translate = useT()
  const value = props.value
  return (
    <>
      <Checkbox
        checked={value.enabled}
        label={translate('qq.merge.enabled')}
        onChange={(enabled) => {
          props.onChange({ enabled })
        }}
      />
      <div className="lmv-toolbar">
        <Field label={translate('qq.merge.windowMs')}>
          <NumberInput
            min={100}
            max={10000}
            value={value.windowMs}
            onChange={(windowMs) => {
              props.onChange({ windowMs })
            }}
          />
        </Field>
        <Field label={translate('qq.merge.maxBatchMessages')}>
          <NumberInput
            min={1}
            max={50}
            value={value.maxBatchMessages}
            onChange={(maxBatchMessages) => {
              props.onChange({ maxBatchMessages })
            }}
          />
        </Field>
        <Field label={translate('qq.merge.maxBatchChars')}>
          <NumberInput
            min={200}
            max={20000}
            value={value.maxBatchChars}
            onChange={(maxBatchChars) => {
              props.onChange({ maxBatchChars })
            }}
          />
        </Field>
      </div>
      <div className="lmv-toolbar">
        <Field label={translate('qq.merge.busyPolicy')}>
          <Select<QqbotMergeBusyPolicy>
            value={value.busyPolicy}
            options={QQBOT_MERGE_BUSY_POLICIES.map((policy) => ({ value: policy, label: translate(`qq.merge.busy.${policy}`) }))}
            onChange={(busyPolicy) => {
              props.onChange({ busyPolicy })
            }}
          />
        </Field>
        <Field label={translate('qq.merge.replyMode')}>
          <Select<QqbotMergeReplyMode>
            value={value.replyMode}
            options={QQBOT_MERGE_REPLY_MODES.map((mode) => ({ value: mode, label: translate(`qq.merge.reply.${mode}`) }))}
            onChange={(replyMode) => {
              props.onChange({ replyMode })
            }}
          />
        </Field>
      </div>
      <div className="lmv-wrap">
        <Checkbox
          checked={value.scope.c2c}
          label={translate('qq.merge.scopeC2c')}
          onChange={(c2c) => {
            props.onChange({ scope: { ...value.scope, c2c } })
          }}
        />
        <Checkbox
          checked={value.scope.group}
          label={translate('qq.merge.scopeGroup')}
          onChange={(group) => {
            props.onChange({ scope: { ...value.scope, group } })
          }}
        />
      </div>
    </>
  )
}

/**
 * 第 3 张卡：连续消息智能合并。
 *
 * 真相只来自运行中的 QQ Bot 扩展：`available: false` 时本卡只显示「未生效」与
 * 原因，并渲染全部禁用的控件（默认值，不写入任何地方）；扩展在线时才允许编辑、
 * 读取真实计数与最近一批合并结果。
 */
function MergeCard(props: {
  report: QqbotMergeReport | null
  loading: boolean
  error: unknown
  saving: boolean
  saveError: unknown
  onSave: (config: QqbotMergeConfig) => void
  onRefresh: () => void
}): ReactElement {
  const translate = useT()
  const [draft, setDraft] = useState<QqbotMergeConfig | null>(null)
  const live = props.report
  const status = live !== null && live.available ? live.status : null

  useEffect(() => {
    setDraft(status === null ? null : normalizeMergeConfig(status.config))
  }, [status])

  const current = status === null ? null : (draft ?? normalizeMergeConfig(status.config))
  const compatible = live !== null && live.available ? live.compatible : false
  const editable = status !== null && compatible
  const dirty =
    current !== null && status !== null && JSON.stringify(current) !== JSON.stringify(normalizeMergeConfig(status.config))
  const missingRpc =
    props.error !== null &&
    (errCode(props.error) === ERROR_CODES.notFound ||
      errCode(props.error) === ERROR_CODES.unsupported ||
      (errCode(props.error) === ERROR_CODES.internal && errMessage(props.error).includes('HTTP 404')))
  const batch = status === null ? null : status.lastBatch
  const enabledNow = current !== null ? current.enabled : status !== null && status.config.enabled

  return (
    <Card
      title={translate('qq.card.merge')}
      actions={
        <>
          {dirty ? <span className="lmv-meta">{translate('qq.merge.dirty')}</span> : null}
          <Button variant="ghost" disabled={props.loading} onClick={props.onRefresh}>
            {translate('qq.merge.refresh')}
          </Button>
          {status === null || current === null ? null : (
            <Button
              variant="primary"
              disabled={!editable || props.saving || !dirty}
              onClick={() => {
                props.onSave(normalizeMergeConfig(current))
              }}
            >
              {translate('qq.merge.save')}
            </Button>
          )}
        </>
      }
    >
      {props.loading && live === null ? <Loading label={translate('qq.merge.loading')} /> : null}

      {live === null && !props.loading ? (
        <>
          <div className="lmv-wrap">
            <Badge kind="warn">{translate('qq.merge.badge.inactive')}</Badge>
          </div>
          <Notice kind="warn">
            {missingRpc ? translate('qq.merge.rpcMissing') : translate('qq.merge.rpcFailed', { message: errMessage(props.error) })}
          </Notice>
        </>
      ) : null}

      {live !== null && !live.available ? (
        <>
          <div className="lmv-wrap">
            <Badge kind="warn">{translate('qq.merge.badge.inactive')}</Badge>
            <span className="lmv-meta">
              {translate('qq.merge.officialVersion')}:{' '}
              <span className="lmv-mono">{live.officialVersion ?? translate('qq.merge.unknownVersion')}</span>
            </span>
          </div>
          <Notice kind="warn">{live.reason}</Notice>
          <Notice>{translate('qq.merge.officialOnly')}</Notice>
          <Notice>{translate('qq.merge.installHint')}</Notice>
          <span className="lmv-meta">{translate('qq.merge.defaultsHint')}</span>
          <fieldset className="lmv-fieldset" disabled>
            <MergeFields
              value={DEFAULT_QQBOT_MERGE_CONFIG}
              onChange={() => {
                /* 扩展不在线时不接受修改：控件全部禁用 */
              }}
            />
          </fieldset>
        </>
      ) : null}

      {live !== null && live.available ? (
        <>
          <div className="lmv-wrap">
            <Badge kind={!compatible ? 'warn' : enabledNow ? 'ok' : 'plain'}>
              {translate(
                !compatible ? 'qq.merge.badge.incompatible' : enabledNow ? 'qq.merge.badge.enabled' : 'qq.merge.badge.disabled',
              )}
            </Badge>
            <span className="lmv-meta">
              {translate('qq.merge.appliedRevision')}: <span className="lmv-mono">{live.status.applied.revision}</span>
            </span>
            <span className="lmv-meta">
              {translate('qq.merge.appliedAt')}: {formatTime(live.status.applied.appliedAt)}
            </span>
          </div>

          {compatible ? null : (
            <Notice kind="warn">
              {translate('qq.merge.compatWarn', { note: live.compatibilityNote ?? translate('common.unknown') })}
            </Notice>
          )}

          {current === null ? null : (
            <fieldset className="lmv-fieldset" disabled={!editable}>
              <MergeFields
                value={current}
                onChange={(changes) => {
                  setDraft({ ...current, ...changes })
                }}
              />
            </fieldset>
          )}
          {props.saveError === null ? null : <ErrorNotice error={props.saveError} />}

          <hr className="lmv-hr" />
          <span className="lmv-card-title">{translate('qq.merge.runtime')}</span>
          <div className="lmv-wrap">
            <Badge kind={live.status.runtime.steerSupported ? 'ok' : 'warn'}>
              {translate(live.status.runtime.steerSupported ? 'qq.merge.steerSupportedYes' : 'qq.merge.steerSupportedNo')}
            </Badge>
          </div>
          <KvList
            items={[
              {
                key: translate('qq.merge.steerMechanism'),
                value: <span className="lmv-mono">{live.status.runtime.steerMechanism}</span>,
              },
              {
                key: translate('qq.merge.integration'),
                value: <span className="lmv-mono">{live.status.runtime.integration}</span>,
              },
              { key: translate('qq.merge.runtimeNote'), value: live.status.runtime.note },
            ]}
          />

          <hr className="lmv-hr" />
          <span className="lmv-card-title">{translate('qq.merge.diagnostics')}</span>
          <Notice>{translate('qq.merge.editorOnly')}</Notice>
          <div className="lmv-grid">
            <Stat label={translate('qq.merge.activeBatches')} value={live.status.applied.activeBatches} />
            <Stat label={translate('qq.merge.pendingMessages')} value={live.status.applied.pendingMessages} />
          </div>

          <span className="lmv-field-label">{translate('qq.merge.counters')}</span>
          <div className="lmv-grid">
            {MERGE_COUNTER_FIELDS.map((entry) => (
              <Stat key={entry.field} label={translate(entry.key)} value={live.status.counters[entry.field]} />
            ))}
          </div>

          <span className="lmv-field-label">{translate('qq.merge.lastBatch')}</span>
          {batch === null ? (
            <Empty>{translate('qq.merge.lastBatchEmpty')}</Empty>
          ) : (
            <div className="lmv-row">
              <span className="lmv-row-main">
                <span className="lmv-meta">
                  <Badge kind={batch.ok ? 'ok' : 'error'}>
                    {batch.ok ? translate('qq.merge.batchOk') : translate('qq.merge.batchFailed', { reason: batch.error ?? translate('common.unknown') })}
                  </Badge>
                  <span>
                    {translate('qq.merge.lastBatchAt')}: {formatTime(batch.at)}
                  </span>
                  <span className="lmv-mono">{shortId(batch.sessionKey, 40)}</span>
                </span>
                <span className="lmv-meta">
                  <span>
                    {translate('qq.merge.lastBatchMode')}: {translate(`qq.merge.batchMode.${batch.mode}`)}
                  </span>
                  <span>
                    {translate('qq.merge.lastBatchCount')}: {batch.count}
                  </span>
                  <span>
                    {translate('qq.merge.lastBatchChars')}: {batch.chars}
                  </span>
                </span>
              </span>
            </div>
          )}
        </>
      ) : null}
    </Card>
  )
}

/** 第 4 张卡：会话隔离与权限（含「私聊/群聊不可区分」的如实说明）。 */
function IsolationCard(props: { report: QqLinkageReport }): ReactElement {
  const translate = useT()
  const samples = buildIsolationSamples(props.report.config)
  const counters = props.report.counters
  const sessions = props.report.sessions
  const qqSample = samples.find((sample) => sample.id === 'qq')
  const trustedSample = samples.find((sample) => sample.id === 'trusted')

  return (
    <Card title={translate('qq.card.isolation')}>
      <Notice kind="warn">{translate('qq.isolation.warning')}</Notice>

      <span className="lmv-card-title">{translate('qq.isolation.table')}</span>
      <div className="lmv-qq-matrix-wrap">
        <div className="lmv-qq-matrix">
          <span className="lmv-qq-matrix-head">{translate('qq.isolation.channel')}</span>
          <span className="lmv-qq-matrix-head">{translate('qq.isolation.verdict')}</span>
          <span className="lmv-qq-matrix-head">{translate('qq.isolation.marker')}</span>
          <span className="lmv-qq-matrix-head">{translate('qq.isolation.read')}</span>
          <span className="lmv-qq-matrix-head">{translate('qq.isolation.write')}</span>
          <span className="lmv-qq-matrix-head">{translate('qq.isolation.tools')}</span>
          {samples.map((sample: QqIsolationSample) => (
            <Fragment key={sample.id}>
              <span className="lmv-qq-cell">{translate(`qq.isolation.sample.${sample.id}`)}</span>
              <span className="lmv-qq-cell">
                <Badge kind={channelKind(sample.provenance.channel)}>
                  {translate(`qq.channel.${sample.provenance.channel}`)}
                </Badge>
              </span>
              <span className="lmv-qq-cell lmv-mono">
                {sample.provenance.matchedBy === null || sample.provenance.marker === null
                  ? translate('qq.isolation.noMarker')
                  : `${sample.provenance.matchedBy}=${sample.provenance.marker}`}
              </span>
              <span className="lmv-qq-cell">
                <Badge kind={sample.read.allowed ? 'ok' : 'warn'}>
                  {translate(sample.read.allowed ? 'qq.isolation.allowed' : 'qq.isolation.blocked')}
                </Badge>
              </span>
              <span className="lmv-qq-cell">
                <Badge kind={sample.write.allowed ? 'ok' : 'plain'}>
                  {translate(sample.write.allowed ? 'qq.isolation.writeAllowed' : 'qq.isolation.writeInbox')}
                </Badge>
              </span>
              <span className="lmv-qq-cell">
                <Badge kind={sample.tools.allowed ? 'ok' : 'warn'}>
                  {translate(sample.tools.allowed ? 'qq.isolation.toolsAllowed' : 'qq.isolation.toolsBlocked')}
                </Badge>
              </span>
            </Fragment>
          ))}
        </div>
      </div>

      {qqSample !== undefined && !qqSample.configured ? (
        <Notice kind="warn">{translate('qq.isolation.qqNotConfigured')}</Notice>
      ) : null}
      {trustedSample !== undefined && !trustedSample.configured ? (
        <Notice kind="warn">{translate('qq.isolation.trustedNotConfigured')}</Notice>
      ) : null}

      <span className="lmv-field-label">{translate('qq.isolation.counters')}</span>
      <div className="lmv-grid">
        <Stat label={translate('qq.counter.standingBlocked')} value={counters.standingBlocked} />
        <Stat label={translate('qq.counter.recallBlocked')} value={counters.recallBlocked} />
        <Stat label={translate('qq.counter.writesForcedInbox')} value={counters.writesForcedInbox} />
        <Stat label={translate('qq.counter.toolsBlocked')} value={counters.toolsBlocked} />
      </div>

      <span className="lmv-card-title">{translate('qq.isolation.sessions')}</span>
      {sessions.length === 0 ? (
        <Empty>{translate('qq.isolation.sessionsEmpty')}</Empty>
      ) : (
        <div className="lmv-list">
          {sessions.map((session) => (
            <div key={`${session.sessionId}:${session.lastSeenAt}`} className="lmv-row">
              <span className="lmv-row-main">
                <span className="lmv-row-title lmv-mono">{shortId(session.sessionId, 30)}</span>
                <span className="lmv-meta">
                  <Badge kind={channelKind(session.channel)}>{channelText(translate, session.channel)}</Badge>
                  <span className="lmv-mono">
                    {session.matchedBy === null ? translate('qq.isolation.noMarker') : `${session.matchedBy}=${session.marker ?? '—'}`}
                  </span>
                  <span>
                    {translate('qq.isolation.lastSeen')}: {formatTime(session.lastSeenAt)}
                  </span>
                </span>
                <span className="lmv-meta">
                  {translate('qq.isolation.reason')}: {session.reason}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

/** 第 5 张卡：记忆写入与收件箱。 */
function InboxCard(props: { report: QqLinkageReport; vault: VaultInfo; onOpenInbox: () => void }): ReactElement {
  const translate = useT()
  const config = props.report.config
  const enforcing = props.report.runtime.enforcing
  const qqIdentifiable = props.report.runtime.qqIdentifiable
  const directActive = config.writeMode === 'direct' && enforcing && qqIdentifiable
  const pending = props.vault.stats.pending

  return (
    <Card
      title={translate('qq.card.inbox')}
      actions={
        <Button variant="primary" onClick={props.onOpenInbox}>
          {translate('qq.inbox.open')}
        </Button>
      }
    >
      <span className="lmv-prose-p">{translate('qq.inbox.flow')}</span>
      <div className="lmv-grid">
        <Stat label={translate('qq.inbox.pending')} value={pending} />
      </div>
      <span className="lmv-meta">{translate('qq.inbox.pendingCount', { count: pending })}</span>
      <KvList
        items={[
          {
            key: translate('qq.inbox.writeMode'),
            value: translate(`qq.write.${config.writeMode}`),
          },
        ]}
      />
      {directActive ? (
        <Notice kind="warn">{translate('qq.inbox.directWarn')}</Notice>
      ) : (
        <Notice>{translate('qq.inbox.modeExplain')}</Notice>
      )}
      {enforcing ? null : <Notice kind="warn">{translate('qq.inbox.offModeExplain')}</Notice>}
    </Card>
  )
}

/** 第 6 张卡：诊断（五类真实结果 + 同一 Vault 与 Profile 的说明）。 */
function DiagnosticsCard(props: {
  probe: QqProbeOutcome | null
  presence: OfficialPresence | null
  probing: boolean
  report: QqLinkageReport | null
  rpcError: string | null
  onRerun: () => void
}): ReactElement {
  const translate = useT()
  const modeLabel = props.report === null ? '—' : translate(`qq.mode.${props.report.config.mode}`)
  const rows: QqDiagnosticRow[] = buildDiagnostics({
    probe: props.probe,
    probing: props.probing,
    report: props.report,
    rpcError: props.rpcError,
    modeLabel,
  })
  // 插件清单是**附加**证据：只有宿主暴露 pluginInventory Remote 时才追加这一行。
  const presence = props.presence
  if (presence !== null && presence.available) {
    rows.push({
      id: 'inventory',
      state: presence.state === 'absent' || presence.state === 'disabled' ? 'warn' : 'ok',
      evidenceKey: 'qq.diag.inventoryEvidence',
      evidenceParams: { state: presence.state, phase: presence.row?.phase ?? '—' },
    })
  }
  const host = props.report === null ? null : props.report.host
  const hostItems: { key: string; value: ReactNode }[] = []
  if (host !== null) {
    hostItems.push({ key: translate('qq.diag.platform'), value: <span className="lmv-mono">{host.platform}</span> })
    hostItems.push({ key: translate('qq.diag.node'), value: <span className="lmv-mono">{host.nodeVersion}</span> })
    hostItems.push({
      key: translate('qq.status.profile'),
      value: <span className="lmv-mono">{host.profile ?? translate('common.unknown')}</span>,
    })
    hostItems.push({
      key: translate('qq.diag.profileSource'),
      value: translate(`qq.diag.profileSource.${host.profileSource}`),
    })
    hostItems.push({
      key: translate('qq.diag.dshHome'),
      value: <span className="lmv-mono">{host.dshHome ?? translate('common.unknown')}</span>,
    })
  }
  hostItems.push({
    key: translate('qq.diag.vault'),
    value: <span className="lmv-mono">{props.report === null ? translate('common.unknown') : (props.report.vaultPath ?? '—')}</span>,
  })

  return (
    <Card
      title={translate('qq.card.diagnostics')}
      actions={
        <Button variant="ghost" onClick={props.onRerun}>
          {translate('qq.diag.rerun')}
        </Button>
      }
    >
      <div className="lmv-list">
        {rows.map((row) => (
          <div key={row.id} className="lmv-row">
            <span className="lmv-row-main">
              <span className="lmv-row-title">{translate(`qq.diag.${row.id}`)}</span>
              <span className="lmv-meta">
                <Badge kind={diagBadgeKind(row.state)}>{translate(`qq.diag.state.${row.state}`)}</Badge>
                <span className="lmv-qq-evidence">{translate(row.evidenceKey, row.evidenceParams)}</span>
              </span>
            </span>
          </div>
        ))}
      </div>

      <span className="lmv-field-label">{translate('qq.diag.hostFacts')}</span>
      <KvList items={hostItems} />

      <span className="lmv-card-title">{translate('qq.diag.modes')}</span>
      <Notice>{translate('qq.diag.vaultSame')}</Notice>
      <Notice kind="warn">{translate('qq.diag.vaultSeparate')}</Notice>
      <Notice kind="warn">{translate('qq.diag.vaultDifferent')}</Notice>
    </Card>
  )
}

/** 第 7 张卡：安全与凭据。 */
function SecurityCard(props: { report: QqLinkageReport | null }): ReactElement {
  const translate = useT()
  const profileDir = props.report === null ? null : props.report.host.profileDir
  return (
    <Card title={translate('qq.card.security')}>
      <span className="lmv-card-title">{translate('qq.security.secretTitle')}</span>
      <Notice kind="warn">{translate('qq.security.secretBody')}</Notice>
      <KvList
        items={[
          {
            key: translate('qq.security.package'),
            value: (
              <span className="lmv-mono">
                {translate('qq.security.packageValue', {
                  pkg: OFFICIAL_PACKAGE,
                  cordis: OFFICIAL_CORDIS_NAME,
                  latest: OFFICIAL_LATEST_KNOWN,
                  clientSince: OFFICIAL_CLIENT_SINCE,
                })}
              </span>
            ),
          },
          {
            key: translate('qq.security.profilePath'),
            value: <span className="lmv-mono">{credentialFilePath(profileDir)}</span>,
          },
        ]}
      />
      <span className="lmv-card-title">{translate('qq.security.compatTitle')}</span>
      <Notice>{translate('qq.security.compatBody', { releases: OFFICIAL_VERIFIED_RELEASES.join(' / ') })}</Notice>
      <Notice>
        {translate('qq.security.compatHost', { range: REPO_HOST_COMPAT, engineRange: REPO_HOST_ENGINE_RANGE })}
      </Notice>
      <Notice>{translate('qq.security.noQr', { route: OFFICIAL_BIND_ROUTE })}</Notice>
      <Notice kind="warn">{translate('qq.security.community')}</Notice>
    </Card>
  )
}

/** 「QQ 接入」页本体：只负责取数与编辑状态，具体分块交给上面的卡片。 */
export function QqView(props: { vault: VaultInfo }): ReactElement {
  const page = usePage()
  const translate = useT()
  const probe = useAsync(() => probeOfficialChannelDetailed(), [])
  const report = useAsync(() => call('qqLinkage', {}), [])
  const save = useMutation((config: Partial<QqLinkageConfig>) => call('setQqLinkage', { config }))
  const merge = useAsync(() => call('qqMerge', {}), [])
  const mergeSave = useMutation((config: Partial<QqbotMergeConfig>) => call('setQqMerge', { config }))
  const [updated, setUpdated] = useState<QqLinkageReport | null>(null)
  const [mergeUpdated, setMergeUpdated] = useState<QqbotMergeReport | null>(null)
  const [draft, setDraft] = useState<QqLinkageConfig | null>(null)
  const [texts, setTexts] = useState<LinkageMarkerTexts | null>(null)

  const live = updated ?? report.data
  const mergeLive = mergeUpdated ?? merge.data

  useEffect(() => {
    const loaded = report.data
    if (loaded === null) return
    setUpdated(null)
    setDraft(loaded.config)
    setTexts(linkageMarkersToText(loaded.config))
  }, [report.data])

  const patchConfig = (changes: Partial<QqLinkageConfig>): void => {
    setDraft((previous) => (previous === null ? previous : { ...previous, ...changes }))
  }

  const patchMarkers = (group: MarkerGroup, field: MarkerField, value: string): void => {
    if (texts === null) return
    const next: LinkageMarkerTexts = {
      qq: group === 'qq' ? { ...texts.qq, [field]: value } : texts.qq,
      trusted: group === 'trusted' ? { ...texts.trusted, [field]: value } : texts.trusted,
    }
    setTexts(next)
    setDraft((previous) => (previous === null ? previous : applyMarkerTexts(previous, next)))
  }

  const doSave = (): void => {
    if (draft === null) return
    void (async () => {
      try {
        const result = await save.run(draft)
        if (result !== undefined) {
          setUpdated(result)
          setDraft(result.config)
          setTexts(linkageMarkersToText(result.config))
          page.toast(translate('qq.linkage.saved'), 'ok')
        }
      } catch {
        /* rendered from the mutation state */
      }
    })()
  }

  const doReset = (): void => {
    if (live === null) return
    setDraft(live.config)
    setTexts(linkageMarkersToText(live.config))
  }

  const doSaveMerge = (config: QqbotMergeConfig): void => {
    void (async () => {
      try {
        const result = await mergeSave.run(config)
        if (result !== undefined) {
          setMergeUpdated(result)
          page.toast(translate('qq.merge.saved'), 'ok')
        }
      } catch {
        /* rendered from the mutation state */
      }
    })()
  }

  const refreshMerge = (): void => {
    setMergeUpdated(null)
    merge.reload()
  }

  const rerun = (): void => {
    probe.reload()
    setUpdated(null)
    report.reload()
  }

  const dirty = draft !== null && live !== null && JSON.stringify(draft) !== JSON.stringify(live.config)

  return (
    <div className="lmv-main">
      <ProbeCard
        probe={probe.data}
        loading={probe.loading}
        error={probe.error}
        profile={live === null ? null : live.host.profile}
        onRefresh={probe.reload}
      />

      {live === null ? (
        <Card title={translate('qq.card.linkage')}>
          {report.error === null ? (
            <Loading label={translate('state.loadingPage')} />
          ) : (
            <ErrorNotice error={report.error} onRetry={report.reload} />
          )}
        </Card>
      ) : draft === null || texts === null ? (
        <Card title={translate('qq.card.linkage')}>
          <Loading />
        </Card>
      ) : (
        <LinkageCard
          report={live}
          draft={draft}
          texts={texts}
          dirty={dirty}
          saving={save.busy}
          saveError={save.error}
          onPatch={patchConfig}
          onMarkerChange={patchMarkers}
          onSave={doSave}
          onReset={doReset}
        />
      )}

      <MergeCard
        report={mergeLive}
        loading={merge.loading}
        error={merge.error}
        saving={mergeSave.busy}
        saveError={mergeSave.error}
        onSave={doSaveMerge}
        onRefresh={refreshMerge}
      />

      {live === null || draft === null || texts === null ? null : (
        <>
          <IsolationCard report={live} />
          <InboxCard report={live} vault={props.vault} onOpenInbox={page.openInbox} />
        </>
      )}

      <DiagnosticsCard
        probe={probe.data === null ? null : probe.data.outcome}
        presence={probe.data === null ? null : probe.data.presence}
        probing={probe.loading}
        report={live}
        rpcError={report.error === null ? null : errMessage(report.error)}
        onRerun={rerun}
      />
      <SecurityCard report={live} />
    </div>
  )
}
