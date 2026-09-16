/**
 * The channel that lets another plugin open a URL in this plugin's web sidebar.
 *
 * Why a channel rather than a direct call: the sidebar's open flag, its width,
 * and its tabs all live in the mounted React tree, while the caller is a
 * different plugin's `apply` — a place with a `ctx` and no DOM. So this plugin
 * PROVIDES a capability on the client context (`ctx.webSidebar`) and the mounted
 * launcher subscribes to it; the two halves of one feature stay on their own side
 * of the React boundary.
 *
 * ## The contract that keeps it from failing quietly
 *
 * `open` returns whether a mounted launcher TOOK the request. A capability that
 * silently does nothing is the worst outcome here — the reader clicks a document
 * and the panel does not move — so the caller can fall back on that boolean and
 * open a tab instead (see `dsh-web-ui`'s document panel, the only caller today).
 *
 * There is deliberately NO buffer for requests that arrive before the launcher
 * mounts. A buffered request would have to be delivered to whoever subscribes
 * next, which is a different reader's click in a different moment; and the case
 * is unreachable in practice — this plugin's launcher mounts with the frame,
 * long before anyone can click a document row. An untaken request is reported as
 * untaken instead, which the caller can act on.
 *
 * @module my-sider/client/sidebar
 */

/** One accepted request, with the id the launcher de-duplicates on. */
export interface WebSidebarRequest {
  /** Monotonic: two clicks on the same URL are two requests, not one. */
  readonly id: number
  /** The absolute address to show. */
  readonly url: string
}

/** What this plugin provides on the client context. */
export interface WebSidebarFace {
  /**
   * Show a URL in the docked web sidebar, opening the panel if it is closed.
   * @param url - the absolute address; an empty string is refused.
   * @returns whether a mounted launcher took the request.
   */
  open: (url: string) => boolean
}

/** The half the launcher holds. */
export interface WebSidebarChannel {
  /**
   * Take every request from now on.
   * @param listener - called once per accepted request.
   * @returns the unsubscribe handle.
   */
  subscribe: (listener: (request: WebSidebarRequest) => void) => () => void
}

/**
 * Build the two halves of one channel. Built per activation, never at module
 * level: a module-level channel would survive a plugin reload as a stale
 * singleton still holding a dead launcher's listener.
 * @returns the provided face and the launcher's subscription handle.
 */
export function createWebSidebar(): { face: WebSidebarFace; channel: WebSidebarChannel } {
  const listeners = new Set<(request: WebSidebarRequest) => void>()
  let sequence = 0

  return {
    face: {
      open: (url) => {
        if (url === '' || listeners.size === 0) return false
        const request: WebSidebarRequest = { id: (sequence += 1), url }
        for (const listener of listeners) listener(request)
        return true
      },
    },
    channel: {
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
  }
}
