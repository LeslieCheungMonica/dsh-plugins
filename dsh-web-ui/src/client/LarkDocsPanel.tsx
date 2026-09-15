/**
 * The Feishu document panel: the column's lower half.
 *
 * It answers three questions in order, and each answer is rendered where it
 * matters rather than as a generic spinner:
 *
 * 1. **Who is signed in?** — the header strip shows the `lark-cli` user (name +
 *    avatar, `open_id` on hover), so "the login worked" is a visible fact rather
 *    than an assumption.
 * 2. **Which knowledge base?** — the personal knowledge base (`my_library`) is
 *    the default and the reason this panel exists; the space menu next to the
 *    user offers the team spaces this account can also read, because a personal
 *    library can be flat while a team space is the one with directories.
 * 3. **What is in here?** — one lazy level of wiki nodes per expansion. A node
 *    with children behaves as a directory (the row expands); a node without
 *    children is a document and the row opens it in Feishu.
 *
 * Only loaded levels are rendered, so a deep tree costs one request per opened
 * directory, and every request carries the generation it was issued in: a reply
 * that lands after a refresh or a space switch is dropped instead of painting
 * another space's tree into this one.
 *
 * @module dsh-web-ui/client/LarkDocsPanel
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconRefreshOutline16,
  IconRightUpOutline16, Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './contract.ts'
import {
  PERSONAL_SPACE_ID, readLarkNodes, readLarkSpaces, readLarkState, wikiUrl,
} from './larkapi.ts'
import type { LarkError, LarkNode, LarkResult, LarkSpace, LarkState } from './larkapi.ts'

/** Props: this panel is rendered by the column, so it receives that copy seat. */
export interface LarkDocsPanelProps {
  /** The plugin's translator (namespace `webui`). */
  readonly t: TranslateNS<typeof NS>
}

/** One lazily loaded level of the tree, keyed by its parent node token. */
interface Level {
  /** `loading` covers both the first read and a "load more" read. */
  readonly status: 'loading' | 'ready' | 'error'
  /** Rows loaded so far; kept across a failed "load more". */
  readonly nodes: readonly LarkNode[]
  /** Whether Feishu has another page for this level. */
  readonly hasMore: boolean
  /** Token to fetch that page. */
  readonly pageToken: string | null
  /** The failure of the last read, when it failed. */
  readonly error: LarkError | null
}

/** Key of the space's root level (no parent node). */
const ROOT = ''

/** Short type chips, language-neutral so one table serves both dictionaries. */
const TYPE_BADGES: Record<string, string> = {
  docx: 'DOC',
  sheet: 'SHT',
  bitable: 'BIT',
  slides: 'PPT',
  mindnote: 'MIND',
  file: 'FILE',
  folder: 'DIR',
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
 * Pick the chip text for a node.
 * @param node - the node.
 * @returns a short type label.
 */
function badgeOf(node: LarkNode): string {
  return TYPE_BADGES[node.objType] ?? (node.hasChild ? 'DIR' : 'FILE')
}

/**
 * Render the Feishu document panel.
 * @param props - the copy seat.
 * @returns the panel element tree.
 */
export function LarkDocsPanel({ t }: LarkDocsPanelProps): ReactNode {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [identity, setIdentity] = useState<LarkState | null>(null)
  const [error, setError] = useState<LarkError | null>(null)
  const [spaceId, setSpaceId] = useState<string>(PERSONAL_SPACE_ID)
  const [levels, setLevels] = useState<Record<string, Level>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [spaces, setSpaces] = useState<readonly LarkSpace[] | null>(null)
  const [spacesFailed, setSpacesFailed] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [avatarFailed, setAvatarFailed] = useState(false)

  // One generation for the whole panel: a refresh or a space switch bumps it,
  // and every in-flight read compares against it before touching state.
  const generation = useRef(0)

  /**
   * Read one level and store it under its parent key.
   * @param key - the parent node token, or ROOT.
   * @param parent - the parent node token to send, or undefined for the root.
   * @param pageToken - the page to append, or undefined for the first page.
   * @param space - the space to read from.
   * @param gen - the generation this read belongs to.
   */
  const loadLevel = useCallback(async (
    key: string,
    parent: string | undefined,
    pageToken: string | undefined,
    space: string,
    gen: number,
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
    const result: LarkResult<{ nodes: readonly LarkNode[]; hasMore: boolean; pageToken: string | null }> =
      await readLarkNodes({ spaceId: space, parentNodeToken: parent, pageToken })
    if (gen !== generation.current) return
    setLevels((previous) => {
      const current = previous[key]
      // The level is gone: the space was switched while this read was open.
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
   * Reset the panel to one space and read its root level.
   * @param space - the space to browse.
   * @param gen - the generation this switch belongs to.
   */
  const openSpace = useCallback(async (space: string, gen: number): Promise<void> => {
    setSpaceId(space)
    setExpanded(new Set())
    setLevels({})
    await loadLevel(ROOT, undefined, undefined, space, gen)
  }, [loadLevel])

  /**
   * Read the identity header and open the personal knowledge base.
   * @param refresh - whether the host's caches should be dropped first.
   */
  const connect = useCallback(async (refresh: boolean): Promise<void> => {
    generation.current += 1
    const gen = generation.current
    setStatus('loading')
    setError(null)
    setAvatarFailed(false)
    const result = await readLarkState(refresh)
    if (gen !== generation.current) return
    if (!result.ok) {
      setIdentity(null)
      setError(result.error)
      setStatus('error')
      setLevels({})
      return
    }
    setIdentity(result.value)
    setSpaces(null)
    setSpacesFailed(false)
    setStatus('ready')
    await openSpace(result.value.space?.spaceId ?? PERSONAL_SPACE_ID, gen)
  }, [openSpace])

  useEffect(() => { void connect(false) }, [connect])

  /**
   * Expand a directory row, or open a document row in Feishu.
   * @param node - the clicked node.
   */
  const activate = (node: LarkNode): void => {
    if (!node.hasChild) {
      window.open(wikiUrl(node), '_blank', 'noopener,noreferrer')
      return
    }
    const next = new Set(expanded)
    if (next.has(node.nodeToken)) {
      next.delete(node.nodeToken)
      setExpanded(next)
      return
    }
    next.add(node.nodeToken)
    setExpanded(next)
    if (levels[node.nodeToken] === undefined) {
      void loadLevel(node.nodeToken, node.nodeToken, undefined, spaceId, generation.current)
    }
  }

  /**
   * Open the space menu, loading the roster on first use.
   */
  const openMenu = (): void => {
    setMenuOpen(true)
    if (spaces !== null) return
    void (async () => {
      const result = await readLarkSpaces()
      if (result.ok) setSpaces(result.value)
      else setSpacesFailed(true)
    })()
  }

  const personalId = identity?.space?.spaceId ?? PERSONAL_SPACE_ID
  // The personal library reports its own name in whichever language the tenant
  // stores it ("My Document Library" on a Chinese tenant), so this panel labels
  // it with its own copy instead — the trigger then reads the same language as
  // the rest of the column. Feishu's name stays in the trigger's tooltip.
  const personalLabel = t('lark.personal')
  const currentSpace = spaceId === personalId
    ? personalLabel
    : (spaces?.find(space => space.spaceId === spaceId)?.name ?? spaceId)

  const menuItems: MenuEntry[] = [
    { type: 'label', id: 'spaces', text: t('lark.spaces.label') },
    // The personal knowledge base is always offered, even before — or without —
    // the roster: it is the view this panel exists for, and an empty menu would
    // make a failed roster look like a broken control.
    { id: personalId, label: personalLabel },
    ...(spaces ?? [])
      .filter(space => space.spaceId !== personalId)
      .map((space): MenuEntry => ({ id: space.spaceId, label: space.name })),
    ...(spacesFailed
      ? [{ id: 'spaces-failed', label: t('lark.spaces.failed'), disabled: true } as MenuEntry]
      : []),
  ]

  const root = levels[ROOT]
  const count = root?.nodes.length ?? 0
  const showIdentity = identity?.loggedIn === true

  /**
   * Render one level and, recursively, the levels opened below it.
   * @param key - the level's key (ROOT or a parent node token).
   * @param depth - indentation depth.
   * @returns the rows of that level.
   */
  const renderLevel = (key: string, depth: number): ReactNode => {
    const level = levels[key]
    if (level === undefined) return null
    return (
      <>
        {level.nodes.map(node => (
          <div key={node.nodeToken}>
            <LarkRow
              node={node}
              depth={depth}
              open={expanded.has(node.nodeToken)}
              t={t}
              onActivate={() => { activate(node) }}
            />
            {expanded.has(node.nodeToken) && renderLevel(node.nodeToken, depth + 1)}
          </div>
        ))}
        {level.status === 'loading' && (
          <div data-wui="larkNote" data-depth={depth} style={indent(depth)}>{t('lark.loading')}</div>
        )}
        {level.status === 'error' && level.error !== null && (
          <div data-wui="larkNote" data-depth={depth} data-tone="error" style={indent(depth)}>
            <span>{level.error.message}</span>
            {(level.error.code === 'cli-network' || level.error.code === 'cli-timeout') && (
              <span data-wui="larkErrorHint">{t('lark.hint.network')}</span>
            )}
            <button
              type="button"
              data-wui="larkNoteAction"
              onClick={() => {
                void loadLevel(key, key === ROOT ? undefined : key, level.pageToken ?? undefined, spaceId, generation.current)
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
                void loadLevel(key, key === ROOT ? undefined : key, level.pageToken ?? undefined, spaceId, generation.current)
              }}
            >
              {t('lark.loadMore')}
            </button>
          </div>
        )}
      </>
    )
  }

  return (
    <div data-wui="larkPanel">
      <div data-wui="larkHeader">
        <span data-wui="larkTitle">{t('lark.title')}</span>
        {status === 'ready' && <span data-wui="larkCount">{t('lark.count', { n: count })}</span>}
        <Tooltip label={t('lark.refresh')} delayMs={500}>
          <button
            type="button"
            data-wui="iconButton"
            aria-label={t('lark.refresh')}
            aria-busy={status === 'loading' || undefined}
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
          <Menu
            open={menuOpen}
            anchor={(
              <button
                type="button"
                data-wui="larkSpaceTrigger"
                aria-haspopup="menu"
                title={spaceId === personalId ? (identity?.space?.name ?? personalLabel) : currentSpace}
                onClick={() => { if (menuOpen) setMenuOpen(false); else openMenu() }}
              >
                <span data-wui="larkSpaceName">{currentSpace}</span>
                <IconChevronDownOutline14 size={12} />
              </button>
            )}
            items={menuItems}
            selectedId={spaceId}
            onSelect={(id) => {
              setMenuOpen(false)
              if (id === spaceId) return
              generation.current += 1
              void openSpace(id, generation.current)
            }}
            onClose={() => { setMenuOpen(false) }}
            portal
            dense
            align="end"
          />
        </div>
      )}

      <div data-wui="larkScroll">
        {status === 'error' && error !== null && (
          <div data-wui="larkError" role="status">
            <span data-wui="larkErrorText">{error.message}</span>
            {(error.code === 'cli-missing' || error.code === 'not-logged-in') && (
              <span data-wui="larkErrorHint">{t('lark.hint.login')}</span>
            )}
            {(error.code === 'cli-network' || error.code === 'cli-timeout') && (
              <span data-wui="larkErrorHint">{t('lark.hint.network')}</span>
            )}
            <button type="button" data-wui="larkNoteAction" onClick={() => { void connect(true) }}>
              {t('lark.retry')}
            </button>
          </div>
        )}
        {status === 'ready' && renderLevel(ROOT, 0)}
        {status === 'ready' && root?.status === 'ready' && root.nodes.length === 0 && (
          <div data-wui="larkNote">{t('lark.empty')}</div>
        )}
      </div>
    </div>
  )
}

/**
 * One tree row: the expander/opener, the type chip, and the title.
 * @param props - the node, its depth, its expansion, and its action.
 * @returns the row element.
 */
function LarkRow({ node, depth, open, onActivate, t }: {
  node: LarkNode
  depth: number
  open: boolean
  onActivate: () => void
  t: TranslateNS<typeof NS>
}): ReactNode {
  const title = node.title.trim() === '' ? t('lark.untitled') : node.title
  return (
    <div data-wui="larkRow" data-depth={depth} data-dir={node.hasChild || undefined} style={indent(depth)}>
      <button
        type="button"
        data-wui="larkRowMain"
        title={node.hasChild ? `${title} · ${t('lark.directory')}` : title}
        aria-expanded={node.hasChild ? open : undefined}
        onClick={onActivate}
      >
        <span data-wui="larkChevron" aria-hidden="true">
          {node.hasChild
            ? (open ? <IconChevronDownOutline14 size={12} /> : <IconChevronRightOutline14 size={12} />)
            : null}
        </span>
        <span data-wui="larkBadge" data-type={node.objType || 'unknown'} aria-hidden="true">
          {badgeOf(node)}
        </span>
        <span data-wui="larkNodeTitle">{title}</span>
      </button>
      <button
        type="button"
        data-wui="larkOpenButton"
        aria-label={t('lark.open')}
        title={t('lark.open')}
        onClick={() => { window.open(wikiUrl(node), '_blank', 'noopener,noreferrer') }}
      >
        <IconRightUpOutline16 size={14} />
      </button>
    </div>
  )
}
