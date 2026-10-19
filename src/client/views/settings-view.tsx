/**
 * Settings (设置) and the recall preview.
 *
 * Every toggle maps to a real `setSettings` field. The LLM-extraction toggle
 * carries an explicit privacy note, because turning it on makes the plugin spend
 * an extra model request against the user's own configured provider.
 *
 * @module dsh-longterm-memory/client/views/settings-view
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import type { PluginSettings, RpcResultMap } from '../../shared/protocol.js'
import type { VaultInfo } from '../../shared/types.js'
import { call, useAsync, useMutation } from '../api.js'
import { setLanguage, useT } from '../i18n.js'
import { usePage } from '../page-api.js'
import { Button, Card, Checkbox, ErrorNotice, Field, KvList, Loading, Notice, NumberInput, Select, TextInput } from '../ui.js'
import { formatTime } from '../util.js'

/** Render the settings pane. */
export function SettingsView(props: { vault: VaultInfo | null; onChanged: () => void }): ReactElement {
  const page = usePage()
  const translate = useT()
  const settings = useAsync(() => call('getSettings', {}), [])
  const save = useMutation((partial: Partial<PluginSettings>) => call('setSettings', partial))
  const preview = useMutation((query: string) => call('previewRecall', query.trim().length > 0 ? { query: query.trim() } : {}))
  const [draft, setDraft] = useState<PluginSettings | null>(null)
  const [previewQuery, setPreviewQuery] = useState('')
  const [previewResult, setPreviewResult] = useState<RpcResultMap['previewRecall'] | null>(null)

  useEffect(() => {
    const loaded = settings.data
    if (loaded === null) return
    setDraft(loaded)
    setLanguage(loaded.language)
  }, [settings.data])

  const patch = (changes: Partial<PluginSettings>): void => {
    setDraft((current) => (current === null ? current : { ...current, ...changes }))
  }

  // The "unsaved changes" hint must reflect reality: it used to be rendered
  // unconditionally, so the settings card always claimed there were changes.
  const dirty = draft !== null && settings.data !== null && JSON.stringify(draft) !== JSON.stringify(settings.data)

  const doSave = async (): Promise<void> => {
    if (draft === null) return
    const payload: Partial<PluginSettings> = {
      language: draft.language,
      enableTools: draft.enableTools,
      enablePromptSection: draft.enablePromptSection,
      standingBudgetTokens: draft.standingBudgetTokens,
      standingMaxItems: draft.standingMaxItems,
      recallBudgetTokens: draft.recallBudgetTokens,
      recallMaxItems: draft.recallMaxItems,
      enablePerStepRecall: draft.enablePerStepRecall,
      enableAutoExtraction: draft.enableAutoExtraction,
      enableLlmExtraction: draft.enableLlmExtraction,
      redactSecrets: draft.redactSecrets,
      sensitiveNeedsConfirmation: draft.sensitiveNeedsConfirmation,
      maxCandidatesPerTurn: draft.maxCandidatesPerTurn,
    }
    try {
      const result = await save.run(payload)
      if (result !== null && result !== undefined) {
        setDraft(result)
        setLanguage(result.language)
      }
      page.toast(translate('settings.saved'), 'ok')
      props.onChanged()
      settings.reload()
    } catch {
      /* rendered from the mutation state */
    }
  }

  if (settings.loading && draft === null) {
    return (
      <div className="lmv-main">
        <Loading />
      </div>
    )
  }

  if (settings.error !== null || draft === null) {
    return (
      <div className="lmv-main">
        <ErrorNotice error={settings.error} onRetry={settings.reload} />
      </div>
    )
  }

  return (
    <div className="lmv-main">
      <Card
        title={translate('settings.title')}
        actions={
          <>
            {dirty ? <span className="lmv-meta">{translate('settings.dirty')}</span> : null}
            <Button variant="primary" disabled={save.busy} onClick={() => void doSave()}>
              {translate('common.save')}
            </Button>
            <Button variant="ghost" disabled={save.busy} onClick={settings.reload}>
              {translate('common.reload')}
            </Button>
          </>
        }
      >
        <Field label={translate('settings.language')}>
          <Select<'zh' | 'en'>
            value={draft.language}
            options={[
              { value: 'zh', label: translate('settings.languageZh') },
              { value: 'en', label: translate('settings.languageEn') },
            ]}
            onChange={(value) => {
              patch({ language: value })
              setLanguage(value)
            }}
          />
        </Field>

        <Checkbox
          checked={draft.enableTools}
          label={translate('settings.enableTools')}
          onChange={(checked) => {
            patch({ enableTools: checked })
          }}
        />
        <Checkbox
          checked={draft.enablePromptSection}
          label={translate('settings.enablePromptSection')}
          onChange={(checked) => {
            patch({ enablePromptSection: checked })
          }}
        />

        <div className="lmv-toolbar">
          <Field label={translate('settings.standingBudgetTokens')}>
            <NumberInput
              value={draft.standingBudgetTokens}
              min={0}
              onChange={(value) => {
                patch({ standingBudgetTokens: value })
              }}
            />
          </Field>
          <Field label={translate('settings.standingMaxItems')}>
            <NumberInput
              value={draft.standingMaxItems}
              min={0}
              onChange={(value) => {
                patch({ standingMaxItems: value })
              }}
            />
          </Field>
          <Field label={translate('settings.recallBudgetTokens')}>
            <NumberInput
              value={draft.recallBudgetTokens}
              min={0}
              onChange={(value) => {
                patch({ recallBudgetTokens: value })
              }}
            />
          </Field>
          <Field label={translate('settings.recallMaxItems')}>
            <NumberInput
              value={draft.recallMaxItems}
              min={0}
              onChange={(value) => {
                patch({ recallMaxItems: value })
              }}
            />
          </Field>
          <Field label={translate('settings.maxCandidatesPerTurn')}>
            <NumberInput
              value={draft.maxCandidatesPerTurn}
              min={0}
              onChange={(value) => {
                patch({ maxCandidatesPerTurn: value })
              }}
            />
          </Field>
        </div>

        <Checkbox
          checked={draft.enablePerStepRecall}
          label={translate('settings.enablePerStepRecall')}
          onChange={(checked) => {
            patch({ enablePerStepRecall: checked })
          }}
        />
        <Checkbox
          checked={draft.enableAutoExtraction}
          label={translate('settings.enableAutoExtraction')}
          onChange={(checked) => {
            patch({ enableAutoExtraction: checked })
          }}
        />
        <Checkbox
          checked={draft.enableLlmExtraction}
          label={translate('settings.enableLlmExtraction')}
          onChange={(checked) => {
            patch({ enableLlmExtraction: checked })
          }}
        />
        <Notice kind="warn">{translate('settings.llmPrivacy')}</Notice>

        <Checkbox
          checked={draft.redactSecrets}
          label={translate('settings.redactSecrets')}
          onChange={(checked) => {
            patch({ redactSecrets: checked })
          }}
        />
        <Checkbox
          checked={draft.sensitiveNeedsConfirmation}
          label={translate('settings.sensitiveNeedsConfirmation')}
          onChange={(checked) => {
            patch({ sensitiveNeedsConfirmation: checked })
          }}
        />

        <KvList
          items={[
            {
              key: translate('settings.vault'),
              value: <span className="lmv-mono">{props.vault === null ? translate('common.none') : props.vault.path}</span>,
            },
            { key: translate('settings.lastIndexRebuild'), value: formatTime(draft.lastIndexRebuild) },
            {
              key: translate('overview.indexCount'),
              value: String(props.vault === null ? 0 : props.vault.index.count),
            },
          ]}
        />

        {save.error === null ? null : <ErrorNotice error={save.error} />}
      </Card>

      <Card
        title={translate('settings.preview')}
        actions={
          <Button
            variant="primary"
            disabled={preview.busy}
            onClick={() => {
              void (async () => {
                try {
                  const result = await preview.run(previewQuery)
                  if (result !== undefined) setPreviewResult(result)
                } catch {
                  setPreviewResult(null)
                }
              })()
            }}
          >
            {translate('settings.previewRun')}
          </Button>
        }
      >
        <span className="lmv-prose-p">{translate('settings.previewHint')}</span>
        <Field label={translate('settings.previewQuery')}>
          <TextInput value={previewQuery} block onChange={setPreviewQuery} />
        </Field>

        {preview.busy ? <Loading /> : null}
        {preview.error === null ? null : <ErrorNotice error={preview.error} />}
        {previewResult === null ? null : (
          <>
            <div className="lmv-wrap">
              <span className="lmv-meta">{translate('settings.previewTokens', { tokens: previewResult.usedTokens })}</span>
              <span className="lmv-meta">
                {translate('settings.previewIncluded', { count: previewResult.includedIds.length })}
              </span>
              <span className="lmv-meta">{translate('settings.previewOmitted', { count: previewResult.omitted })}</span>
            </div>
            {previewResult.text.trim().length === 0 ? (
              <Notice>{translate('settings.previewEmpty')}</Notice>
            ) : (
              <pre className="lmv-pre">{previewResult.text}</pre>
            )}
            <KvList
              items={[
                {
                  key: translate('settings.previewIncluded'),
                  value: <span className="lmv-mono">{previewResult.includedIds.join(', ')}</span>,
                },
              ]}
            />
          </>
        )}
      </Card>
    </div>
  )
}
