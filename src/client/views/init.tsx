/**
 * First-run view: the discovery report and the initialization action.
 *
 * This is the state the panel renders before a vault exists, so it must be
 * complete on its own: environment, whether the filesystem is reachable at all,
 * what Obsidian installs were found, why the host decided what it decided, the
 * warnings worth reading, the candidate paths to adopt, and a manual path box.
 *
 * @module dsh-longterm-memory/client/views/init
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import { call, useAsync, useMutation } from '../api.js'
import { t, useT } from '../i18n.js'
import { usePage } from '../page-api.js'
import { Button, Card, ErrorNotice, Field, KvList, Loading, Notice, TextInput } from '../ui.js'

/** Render the first-run flow. */
export function InitView(props: { onReady: () => void }): ReactElement {
  const page = usePage()
  const translate = useT()
  const discovery = useAsync(() => call('discover', {}), [])
  const initialize = useMutation((path: string) => call('initialize', path.length > 0 ? { path } : {}))
  const [manual, setManual] = useState('')
  const [chosen, setChosen] = useState<string | null>(null)

  const report = discovery.data
  const effective = chosen !== null && chosen.length > 0 ? chosen : manual.trim()
  const environmentLabel =
    report === null
      ? ''
      : report.environment === 'desktop'
        ? translate('init.environment.desktop')
        : report.environment === 'web'
          ? translate('init.environment.web')
          : translate('init.environment.node')

  const run = async (): Promise<void> => {
    try {
      await initialize.run(effective)
      page.toast(t('init.done'), 'ok')
      props.onReady()
    } catch {
      /* surfaced by the mutation state below */
    }
  }

  return (
    <div className="lmv-main">
      <Card title={translate('init.title')}>
        <p className="lmv-prose-p">{translate('init.intro')}</p>

        {discovery.loading ? <Loading label={translate('common.loading')} /> : null}
        {discovery.error === null ? null : <ErrorNotice error={discovery.error} onRetry={discovery.reload} />}

        {report === null ? null : (
          <>
            <KvList
              items={[
                { key: translate('init.environment'), value: environmentLabel },
                {
                  key: translate('init.filesystem'),
                  value: report.filesystem ? translate('common.yes') : translate('common.no'),
                },
                {
                  key: translate('init.obsidianDetected'),
                  value: report.obsidian.detected ? translate('common.yes') : translate('common.no'),
                },
                {
                  key: translate('init.obsidianConfig'),
                  value: report.obsidian.configPath === null ? translate('common.none') : report.obsidian.configPath,
                },
                {
                  key: translate('init.current'),
                  value: report.current === null ? translate('common.none') : report.current,
                },
                {
                  key: translate('init.needsChoice'),
                  value: report.needsChoice ? translate('common.yes') : translate('common.no'),
                },
              ]}
            />

            <Field label={translate('init.rationale')}>
              <p className="lmv-prose-p">{report.rationale}</p>
            </Field>

            {report.warnings.length === 0 ? null : (
              <div className="lmv-list">
                {report.warnings.map((warning) => (
                  <Notice key={warning} kind="warn">
                    {warning}
                  </Notice>
                ))}
              </div>
            )}

            <div className="lmv-field">
              <span className="lmv-field-label">{translate('init.candidates')}</span>
              {report.candidates.length === 0 ? (
                <Notice>{translate('init.noCandidates')}</Notice>
              ) : (
                <div className="lmv-list">
                  {report.candidates.map((candidate) => (
                    <div key={candidate} className="lmv-row">
                      <span className="lmv-row-main">
                        <span className="lmv-mono">{candidate}</span>
                      </span>
                      <Button
                        variant={effective === candidate ? 'primary' : 'default'}
                        onClick={() => {
                          setChosen(candidate)
                          setManual('')
                        }}
                      >
                        {effective === candidate ? translate('common.selected') : translate('common.apply')}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Field label={translate('init.manual')}>
              <TextInput
                value={manual}
                block
                placeholder={translate('init.manualPlaceholder')}
                onChange={(value) => {
                  setManual(value)
                  setChosen(null)
                }}
              />
            </Field>

            {initialize.error === null ? null : <ErrorNotice error={initialize.error} />}

            <div className="lmv-wrap">
              <Button variant="primary" disabled={initialize.busy} onClick={() => void run()}>
                {initialize.busy ? translate('init.working') : translate('init.initialize')}
              </Button>
              <span className="lmv-meta">
                {effective.length === 0 ? translate('init.needsChoice') : `${translate('init.ready')}: ${effective}`}
              </span>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
