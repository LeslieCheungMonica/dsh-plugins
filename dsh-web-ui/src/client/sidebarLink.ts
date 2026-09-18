/**
 * The sidebar-link capability's PROVIDER side: which peers can show a page
 * inside the GUI, and what this plugin hands each of them.
 *
 * A Feishu document is something a reader wants BESIDE the conversation — the
 * folder while a session works in it, the evidence while a gate is being filled
 * in — so every link this plugin draws asks for the GUI first and only falls back
 * to a system tab. That question is `openInSidebar(url): boolean`, and this
 * module is the half that answers it (the consumers are the panel and the gate
 * dialog, which ask and then open a tab when the answer is `false`).
 *
 * Two peers can hold a sidebar in this deployment's history, and a deployment may
 * have either:
 *
 * - **`my-sider`** publishes `ctx.webSidebar` whose `open` already answers a
 *   boolean, so its adapter is a delegate.
 * - **`better-sidebar`** publishes `ctx.betterSidebar`, a general tab registry.
 *   Its browser tab is opened through `openTab({ type: 'browser', url, title })`
 *   — the same seed its own link takeover builds (`lib/client.js`).
 *
 * Both are reached as cordis service NAMES, never as imports: a client bundle may
 * not import a peer's module (the purity gate in `tsdown.config.ts`), so the
 * structural shapes below are the whole contract between the two sides.
 *
 * **Why the `better-sidebar` adapter asks before opening.** `openTab` returns
 * nothing and, per its own documentation, refuses quietly in two states this
 * plugin cannot see otherwise: a tab type disabled in the sidebar's settings, and
 * no active session to land the tab in. Answering `true` in those states would
 * make a document click do NOTHING at all — the precise failure this capability's
 * boolean exists to prevent — so both gates are checked here and reported as `false`,
 * which sends the caller to a system tab instead.
 *
 * @module dsh-web-ui/client/sidebarLink
 */

/**
 * Show a URL inside the GUI.
 *
 * @param url - the absolute link the host built.
 * @returns whether a sidebar took it; `false` means the caller opens a tab.
 */
export type OpenInSidebar = (url: string) => boolean

/**
 * `my-sider`'s `ctx.webSidebar`: show a page in its docked panel.
 *
 * `open` is the whole contract, and its boolean is the point — a missing sidebar
 * has to be distinguishable from a sidebar that took the link.
 */
export interface WebSidebarService {
  /** @returns whether a mounted sidebar took the URL. */
  open: (url: string) => boolean
}

/** The tab seed `better-sidebar` opens a tab with. */
export interface BetterSidebarTabSeed {
  /** Tab type id; the browser tab's is {@link BROWSER_TAB}. */
  type: string
  /** The URL the tab navigates to on mount. */
  url?: string
  /** Tab label; the browser tab is labelled with the host it shows. */
  title?: string
}

/** The part of `better-sidebar`'s snapshot this plugin reads. */
export interface BetterSidebarSnapshot {
  /** The active session, or undefined while none is active. */
  sessionId: string | undefined
}

/**
 * `better-sidebar`'s `ctx.betterSidebar`, as far as this plugin consumes it.
 *
 * Deliberately narrower than the peer's own interface: this plugin opens ONE tab
 * type and needs the two questions that decide whether that open would land. The
 * real service is structurally assignable to this, so nothing has to be declared
 * twice (see the capability declaration in `contract.ts`).
 */
export interface BetterSidebarService {
  /** Whether a tab type is enabled; an unset preference means enabled. */
  isTabEnabled: (id: string) => boolean
  /** The current state, of which only the active session is read. */
  getSnapshot: () => BetterSidebarSnapshot
  /**
   * Open a tab. Refuses quietly — no answer, no throw — for a disabled type and
   * for a deployment with no active session, which is why this plugin asks
   * {@link BetterSidebarService.isTabEnabled} and the snapshot first.
   */
  openTab: (seed: BetterSidebarTabSeed) => void
}

/** Tab type id `better-sidebar` gives its in-sidebar browser. */
export const BROWSER_TAB = 'browser'

/**
 * The host a link points at, as the label for the tab showing it.
 *
 * The peer labels its browser tabs with the hostname (that is what its own link
 * takeover passes), and a document link is far more legible as
 * `asiainfo-sec.feishu.cn` than as an opaque token.
 *
 * @param url - the link being opened.
 * @returns the hostname, or undefined when the URL cannot be parsed.
 */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname
  } catch {
    // Not a parseable absolute URL. The peer owns its own address gate (it
    // normalizes and refuses what it will not navigate), so this is not the
    // place to duplicate that policy: the link is handed over untitled.
    return undefined
  }
}

/**
 * Adapt `my-sider`'s sidebar to the capability.
 * @param service - its published client service.
 * @returns the opener.
 */
export function webSidebarOpener(service: WebSidebarService): OpenInSidebar {
  return (url) => service.open(url)
}

/**
 * Adapt `better-sidebar`'s browser tab to the capability.
 *
 * @param service - its published client service.
 * @returns the opener, which answers `false` for every state in which the peer
 * would drop the open — see this module's own note on why that matters.
 */
export function betterSidebarOpener(service: BetterSidebarService): OpenInSidebar {
  return (url) => {
    // An empty link would open an empty tab; the callers guard this too, but the
    // capability is asked by more than one of them.
    if (url === '') return false
    if (!service.isTabEnabled(BROWSER_TAB)) return false
    if (service.getSnapshot().sessionId === undefined) return false
    const host = hostOf(url)
    service.openTab(host === undefined ? { type: BROWSER_TAB, url } : { type: BROWSER_TAB, url, title: host })
    return true
  }
}

/**
 * Ask every mounted peer, in order, and report whether one took the link.
 *
 * The list is read LIVE on each call rather than captured as a snapshot: this
 * plugin arms each peer from its own `ctx.inject` (whose callback lands whenever
 * that peer appears, and which is also where the disarm happens), so which peers
 * exist is a fact that changes after this function was built.
 *
 * @param openers - the peers currently mounted, in the order they should be asked.
 * @returns the composed capability.
 */
export function combineOpeners(openers: readonly OpenInSidebar[]): OpenInSidebar {
  return (url) => {
    for (const open of openers) {
      if (open(url)) return true
    }
    return false
  }
}
