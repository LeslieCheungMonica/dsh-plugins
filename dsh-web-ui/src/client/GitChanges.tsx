/**
 * The 改动 tab: what is dirty, what is stashed, and what is about to be
 * committed.
 *
 * Four sections, each one a bucket git itself decided — unmerged, staged,
 * working-tree, untracked — because a path can be dirty on BOTH sides of the
 * index and collapsing that into one row would hide the fact that the file the
 * operator is looking at is not the file the commit will record. The status
 * chip keeps git's own two letters (`MM`, `AM`, `D.`) for the same reason.
 *
 * Two behaviours are worth naming:
 *
 * - **The diff opens in place.** Clicking a row expands a patch under it, read
 *   on demand and only for the side the row belongs to (index or working tree).
 *   It is one request per opened row, and each carries the generation it was
 *   issued in, so a stale patch can never paint under a row whose change is
 *   already gone.
 * - **The commit box survives.** It is component state rather than a keyed
 *   value, and the drawer keeps this tab mounted across tab switches, so a
 *   half-typed message is never silently discarded by looking at the history.
 *
 * @module dsh-web-ui/client/GitChanges
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconLoadingOutline16,
  IconPlusOutline16, IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GitChanges as GitChangeSet, GitError, GitFileChange, GitOverview } from '../shared/gitwire.ts'
import type { NS } from './contract.ts'
import { readChanges, readDiff } from './gitapi.ts'
import type { GitTabProps } from './GitPanel.tsx'

/** Props of the changes tab: the shared face plus the drawer's overview. */
export type GitChangesProps = GitTabProps & {
  /** The drawer's overview read, used for the operation strip and the counts. */
  readonly overview: GitOverview
}

/** Which side of the index an expanded patch shows. */
interface DiffKey {
  /** The path the patch belongs to. */
  readonly path: string
  /** True when the patch is the index-vs-HEAD diff. */
  readonly staged: boolean
}

/**
 * Render one status chip: git's two letters, coloured by bucket.
 * @param props - the change and its bucket.
 * @returns the chip.
 */
function StatusChip({ change, t }: { change: GitFileChange; t: TranslateNS<typeof NS> }): ReactNode {
  // The two letters are git's own (`M `, ` M`, `MM`, `??`, `UU`): a `.` means
  // "clean on this side", and replacing it with a space would hide which side
  // of the index the change is on — the one fact this chip exists to carry.
  const letters = change.untracked ? '??' : `${change.index}${change.worktree}`
  const side = change.untracked
    ? 'untracked'
    : change.conflicted
      ? 'conflict'
      : change.staged && !change.unstaged
        ? 'staged'
        : 'unstaged'
  const title = t(`git.side.${side}`)
  return (
    <span data-wui="gitStatusChip" data-side={side} title={title} aria-label={title}>
      {letters}
    </span>
  )
}

/**
 * One collapsible section of the tab.
 * @param props - the header copy, the count, and the rows.
 * @returns the section.
 */
function Section({ title, count, tone, children }: {
  title: string
  count: number
  tone?: 'conflict'
  children: ReactNode
}): ReactNode {
  const [open, setOpen] = useState(true)
  if (count === 0) return null
  return (
    <section data-wui="gitSection" data-tone={tone}>
      <button
        type="button"
        data-wui="gitDisclosure"
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        {open ? <IconChevronDownOutline14 size={12} /> : <IconChevronRightOutline14 size={12} />}
        {title}
      </button>
      {open && children}
    </section>
  )
}

/**
 * Render the changes tab.
 * @param props - the shared tab face plus the overview.
 * @returns the tab's element tree.
 */
export function GitChanges({ dir, t, token, run, confirm, overview }: GitChangesProps): ReactNode {
  const [set, setSet] = useState<GitChangeSet | null>(null)
  const [error, setError] = useState<GitError | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [commitAll, setCommitAll] = useState(false)
  const [stashMessage, setStashMessage] = useState('')
  const [expanded, setExpanded] = useState<DiffKey | null>(null)
  const [patch, setPatch] = useState<{ key: DiffKey; text: string; truncated: boolean } | null>(null)
  const [patchError, setPatchError] = useState<{ key: DiffKey; message: string } | null>(null)
  const generation = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    generation.current += 1
    const gen = generation.current
    setLoading(true)
    const answer = await readChanges(dir)
    if (gen !== generation.current) return
    setLoading(false)
    if (!answer.ok) {
      setSet(null)
      setError(answer.error)
      return
    }
    setError(null)
    setSet(answer.data)
  }, [dir])

  useEffect(() => { void load() }, [load, token])

  // The expanded row is dropped whenever the tree changed: the patch on screen
  // belonged to the previous state of that path, and leaving it there would
  // show a diff that no longer exists.
  useEffect(() => {
    setExpanded(null)
    setPatch(null)
    setPatchError(null)
  }, [token])

  /**
   * Expand or collapse one row's patch.
   * @param key - the path and the side to show.
   */
  const toggleDiff = useCallback((key: DiffKey): void => {
    setExpanded(current => (current !== null && current.path === key.path && current.staged === key.staged
      ? null
      : key))
  }, [])

  // One read per opened row, carrying the generation it belongs to.
  useEffect(() => {
    if (expanded === null) return
    if (patch !== null && patch.key.path === expanded.path && patch.key.staged === expanded.staged) return
    if (patchError !== null && patchError.key.path === expanded.path && patchError.key.staged === expanded.staged) return
    const gen = generation.current
    const key = expanded
    void (async () => {
      const answer = await readDiff(dir, key.path, key.staged)
      if (gen !== generation.current) return
      if (!answer.ok) {
        setPatchError({ key, message: answer.error.message })
        return
      }
      setPatchError(null)
      setPatch({ key, text: answer.data.patch, truncated: answer.data.truncated })
    })()
  }, [dir, expanded, patch, patchError])

  const staged = set?.files.filter(file => file.staged && !file.conflicted && !file.untracked) ?? []
  const modified = set?.files.filter(file => file.unstaged && !file.conflicted && !file.untracked) ?? []
  const untracked = set?.files.filter(file => file.untracked) ?? []
  const conflicted = set?.files.filter(file => file.conflicted) ?? []

  const canCommit = message.trim() !== '' && (staged.length > 0 || commitAll)

  /**
   * Render one changed path with its actions and, when open, its patch.
   * @param file - the change.
   * @param side - which section it is listed under.
   * @returns the row.
   */
  const row = (file: GitFileChange, side: 'staged' | 'unstaged' | 'untracked' | 'conflict'): ReactNode => {
    const key: DiffKey = { path: file.path, staged: side === 'staged' }
    const open = expanded !== null && expanded.path === key.path && expanded.staged === key.staged
    return (
      <li key={`${side}:${file.path}`} data-wui="gitRow" data-open={open || undefined}>
        <button
          type="button"
          data-wui="gitRowMain"
          aria-expanded={open}
          title={file.path}
          onClick={() => { toggleDiff(key) }}
        >
          <span data-wui="gitRowTitle">
            <span data-wui="gitStatusChipHost"><StatusChip change={file} t={t} /></span>
            <span data-wui="gitRowName" data-path="true">{file.path}</span>
          </span>
          {file.from !== null && <span data-wui="gitRowMeta"><span data-wui="gitRowSubject">← {file.from}</span></span>}
        </button>
        <span data-wui="gitRowActions">
          {side === 'staged' && (
            <button
              type="button"
              data-wui="gitTinyAction"
              onClick={() => { void run('unstage', { files: [file.path] }) }}
            >
              {t('git.changes.unstage')}
            </button>
          )}
          {side === 'unstaged' && (
            <>
              <button
                type="button"
                data-wui="gitTinyAction"
                onClick={() => { void run('stage', { files: [file.path] }) }}
              >
                {t('git.changes.stage')}
              </button>
              <button
                type="button"
                data-wui="gitTinyAction"
                data-tone="danger"
                onClick={() => {
                  void confirm({
                    title: t('git.changes.discard.title'),
                    message: t('git.changes.discard.message', { path: file.path }),
                    confirmLabel: t('git.changes.discard'),
                  }).then((yes) => { if (yes) void run('discard', { files: [file.path] }) })
                }}
              >
                {t('git.changes.discard')}
              </button>
            </>
          )}
          {side === 'untracked' && (
            <>
              <button
                type="button"
                data-wui="gitTinyAction"
                onClick={() => { void run('stage', { files: [file.path] }) }}
              >
                {t('git.changes.stage')}
              </button>
              <button
                type="button"
                data-wui="gitTinyAction"
                data-tone="danger"
                onClick={() => {
                  void confirm({
                    title: t('git.changes.remove.title'),
                    message: t('git.changes.remove.message', { path: file.path }),
                    confirmLabel: t('git.changes.remove'),
                  }).then((yes) => { if (yes) void run('clean', { files: [file.path] }) })
                }}
              >
                {t('git.changes.remove')}
              </button>
            </>
          )}
          {side === 'conflict' && (
            <button
              type="button"
              data-wui="gitTinyAction"
              onClick={() => { void run('stage', { files: [file.path] }) }}
            >
              {t('git.changes.stage')}
            </button>
          )}
        </span>
        {open && (
          <div data-wui="gitPatch">
            {patchError !== null && patchError.key.path === file.path && (
              <div data-wui="gitNote" data-tone="error">{patchError.message}</div>
            )}
            {patch !== null && patch.key.path === file.path && patch.key.staged === key.staged && (
              <>
                {patch.text.trim() === ''
                  ? <div data-wui="gitNote">{t('git.changes.diff.empty')}</div>
                  : <pre data-wui="gitPatchText">{patch.text}</pre>}
                {patch.truncated && <div data-wui="gitNote">{t('git.history.truncated')}</div>}
              </>
            )}
            {patch === null && (patchError === null || patchError.key.path !== file.path) && (
              <div data-wui="gitNote"><IconLoadingOutline16 size={12} />{t('git.loading')}</div>
            )}
          </div>
        )}
      </li>
    )
  }

  if (error !== null) {
    return (
      <div data-wui="gitEmpty" data-tone="error" role="status">
        <IconWarningOutline16 size={16} />
        <span data-wui="gitEmptyTitle">{error.message}</span>
        <button type="button" data-wui="gitQuickButton" onClick={() => { void load() }}>{t('git.retry')}</button>
      </div>
    )
  }

  if (set === null) {
    return <div data-wui="gitEmpty"><IconLoadingOutline16 size={16} /><span>{t('git.loading')}</span></div>
  }

  const nothing = set.files.length === 0

  return (
    <div data-wui="gitSection">
      {conflicted.length > 0 && (
        <div data-wui="gitAlert" data-tone="error" role="status">
          <IconWarningOutline16 size={14} />
          <span>{t('git.conflict.hint', { op: t(`git.op.${overview.repo.operation ?? 'merge'}`) })}</span>
          <button
            type="button"
            data-wui="gitTinyAction"
            onClick={() => {
              void confirm({
                title: t('git.op.abort.title'),
                message: t('git.op.abort.message', { op: t(`git.op.${overview.repo.operation ?? 'merge'}`) }),
                confirmLabel: t('git.confirm'),
              }).then((yes) => { if (yes) void run('abort') })
            }}
          >
            {t('git.conflict.abort', { op: t(`git.op.${overview.repo.operation ?? 'merge'}`) })}
          </button>
        </div>
      )}

      <section data-wui="gitCommitBox">
        <textarea
          data-wui="gitCommitInput"
          rows={3}
          value={message}
          placeholder={t('git.changes.commit.placeholder')}
          aria-label={t('git.changes.commit.placeholder')}
          onChange={(event) => { setMessage(event.target.value) }}
        />
        <label data-wui="gitCommitAll">
          <input
            type="checkbox"
            checked={commitAll}
            onChange={(event) => { setCommitAll(event.target.checked) }}
          />
          <span>{t('git.changes.commit.all')}</span>
        </label>
        <div data-wui="gitCommitActions">
          <button
            type="button"
            data-wui="gitPrimaryButton"
            disabled={!canCommit}
            onClick={() => {
              const text = message.trim()
              void run('commit', commitAll ? { message: text, all: true } : { message: text })
                .then((result) => { if (result?.ok === true) { setMessage(''); setCommitAll(false) } })
            }}
          >
            {t('git.changes.commit.action')}
          </button>
          <button
            type="button"
            data-wui="gitTinyAction"
            disabled={!canCommit}
            onClick={() => {
              const text = message.trim()
              void run('amend', commitAll ? { message: text, all: true } : { message: text })
                .then((result) => { if (result?.ok === true) { setMessage(''); setCommitAll(false) } })
            }}
          >
            {t('git.changes.amend')}
          </button>
        </div>
      </section>

      {nothing && <div data-wui="gitNote">{t('git.changes.clean')}</div>}

      <Section title={t('git.conflicted.count', { n: conflicted.length })} count={conflicted.length} tone="conflict">
        <ul data-wui="gitRows">{conflicted.map(file => row(file, 'conflict'))}</ul>
      </Section>

      <Section title={t('git.staged.count', { n: staged.length })} count={staged.length}>
        <ul data-wui="gitRows">{staged.map(file => row(file, 'staged'))}</ul>
      </Section>

      <Section title={t('git.unstaged.count', { n: modified.length })} count={modified.length}>
        <ul data-wui="gitRows">{modified.map(file => row(file, 'unstaged'))}</ul>
      </Section>

      <Section title={t('git.untracked.count', { n: untracked.length })} count={untracked.length}>
        <ul data-wui="gitRows">{untracked.map(file => row(file, 'untracked'))}</ul>
      </Section>

      <section data-wui="gitSection">
        <div data-wui="gitStashHead">
          <span data-wui="gitSectionTitle">{t('git.stash.count', { n: set.stashes.length })}</span>
          <input
            data-wui="gitStashInput"
            value={stashMessage}
            placeholder={t('git.changes.stash.placeholder')}
            aria-label={t('git.changes.stash.placeholder')}
            onChange={(event) => { setStashMessage(event.target.value) }}
          />
          <button
            type="button"
            data-wui="gitTinyAction"
            onClick={() => {
              const text = stashMessage.trim()
              void run('stash-save', text === '' ? {} : { message: text })
                .then((result) => { if (result?.ok === true) setStashMessage('') })
            }}
          >
            <IconPlusOutline16 size={12} />
            {t('git.changes.stash.save')}
          </button>
        </div>
        {set.stashes.length === 0 && <div data-wui="gitNote">{t('git.changes.stash.empty')}</div>}
        <ul data-wui="gitRows">
          {set.stashes.map(stash => (
            <li key={stash.ref} data-wui="gitRow">
              <span data-wui="gitRowMain" data-static="true" title={`${stash.ref} · ${stash.branch}`}>
                <span data-wui="gitRowTitle">
                  <span data-wui="gitStashRef">{stash.ref}</span>
                  <span data-wui="gitRowName">{stash.message}</span>
                </span>
                <span data-wui="gitRowMeta"><span data-wui="gitRowSubject">{stash.branch}</span></span>
              </span>
              <span data-wui="gitRowActions">
                <button type="button" data-wui="gitTinyAction" onClick={() => { void run('stash-pop', { index: stash.index }) }}>
                  {t('git.changes.stash.pop')}
                </button>
                <button type="button" data-wui="gitTinyAction" onClick={() => { void run('stash-apply', { index: stash.index }) }}>
                  {t('git.changes.stash.apply')}
                </button>
                <button
                  type="button"
                  data-wui="gitTinyAction"
                  data-tone="danger"
                  onClick={() => {
                    void confirm({
                      title: t('git.changes.stash.drop.title'),
                      message: t('git.changes.stash.drop.message', { ref: stash.ref }),
                      confirmLabel: t('git.changes.stash.drop'),
                    }).then((yes) => { if (yes) void run('stash-drop', { index: stash.index }) })
                  }}
                >
                  {t('git.changes.stash.drop')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
