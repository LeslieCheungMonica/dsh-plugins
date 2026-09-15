/**
 * Slot contract for this plugin's shell.
 *
 * This plugin OCCUPIES the frame's `sidebar` slot (declared by ui-layout) and,
 * in the same registration, declares the five child seats the shipped sidebar
 * shell used to declare. That is the whole trick of this plugin: taking the
 * `sidebar` name over makes this column the left column, and re-declaring the
 * SAME child keys means the shipped region occupants (the workspace browser,
 * the settings panel, the brand seats, the footer actions) register into this
 * column instead of losing their home.
 *
 * The type-only imports below pull the SlotMap merges of the owners:
 * ui-layout declares `sidebar` (its owner share is the live column state this
 * component receives) and ui-sidebar declares the five child keys with their
 * owner shares.
 */
import type {
  PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {
  DirectoryListing, SessionId, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { WebUiKey } from './locales.ts'
import type { SelectionStore } from './project.ts'

/** Dictionary namespace owned by this plugin. */
export const NS = 'webui'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's shell copy. */
    webui: WebUiKey
  }
}

/**
 * The business face this plugin's apply hands its shell. Everything reads or
 * writes through the runtime's public services (`ctx.workspaces`,
 * `ctx.sessions`, `ctx.layout`) — a slot component never sees `ctx`.
 */
export interface ShellInjected {
  /** Start a session in a workspace: reuse its blank session, else create one. */
  startSession: (workspaceId?: WorkspaceId) => void
  /** Toggle the layout column through the layout service. */
  toggleSidebar: () => void
  /** Open the host's native directory chooser; null when the operator cancelled. */
  pickDirectory: () => Promise<string | null>
  /** Register an existing path as a workspace (idempotent by canonical path). */
  createWorkspace: (input: { path: string }) => Promise<WorkspaceView>
  /** List one directory level (the in-app fallback browser). */
  listDirectory: (path?: string) => Promise<DirectoryListing>
  /** Create one child directory (the fallback browser's New folder). */
  createDirectory: (path: string, name: string) => Promise<string>
  /** Select a listed session as the current one. */
  openSession: (sessionId: SessionId) => void
  /** Scope the column to one project (or clear the scope). */
  selectProject: (workspaceId: WorkspaceId | undefined) => void
  /** Rename a session through its per-session binding. */
  renameSession: (sessionId: SessionId, title: string) => Promise<void>
  /** Archive a session: hidden from every grouping surface, log retained. */
  archiveSession: (sessionId: SessionId) => Promise<void>
  /** Rename a project. */
  renameWorkspace: (workspaceId: WorkspaceId, title: string) => Promise<void>
  /** Delete a project; its sessions fall back to the ungrouped bucket. */
  deleteWorkspace: (workspaceId: WorkspaceId) => Promise<void>
}

/** Child keys this plugin declares in the same registration that occupies `sidebar`. */
export type ShellChildSlots =
  | 'sidebar.brand.mark'
  | 'sidebar.brand.name'
  | 'sidebar.workspaces'
  | 'sidebar.settings'
  | 'sidebar.footer.action'

/**
 * Composed props of the owned column: the frame's column state + the global
 * session/workspace hooks (`PropsRuntime`), the five child-render shares, this
 * plugin's injected face, and the typed `t` seat.
 */
export type ShellProps =
  & PropsRuntime<'sidebar'>
  & PropsRenderSlots<ShellChildSlots>
  & PropsStore<SelectionStore>
  & ShellInjected
  & PropsLocale<typeof NS>

/**
 * Composed props of the degraded contribution: it occupies the shipped shell's
 * `sidebar.brand.name` seat, so its owner share is that seat's (no column state)
 * and it declares no children.
 */
export type FallbackProps =
  & PropsRuntime<'sidebar.brand.name'>
  & ShellInjected
  & PropsLocale<typeof NS>
