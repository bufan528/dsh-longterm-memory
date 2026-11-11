/**
 * First-run view: the discovery report and the initialization action.
 *
 * This is the state the panel renders before a vault exists, so it must be
 * complete on its own: environment, whether the filesystem is reachable at all,
 * what Obsidian installs were found, why the host decided what it decided, the
 * warnings worth reading, the candidate paths to adopt, and a manual path box.
 *
 * Because adopting a path is this page's only real job, the candidate list is
 * the interactive element — the whole row is the control, not a button parked at
 * its right edge.
 *
 * @module dsh-longterm-memory/client/views/init
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import { call, useAsync, useMutation } from '../api.js'
import { t, useT } from '../i18n.js'
import { usePage } from '../page-api.js'
import { Badge, Button, Card, ErrorNotice, Field, Icon, KvList, Loading, Notice, TextInput } from '../ui.js'

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
      <section className="lmv-hero">
        <div className="lmv-hero-main">
          <span className="lmv-kicker">{translate('init.title')}</span>
          <span className="lmv-hero-path">{translate('init.intro')}</span>
          <div className="lmv-hero-facts">
            {report === null ? null : (
              <>
                <Badge kind="plain">{environmentLabel}</Badge>
                <Badge kind={report.filesystem ? 'ok' : 'error'}>
                  {translate('init.filesystem')}: {report.filesystem ? translate('common.yes') : translate('common.no')}
                </Badge>
                <Badge kind={report.obsidian.detected ? 'brand' : 'plain'}>
                  Obsidian: {report.obsidian.detected ? translate('common.yes') : translate('common.no')}
                </Badge>
              </>
            )}
          </div>
        </div>
        <div className="lmv-hero-actions">
          <Button variant="ghost" disabled={discovery.loading} onClick={discovery.reload}>
            <Icon name="refresh" size={13} />
            {translate('common.refresh')}
          </Button>
        </div>
      </section>

      <Card
        title={
          <>
            <Icon name="diagnostics" />
            {translate('init.environment')}
          </>
        }
      >
        {discovery.loading ? <Loading label={translate('common.loading')} /> : null}
        {discovery.error === null ? null : <ErrorNotice error={discovery.error} onRetry={discovery.reload} />}

        {report === null ? null : (
          <>
            <KvList
              items={[
                { key: translate('init.environment'), value: environmentLabel },
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

            <span className="lmv-field-label">{translate('init.rationale')}</span>
            <p className="lmv-prose-p">{report.rationale}</p>

            {report.warnings.length === 0 ? null : (
              <div className="lmv-list">
                {report.warnings.map((warning) => (
                  <Notice key={warning} kind="warn">
                    {warning}
                  </Notice>
                ))}
              </div>
            )}
          </>
        )}
      </Card>

      {report === null ? null : (
        <Card
          title={
            <>
              <Icon name="overview" />
              {translate('init.candidates')}
            </>
          }
          actions={<Badge kind="plain">{String(report.candidates.length)}</Badge>}
        >
          {report.candidates.length === 0 ? (
            <Notice>{translate('init.noCandidates')}</Notice>
          ) : (
            <div className="lmv-list">
              {report.candidates.map((candidate) => {
                const on = effective === candidate
                return (
                  <button
                    key={candidate}
                    type="button"
                    className={`lmv-row lmv-row-click${on ? ' lmv-row-on' : ''}`}
                    onClick={() => {
                      setChosen(candidate)
                      setManual('')
                    }}
                  >
                    <span className="lmv-inline lmv-mono lmv-grow">
                      <Icon name={on ? 'check' : 'chevron'} size={13} />
                      {candidate}
                    </span>
                    {on ? <Badge kind="brand">{translate('init.chosen')}</Badge> : null}
                  </button>
                )
              })}
            </div>
          )}

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
            <Button variant="primary" disabled={initialize.busy || effective.length === 0} onClick={() => void run()}>
              <Icon name="check" size={14} />
              {initialize.busy ? translate('init.working') : translate('init.initialize')}
            </Button>
            <span className="lmv-meta">
              {effective.length === 0
                ? translate('init.needsChoice')
                : `${translate('init.ready')}: ${effective}`}
            </span>
          </div>
        </Card>
      )}
    </div>
  )
}
