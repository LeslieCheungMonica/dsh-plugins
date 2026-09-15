/**
 * The 分支 tab: what branch HEAD is on, what else exists, and what can be done
 * to any of them.
 *
 * The roster is one read of `git for-each-ref`, so local and remote branches
 * arrive together and the panel splits them by `kind` rather than by two
 * requests that could disagree. Each row carries the two facts a branch
 * decision actually turns on — how far it has drifted from its upstream, and
 * what its tip commit says — because a branch list without them is a list of
 * names, and choosing between names is not a decision anyone can make.
 *
 * The current branch is a CARD rather than a row: it is the one entry whose
 * actions are not about moving somewhere, and mixing "switch to" with
 * "pull/push/new branch" in one list is how a click lands on the wrong verb.
 *
 * @module dsh-web-ui/client/GitBranches
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconBranchOutline16, IconChevronDownOutline14, IconChevronRightOutline14,
  IconLoadingOutline16, IconPlusOutline16, IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GitBranch, GitBranchList, GitError, GitOverview, GitRemote } from '../shared/gitwire.ts'
import type { NS } from './contract.ts'
import { readBranches } from './gitapi.ts'
import { GitRowMenu, type GitTabProps } from './GitPanel.tsx'
import { relativeTime } from './project.ts'

/** Props of the branches tab: the shared face plus the drawer's own overview. */
export type GitBranchesProps = GitTabProps & {
  /** The drawer's overview read, shared so this tab issues one request, not two. */
  readonly overview: GitOverview
}

/**
 * Copy text to the clipboard, tolerating a context that has no clipboard API
 * (an insecure origin exposes `navigator.clipboard` as undefined). A copy is a
 * convenience: it must never throw out of a menu handler.
 * @param text - the text to copy.
 */
function copy(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => { /* the operator can still select the name */ })
}

/**
 * The branch's name as this tab displays it: a remote-tracking ref keeps its
 * remote in the label (`origin/main`), because two remotes can hold the same
 * branch name and hiding the remote is how a push lands on the wrong one.
 * @param branch - the branch.
 * @returns the display name.
 */
function label(branch: GitBranch): string {
  return branch.name
}

/**
 * Render one commit instant as the compact relative phrase this list uses.
 * @param date - the ISO-8601 instant, as git reported it.
 * @param now - the current epoch milliseconds.
 * @param t - the translator.
 * @returns the phrase, or an empty string when git reported no usable date.
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
 * The local name a remote-tracking branch would be checked out as.
 * @param branch - the remote branch.
 * @returns the local branch name.
 */
function localNameOf(branch: GitBranch): string {
  const slash = branch.name.indexOf('/')
  return slash === -1 ? branch.name : branch.name.slice(slash + 1)
}

/**
 * Render one tracking chip pair: ahead, behind, gone.
 * @param props - the branch, its translator, and whether to show the upstream name.
 * @returns the chips, or null when there is nothing to say.
 */
function TrackChips({ branch, t, showUpstream }: {
  branch: GitBranch
  t: TranslateNS<typeof NS>
  showUpstream: boolean
}): ReactNode {
  const nothing = branch.ahead === 0 && branch.behind === 0 && !branch.gone
  if (nothing && !showUpstream) return null
  return (
    <span data-wui="gitTrackRow">
      {showUpstream && branch.gone && <span data-wui="gitTrack" data-tone="warn">{t('git.upstream.gone')}</span>}
      {branch.ahead > 0 && <span data-wui="gitTrack" data-tone="ahead">{t('git.ahead', { n: branch.ahead })}</span>}
      {branch.behind > 0 && <span data-wui="gitTrack" data-tone="behind">{t('git.behind', { n: branch.behind })}</span>}
    </span>
  )
}

/**
 * Render the branches tab.
 * @param props - the shared tab face plus the overview.
 * @returns the tab's element tree.
 */
export function GitBranches({ dir, t, token, run, confirm, prompt, overview }: GitBranchesProps): ReactNode {
  const [list, setList] = useState<GitBranchList | null>(null)
  const [error, setError] = useState<GitError | null>(null)
  const [loading, setLoading] = useState(true)
  const [branchesOpen, setBranchesOpen] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [remotesOpen, setRemotesOpen] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const generation = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    generation.current += 1
    const gen = generation.current
    setLoading(true)
    const answer = await readBranches(dir)
    if (gen !== generation.current) return
    setLoading(false)
    if (!answer.ok) {
      setList(null)
      setError(answer.error)
      return
    }
    setError(null)
    setList(answer.data)
    setNow(Date.now())
  }, [dir])

  useEffect(() => { void load() }, [load, token])

  /**
   * Check out one local branch.
   * @param branch - the branch to switch to.
   */
  const checkout = (branch: GitBranch): void => {
    if (branch.current) return
    void run('checkout', { ref: branch.name })
  }

  /**
   * The menu of one REMOTE row (the address), as opposed to one remote-tracking
   * branch row below it.
   * @returns the entries.
   */
  const remoteAddressItems = (): MenuEntry[] => [
    { id: 'set-url', label: t('git.remote.edit.title') },
    { id: 'rename', label: t('git.remote.rename.title') },
    { id: 'copy', label: t('git.remote.copy') },
    { id: 'remove', label: t('git.remote.remove') },
  ]

  /**
   * Handle one remote row menu selection.
   * @param remote - the row's remote.
   * @param id - the selected entry id.
   */
  const onRemoteRowSelect = (remote: GitRemote, id: string): void => {
    if (id === 'set-url') {
      prompt({
        title: t('git.remote.edit.title'),
        label: t('git.remote.url'),
        initialValue: remote.url,
        onSubmit: (url) => { void run('remote-set-url', { name: remote.name, url }) },
      })
      return
    }
    if (id === 'rename') {
      prompt({
        title: t('git.remote.rename.title'),
        label: t('git.remote.rename.name'),
        initialValue: remote.name,
        onSubmit: (to) => { void run('remote-rename', { name: remote.name, to }) },
      })
      return
    }
    if (id === 'copy') {
      copy(remote.url)
      return
    }
    void (async () => {
      const yes = await confirm({
        title: t('git.remote.remove.title'),
        message: t('git.remote.remove.message', { name: remote.name, url: remote.url }),
        confirmLabel: t('git.remote.remove'),
      })
      if (yes) void run('remote-remove', { name: remote.name })
    })()
  }

  /**
   * The menu of one local branch row.
   * @param branch - the row's branch.
   * @returns the entries.
   */
  const localItems = (branch: GitBranch): MenuEntry[] => {
    const entries: MenuEntry[] = []
    if (!branch.current) entries.push({ id: 'checkout', label: t('git.branch.checkout') })
    if (!branch.current) entries.push({ id: 'merge', label: t('git.branch.merge') })
    if (!branch.current) entries.push({ id: 'rebase', label: t('git.branch.rebase') })
    entries.push({ id: 'push', label: t('git.branch.push') })
    entries.push({ id: 'tag', label: t('git.branch.tag') })
    entries.push({ id: 'rename', label: t('git.branch.rename.title') })
    entries.push({ id: 'copy', label: t('git.branch.copy') })
    if (!branch.current) entries.push({ id: 'delete', label: t('git.branch.delete') })
    return entries
  }

  /**
   * Handle one local branch menu selection.
   * @param branch - the row's branch.
   * @param id - the selected entry id.
   */
  const onLocalSelect = (branch: GitBranch, id: string): void => {
    if (id === 'checkout') checkout(branch)
    else if (id === 'merge') void run('merge', { ref: branch.name })
    else if (id === 'rebase') void run('rebase', { ref: branch.name })
    else if (id === 'push') void run('push-branch', { name: branch.name, force: false })
    else if (id === 'copy') copy(branch.name)
    else if (id === 'tag') {
      prompt({
        title: t('git.tag.title'),
        label: t('git.tag.name'),
        initialValue: '',
        second: { label: t('git.tag.annotation'), initialValue: '' },
        onSubmit: (name, annotation) => {
          void run('tag-create', annotation === '' ? { name, ref: branch.name } : { name, annotation, ref: branch.name })
        },
      })
    } else if (id === 'rename') {
      prompt({
        title: t('git.branch.rename.title'),
        label: t('git.branch.rename.name'),
        initialValue: branch.name,
        onSubmit: (to) => { void run('rename-branch', { from: branch.name, to }) },
      })
    } else if (id === 'delete') {
      void (async () => {
        const yes = await confirm({
          title: t('git.branch.delete.title'),
          message: t('git.branch.delete.message', { name: branch.name }),
          confirmLabel: t('git.branch.delete.force'),
        })
        if (!yes) return
        // A plain `git branch -d` refuses an unmerged branch and explains why,
        // which is a better first answer than a force delete; the operator's
        // confirmation here authorises the FORCE, so `-D` is what follows it.
        void run('delete-branch', { name: branch.name, force: true })
      })()
    }
  }

  /**
   * The menu of one remote branch row.
   * @returns the entries.
   */
  const remoteItems = (): MenuEntry[] => [
    { id: 'checkout', label: t('git.branch.checkoutRemote') },
    { id: 'merge', label: t('git.branch.merge') },
    { id: 'copy', label: t('git.branch.copy') },
  ]

  /**
   * Handle one remote branch menu selection.
   * @param branch - the row's branch.
   * @param id - the selected entry id.
   */
  const onRemoteSelect = (branch: GitBranch, id: string): void => {
    if (id === 'checkout') {
      const name = localNameOf(branch)
      // The local name may already exist (a checked-out tracking branch): git
      // then refuses `-b` and this falls back to a plain checkout of the name.
      const taken = list?.local.some(local => local.name === name) === true
      if (taken) void run('checkout', { ref: name })
      else void run('create-branch', { name, startPoint: branch.name, checkout: true })
    } else if (id === 'merge') void run('merge', { ref: branch.name })
    else if (id === 'copy') copy(branch.name)
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

  if (list === null) {
    return <div data-wui="gitEmpty"><IconLoadingOutline16 size={16} /><span>{t('git.loading')}</span></div>
  }

  const head = overview.head
  const branchLabel = head.detached ? t('git.detached') : (head.branch ?? t('git.unborn'))

  return (
    <div data-wui="gitSection">
      <section data-wui="gitCard">
        <div data-wui="gitCardHead">
          <IconBranchOutline16 size={14} />
          <span data-wui="gitCardLabel">{t('git.current')}</span>
          <span data-wui="gitBranchName" title={branchLabel}>{branchLabel}</span>
        </div>
        <div data-wui="gitCardMeta">
          {head.upstream === null
            ? <span data-wui="gitTrack" data-tone="muted">{t('git.upstream.none')}</span>
            : <span data-wui="gitTrack" data-tone="muted" title={head.upstream}>↑ {head.upstream}</span>}
          {head.ahead > 0 && <span data-wui="gitTrack" data-tone="ahead">{t('git.ahead', { n: head.ahead })}</span>}
          {head.behind > 0 && <span data-wui="gitTrack" data-tone="behind">{t('git.behind', { n: head.behind })}</span>}
        </div>
        {head.subject !== '' && <div data-wui="gitCardSubject" title={head.subject}>{head.subject}</div>}
      </section>

      <div data-wui="gitSectionHead">
        <span>{t('git.local.count', { n: list.local.length })}</span>
        <button
          type="button"
          data-wui="gitTinyAction"
          onClick={() => {
            prompt({
              title: t('git.branch.new.title'),
              label: t('git.branch.new.name'),
              initialValue: '',
              second: { label: t('git.branch.new.start'), initialValue: '' },
              onSubmit: (name, startPoint) => {
                void run('create-branch', startPoint === ''
                  ? { name, checkout: true }
                  : { name, startPoint, checkout: true })
              },
            })
          }}
        >
          <IconPlusOutline16 size={12} />
          {t('git.branch.new')}
        </button>
      </div>

      {list.local.length === 0 && <div data-wui="gitNote">{t('git.local.empty')}</div>}

      <ul data-wui="gitRows" aria-label={t('git.branch.rows.aria')}>
        {list.local.map(branch => (
          <li key={branch.ref} data-wui="gitRow" data-current={branch.current || undefined}>
            <button
              type="button"
              data-wui="gitRowMain"
              disabled={branch.current || loading}
              title={branch.subject}
              onClick={() => { checkout(branch) }}
            >
              <span data-wui="gitRowTitle">
                <span data-wui="gitBranchDot" data-current={branch.current || undefined} aria-hidden="true" />
                <span data-wui="gitRowName">{label(branch)}</span>
                <TrackChips branch={branch} t={t} showUpstream />
              </span>
              <span data-wui="gitRowMeta">
                <span data-wui="gitRowSubject">{branch.subject === '' ? t('git.unborn') : branch.subject}</span>
                <span data-wui="gitRowTime" title={`${branch.shortSha} · ${branch.author}`}>
                  {relative(branch.date, now, t)}
                </span>
              </span>
            </button>
            <GitRowMenu
              label={t('git.branch.actions', { name: branch.name })}
              items={localItems(branch)}
              onSelect={(id) => { onLocalSelect(branch, id) }}
              open={menuFor === branch.ref}
              setOpen={(open) => { setMenuFor(open ? branch.ref : null) }}
              t={t}
            />
          </li>
        ))}
      </ul>

      {/* Remotes and remote-tracking branches are two different facts — where a
          push GOES versus what has been fetched — so they are two sections, and
          the address is editable right here. A repository with no remote is the
          normal state of a new project, so the empty section is an invitation
          rather than a note. */}
      <section data-wui="gitSection" data-tone="remotes">
        <div data-wui="gitSectionHead">
          <button
            type="button"
            data-wui="gitDisclosure"
            aria-expanded={remotesOpen}
            onClick={() => { setRemotesOpen(open => !open) }}
          >
            {remotesOpen ? <IconChevronDownOutline14 size={12} /> : <IconChevronRightOutline14 size={12} />}
            {t('git.remotes.count', { n: overview.remotes.length })}
          </button>
          <button
            type="button"
            data-wui="gitTinyAction"
            onClick={() => {
              prompt({
                title: t('git.remote.add.title'),
                label: t('git.remote.url'),
                initialValue: '',
                second: { label: t('git.remote.add.name'), initialValue: 'origin' },
                onSubmit: (url, name) => { void run('remote-add', { name: name === '' ? 'origin' : name, url }) },
              })
            }}
          >
            <IconPlusOutline16 size={12} />
            {t('git.remote.add')}
          </button>
        </div>
        {remotesOpen && overview.remotes.length === 0 && (
          <>
            <div data-wui="gitNote">{t('git.remote.none')}</div>
            <div data-wui="gitNote" data-tone="hint">{t('git.remote.auth.hint')}</div>
          </>
        )}
        {remotesOpen && overview.remotes.length > 0 && (
          <>
            <ul data-wui="gitRows" aria-label={t('git.remote.title')}>
              {overview.remotes.map(remote => (
                <li key={remote.name} data-wui="gitRow">
                  <span data-wui="gitRowMain" data-static="true" title={remote.url}>
                    <span data-wui="gitRowTitle">
                      <span data-wui="gitRemoteName">{remote.name}</span>
                      <span data-wui="gitRowName" data-muted="true">{remote.url}</span>
                    </span>
                  </span>
                  <GitRowMenu
                    label={t('git.branch.actions', { name: remote.name })}
                    items={remoteAddressItems()}
                    onSelect={(id) => { onRemoteRowSelect(remote, id) }}
                    open={menuFor === `remote:${remote.name}`}
                    setOpen={(open) => { setMenuFor(open ? `remote:${remote.name}` : null) }}
                    t={t}
                  />
                </li>
              ))}
            </ul>
            <div data-wui="gitNote" data-tone="hint">{t('git.remote.auth.hint')}</div>
          </>
        )}
      </section>

      <div data-wui="gitSectionHead">
        <button
          type="button"
          data-wui="gitDisclosure"
          aria-expanded={branchesOpen}
          onClick={() => { setBranchesOpen(open => !open) }}
        >
          {branchesOpen ? <IconChevronDownOutline14 size={12} /> : <IconChevronRightOutline14 size={12} />}
          {t('git.remote.count', { n: list.remote.length })}
        </button>
      </div>

      {branchesOpen && (
        <>
          {list.remote.length === 0 && overview.remotes.length > 0 && (
            <div data-wui="gitNote">{t('git.remote.empty')}</div>
          )}
          <ul data-wui="gitRows" aria-label={t('git.branch.rows.aria')}>
            {list.remote.map(branch => (
              <li key={branch.ref} data-wui="gitRow">
                <button
                  type="button"
                  data-wui="gitRowMain"
                  title={branch.subject}
                  onClick={() => { onRemoteSelect(branch, 'checkout') }}
                >
                  <span data-wui="gitRowTitle">
                    <span data-wui="gitRowName" data-muted="true">{label(branch)}</span>
                  </span>
                  <span data-wui="gitRowMeta">
                    <span data-wui="gitRowSubject">{branch.subject}</span>
                    <span data-wui="gitRowTime" title={`${branch.shortSha} · ${branch.author}`}>
                      {relative(branch.date, now, t)}
                    </span>
                  </span>
                </button>
                <GitRowMenu
                  label={t('git.branch.actions', { name: branch.name })}
                  items={remoteItems()}
                  onSelect={(id) => { onRemoteSelect(branch, id) }}
                  open={menuFor === branch.ref}
                  setOpen={(open) => { setMenuFor(open ? branch.ref : null) }}
                  t={t}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
