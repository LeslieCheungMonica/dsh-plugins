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
 * It declares two seats the shipped shell never had, for the account dock at the
 * column's bottom-left corner (see the `SlotMap` merge below).
 *
 * The type-only imports below pull the SlotMap merges of the owners:
 * ui-layout declares `sidebar` (its owner share is the live column state this
 * component receives) and ui-sidebar declares the five child keys with their
 * owner shares.
 */
import type {
  PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the DTO the host's plugin-inventory Remote answers with. Erased at
// build (this plugin takes no runtime dependency on the remote layer — the
// namespace arrives through `ctx.inject` in the browser half).
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only, the same way: the marketplace's wire shapes, shared with the host
// half that produces them.
import type {
  InstalledSkillSnapshot, SkillInstallRequest, SkillInstallResult, SkillMarketSnapshot, SkillResponse,
} from '../shared/skillswire.ts'
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
  /**
   * Show a Feishu link inside the GUI, in `my-sider`'s docked web sidebar.
   *
   * @param url - the link the host built.
   * @returns whether a sidebar took it; false means the caller should open a tab
   * instead (no `my-sider` in this deployment, or its launcher is not mounted).
   */
  openInSidebar: (url: string) => boolean
  /**
   * Read the host's own plugin inventory: one entry per non-group Loader row,
   * with its exact module specifier, its effective enablement, and the phase of
   * its root Fiber.
   *
   * It is the SAME read the Settings → Plugins page performs (`remote.pluginInventory`),
   * not a second source: the drawer's block and the settings page cannot
   * disagree about what is loaded. It rejects when this composition has no
   * inventory unit at all, which the block renders as a state rather than as an
   * empty list — "nothing is loaded" and "nobody can say" are different answers.
   */
  listPlugins: () => Promise<PluginInventorySnapshot>
  /**
   * Read the skill marketplace: which FDE skills this deployment's SkillHub
   * publishes.
   *
   * Like {@link ShellInjected.listPlugins}, this is a read the browser may not
   * perform itself — the host derives a per-reader SkillHub token from the
   * session cookie and never hands it over — so it arrives as this face's
   * method rather than as a URL a component fetches. The identity travels as the
   * cookie the browser already holds, and the two parameters that define what this
   * deployment searches are host-side constants: the only thing a caller may add is
   * a search TERM, which narrows within that frame and cannot name an identity, ask
   * for another asset type, or widen the scope (see `shared/skillswire.ts`).
   *
   * It never rejects for a *domain* failure: an unreachable SkillHub, a refused
   * token, and a login without an email all resolve to `{ ok: false, error }`
   * with a code the modal phrases, because all three are states a reader can be
   * looking at. A rejection here means the DSH host itself could not be reached.
   *
   * @param term - the reader's search term; omitted reads the whole catalogue.
   */
  listMarketSkills: (term?: string) => Promise<SkillResponse<SkillMarketSnapshot>>
  /**
   * What is installed on THIS host, split the way the modal shows it.
   *
   * @param projectPath - the selected project's directory, so the project's two
   * skill roots are scanned as well. Absent means "no project", which narrows the
   * list rather than failing: a reader with no project selected still sees their
   * own skills and the shared ones.
   */
  listInstalledSkills: (projectPath?: string) => Promise<SkillResponse<InstalledSkillSnapshot>>
  /**
   * Install one marketplace skill onto this host.
   *
   * The ONLY write this plugin performs, and the only face method whose answer can
   * be `already-installed`: the host refuses to touch a directory that exists, so a
   * second click on an installed skill changes nothing. The browser names the skill
   * by namespace and slug — never a path, a URL, or a directory — so the caller
   * cannot steer the write.
   */
  installMarketSkill: (request: SkillInstallRequest) => Promise<SkillResponse<SkillInstallResult>>
}

/**
 * The capability this plugin CONSUMES from another plugin: `my-sider`'s docked
 * web sidebar, which can show a page inside the GUI.
 *
 * Declared here as well as in the plugin that provides it, for the same reason
 * the account seats are declared twice: a client bundle may not import a peer's
 * module (the purity gate in tsdown.config.ts), so a cordis service NAME is the
 * whole contract between them. It is reached OPTIONALLY — a deployment without
 * `my-sider` has no `ctx.webSidebar`, and every caller falls back to a plain tab
 * — so this is a capability, never a dependency of the column.
 *
 * `open` answers whether a mounted sidebar took the request. That boolean is the
 * point: without it a missing sidebar would turn a document click into nothing at
 * all, which reads as a broken link.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    webSidebar: {
      /** Show a URL in the docked sidebar; false when no sidebar is mounted. */
      open: (url: string) => boolean
    }
    /**
     * The capability this plugin PROVIDES the other way: show a file's content
     * inside the GUI.
     *
     * `ui-conversation` consumes it (see its `FileViewer` — the shape is declared
     * on both sides for the same reason the seats are), and it is asked first
     * whenever ANY file affordance in the transcript is clicked: a tool row's path
     * link, a prose mention. Answering `true` means "do not hand this path to the
     * editor"; answering `false` keeps the editor, which is what happens for a
     * path outside every registered project, or on a deployment with no sidebar to
     * show it in.
     */
    fileViewer: {
      /** @returns whether this deployment took the path. */
      open: (path: string) => boolean
    }
  }
}

/**
 * The two seats this plugin ADDS to the shipped set: the account dock at the
 * column's bottom-left corner.
 *
 * They exist because the account controls used to live in the frame's top-right
 * corner, owned by a different plugin (`dsh-feishu-login`, which registers the
 * occupants). Moving the controls into this column therefore has to be a SEAT
 * move, not a code move: this plugin owns the geometry (the row, the drawer, and
 * what the drawer holds), and the plugin that owns the identity keeps rendering
 * it. Neither plugin imports the other — a client bundle may not (`tsdown.config.ts`
 * refuses cross-plugin value imports), and a slot key is the same string contract
 * one package's declaration hands another's registration.
 *
 * The owner share is deliberately small: the identity occupant gets the column
 * state and the drawer's open flag so it can render itself for a rail row or a
 * wide row, and a menu row gets only the verb that closes the drawer it sits in.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The signed-in identity inside the column's bottom-left row. Declared by
     * this plugin's `sidebar` entry; the identity's own plugin registers the
     * occupant. The row itself — its button, its chevron, and the drawer it
     * opens — stays this plugin's, so a deployment with no identity plugin still
     * gets a working drawer (see Shell.tsx's fallback).
     */
    'sidebar.account': { kind: 'single'; scope: 'root'; owner: SidebarAccountOwnerProps }
    /**
     * Rows at the bottom of the account drawer, under this plugin's own Usage and
     * Settings rows. Declared by this plugin's `sidebar` entry; the identity
     * plugin registers the one action that ends the session.
     */
    'sidebar.account.menu': { kind: 'list'; scope: 'root'; owner: SidebarAccountMenuOwnerProps }
  }
}

/**
 * Owner share of the account identity seat: the column state its content must
 * render against.
 *
 * Deliberately no `open` flag. The expanded state belongs to the row — a button
 * that carries `aria-expanded` and that the occupant is content INSIDE of — so
 * handing it to the occupant as well would be two homes for one fact, and the
 * two would disagree in the rail, where the row expands the column instead of
 * opening a drawer.
 */
export interface SidebarAccountOwnerProps {
  /** Whether the column renders wide content (false = 56px rail, avatar only). */
  wide: boolean
}

/**
 * Owner share of one row inside the account drawer: nothing.
 *
 * The drawer hands a row no state and no verb, and that is the point — every
 * row this corner has today either acts on the session (sign out, which
 * navigates away or reports its own failure in place) or opens a surface of its
 * own above the drawer (the shipped Settings trigger). Neither needs the drawer
 * closed behind it, so nothing here pretends otherwise; a row that does need a
 * verb gets one when it exists, not before.
 */
export interface SidebarAccountMenuOwnerProps {
  /** Marker field: the row owns its own content and behaviour. */
  children?: never
}

/**
 * The seat this plugin's ACTION ROW declares: one horizontal strip of controls
 * at the conversation header's right, above its hairline.
 *
 * It is the same move as `sidebar.account`, applied to the frame's top-right
 * corner. Two peer plugins each want a control there — this plugin's Git, and
 * `my-sider`'s two panel toggles — and two independently `position: fixed` bars
 * cannot make one row: each would have to know the other's width to know where to
 * start, and the arithmetic breaks silently the moment either gains a control
 * (this plugin's own README keeps a terminal control ready to come back).
 *
 * So the ROW is owned here and the CONTROLS are not: `my-sider` renders its
 * toggles into this seat, keeps its own open state and its own panels, and the
 * strip lays them out. A deployment without `my-sider` gets the row with Git
 * alone, and a deployment without `dsh-web-ui` gets `my-sider`'s own floating bar
 * (see that plugin's index.tsx for the bounded fallback).
 *
 * Declared by the ActionBar registration, not by the sidebar one: a child key
 * belongs to the entry that renders it.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Peer controls sharing this plugin's action row. */
    'shell.action': { kind: 'list'; scope: 'root'; owner: ShellActionOwnerProps }
  }
}

/**
 * Owner share of one control in the action row: nothing.
 *
 * The row supplies no state and no verb, and that is the design — an occupant
 * owns its own control's look, its own open flag, and its own surface. What the
 * row contributes is only what a row can: order, spacing, and a place above the
 * conversation header's line.
 */
export interface ShellActionOwnerProps {
  /** Marker field: the occupant owns its own content and behaviour. */
  children?: never
}

/**
 * Child keys this plugin declares in the same registration that occupies `sidebar`.
 */
export type ShellChildSlots =
  | 'sidebar.brand.mark'
  | 'sidebar.brand.name'
  | 'sidebar.workspaces'
  | 'sidebar.settings'
  | 'sidebar.footer.action'
  | 'sidebar.account'
  | 'sidebar.account.menu'

/**
 * Composed props of the owned column: the frame's column state + the global
 * session/workspace hooks (`PropsRuntime`), every child-render share (the five
 * re-declared seats plus this plugin's own account pair), this plugin's injected
 * face, and the typed `t` seat.
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
