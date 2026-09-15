/**
 * The git drawer: a right-hand panel that answers the four questions an
 * operator actually has about a checkout.
 *
 * | Tab | Question |
 * | --- | --- |
 * | 分支 | What branch am I on, what else is here, and what can I do to them? |
 * | 改动 | What is dirty, what is stashed, and what am I about to commit? |
 * | 历史 | What landed recently, and what did it touch? |
 * | 操作记录 | What has this panel actually run, and what did git say back? |
 *
 * Three structural decisions carry the whole component:
 *
 * 1. **The drawer owns the mutations, and there is exactly one of them in
 *    flight.** `run` is the single callable every tab receives: it serializes
 *    through a ref-held promise chain, bumps the read token AFTER the command
 *    settles, and records the outcome for the footer. A tab therefore never
 *    reasons about concurrency, and two fast clicks on "delete branch" cannot
 *    produce two commands whose results interleave into a stale list.
 * 2. **Reads are generation-guarded.** Each read carries the generation it was
 *    issued in and drops its answer if a newer one has started, so a slow fetch
 *    landing after a branch switch can never paint the previous repository
 *    state back onto the drawer.
 * 3. **Destructive actions ask first, in the panel's own dialog.** The host
 *    refuses what git refuses; the confirmation is the operator's, and it is
 *    asked in the panel with the exact path or branch in the sentence, not in a
 *    generic browser modal.
 *
 * The component renders through a portal onto `document.body`: the session
 * header it is mounted from is inside a grid whose tracks animate, and a
 * `position: fixed` drawer inside an animating track would move with it.
 *
 * @module dsh-web-ui/client/GitPanel
 */
import { createPortal } from 'react-dom'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconBranchOutline16, IconCheckOutline14, IconCloseOutline16, IconEllipsisOutline16,
  IconLoadingOutline16, IconRefreshOutline16, IconWarningOutline16,
  Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GitAction, GitActionArgs, GitActionResult, GitError, GitOverview } from '../shared/gitwire.ts'
import type { NS } from './contract.ts'
import {
  readBranches, readOverview, runAction,
} from './gitapi.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { TextPromptDialog, type PromptSecondField } from './TextPromptDialog.tsx'
import { GitBranches } from './GitBranches.tsx'
import { GitChanges } from './GitChanges.tsx'
import { GitHistory } from './GitHistory.tsx'
import { GitRecords } from './GitRecords.tsx'

/** Which tab the drawer is showing. */
type GitTab = 'branches' | 'changes' | 'history' | 'records'

/** The tab strip, in render order. */
const TABS: readonly GitTab[] = ['branches', 'changes', 'history', 'records']

/** One requested confirmation. */
export interface Confirmation {
  /** Dialog title. */
  readonly title: string
  /** Body copy, naming the exact branch or path. */
  readonly message: string
  /** The confirming button's label. */
  readonly confirmLabel: string
}

/** One prompt the drawer should raise on a tab's behalf. */
export interface GitPromptRequest {
  /** Dialog title. */
  readonly title: string
  /** The primary field's placeholder and aria label. */
  readonly label: string
  /** The primary field's starting value. */
  readonly initialValue: string
  /** An optional second field. */
  readonly second?: PromptSecondField
  /** Called with both trimmed values when the operator confirms. */
  readonly onSubmit: (value: string, second: string) => void
}

/** What every tab receives, whether or not it mutates anything. */
export interface GitTabCommon {
  /** The work-tree directory this drawer is about. */
  readonly dir: string
  /** The plugin's translator. */
  readonly t: TranslateNS<typeof NS>
  /**
   * Bumped after every settled mutation and by the refresh button. A tab keys
   * its reads on it, so the tab re-reads when and only when the tree changed.
   */
  readonly token: number
}

/**
 * The panel's shared business face, handed to every MUTATING tab. The two
 * read-only tabs (history and the journal) take `GitTabCommon` alone: a
 * component that cannot change the tree should not hold the buttons that do.
 */
export interface GitTabProps extends GitTabCommon {
  /**
   * Run one mutation through the drawer's single-flight queue.
   * @returns the action's outcome, or null when rejecting it left the tree untouched.
   */
  readonly run: (action: GitAction, args?: GitActionArgs) => Promise<GitActionResult | null>
  /** Ask the operator to confirm; resolves false when they decline. */
  readonly confirm: (request: Confirmation) => Promise<boolean>
  /** Raise a text prompt owned by the drawer, so only one can ever be open. */
  readonly prompt: (request: GitPromptRequest) => void
}

/** Props of the drawer itself. */
export interface GitPanelProps {
  /** The work-tree directory: the current session's project path. */
  readonly dir: string
  /** The plugin's translator. */
  readonly t: TranslateNS<typeof NS>
  /** Close the drawer. */
  readonly onClose: () => void
}

/**
 * Turn a failed response into the sentence the drawer shows.
 * @param response - the failure arm.
 * @param t - the translator.
 * @returns the message, plus the code so the caller can add a hint.
 */
function describe(response: { readonly error: GitError }): string {
  return response.error.message
}

/**
 * Render the git drawer.
 * @param props - the directory, the translator, and the close action.
 * @returns the portal-mounted drawer.
 */
export function GitPanel({ dir, t, onClose }: GitPanelProps): ReactNode {
  const [tab, setTab] = useState<GitTab>('branches')
  const [token, setToken] = useState(0)
  const [overview, setOverview] = useState<GitOverview | null>(null)
  const [overviewError, setOverviewError] = useState<GitError | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [prompt, setPrompt] = useState<GitPromptRequest | null>(null)
  const [asked, setAsked] = useState<Confirmation | null>(null)

  // One generation for the whole drawer: the refresh button and a project
  // change both bump it, and every in-flight read compares against it before
  // touching state.
  const generation = useRef(0)
  // The mutation queue: a ref-held promise chain, so `run` stays a stable
  // callback that never needs to re-create itself to see the latest tail.
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const confirmResolver = useRef<((value: boolean) => void) | null>(null)

  const bump = useCallback((): void => { setToken(current => current + 1) }, [])

  /**
   * Read the overview, dropping the answer when a newer read has started.
   * @param announce - whether a failure should also raise the footer strip.
   */
  const loadOverview = useCallback(async (announce: boolean): Promise<void> => {
    generation.current += 1
    const gen = generation.current
    setLoading(true)
    const answer = await readOverview(dir)
    if (gen !== generation.current) return
    setLoading(false)
    if (!answer.ok) {
      setOverview(null)
      setOverviewError(answer.error)
      if (announce) setStatus({ tone: 'error', text: describe(answer) })
      return
    }
    setOverviewError(null)
    setOverview(answer.data)
  }, [dir])

  useEffect(() => { void loadOverview(false) }, [loadOverview, token])

  // A different project is a different repository: the previous one's status
  // line would be a sentence about a tree the drawer is no longer showing.
  useEffect(() => { setStatus(null) }, [dir])

  // Escape closes the drawer, exactly as it closes the shipped popovers. The
  // listener is on the document because focus may sit anywhere in the page.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (prompt !== null || asked !== null) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [asked, onClose, prompt])

  /**
   * Ask the operator to confirm, resolving false when they decline or close.
   * @param request - the confirmation to show.
   * @returns whether they confirmed.
   */
  const confirm = useCallback((request: Confirmation): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      confirmResolver.current = resolve
      setAsked(request)
    }), [])

  /**
   * Settle the open confirmation.
   * @param value - the operator's answer.
   */
  const settleConfirmation = (value: boolean): void => {
    setAsked(null)
    const resolve = confirmResolver.current
    confirmResolver.current = null
    resolve?.(value)
  }

  const run = useCallback((action: GitAction, args?: GitActionArgs): Promise<GitActionResult | null> => {
    const task = queue.current.then(async (): Promise<GitActionResult | null> => {
      setBusy(true)
      setStatus(null)
      const answer = await runAction(args === undefined ? { dir, action } : { dir, action, args })
      setBusy(false)
      if (!answer.ok) {
        setStatus({ tone: 'error', text: describe(answer) })
        // A refused action changes nothing, so the reads are NOT invalidated:
        // re-reading here would make the list flicker for no new information.
        return null
      }
      setStatus({
        tone: answer.data.ok ? 'ok' : 'error',
        text: answer.data.ok
          ? t('git.actions.done', { command: answer.data.command })
          : t('git.actions.failed', { command: answer.data.command }),
      })
      // The command may have failed in git's own terms (a conflicted merge, a
      // rejected push) — the tree still changed, so every read is refreshed.
      bump()
      return answer.data
    })
    // The chain must survive a rejection, or one failed action would wedge
    // every later one behind a rejected promise.
    queue.current = task.catch(() => null)
    return task
  }, [bump, dir, t])

  const head = overview?.head
  const currentBranch = head === undefined
    ? ''
    : head.detached ? t('git.detached') : (head.branch ?? t('git.unborn'))

  // A branch with no upstream has nowhere to push: `git push` would fail with
  // a hint the operator then has to translate into a second click, so the
  // first click already carries `--set-upstream`.
  const quickPush = useCallback((): void => {
    const upstream = head?.upstream ?? null
    void run('push', upstream === null ? { setUpstream: true } : {})
  }, [head?.upstream, run])

  const moreItems = useMemo((): MenuEntry[] => {
    const entries: MenuEntry[] = [
      { id: 'pull-rebase', label: `${t('git.quick.pull')} (--rebase)` },
      { id: 'fetch-prune', label: `${t('git.quick.fetch')} (--prune)` },
      { id: 'push-tags', label: `${t('git.quick.push')} --tags` },
      { id: 'tag', label: t('git.tag.title') },
    ]
    if (overview?.repo.operation != null) {
      entries.push({ id: 'abort', label: t('git.conflict.abort', { op: t(`git.op.${overview.repo.operation}`) }) })
    }
    return entries
  }, [overview?.repo.operation, t])

  const [moreOpen, setMoreOpen] = useState(false)

  const drawer = (
    // The layer is a positioning container, NOT a scrim: it is click-through, so
    // the drawer can stay open while the operator reads or types behind it. A
    // dismiss-on-outside-click overlay would make the panel useless for the one
    // workflow it exists for — watching the tree while working in the session.
    <div data-wui="gitLayer">
      <aside
        data-wui="gitDrawer"
        role="complementary"
        aria-label={t('git.title')}
      >
        <header data-wui="gitHeader">
          <span data-wui="gitMark" aria-hidden="true"><IconBranchOutline16 size={16} /></span>
          <div data-wui="gitHeaderText">
            <span data-wui="gitRepoName" title={overview?.repo.root ?? dir}>
              {overview?.repo.name ?? dir.split('/').pop() ?? dir}
            </span>
            <span data-wui="gitBranchLine">
              <span data-wui="gitBranchChip" data-detached={head?.detached === true || undefined}>
                {loading && overview === null ? t('git.loading') : currentBranch}
              </span>
              {head !== null && head !== undefined && head.ahead > 0 && (
                <span data-wui="gitTrack" data-tone="ahead">{t('git.ahead', { n: head.ahead })}</span>
              )}
              {head !== null && head !== undefined && head.behind > 0 && (
                <span data-wui="gitTrack" data-tone="behind">{t('git.behind', { n: head.behind })}</span>
              )}
              {head !== null && head !== undefined && head.upstream === null && !head.unborn && !head.detached && (
                <span data-wui="gitTrack" data-tone="muted">{t('git.upstream.none')}</span>
              )}
            </span>
          </div>
          <Tooltip label={t('git.refresh')} delayMs={400}>
            <button
              type="button"
              data-wui="iconButton"
              aria-label={t('git.refresh')}
              aria-busy={loading || busy || undefined}
              onClick={() => { void loadOverview(true); bump() }}
            >
              <IconRefreshOutline16 size={14} />
            </button>
          </Tooltip>
          <Tooltip label={t('git.close')} delayMs={400}>
            <button type="button" data-wui="iconButton" aria-label={t('git.close')} onClick={onClose}>
              <IconCloseOutline16 size={14} />
            </button>
          </Tooltip>
        </header>

        {overview !== null && (
          <div data-wui="gitQuick">
            <button type="button" data-wui="gitQuickButton" disabled={busy} onClick={() => { void run('fetch', { prune: true }) }}>
              {t('git.quick.fetch')}
            </button>
            <button
              type="button"
              data-wui="gitQuickButton"
              disabled={busy || head?.upstream == null}
              title={head?.upstream == null ? t('git.upstream.none') : undefined}
              onClick={() => { void run('pull') }}
            >
              {t('git.quick.pull')}
            </button>
            <button type="button" data-wui="gitQuickButton" disabled={busy} onClick={quickPush}>
              {t('git.quick.push')}
            </button>
            <Menu
              open={moreOpen}
              anchor={(
                <button
                  type="button"
                  data-wui="iconButton"
                  aria-label={t('git.quick.more')}
                  aria-haspopup="menu"
                  onClick={() => { setMoreOpen(current => !current) }}
                >
                  <IconEllipsisOutline16 size={14} />
                </button>
              )}
              items={moreItems}
              onSelect={(id) => {
                setMoreOpen(false)
                if (id === 'pull-rebase') void run('pull', { rebase: true })
                else if (id === 'fetch-prune') void run('fetch', { prune: true })
                else if (id === 'push-tags') void run('push', { tags: true })
                else if (id === 'tag') setPrompt({
                  title: t('git.tag.title'),
                  label: t('git.tag.name'),
                  initialValue: '',
                  second: { label: t('git.tag.annotation'), initialValue: '' },
                  onSubmit: (name, annotation) => {
                    setPrompt(null)
                    void run('tag-create', annotation === '' ? { name } : { name, annotation })
                  },
                })
                else if (id === 'abort') {
                  void confirm({
                    title: t('git.op.abort.title'),
                    message: t('git.op.abort.message', { op: t(`git.op.${overview?.repo.operation ?? 'merge'}`) }),
                    confirmLabel: t('git.confirm'),
                  }).then((yes) => { if (yes) void run('abort') })
                }
              }}
              onClose={() => { setMoreOpen(false) }}
              portal
              dense
              align="end"
            />
          </div>
        )}

        {overview?.repo.operation != null && (
          <div data-wui="gitAlert" data-tone="warn" role="status">
            <IconWarningOutline16 size={14} />
            <span>{t('git.conflict.hint', { op: t(`git.op.${overview.repo.operation}`) })}</span>
          </div>
        )}

        <nav data-wui="gitTabs" role="tablist">
          {TABS.map(entry => (
            <button
              key={entry}
              type="button"
              role="tab"
              data-wui="gitTab"
              aria-selected={tab === entry}
              data-active={tab === entry || undefined}
              onClick={() => { setTab(entry) }}
            >
              {t(`git.tab.${entry}`)}
              {entry === 'changes' && overview !== null && overview.counts.staged > 0 && (
                <span data-wui="gitCount">{overview.counts.staged}</span>
              )}
            </button>
          ))}
        </nav>

        <div data-wui="gitBody">
          {overviewError !== null && (
            <div data-wui="gitEmpty" data-tone="error" role="status">
              <IconWarningOutline16 size={16} />
              <span data-wui="gitEmptyTitle">
                {overviewError.code === 'not-a-repo'
                  ? t('git.notRepo', { path: dir })
                  : overviewError.message}
              </span>
              <span data-wui="gitEmptyHint">
                {overviewError.code === 'not-a-repo'
                  ? t('git.notRepo.hint')
                  : overviewError.code === 'git-missing'
                    ? t('git.gitMissing.hint')
                    : null}
              </span>
              <button type="button" data-wui="gitQuickButton" onClick={() => { void loadOverview(true) }}>
                {t('git.retry')}
              </button>
            </div>
          )}

          {overviewError === null && loading && overview === null && (
            <div data-wui="gitEmpty"><IconLoadingOutline16 size={16} /><span>{t('git.loading')}</span></div>
          )}

          {overviewError === null && overview !== null && (
            <div data-wui="gitTabHost" data-tab={tab}>
              {/* Every tab stays MOUNTED while the drawer is open: a commit box
                  with a half-typed message must survive a look at the branches,
                  which unmounting on tab change would silently discard. */}
              <div data-wui="gitTabPane" data-hidden={tab !== 'branches' || undefined}>
                <GitBranches
                  dir={dir}
                  t={t}
                  token={token}
                  run={run}
                  confirm={confirm}
                  overview={overview}
                  prompt={setPrompt}
                />
              </div>
              <div data-wui="gitTabPane" data-hidden={tab !== 'changes' || undefined}>
                <GitChanges
                  dir={dir}
                  t={t}
                  token={token}
                  run={run}
                  confirm={confirm}
                  prompt={setPrompt}
                  overview={overview}
                />
              </div>
              <div data-wui="gitTabPane" data-hidden={tab !== 'history' || undefined}>
                <GitHistory dir={dir} t={t} token={token} />
              </div>
              <div data-wui="gitTabPane" data-hidden={tab !== 'records' || undefined}>
                <GitRecords dir={dir} t={t} token={token} />
              </div>
            </div>
          )}
        </div>

        <footer data-wui="gitFooter">
          {busy && <span data-wui="gitFooterBusy"><IconLoadingOutline16 size={12} />{t('git.actions.running')}</span>}
          {!busy && status !== null && (
            <span data-wui="gitFooterStatus" data-tone={status.tone} title={status.text}>
              {status.tone === 'ok' ? <IconCheckOutline14 size={12} /> : <IconWarningOutline16 size={12} />}
              <span data-wui="gitFooterText">{status.text}</span>
            </span>
          )}
          {!busy && status === null && overview !== null && (
            <span data-wui="gitFooterIdle">
              {overview.counts.staged + overview.counts.modified + overview.counts.untracked + overview.counts.conflicted === 0
                ? t('git.changes.clean')
                : t('git.unstaged.count', { n: overview.counts.modified + overview.counts.staged + overview.counts.untracked })}
            </span>
          )}
        </footer>
      </aside>

      <ConfirmDialog
        open={asked !== null}
        title={asked?.title ?? ''}
        message={asked?.message ?? ''}
        confirmLabel={asked?.confirmLabel ?? t('git.confirm')}
        cancelLabel={t('git.cancel')}
        busy={false}
        onConfirm={() => { settleConfirmation(true) }}
        onClose={() => { settleConfirmation(false) }}
      />

      <TextPromptDialog
        open={prompt !== null}
        title={prompt?.title ?? ''}
        label={prompt?.label ?? ''}
        initialValue={prompt?.initialValue ?? ''}
        {...(prompt?.second === undefined ? {} : { second: prompt.second })}
        confirmLabel={t('git.confirm')}
        cancelLabel={t('git.cancel')}
        busy={false}
        onSubmit={(value, second) => {
          const request = prompt
          setPrompt(null)
          request?.onSubmit(value, second)
        }}
        onClose={() => { setPrompt(null) }}
      />
    </div>
  )

  return createPortal(drawer, document.body)
}

/**
 * One row's trailing "more" button plus its menu: the shared shape of every
 * per-item action list in this drawer.
 * @param props - the accessible label, the entries, the handler, and its open state.
 * @returns the trigger and its menu.
 */
export function GitRowMenu({ label, items, onSelect, open, setOpen, t }: {
  label: string
  items: readonly MenuEntry[]
  onSelect: (id: string) => void
  open: boolean
  setOpen: (open: boolean) => void
  t: TranslateNS<typeof NS>
}): ReactNode {
  return (
    <Menu
      open={open}
      anchor={(
        <button
          type="button"
          data-wui="gitRowAction"
          aria-label={label}
          aria-haspopup="menu"
          title={t('git.more')}
          onClick={(event) => { event.stopPropagation(); setOpen(!open) }}
        >
          <IconEllipsisOutline16 size={14} />
        </button>
      )}
      items={[...items]}
      onSelect={(id) => { setOpen(false); onSelect(id) }}
      onClose={() => { setOpen(false) }}
      portal
      dense
      align="end"
    />
  )
}
