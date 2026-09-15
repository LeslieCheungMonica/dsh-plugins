/**
 * The browsing region, scoped to the selected project.
 *
 * This occupant SHADOWS the shipped workspace browser (`sidebar.workspaces`,
 * registered by ui-workspace at the default priority) because the shipped
 * browser groups every workspace together and publishes no filter hook: a
 * project-scoped list is a different projection of the same two stores, not a
 * configuration of it.
 *
 * What it keeps from the shipped browser, because those are the flows a session
 * list owes its reader: open a session, the live status dot (waiting / running /
 * running subagents / finished-unopened), the current-session highlight, a
 * search box, rename, and archive. What it drops, deliberately: fork, the
 * host-side content search, manual reordering, and the per-workspace
 * expand/collapse tree — a single project has no tree. Project rename/delete
 * moved to the project dropdown in the column header.
 *
 * Visibility follows the shipped tree's rules (`ui-workspace`'s `tree.ts`):
 * subagent-origin rows never appear, archived sessions never appear, and among
 * blank sessions only the current one does. Membership is the workspace's
 * account — plus any session whose cwd IS this project's path, so a session that
 * failed to attach still shows up here rather than nowhere.
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconEditOutline16, IconNewChatOutline16,
  IconSearchOutline16, IconTrashOutline16, Input, Menu, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry, StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { indexSubagentDescendants } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  PendingInteractionStatus, SessionId, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS, type ShellInjected } from './contract.ts'
import { relativeTime, useProjectScope, type SelectionStore } from './project.ts'
import { TextPromptDialog } from './TextPromptDialog.tsx'

/** Composed props of the region occupant. */
export type SessionListProps =
  & PropsRuntime<'sidebar.workspaces'>
  & PropsStore<SelectionStore>
  & ShellInjected
  & PropsLocale<typeof NS>

/** The translator seat this plugin's copy arrives through. */
type T = TranslateNS<typeof NS>

/** Relative-time keys by bucket, so the lookup stays inside the key union. */
const TIME_KEYS = {
  minutes: 'time.minutes',
  hours: 'time.hours',
  days: 'time.days',
  months: 'time.months',
  years: 'time.years',
} as const

/** One rendered session row. */
interface SessionRow {
  id: SessionId
  title: string
  blank: boolean
  running: boolean
  runningSubagents: number
  pending: PendingInteractionStatus | undefined
  completed: boolean
  updatedAt: number
}

/**
 * Whether a session belongs in a project's list.
 * @param summary - the session's list row.
 * @param workspace - the project.
 * @param current - the current session id.
 * @param archived - registry-global archive set.
 * @returns true when the row renders.
 */
function visibleIn(
  summary: { id: SessionId; blank: boolean; cwd?: string | undefined; origin?: string | undefined },
  workspace: WorkspaceView,
  current: SessionId | undefined,
  archived: ReadonlySet<string>,
): boolean {
  if (summary.origin === 'subagent') return false
  if (archived.has(summary.id)) return false
  if (summary.blank && summary.id !== current) return false
  return workspace.sessionIds.includes(summary.id) || summary.cwd === workspace.path
}

/**
 * The primary status dot of a row, mirroring the shipped browser's precedence:
 * a waiting interaction outranks live activity, activity outranks the
 * finished-unopened reminder.
 * @param row - the row's facts.
 * @returns the dot state.
 */
function statusOf(row: SessionRow): StateDotState {
  if (row.pending !== undefined) return 'warning'
  if (row.running || row.runningSubagents > 0) return 'ongoing'
  return 'done'
}

/**
 * Render the project-scoped session list.
 * @param props - owner share (wide/expandSidebar) + store seat + injected face + copy.
 * @returns the region element tree.
 */
export function SessionList(props: SessionListProps): ReactNode {
  const {
    wide, expandSidebar, t, useSessions, useWorkspaces, useStore, actions,
    openSession, renameSession, archiveSession, startSession, selectProject,
  } = props

  const scope = useProjectScope({
    useWorkspaces,
    useSessions,
    useStore,
    select: selectProject,
  })
  const ids = useSessions(state => state.ids)
  const byId = useSessions(state => state.byId)
  const current = useSessions(state => state.current)
  const phase = useSessions(state => state.phase)
  const archivedIds = useWorkspaces(state => state.archivedSessionIds)

  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [renaming, setRenaming] = useState<{ id: SessionId; title: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { rows, archivedRows, archivedHidden } = useMemo(() => {
    const workspace = scope.selected
    const archived = new Set<string>(archivedIds as readonly string[])
    const collected: SessionRow[] = []
    let archivedCount = 0
    if (workspace !== undefined) {
      const descendants = indexSubagentDescendants(byId)
      // Account order first (its stored order), then sessions that only match by
      // path, newest first — the account is the project's own ordering.
      const account = workspace.sessionIds.filter(id => byId[id] !== undefined)
      const strays = ids.filter(id => byId[id] !== undefined
        && !workspace.sessionIds.includes(id)
        && byId[id]?.cwd === workspace.path)
      for (const id of [...account, ...strays]) {
        const summary = byId[id]
        if (summary === undefined) continue
        const isArchived = archived.has(summary.id)
        if (isArchived) {
          // Archived rows are counted, and listed only when the reader asks.
          if (summary.origin !== 'subagent') archivedCount += 1
          if (!showArchived) continue
        } else if (!visibleIn(summary, workspace, current, archived)) {
          continue
        }
        collected.push({
          id: summary.id,
          title: summary.blank ? t('session.new') : summary.displayTitle,
          blank: summary.blank,
          running: summary.running,
          runningSubagents: descendants.get(summary.id)?.runningCount ?? 0,
          pending: summary.pendingInteraction,
          completed: summary.completed === true,
          updatedAt: summary.updatedAt,
        })
      }
    }
    const needle = query.trim().toLowerCase()
    const matched = needle === ''
      ? collected
      : collected.filter(row => row.title.toLowerCase().includes(needle))
    const live = matched.filter(row => !archived.has(row.id))
    const archivedShown = matched.filter(row => archived.has(row.id))
    return { rows: live, archivedRows: archivedShown, archivedHidden: archivedCount }
  }, [archivedIds, byId, current, ids, query, scope.selected, showArchived, t])

  const rename = (value: string): void => {
    if (renaming === null) return
    setBusy(true)
    setError(null)
    void (async () => {
      try {
        await renameSession(renaming.id, value)
        setRenaming(null)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
      }
    })()
  }

  const archive = (id: SessionId): void => {
    setError(null)
    void (async () => {
      try {
        await archiveSession(id)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    })()
  }

  // Rail: the column header already carries the project and New Session
  // controls, so the rail shows one control — expand the column — with a badge
  // for anything waiting or running inside it.
  if (!wide) {
    const attention = rows.filter(row => row.pending !== undefined || row.running).length
    return (
      <div data-wui="sessionRail">
        <button
          type="button"
          data-wui="iconButton"
          aria-label={t('sessions.expand')}
          title={t('sessions.expand')}
          onClick={expandSidebar}
        >
          <IconChevronRightOutline14 size={14} />
          {attention > 0 && <span data-wui="railBadge">{attention}</span>}
        </button>
      </div>
    )
  }

  const renderRow = (row: SessionRow, isArchived: boolean): ReactNode => (
    <SessionRowView
      key={row.id}
      row={row}
      archived={isArchived}
      current={row.id === current}
      t={t}
      onOpen={() => { openSession(row.id) }}
      onRename={() => { setRenaming({ id: row.id, title: row.title }) }}
      onArchive={() => { archive(row.id) }}
    />
  )

  return (
    <div data-wui="sessionList" data-project={scope.selectedId ?? ''}>
      {/* No header row. The list used to open with one that named the project —
          which the dropdown directly above the New Session button already names,
          so it was a second copy of one fact — and then with the same row
          carrying the count alone, which cost a row of the column for a number.
          The count now rides the SEARCH row instead, so the list starts with a
          control the operator uses and gains back the row.

          What the scope is, is still visible: `data-project` on this element
          carries it, and the dropdown trigger keeps the project's PATH in its
          tooltip and spells it out in its menu. */}
      <div data-wui="sessionSearch">
        <span data-wui="sessionSearchField">
          <Input
            icon={<IconSearchOutline16 size={16} />}
            value={query}
            placeholder={t('sessions.search.placeholder')}
            aria-label={t('sessions.search.placeholder')}
            onChange={(event) => { setQuery(event.target.value) }}
          />
        </span>
        <span data-wui="sessionCount" title={scope.selected?.path ?? ''}>
          {t('sessions.count', { n: rows.length })}
        </span>
      </div>

      {error !== null && (
        <div data-wui="error" role="status">
          <span data-wui="errorText">{error}</span>
        </div>
      )}

      <div data-wui="sessionScroll">
        {scope.selectedId === undefined && (
          <div data-wui="sessionEmpty">
            <p>{t('sessions.noProject')}</p>
          </div>
        )}
        {scope.selectedId !== undefined && rows.length === 0 && phase === 'ready' && (
          <div data-wui="sessionEmpty">
            <p>{query.trim() === '' ? t('sessions.empty') : t('sessions.noMatch')}</p>
            {query.trim() === '' && (
              <button
                type="button"
                data-wui="sessionEmptyAction"
                onClick={() => { startSession(scope.selectedId) }}
              >
                <IconNewChatOutline16 size={14} />
                {t('session.new')}
              </button>
            )}
          </div>
        )}
        {rows.map(row => renderRow(row, false))}
        {archivedRows.length > 0 && (
          <>
            <div data-wui="sessionArchivedLabel">{t('sessions.archived')}</div>
            {archivedRows.map(row => renderRow(row, true))}
          </>
        )}
      </div>

      {archivedHidden > 0 && (
        <button
          type="button"
          data-wui="sessionArchivedToggle"
          aria-expanded={showArchived}
          onClick={() => { setShowArchived(value => !value) }}
        >
          <IconChevronDownOutline14 size={14} />
          {showArchived ? t('sessions.hideArchived') : t('sessions.showArchived', { n: archivedHidden })}
        </button>
      )}

      <TextPromptDialog
        open={renaming !== null}
        title={t('rename.session.title')}
        label={t('rename.session.label')}
        initialValue={renaming?.title ?? ''}
        confirmLabel={t('rename.confirm')}
        cancelLabel={t('picker.cancel')}
        busy={busy}
        onSubmit={rename}
        onClose={() => { setRenaming(null) }}
      />
    </div>
  )
}

/**
 * One session row: status dot, title, relative time, and its action menu.
 * @param props - the row facts and its three actions.
 * @returns the row element.
 */
function SessionRowView({ row, archived, current, onOpen, onRename, onArchive, t }: {
  row: SessionRow
  archived: boolean
  current: boolean
  onOpen: () => void
  onRename: () => void
  onArchive: () => void
  t: T
}): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false)
  const now = Date.now()
  const { unit, n } = relativeTime(row.updatedAt, now)
  const time = unit === 'now' ? '' : t(TIME_KEYS[unit], { n })

  const items: MenuEntry[] = [
    { id: 'rename', label: t('rename.session.title'), icon: <IconEditOutline16 size={16} /> },
    ...(archived ? [] : [{ id: 'archive', label: t('session.archive'), icon: <IconTrashOutline16 size={16} /> }]),
  ]

  return (
    <div
      data-wui="sessionRow"
      data-session={row.id}
      data-current={current || undefined}
      data-archived={archived || undefined}
      data-status={statusOf(row)}
    >
      <button
        type="button"
        data-wui="sessionOpen"
        title={row.title}
        aria-current={current || undefined}
        onClick={onOpen}
      >
        <span data-wui="sessionDot" aria-hidden="true"><StateDot state={statusOf(row)} /></span>
        <span data-wui="sessionTitle">{row.title}</span>
        {row.runningSubagents > 0 && (
          <span data-wui="sessionSubagents">{t('status.subagents', { n: row.runningSubagents })}</span>
        )}
        {time !== '' && !row.blank && <span data-wui="sessionTime">{time}</span>}
      </button>
      <Menu
        open={menuOpen}
        anchor={(
          <button
            type="button"
            data-wui="sessionMenuButton"
            aria-label={t('actions.session.aria', { name: row.title })}
            aria-haspopup="menu"
            onClick={() => { setMenuOpen(value => !value) }}
          >
            ⋯
          </button>
        )}
        items={items}
        onSelect={(id) => {
          setMenuOpen(false)
          if (id === 'rename') onRename()
          if (id === 'archive') onArchive()
        }}
        onClose={() => { setMenuOpen(false) }}
        portal
        dense
      />
    </div>
  )
}
