/**
 * The 历史 tab: what landed recently, and what each commit touched.
 *
 * The list is one `git log` read for the whole page, and a commit's patch is a
 * second read made only when the row is opened — a repository with a large
 * history would otherwise ship megabytes of diff to render rows nobody looked
 * at. Each patch read is guarded by the generation it was issued in, so the
 * answer to a previously opened commit can never appear under a later one.
 *
 * A merge commit is shown as metadata with no files and no patch, because git
 * has no single diff for it: the panel would have to choose a parent, and a
 * chosen parent renders a truthful-looking patch that is not the commit.
 *
 * @module dsh-web-ui/client/GitHistory
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconLoadingOutline16,
  IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GitCommit, GitCommitDetail, GitError } from '../shared/gitwire.ts'
import type { NS } from './contract.ts'
import { readCommit, readLog } from './gitapi.ts'
import type { GitTabCommon } from './GitPanel.tsx'
import { relativeTime } from './project.ts'

/** The page sizes the limit selector offers. */
const LIMITS: readonly number[] = [20, 50, 100, 200]

/**
 * Render one commit instant as a compact relative phrase.
 * @param date - the ISO-8601 instant.
 * @param now - the current epoch milliseconds.
 * @param t - the translator.
 * @returns the phrase.
 */
function relative(date: string, now: number, t: TranslateNS<typeof NS>): string {
  const at = Date.parse(date)
  if (!Number.isFinite(at)) return ''
  const { unit, n } = relativeTime(at, now)
  switch (unit) {
    case 'now': return t('time.now')
    case 'minutes': return t('time.minutes', { n })
    case 'hours': return t('time.hours', { n })
    case 'days': return t('time.days', { n })
    case 'months': return t('time.months', { n })
    default: return t('time.years', { n })
  }
}

/**
 * Render the history tab.
 * @param props - the shared tab face.
 * @returns the tab's element tree.
 */
export function GitHistory({ dir, t, token }: GitTabCommon): ReactNode {
  const [limit, setLimit] = useState(50)
  const [commits, setCommits] = useState<readonly GitCommit[] | null>(null)
  const [error, setError] = useState<GitError | null>(null)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<string | null>(null)
  const [detail, setDetail] = useState<GitCommitDetail | null>(null)
  const [detailError, setDetailError] = useState<{ sha: string; message: string } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const generation = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    generation.current += 1
    const gen = generation.current
    setLoading(true)
    const answer = await readLog(dir, limit)
    if (gen !== generation.current) return
    setLoading(false)
    if (!answer.ok) {
      setCommits(null)
      setError(answer.error)
      return
    }
    setError(null)
    setCommits(answer.data)
    setNow(Date.now())
  }, [dir, limit])

  useEffect(() => { void load() }, [load, token])

  // A new page of history invalidates the open row: its patch belonged to the
  // list that was on screen a moment ago.
  useEffect(() => {
    setOpen(null)
    setDetail(null)
    setDetailError(null)
  }, [token, limit])

  useEffect(() => {
    if (open === null) return
    if (detail !== null && detail.commit.sha === open) return
    // Keyed by commit: a failure belongs to ONE row, and holding it globally
    // would stop every later commit from ever being opened.
    if (detailError !== null && detailError.sha === open) return
    const gen = generation.current
    const sha = open
    void (async () => {
      const answer = await readCommit(dir, sha)
      if (gen !== generation.current) return
      if (!answer.ok) {
        setDetailError({ sha, message: answer.error.message })
        return
      }
      setDetailError(null)
      setDetail(answer.data)
    })()
  }, [detail, detailError, dir, open])

  if (error !== null) {
    return (
      <div data-wui="gitEmpty" data-tone="error" role="status">
        <IconWarningOutline16 size={16} />
        <span data-wui="gitEmptyTitle">{error.message}</span>
        <button type="button" data-wui="gitQuickButton" onClick={() => { void load() }}>{t('git.retry')}</button>
      </div>
    )
  }

  if (commits === null) {
    return <div data-wui="gitEmpty"><IconLoadingOutline16 size={16} /><span>{t('git.loading')}</span></div>
  }

  return (
    <div data-wui="gitSection">
      <div data-wui="gitSectionHead">
        <span>{t('git.history.limit', { n: commits.length })}</span>
        <select
          data-wui="gitSelect"
          value={String(limit)}
          aria-label={t('git.history.limit', { n: limit })}
          onChange={(event) => { setLimit(Number(event.target.value)) }}
        >
          {LIMITS.map(value => <option key={value} value={String(value)}>{String(value)}</option>)}
        </select>
      </div>

      {commits.length === 0 && <div data-wui="gitNote">{t('git.history.empty')}</div>}

      <ul data-wui="gitRows">
        {commits.map((commit) => {
          const expanded = open === commit.sha
          return (
            <li key={commit.sha} data-wui="gitRow" data-open={expanded || undefined}>
              <button
                type="button"
                data-wui="gitRowMain"
                aria-expanded={expanded}
                title={commit.subject}
                onClick={() => { setOpen(expanded ? null : commit.sha) }}
              >
                <span data-wui="gitRowTitle">
                  <span data-wui="gitRowToggle" aria-hidden="true">
                    {expanded ? <IconChevronDownOutline14 size={12} /> : <IconChevronRightOutline14 size={12} />}
                  </span>
                  <span data-wui="gitSha">{commit.shortSha}</span>
                  <span data-wui="gitRowName">{commit.subject}</span>
                </span>
                <span data-wui="gitRowMeta">
                  {commit.parents.length > 1 && <span data-wui="gitTrack" data-tone="muted">merge</span>}
                  {commit.refs.map(ref => <span key={ref} data-wui="gitRefChip">{ref}</span>)}
                  <span data-wui="gitRowSubject">{commit.author}</span>
                  <span data-wui="gitRowTime">{relative(commit.date, now, t)}</span>
                </span>
              </button>
              {expanded && (
                <div data-wui="gitPatch">
                  {detailError?.sha === commit.sha && (
                    <div data-wui="gitNote" data-tone="error">{detailError.message}</div>
                  )}
                  {detail !== null && detail.commit.sha === commit.sha && (
                    <>
                      <div data-wui="gitCommitFiles">
                        <span data-wui="gitRowSubject">
                          {detail.files.length === 0
                            ? t('git.history.merge')
                            : t('git.history.files', { n: detail.files.length })}
                        </span>
                        {detail.files.map(file => (
                          <span key={file.path} data-wui="gitNumstat">
                            <span data-wui="gitRowName" data-path="true">{file.path}</span>
                            <span data-wui="gitAdd">{file.additions === null ? 'bin' : `+${String(file.additions)}`}</span>
                            <span data-wui="gitDel">{file.deletions === null ? '' : `-${String(file.deletions)}`}</span>
                          </span>
                        ))}
                      </div>
                      {detail.patch.trim() !== '' && <pre data-wui="gitPatchText">{detail.patch}</pre>}
                      {detail.truncated && <div data-wui="gitNote">{t('git.history.truncated')}</div>}
                    </>
                  )}
                  {detail === null && detailError?.sha !== commit.sha && (
                    <div data-wui="gitNote"><IconLoadingOutline16 size={12} />{t('git.loading')}</div>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
