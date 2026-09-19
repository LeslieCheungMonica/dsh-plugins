/**
 * The Feishu folder panel: the column's lower half.
 *
 * Its subject is ONE folder — the folder this deployment created for the
 * project when the project was created. That is the whole point of the panel:
 * a project's deliverables land in Feishu in the folder named after the
 * project, so the column shows that folder's contents rather than a knowledge
 * base the operator has to navigate to by hand.
 *
 * It answers four questions in order, and each answer is rendered where it
 * matters rather than as a generic spinner:
 *
 * 1. **Which project?** — nothing selected means nothing to show, so the panel
 *    says so rather than reading a folder that belongs to no one.
 * 2. **Which folder?** — the host resolves it from the project's record, and
 *    when the record has none it looks in the archive for a folder of the
 *    project's name. Three outcomes are states rather than errors, and each gets
 *    its own affordance: a folder (browse it), none (create it, or point the
 *    project at one that exists), and several (choose one — Feishu permits two
 *    folders with the same name, so only the operator knows which is theirs).
 * 3. **Who is signed in?** — the header strip shows the `lark-cli` user (name +
 *    avatar, `open_id` on hover), so "the login worked" is a visible fact rather
 *    than an assumption, and the project's folder name sits beside it as the
 *    link that opens that folder in Feishu.
 * 4. **What is in here?** — one lazy level of entries per expansion. A subfolder
 *    (or a shortcut into one) expands; a document or file opens in Feishu.
 *
 * Only loaded levels are rendered, so a deep tree costs one request per opened
 * directory, and every request carries the generation it was issued in: a reply
 * that lands after a refresh or a project switch is dropped instead of painting
 * another project's tree into this one.
 *
 * @module dsh-web-ui/client/LarkDocsPanel
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconRefreshOutline16,
  IconRightUpOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './contract.ts'
import {
  attachProjectFolder, createProjectFolder, folderTokenFromInput, readLarkFiles,
  readLarkState, readProjectFolder,
} from './larkapi.ts'
import type {
  FolderResolution, LarkEntry, LarkError, LarkResult, LarkState,
} from './larkapi.ts'
import { feishuFailureHint } from './projectFlow.ts'
import { LarkLoginDialog } from './LarkLoginDialog.tsx'

/** Props: the project this panel is about, and the column's copy seat. */
export interface LarkDocsPanelProps {
  /** The plugin's translator (namespace `webui`). */
  readonly t: TranslateNS<typeof NS>
  /**
   * The project the column is scoped to, or undefined when none is selected.
   *
   * Only these two fields travel: the panel addresses a project by its PATH (the
   * record's key and what the host's routes take) and names its folder after the
   * TITLE (what the sidebar shows and what the archive is searched for).
   */
  readonly project: { readonly path: string; readonly title: string } | undefined
  /**
   * Show a link in the GUI's web sidebar instead of a new tab, when one is
   * mounted. Absent on a deployment without `my-sider`, and the panel then opens
   * a tab exactly as it always did.
   */
  readonly openInSidebar?: ((url: string) => boolean) | undefined
}

/** One lazily loaded level of the tree, keyed by the folder token it lists. */
interface Level {
  /** `loading` covers both the first read and a "load more" read. */
  readonly status: 'loading' | 'ready' | 'error'
  /** Entries loaded so far; kept across a failed "load more". */
  readonly nodes: readonly LarkEntry[]
  /** Whether Feishu has another page for this level. */
  readonly hasMore: boolean
  /** Token to fetch that page. */
  readonly pageToken: string | null
  /** The failure of the last read, when it failed. */
  readonly error: LarkError | null
}

/** Short type chips, language-neutral so one table serves both dictionaries. */
const TYPE_BADGES: Record<string, string> = {
  folder: 'DIR',
  doc: 'DOC',
  docx: 'DOC',
  sheet: 'SHT',
  bitable: 'BIT',
  slides: 'PPT',
  mindnote: 'MIND',
  file: 'FILE',
  shortcut: 'LINK',
}

/** One indentation step per tree level, in pixels. */
const INDENT_PX = 11

/**
 * Indentation style of one level's rows.
 * @param depth - the level's depth.
 * @returns the inline style (indentation is a computed fact, not a class).
 */
function indent(depth: number): { paddingLeft: number } {
  return { paddingLeft: 4 + depth * INDENT_PX }
}

/**
 * Pick the chip text for an entry.
 * @param entry - the entry.
 * @returns a short type label.
 */
function badgeOf(entry: LarkEntry): string {
  return TYPE_BADGES[entry.type] ?? (entry.expandToken === '' ? 'FILE' : 'DIR')
}

/**
 * Message text of an unknown throw.
 * @param reason - the caught value.
 * @returns display text.
 */
function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * Open one Feishu link: inside the GUI when a web sidebar is available, else in
 * a new tab.
 *
 * The sidebar is preferred because a Feishu document is something a reader wants
 * BESIDE the conversation — checking the folder while a session works in it — and
 * `my-sider`'s panel loads it directly, so the browser's own Feishu session is
 * what signs the page in.
 *
 * `noopener,noreferrer` matters for the fallback: the target is a remote tenant,
 * and the panel should not hand it a handle on this window.
 * @param url - the link the host built.
 * @param openInSidebar - the capability, absent on a deployment without one.
 */
function openUrl(url: string, openInSidebar?: (url: string) => boolean): void {
  if (url === '') return
  if (openInSidebar?.(url) === true) return
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * Render the Feishu folder panel.
 * @param props - the project and the copy seat.
 * @returns the panel element tree.
 */
export function LarkDocsPanel({ t, project, openInSidebar }: LarkDocsPanelProps): ReactNode {
  const path = project?.path ?? ''
  const title = project?.title ?? ''

  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [identity, setIdentity] = useState<LarkState | null>(null)
  const [error, setError] = useState<LarkError | null>(null)
  const [resolution, setResolution] = useState<FolderResolution | null>(null)
  const [levels, setLevels] = useState<Record<string, Level>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  /** A create or an attach is in flight. */
  const [working, setWorking] = useState(false)
  /** The last create/attach failure, rendered where it happened. */
  const [actionError, setActionError] = useState<LarkError | null>(null)
  /** Whether the "paste a folder link" input is open. */
  const [attachOpen, setAttachOpen] = useState(false)
  const [attachText, setAttachText] = useState('')
  const [avatarFailed, setAvatarFailed] = useState(false)
  /**
   * The scopes the login dialog is asking for, or null while it is closed.
   *
   * The SCOPES are the dialog's argument rather than a boolean, because they are
   * what the failure named: opening the dialog for a missing scope asks for that
   * scope, and opening it for a missing login asks for the host's own set.
   */
  const [loginScopes, setLoginScopes] = useState<readonly string[] | null>(null)

  // One generation for the whole panel: a refresh or a project switch bumps it,
  // and every in-flight read compares against it before touching state.
  const generation = useRef(0)

  /**
   * Read one folder's page and store it under that folder's token.
   * @param key - the folder token to list.
   * @param pageToken - the page to append, or undefined for the first page.
   * @param gen - the generation this read belongs to.
   * @param refresh - whether the host's caches should be dropped first.
   */
  const loadLevel = useCallback(async (
    key: string,
    pageToken: string | undefined,
    gen: number,
    refresh: boolean,
  ): Promise<void> => {
    setLevels((previous) => {
      const current = previous[key]
      return {
        ...previous,
        [key]: {
          status: 'loading',
          nodes: current?.nodes ?? [],
          hasMore: current?.hasMore ?? false,
          pageToken: current?.pageToken ?? null,
          error: null,
        },
      }
    })
    const result: LarkResult<{ nodes: readonly LarkEntry[]; hasMore: boolean; pageToken: string | null }> =
      await readLarkFiles({ folderToken: key, pageToken, refresh })
    if (gen !== generation.current) return
    setLevels((previous) => {
      const current = previous[key]
      // The level is gone: the project was switched while this read was open.
      if (current === undefined) return previous
      if (!result.ok) return { ...previous, [key]: { ...current, status: 'error', error: result.error } }
      return {
        ...previous,
        [key]: {
          status: 'ready',
          // A "load more" appends; a first read replaces (and clears rows that
          // a previous failed-then-succeeded attempt may have left).
          nodes: pageToken === undefined ? result.value.nodes : [...current.nodes, ...result.value.nodes],
          hasMore: result.value.hasMore,
          pageToken: result.value.pageToken,
          error: null,
        },
      }
    })
  }, [])

  /**
   * Read the identity header, resolve the project's folder, and open its root level.
   * @param refresh - whether the host's caches should be dropped first.
   */
  const connect = useCallback(async (refresh: boolean): Promise<void> => {
    generation.current += 1
    const gen = generation.current
    setLevels({})
    setExpanded(new Set())
    setResolution(null)
    setError(null)
    setActionError(null)
    setAttachOpen(false)
    setAttachText('')
    setAvatarFailed(false)

    // No project, no folder: the panel renders the "pick a project" line instead
    // of asking the host about a folder that belongs to no one.
    if (path === '') {
      setIdentity(null)
      setStatus('idle')
      return
    }

    setStatus('loading')
    const header = await readLarkState(refresh)
    if (gen !== generation.current) return
    setIdentity(header.ok ? header.value : null)

    const resolved = await readProjectFolder({ path, name: title, refresh })
    if (gen !== generation.current) return
    if (!resolved.ok) {
      setError(resolved.error)
      setStatus('error')
      return
    }
    setResolution(resolved.value)
    setStatus('ready')
    if (resolved.value.folder !== null) {
      await loadLevel(resolved.value.folder.folderToken, undefined, gen, refresh)
    }
  }, [loadLevel, path, title])

  useEffect(() => { void connect(false) }, [connect])

  /**
   * Expand a subfolder row, or open a document row in Feishu.
   * @param entry - the clicked entry.
   */
  const activate = (entry: LarkEntry): void => {
    if (entry.expandToken === '') {
      openUrl(entry.url, openInSidebar)
      return
    }
    const key = entry.expandToken
    const next = new Set(expanded)
    if (next.has(key)) {
      next.delete(key)
      setExpanded(next)
      return
    }
    next.add(key)
    setExpanded(next)
    if (levels[key] === undefined) {
      void loadLevel(key, undefined, generation.current, false)
    }
  }

  /**
   * Run one folder mutation, then re-resolve.
   *
   * Both mutations end the same way — the host has recorded a folder, so the
   * panel re-reads its state — which is why the two share one path: the only
   * difference between them is which route records the folder.
   * @param run - the request to make.
   */
  const mutate = useCallback((run: () => Promise<LarkResult<unknown>>): void => {
    setWorking(true)
    setActionError(null)
    void run().then((result) => {
      setWorking(false)
      if (!result.ok) {
        setActionError(result.error)
        return
      }
      // A cleared cache is what makes the just-recorded folder visible: the
      // resolve below must not be answered from the read that preceded the
      // write.
      void connect(true)
    }, (reason: unknown) => {
      setWorking(false)
      setActionError({ code: 'unreachable', message: messageOf(reason) })
    })
  }, [connect])

  /** Create the project's folder in the archive. */
  const create = useCallback((): void => {
    if (path === '') return
    mutate(() => createProjectFolder({ path, name: title }))
  }, [mutate, path, title])

  /**
   * Record a folder for this project: one the host found, or one pasted.
   * @param folderToken - the folder's token.
   * @param url - the folder's link, when it is already known.
   */
  const attach = useCallback((folderToken: string, url?: string): void => {
    if (path === '') return
    mutate(() => attachProjectFolder({
      path,
      folderToken,
      name: title,
      ...(url === undefined ? {} : { url }),
    }))
  }, [mutate, path, title])

  /**
   * Apply the pasted link: a Feishu folder URL, or a bare token.
   */
  const attachPasted = useCallback((): void => {
    const token = folderTokenFromInput(attachText)
    if (token === '') {
      // Not a request failure: the text is not a folder reference, and saying so
      // is more useful than sending a request the host would refuse.
      setActionError({ code: 'bad-input', message: t('lark.folder.pasteInvalid') })
      return
    }
    attach(token)
  }, [attach, attachText, t])

  const folder = resolution?.folder ?? null
  const root = folder === null ? undefined : levels[folder.folderToken]
  const count = root?.nodes.length ?? 0
  const showIdentity = identity?.loggedIn === true
  // The fix for the last failure, whichever surface reported it: a failure the
  // panel renders without its remedy is a failure the operator has to interpret.
  const errorHint = error === null ? null : feishuFailureHint(error, t)
  const actionHint = actionError === null ? null : feishuFailureHint(actionError, t)

  /**
   * The one failure a Retry cannot fix.
   *
   * A missing scope and a missing login are the same problem from here: the
   * operator has to authorize, and pressing Retry re-asks a question that was
   * already refused. Everything else — a network, a permission they must be
   * granted, a missing binary — is NOT this, and offering a login for it would
   * send them round a loop.
   * @param failure - the failure a surface is rendering.
   * @returns the login button, or null when a login is not the fix.
   */
  const loginButton = (failure: LarkError | null): ReactNode => {
    if (failure === null) return null
    // Three failures share one fix — the operator has to authorize, and pressing
    // Retry re-asks a question already refused: the login lacks a scope, nobody
    // signed the CLI in at all, or SOMEBODY ELSE did (the CLI holds one account
    // per host, so the way to read your own drive is to sign it in as yourself).
    if (failure.code !== 'scope-missing' && failure.code !== 'not-logged-in'
      && failure.code !== 'identity-mismatch') return null
    const scopes = failure.missingScopes ?? []
    return (
      <button
        type="button"
        data-wui="larkNoteAction"
        data-primary="true"
        onClick={() => { setLoginScopes(scopes) }}
      >
        {t('lark.login.action')}
      </button>
    )
  }

  /**
   * Render one level and, recursively, the levels opened below it.
   *
   * `chain` is this level's ancestry — the folder tokens that led here, this one
   * included — and it is what makes the recursion safe: an entry pointing back at
   * one of its own ancestors (Feishu allows a shortcut into a folder that holds
   * it, and two folders can link to each other) is rendered as a row that OPENS
   * rather than expands. Remote data must not get to decide this component's
   * stack depth.
   * @param key - the folder token this level lists.
   * @param depth - indentation depth.
   * @param chain - the folder tokens above this level, this level included.
   * @returns the rows of that level.
   */
  const renderLevel = (key: string, depth: number, chain: ReadonlySet<string>): ReactNode => {
    const level = levels[key]
    if (level === undefined) return null
    const hint = level.status === 'error' && level.error !== null ? feishuFailureHint(level.error, t) : null
    return (
      <>
        {level.nodes.map((entry) => {
          // A directory may expand only when it does not lead back up this
          // branch; a shortcut to an ancestor stays a row that opens Feishu.
          const expandable = entry.expandToken !== '' && !chain.has(entry.expandToken)
          const open = expandable && expanded.has(entry.expandToken)
          return (
            <div key={entry.token}>
              <EntryRow
                entry={entry}
                depth={depth}
                expandable={expandable}
                open={open}
                t={t}
                onActivate={() => {
                  if (expandable) activate(entry)
                  else openUrl(entry.url, openInSidebar)
                }}
                onOpen={() => { openUrl(entry.url, openInSidebar) }}
              />
              {open && renderLevel(entry.expandToken, depth + 1, new Set([...chain, entry.expandToken]))}
            </div>
          )
        })}
        {level.status === 'loading' && (
          <div data-wui="larkNote" data-depth={depth} style={indent(depth)}>{t('lark.loading')}</div>
        )}
        {level.status === 'error' && level.error !== null && (
          <div data-wui="larkNote" data-depth={depth} data-tone="error" style={indent(depth)}>
            <span>{level.error.message}</span>
            {hint !== null && <span data-wui="larkErrorHint">{hint}</span>}
            {loginButton(level.error)}
            <button
              type="button"
              data-wui="larkNoteAction"
              onClick={() => {
                void loadLevel(key, level.pageToken ?? undefined, generation.current, true)
              }}
            >
              {t('lark.retry')}
            </button>
          </div>
        )}
        {level.status === 'ready' && level.hasMore && level.pageToken !== null && (
          <div data-wui="larkNote" data-depth={depth} style={indent(depth)}>
            <button
              type="button"
              data-wui="larkNoteAction"
              onClick={() => {
                void loadLevel(key, level.pageToken ?? undefined, generation.current, false)
              }}
            >
              {t('lark.loadMore')}
            </button>
          </div>
        )}
      </>
    )
  }

  /**
   * The two ways out of "this project has no folder yet", and the one way out of
   * "several folders could be it": create, or point at one that exists.
   * @returns the block, with the paste field when it is open.
   */
  const renderFolderActions = (): ReactNode => (
    <div data-wui="larkActions">
      <button
        type="button"
        data-wui="larkNoteAction"
        data-primary="true"
        disabled={working}
        onClick={create}
      >
        {working ? t('lark.folder.creating') : t('lark.folder.create')}
      </button>
      <button
        type="button"
        data-wui="larkNoteAction"
        disabled={working}
        onClick={() => { setAttachOpen(open => !open) }}
      >
        {t('lark.folder.paste')}
      </button>
      {attachOpen && (
        <div data-wui="larkAttach">
          <input
            data-wui="larkInput"
            type="text"
            value={attachText}
            placeholder={t('lark.folder.pasteHint')}
            aria-label={t('lark.folder.pasteHint')}
            onChange={(event) => { setAttachText(event.target.value) }}
            onKeyDown={(event) => { if (event.key === 'Enter') attachPasted() }}
          />
          <button
            type="button"
            data-wui="larkNoteAction"
            disabled={working || attachText.trim() === ''}
            onClick={attachPasted}
          >
            {t('lark.folder.pasteApply')}
          </button>
        </div>
      )}
    </div>
  )

  return (
    <div data-wui="larkPanel">
      <div data-wui="larkHeader">
        <span data-wui="larkTitle">{t('lark.title')}</span>
        {status === 'ready' && folder !== null && (
          <span data-wui="larkCount">{t('lark.count', { n: count })}</span>
        )}
        <Tooltip label={t('lark.refresh')} delayMs={500}>
          <button
            type="button"
            data-wui="iconButton"
            aria-label={t('lark.refresh')}
            aria-busy={status === 'loading' || undefined}
            disabled={path === ''}
            onClick={() => { void connect(true) }}
          >
            <IconRefreshOutline16 size={14} />
          </button>
        </Tooltip>
      </div>

      {showIdentity && identity !== null && (
        <div data-wui="larkIdentity">
          {identity.user !== null && identity.user.avatarUrl !== '' && !avatarFailed
            ? (
              <img
                data-wui="larkAvatar"
                src={identity.user.avatarUrl}
                alt=""
                referrerPolicy="no-referrer"
                onError={() => { setAvatarFailed(true) }}
              />
            )
            : (
              <span data-wui="larkAvatar" data-fallback="true" aria-hidden="true">
                {(identity.user?.name ?? '飞').slice(0, 1)}
              </span>
            )}
          <span
            data-wui="larkUserName"
            title={identity.user === null ? '' : `${identity.user.name} · ${identity.user.openId}`}
          >
            {identity.user?.name ?? t('lark.unknownUser')}
          </span>
          {/* The folder's own name sits beside the user because the two are the
              strip's facts: who is reading, and which folder they are reading.
              It is a link, not a menu: the panel's subject is now fixed. */}
          {folder !== null && folder.url !== '' && (
            <button
              type="button"
              data-wui="larkFolderLink"
              title={t('lark.folder.open')}
              aria-label={t('lark.folder.open')}
              onClick={() => { openUrl(folder.url, openInSidebar) }}
            >
              <span data-wui="larkFolderName">
                {folder.name.trim() === '' ? t('lark.untitled') : folder.name}
              </span>
              <IconRightUpOutline16 size={12} />
            </button>
          )}
        </div>
      )}

      <div data-wui="larkScroll">
        {path === '' && <div data-wui="larkNote">{t('lark.noProject')}</div>}

        {path !== '' && status === 'error' && error !== null && (
          <div data-wui="larkError" role="status">
            <span data-wui="larkErrorText">{error.message}</span>
            {identity?.mismatch === true && (
              <span data-wui="larkIdentityMismatch">
                {t('lark.identity.mismatch', {
                  viewer: identity.viewer?.name ?? identity.viewer?.openId ?? t('lark.unknownUser'),
                  docs: identity.user?.name ?? identity.user?.openId ?? t('lark.unknownUser'),
                })}
              </span>
            )}
            {errorHint !== null && <span data-wui="larkErrorHint">{errorHint}</span>}
            {loginButton(error)}
            <button type="button" data-wui="larkNoteAction" onClick={() => { void connect(true) }}>
              {t('lark.retry')}
            </button>
          </div>
        )}

        {path !== '' && status === 'ready' && folder === null && resolution?.source === 'missing' && (
          <div data-wui="larkNote" data-tone="empty">
            <span>{t('lark.folder.missing')}</span>
            {renderFolderActions()}
          </div>
        )}

        {path !== '' && status === 'ready' && folder === null && resolution?.source === 'ambiguous' && (
          <div data-wui="larkNote" data-tone="empty">
            <span>{t('lark.folder.ambiguous', { n: resolution.candidates.length })}</span>
            <div data-wui="larkCandidates">
              {resolution.candidates.map(candidate => (
                <div key={candidate.folderToken} data-wui="larkCandidate">
                  <span data-wui="larkCandidateName" title={candidate.folderToken}>
                    {candidate.name.trim() === '' ? t('lark.untitled') : candidate.name}
                  </span>
                  <button
                    type="button"
                    data-wui="larkNoteAction"
                    disabled={working}
                    onClick={() => { attach(candidate.folderToken, candidate.url) }}
                  >
                    {t('lark.folder.use')}
                  </button>
                  <button
                    type="button"
                    data-wui="larkOpenButton"
                    aria-label={t('lark.open')}
                    title={t('lark.open')}
                    onClick={() => { openUrl(candidate.url, openInSidebar) }}
                  >
                    <IconRightUpOutline16 size={14} />
                  </button>
                </div>
              ))}
            </div>
            {renderFolderActions()}
          </div>
        )}

        {actionError !== null && (
          <div data-wui="larkNote" data-tone="error">
            <span>{actionError.message}</span>
            {actionHint !== null && <span data-wui="larkErrorHint">{actionHint}</span>}
            {loginButton(actionError)}
          </div>
        )}

        {folder !== null && status === 'ready'
          && renderLevel(folder.folderToken, 0, new Set([folder.folderToken]))}
        {folder !== null && root?.status === 'ready' && root.nodes.length === 0 && (
          <div data-wui="larkNote">{t('lark.empty')}</div>
        )}
      </div>

      {loginScopes !== null && (
        <LarkLoginDialog
          open
          scopes={loginScopes}
          t={t}
          onDone={() => {
            // The login landed, so the read that failed is worth re-reading:
            // `connect(true)` drops the host's caches and walks the panel again,
            // which is what makes the authorization visible as the folder it was
            // blocking.
            setLoginScopes(null)
            void connect(true)
          }}
          onClose={() => { setLoginScopes(null) }}
        />
      )}
    </div>
  )
}

/**
 * One tree row: the expander/opener, the type chip, and the name.
 * @param props - the entry, its depth, whether it expands, and its action.
 * @returns the row element.
 */
function EntryRow({ entry, depth, expandable, open, onActivate, onOpen, t }: {
  entry: LarkEntry
  depth: number
  /**
   * Whether this row expands. A directory usually does; one that leads back to
   * an ancestor of its own branch does not, and opens in Feishu instead.
   */
  expandable: boolean
  open: boolean
  onActivate: () => void
  /** The row's own "open in Feishu" control; the same seam `onActivate` uses. */
  onOpen: () => void
  t: TranslateNS<typeof NS>
}): ReactNode {
  const name = entry.name.trim() === '' ? t('lark.untitled') : entry.name
  return (
    <div data-wui="larkRow" data-depth={depth} data-dir={expandable || undefined} style={indent(depth)}>
      <button
        type="button"
        data-wui="larkRowMain"
        title={entry.expandToken === '' ? name : `${name} · ${t('lark.directory')}`}
        aria-expanded={expandable ? open : undefined}
        onClick={onActivate}
      >
        <span data-wui="larkChevron" aria-hidden="true">
          {expandable
            ? (open ? <IconChevronDownOutline14 size={12} /> : <IconChevronRightOutline14 size={12} />)
            : null}
        </span>
        <span data-wui="larkBadge" data-type={entry.type || 'unknown'} aria-hidden="true">
          {badgeOf(entry)}
        </span>
        <span data-wui="larkNodeTitle">{name}</span>
      </button>
      <button
        type="button"
        data-wui="larkOpenButton"
        aria-label={t('lark.open')}
        title={t('lark.open')}
        disabled={entry.url === ''}
        onClick={onOpen}
      >
        <IconRightUpOutline16 size={14} />
      </button>
    </div>
  )
}
