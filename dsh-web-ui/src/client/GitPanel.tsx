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
 * A project is not always one repository. A directory holding two packages that
 * each carry their own `.git` has no repository of its own, so the drawer asks
 * the host what the project holds and works on ONE of them: the first candidate
 * until the operator picks another in the header's switcher. Everything below —
 * the four tabs, the mutations, the journal — is about the SELECTED repository,
 * which is why the selection is a single `repoDir` and not a per-tab choice: a
 * branch list from one checkout beside a diff from another would be a page about
 * nothing.
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
  IconBranchOutline16, IconCheckOutline14, IconChevronDownOutline14,
  IconCloseOutline16, IconEllipsisOutline16,
  IconLoadingOutline16, IconRefreshOutline16, IconWarningOutline16,
  Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  GitAction, GitActionArgs, GitActionResult, GitError, GitOverview, GitRepoRef,
} from '../shared/gitwire.ts'
import type { NS } from './contract.ts'
import {
  discoverRepos, readBranches, readOverview, runAction,
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
  /** The PROJECT directory: the current session's project path. */
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
  // The project's repositories, and which one the drawer is about. `null` means
  // discovery has not answered yet — and since a project with no repository at
  // all is a real state whose repairs live in THIS panel (the init verb), the
  // fallback is the project directory itself rather than an empty drawer.
  const [repos, setRepos] = useState<readonly GitRepoRef[]>([])
  const [repoDir, setRepoDir] = useState<string | null>(null)
  /** True when the host found more repositories than it was willing to report. */
  const [truncated, setTruncated] = useState(false)
  /** Bumped by the refresh button and after an init, to re-ask what the project holds. */
  const [discovery, setDiscovery] = useState(0)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const activeDir = repoDir ?? dir

  // One generation for the whole drawer: the refresh button, a repository
  // switch, and a project change all bump it, and every in-flight read compares
  // against it before touching state.
  const generation = useRef(0)
  // The mutation queue: a ref-held promise chain, so `run` stays a stable
  // callback that never needs to re-create itself to see the latest tail.
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const confirmResolver = useRef<((value: boolean) => void) | null>(null)

  const bump = useCallback((): void => { setToken(current => current + 1) }, [])

  // What does this project hold? Asked once per project, once per refresh, and
  // once after an init. A failure here is NOT rendered on its own: the overview
  // read that follows names the same problem (`git-missing`, `no-directory`) in
  // the words the panel already uses, and a second error surface would say it
  // twice. The repositories are dropped so a stale list cannot outlive a failure.
  useEffect(() => {
    let cancelled = false
    setRepos([])
    setRepoDir(null)
    setTruncated(false)
    void discoverRepos(dir).then((answer) => {
      if (cancelled) return
      const found = answer.ok ? answer.data.repos : []
      setRepos(found)
      setTruncated(answer.ok && answer.data.truncated)
      // The host orders these shallowest first, with the project's own
      // repository ahead of the packages, so the first one is the answer an
      // operator would give: "this project's checkout, or the package it starts
      // with". Remembering a choice ACROSS opens was deliberately not built —
      // see the README.
      setRepoDir(found[0]?.root ?? dir)
    })
    return () => { cancelled = true }
  }, [dir, discovery])

  /**
   * Read the overview of the SELECTED repository — the one every read and every
   * mutation below is locked to — dropping the answer when a newer read has
   * started.
   *
   * Silent until discovery has answered. Without that, the first read would be
   * about the PROJECT directory, and on a project whose packages each own their
   * own repository — the case this mechanism exists for — that read fails and
   * paints "not a git repository" over a project that holds three of them. The
   * `repoDir` in the dependency list is what re-runs this once discovery
   * settles, including when it settles on the project directory itself: a
   * project with no repository anywhere is the state the init verb repairs.
   * @param announce - whether a failure should also raise the footer strip.
   */
  const loadOverview = useCallback(async (announce: boolean): Promise<void> => {
    if (repoDir === null) return
    generation.current += 1
    const gen = generation.current
    setLoading(true)
    const answer = await readOverview(activeDir)
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
  }, [activeDir, repoDir])

  useEffect(() => { void loadOverview(false) }, [loadOverview, token])

  // A different repository is a different tree: the previous one's status line
  // would be a sentence about a checkout the drawer is no longer showing.
  useEffect(() => { setStatus(null) }, [activeDir])

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
      const answer = await runAction(args === undefined ? { dir: activeDir, action } : { dir: activeDir, action, args })
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
      // `init` is the one action that changes the ANSWER to "what does this
      // project hold": the drawer has just become a repository where there was
      // none, so the repository list is re-read rather than left stale.
      if (action === 'init') setDiscovery(current => current + 1)
      // The command may have failed in git's own terms (a conflicted merge, a
      // rejected push) — the tree still changed, so every read is refreshed.
      bump()
      return answer.data
    })
    // The chain must survive a rejection, or one failed action would wedge
    // every later one behind a rejected promise.
    queue.current = task.catch(() => null)
    return task
  }, [activeDir, bump, t])

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

  /**
   * The repository switcher's entries: one per repository this project holds,
   * named and placed so two same-named packages can be told apart.
   */
  const repoItems = useMemo((): MenuEntry[] => {
    const entries: MenuEntry[] = [
      { type: 'label', id: 'repos', text: t('git.repo.menu', { n: repos.length }) },
      ...repos.map((repo): MenuEntry => ({
        id: repo.root,
        label: (
          <span data-wui="gitRepoOption">
            <span data-wui="gitRepoOptionName">{repo.name}</span>
            {/* `.` is the project directory itself: naming it would be a label
                that says nothing, and the name above already said it. */}
            {repo.relPath !== '.' && <span data-wui="gitRepoOptionPath">{repo.relPath}</span>}
          </span>
        ),
      })),
    ]
    if (truncated) entries.push({ type: 'label', id: 'more', text: t('git.repo.truncated') })
    return entries
  }, [repos, t, truncated])

  /** The repository name the header shows, from the read that succeeded. */
  const repoName = overview?.repo.name ?? (activeDir.split('/').pop() ?? activeDir)

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
            {/* ONE name element in both states, so the header reads the same
                whether or not it is clickable: with a single repository a menu
                of one would be an affordance with nothing behind it, and with
                several the name IS the switch. */}
            {repos.length > 1 ? (
              <Menu
                open={switcherOpen}
                anchor={(
                  <button
                    type="button"
                    data-wui="gitRepoSwitch"
                    aria-label={t('git.repo.switch')}
                    aria-haspopup="menu"
                    title={overview?.repo.root ?? activeDir}
                    onClick={() => { setSwitcherOpen(current => !current) }}
                  >
                    <span data-wui="gitRepoName">{repoName}</span>
                    <IconChevronDownOutline14 size={12} />
                  </button>
                )}
                items={repoItems}
                selectedId={activeDir}
                onSelect={(id) => {
                  setSwitcherOpen(false)
                  // Only a real change is a switch: re-selecting the repository
                  // already showing would re-run every read for the same answer.
                  if (id !== activeDir) setRepoDir(id)
                }}
                onClose={() => { setSwitcherOpen(false) }}
                portal
                dense
                align="start"
              />
            ) : (
              <span data-wui="gitRepoName" title={overview?.repo.root ?? activeDir}>{repoName}</span>
            )}
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
              onClick={() => {
                // A refresh re-asks the PROJECT too: a package that appeared
                // since the drawer opened is exactly what the operator is
                // fixing by pressing this (a `git init` in another terminal).
                setDiscovery(current => current + 1)
                void loadOverview(true)
                bump()
              }}
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
                  ? t('git.notRepo', { path: activeDir })
                  : overviewError.message}
              </span>
              <span data-wui="gitEmptyHint">
                {overviewError.code === 'not-a-repo'
                  ? t('git.notRepo.hint')
                  : overviewError.code === 'git-missing'
                    ? t('git.gitMissing.hint')
                    : null}
              </span>
              {/* A directory with no repository is not an error the operator
                  has to leave the page to fix: the drawer can create the
                  repository, which is exactly the state a brand-new project is
                  in. The verb is offered HERE, next to the sentence that names
                  the directory, so the fix is one click from the diagnosis. */}
              {overviewError.code === 'not-a-repo' && (
                <button
                  type="button"
                  data-wui="gitPrimaryButton"
                  disabled={busy}
                  onClick={() => {
                    setPrompt({
                      title: t('git.init.title'),
                      label: t('git.init.label'),
                      initialValue: 'main',
                      onSubmit: (branch) => {
                        void run('init', branch === '' ? {} : { branch }).then((result) => {
                          if (result?.ok === true) setStatus({ tone: 'ok', text: t('git.init.done') })
                        })
                      },
                    })
                  }}
                >
                  {t('git.init')}
                </button>
              )}
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
                  dir={activeDir}
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
                  dir={activeDir}
                  t={t}
                  token={token}
                  run={run}
                  confirm={confirm}
                  prompt={setPrompt}
                  overview={overview}
                />
              </div>
              <div data-wui="gitTabPane" data-hidden={tab !== 'history' || undefined}>
                <GitHistory dir={activeDir} t={t} token={token} />
              </div>
              <div data-wui="gitTabPane" data-hidden={tab !== 'records' || undefined}>
                <GitRecords dir={activeDir} t={t} token={token} />
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
