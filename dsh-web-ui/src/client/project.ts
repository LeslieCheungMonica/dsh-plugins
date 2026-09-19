/**
 * The selected project: the one fact the column's header and its session list
 * both read.
 *
 * A project IS a DSH workspace, and DSH has no host-side "active workspace", so
 * the selection is a client fact this plugin owns:
 *
 * - the dropdown writes it (picking a project scopes the list; a pick that
 *   MOVES the column also opens that project's session — the rule is
 *   `projectPick.ts`, and it deliberately does NOT live in this store's writer,
 *   which the follow-the-current-session effect below also calls);
 * - the session list reads it (it renders exactly that project's sessions);
 * - the New Session button targets it.
 *
 * It FOLLOWS the current session: whenever the open session moves to another
 * project, the selection moves with it, so the column never shows a project
 * whose session you are not looking at. A manual pick holds until you open a
 * session somewhere else. The value is persisted, so a reload keeps the scope
 * you were browsing; a stored value that no longer resolves (a deleted
 * workspace) falls back to the current session's project and then to the most
 * recently active one.
 */
import { useEffect, useMemo, useRef } from 'react'
import { defineStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  SessionListState, WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

/** Persisted selection state: the project the column is scoped to. */
interface SelectionState {
  /** Selected workspace id; absent until a project is known. */
  workspaceId: string | undefined
}

/**
 * Build the selection store. Called from `apply` (never at module level: a
 * module-level handle is a disguised singleton across plugin reloads), and the
 * one handle is shared by this plugin's two root-scope registrations — the
 * column shell and the session list — so both read one instance.
 * @returns the store handle.
 */
export function createSelectionStore() {
  return defineStore({
    init: (): SelectionState => ({ workspaceId: undefined }),
    persist: 'dsh-web-ui.selected-project',
    actions: {
      /**
       * Scope the column to one project (or clear the scope).
       * @param draft - store draft.
       * @param workspaceId - the project to select.
       */
      select(draft: SelectionState, workspaceId: WorkspaceId | undefined): void {
        draft.workspaceId = workspaceId
      },
    },
  })
}

/** The selection store handle's type (what components receive as props). */
export type SelectionStore = ReturnType<typeof createSelectionStore>

/**
 * The baked write set of the selection store. A handle carries no callable
 * actions — the framework bakes them per instance and hands them to the
 * registration's inject factory — so this is the parameter type of that factory.
 */
export interface SelectionActions {
  select: (workspaceId: WorkspaceId | undefined) => void
}

/** The project scope the column renders. */
export interface ProjectScope {
  /** Every registered workspace, in host order. */
  readonly workspaces: readonly WorkspaceView[]
  /** Id of the project this column is scoped to; undefined while none exists. */
  readonly selectedId: WorkspaceId | undefined
  /** The selected workspace's record; undefined while none resolves. */
  readonly selected: WorkspaceView | undefined
  /** Project owning the current session, when there is one. */
  readonly currentProjectId: WorkspaceId | undefined
}

/**
 * Resolve the project scope from the sessions list, the workspace registry, and
 * the persisted selection.
 * @param input - the two standard hooks, the selection hook, and its writer.
 * @returns the scope, and keeps the selection following the current session.
 */
export function useProjectScope(input: {
  useWorkspaces: SnapshotSelectorHook<WorkspaceListState>
  useSessions: SnapshotSelectorHook<SessionListState>
  useStore: SnapshotSelectorHook<SelectionState>
  select: (workspaceId: WorkspaceId | undefined) => void
}): ProjectScope {
  const { useWorkspaces, useSessions, useStore, select } = input
  const workspaces = useWorkspaces(state => state.items)
  const recentWorkspaceId = useWorkspaces(state => state.recentWorkspaceId)
  const currentSessionId = useSessions(state => state.current)
  const stored = useStore(state => state.workspaceId)

  // The project of the CURRENT session: the workspace whose account lists it.
  const currentProjectId = useMemo((): WorkspaceId | undefined => {
    if (currentSessionId === undefined) return undefined
    return workspaces.find(workspace => workspace.sessionIds.includes(currentSessionId))?.workspaceId
  }, [currentSessionId, workspaces])

  const selectedId = useMemo((): WorkspaceId | undefined => {
    const storedId = stored as WorkspaceId | undefined
    if (storedId !== undefined && workspaces.some(workspace => workspace.workspaceId === storedId)) {
      return storedId
    }
    return currentProjectId ?? recentWorkspaceId
  }, [currentProjectId, recentWorkspaceId, stored, workspaces])

  // Follow the current session, but only when it MOVES between two known
  // projects. The current project is absent while the session list is still
  // loading, so its FIRST resolution is a baseline, not a move — otherwise a
  // selection restored from storage would be overwritten on every reload.
  const lastProject = useRef<WorkspaceId | undefined>(undefined)
  useEffect(() => {
    if (currentProjectId === undefined) return
    const previous = lastProject.current
    lastProject.current = currentProjectId
    if (previous === undefined || currentProjectId === previous) return
    if (currentProjectId !== selectedId) select(currentProjectId)
  }, [currentProjectId, select, selectedId])

  return {
    workspaces,
    selectedId,
    selected: selectedId === undefined
      ? undefined
      : workspaces.find(workspace => workspace.workspaceId === selectedId),
    currentProjectId,
  }
}

/** Relative-time bucket of a session row's trailing label. */
export interface RelativeTime {
  unit: 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'
  n: number
}

/**
 * Compact relative time for session rows (the shipped browser's buckets,
 * reimplemented here: importing another plugin's client bundle as a value is
 * forbidden by the module-table rule).
 * @param updatedAt - epoch ms of the session's last activity.
 * @param now - current epoch ms.
 * @returns the bucket and its magnitude.
 */
export function relativeTime(updatedAt: number, now: number): RelativeTime {
  const MINUTE = 60_000
  const HOUR = 3_600_000
  const DAY = 86_400_000
  const diff = Math.max(0, now - updatedAt)
  if (diff < MINUTE) return { unit: 'now', n: 0 }
  if (diff < HOUR) return { unit: 'minutes', n: Math.floor(diff / MINUTE) }
  if (diff < DAY) return { unit: 'hours', n: Math.floor(diff / HOUR) }
  if (diff < 30 * DAY) return { unit: 'days', n: Math.floor(diff / DAY) }
  if (diff < 365 * DAY) return { unit: 'months', n: Math.floor(diff / (30 * DAY)) }
  return { unit: 'years', n: Math.floor(diff / (365 * DAY)) }
}
