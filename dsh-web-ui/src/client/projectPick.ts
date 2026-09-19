/**
 * One pick in the column's project dropdown, and what it does.
 *
 * The dropdown is a SCOPE control and a NAVIGATION control at once, and the two
 * halves have different triggers:
 *
 * - the scope write happens on every pick, including a pick of the project the
 *   column is already scoped to — clicking a row must never become an inert one;
 * - the session open happens only when the pick actually MOVES the column, so a
 *   mis-click on the current project does not throw the reader out of the
 *   conversation they were reading.
 *
 * DSH's `workspaces.startSession` is what opens it, and it opens the project's
 * *blank* session — an existing one is reused, so moving back and forth between
 * two projects does not accumulate empty sessions.
 *
 * **Why this is not part of the scope store** (`project.ts`). The store's
 * `select` writer is used by two callers with different meanings: this module's
 * pick, and the column's follow-the-current-session effect — which fires every
 * time the open session moves to another project. Moulding the session open into
 * that writer would make "open a session in project B" start a SECOND one, so
 * the mint belongs to the pick alone. Keeping the rule here also keeps it a pure
 * decision: the module imports no client runtime, which is what lets the offline
 * harness (`scripts/harness/project-pick.mjs`) drive the shipped rule with
 * nothing behind it.
 *
 * @module dsh-web-ui/client/projectPick
 */
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * The write sinks one pick may reach.
 *
 * Both are passed in rather than imported: the pick is the same rule whatever
 * surface reports it, and the caller is the one that owns the wiring (the column
 * hands it the injected face).
 */
export interface ProjectPickSinks {
  /** Scope the column to the picked project. Runs on EVERY pick. */
  select: (workspaceId: WorkspaceId) => void
  /**
   * Open the picked project's session. Runs only when the pick moves the
   * column, and the list is scoped FIRST so the click's own feedback does not
   * wait for a session to connect.
   */
  startSession: (workspaceId: WorkspaceId) => void
}

/**
 * Apply one pick from the project dropdown.
 *
 * @param picked - the project the reader chose.
 * @param current - the project the column is scoped to now, if any.
 * @param sinks - the two writers, as the caller knows them.
 */
export function pickProject(
  picked: WorkspaceId,
  current: WorkspaceId | undefined,
  sinks: ProjectPickSinks,
): void {
  sinks.select(picked)
  // Same project: the pick was a re-scope, not a move. Leaving a conversation
  // for a blank one here is the mis-click this line prevents.
  if (picked === current) return
  sinks.startSession(picked)
}
