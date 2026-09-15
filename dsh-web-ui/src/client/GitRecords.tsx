/**
 * The 操作记录 tab: what this panel actually ran, and what git said back.
 *
 * The journal lives on the HOST, not here, and that is the point. A record kept
 * in the browser would be a record of what this tab believes it asked for; the
 * host's ring is what reached a process, with the exit status, the duration, and
 * git's own output attached. An operator debugging "why did the push not land"
 * needs the second one.
 *
 * Records are newest-first and scoped to the repository, so switching projects
 * shows that repository's history rather than a merged stream from every tree
 * this plugin has touched.
 *
 * @module dsh-web-ui/client/GitRecords
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconLoadingOutline16,
  IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitError, GitRecord, GitRecordList } from '../shared/gitwire.ts'
import { readRecords } from './gitapi.ts'
import type { GitTabCommon } from './GitPanel.tsx'

/** How many records the tab renders before offering the count alone. */
const RENDER_CAP = 100

/**
 * Render the journal tab.
 * @param props - the shared tab face.
 * @returns the tab's element tree.
 */
export function GitRecords({ dir, t, token }: GitTabCommon): ReactNode {
  const [list, setList] = useState<GitRecordList | null>(null)
  const [error, setError] = useState<GitError | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const generation = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    generation.current += 1
    const gen = generation.current
    const answer = await readRecords(dir)
    if (gen !== generation.current) return
    if (!answer.ok) {
      setList(null)
      setError(answer.error)
      return
    }
    setError(null)
    setList(answer.data)
  }, [dir])

  useEffect(() => { void load() }, [load, token])

  if (error !== null) {
    return (
      <div data-wui="gitEmpty" data-tone="error" role="status">
        <IconWarningOutline16 size={16} />
        <span data-wui="gitEmptyTitle">{error.message}</span>
        <button type="button" data-wui="gitQuickButton" onClick={() => { void load() }}>{t('git.retry')}</button>
      </div>
    )
  }

  if (list === null) {
    return <div data-wui="gitEmpty"><IconLoadingOutline16 size={16} /><span>{t('git.loading')}</span></div>
  }

  const rows: readonly GitRecord[] = list.records.slice(0, RENDER_CAP)

  return (
    <div data-wui="gitSection">
      <div data-wui="gitSectionHead">
        <span>{t('git.records.count', { n: list.total })}</span>
      </div>

      {list.records.length === 0 && <div data-wui="gitNote">{t('git.records.empty')}</div>}

      <ul data-wui="gitRows">
        {rows.map((record) => {
          const expanded = open === record.id
          const when = new Date(record.at)
          return (
            <li key={record.id} data-wui="gitRow" data-tone={record.ok ? undefined : 'error'}>
              <button
                type="button"
                data-wui="gitRowMain"
                aria-expanded={expanded}
                title={record.command}
                onClick={() => { setOpen(expanded ? null : record.id) }}
              >
                <span data-wui="gitRowTitle">
                  <span data-wui="gitRowToggle" aria-hidden="true">
                    {expanded ? <IconChevronDownOutline14 size={12} /> : <IconChevronRightOutline14 size={12} />}
                  </span>
                  <span data-wui="gitStatusChip" data-side={record.ok ? 'staged' : 'conflict'}>
                    {record.ok ? '0' : String(record.code)}
                  </span>
                  <span data-wui="gitRowName" data-code="true">{record.command}</span>
                </span>
                <span data-wui="gitRowMeta">
                  <span data-wui="gitRowSubject" data-tone={record.ok ? undefined : 'error'}>
                    {record.ok ? t('git.records.ok') : t('git.records.failed')}
                  </span>
                  <span data-wui="gitRowTime">
                    {when.toLocaleTimeString()} · {record.durationMs} ms
                  </span>
                </span>
              </button>
              {expanded && (
                <div data-wui="gitPatch">
                  {record.output.trim() === ''
                    ? <div data-wui="gitNote">{t('git.records.none')}</div>
                    : <pre data-wui="gitPatchText">{record.output}</pre>}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
