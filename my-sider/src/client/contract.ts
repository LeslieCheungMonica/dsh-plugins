/**
 * What this plugin's browser half registers, and the types that go with it.
 *
 * The launcher's seat is `shell.action`: the one-row strip of controls that
 * `dsh-web-ui` renders at the conversation header's right, above its hairline,
 * and declares for exactly this purpose. Two independently `position: fixed` bars
 * cannot make one row — each would need the other's width to know where to start
 * — so whoever renders the strip owns it and peer plugins put their controls in
 * it.
 *
 * The FALLBACK seat is `shell.overlay`: the frame's additive, root-scope,
 * click-through floating layer (declared by ui-layout inside AppFrame). Additive
 * is why it is the right fallback — a fresh `id` sits BESIDE whatever else is
 * there instead of shadowing it — and a deployment with no `dsh-web-ui` has no
 * strip for the launcher to live in, so there it pins its own bar.
 *
 * The type-only import below pulls ui-layout's SlotMap merge, so
 * `PropsRuntime<'shell.overlay'>` resolves to the frame's global kit — the
 * session and workspace hooks this launcher reads the current project from.
 *
 * @module my-sider/client/contract
 */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { MySiderKey } from './locales.ts'
import type { WebSidebarChannel, WebSidebarFace } from './sidebar.ts'

/**
 * The capability this plugin PROVIDES for other plugins: open a URL in the docked
 * web sidebar.
 *
 * A cordis service, because that is the sanctioned way for one plugin to reach
 * another's VALUE (a client bundle may not import a peer's module — see the
 * purity rule in `dsh-web-ui`'s tsdown config), and because a caller must be able
 * to ask for it OPTIONALLY: a deployment without this plugin simply has no
 * `ctx.webSidebar`, and the caller falls back to opening a tab.
 *
 * Declared here on the client `Context` so both halves of this plugin — the
 * `apply` that provides it and the launcher that subscribes — agree on the shape
 * without a shared runtime value.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    webSidebar: WebSidebarFace
  }
}

export type { WebSidebarFace }

/** Dictionary namespace owned by this plugin. */
export const NS = 'mysider'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's panel copy. */
    mysider: MySiderKey
  }
}

/**
 * The action-row seat `dsh-web-ui` declares, restated here with the same shape.
 *
 * A slot key is a contract, not a symbol: the declaring plugin ships no type
 * declarations (this composition's plugins share types through the framework
 * packages, never through each other), so the registering side declares the share
 * it consumes and interface merging makes the two one. Identical members are the
 * price of a cross-plugin contract no package.json can express.
 *
 * A deployment without `dsh-web-ui` never declares this key, so the registration
 * in index.tsx simply never lands — which is why the launcher keeps its own
 * pinned bar as a bounded fallback.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Peer controls sharing `dsh-web-ui`'s action row. */
    'shell.action': { kind: 'list'; scope: 'root'; owner: ShellActionOwnerProps }
  }
}

/**
 * Owner share of one control in that row, as `dsh-web-ui` passes it: nothing. The
 * row contributes order and spacing; the occupant owns its control's look, its
 * open flags, and its panels.
 */
export interface ShellActionOwnerProps {
  /** Marker field: the occupant owns its own content and behaviour. */
  children?: never
}

/**
 * Composed props of the launcher: the frame's global session/workspace hooks,
 * this plugin's injected placement fact and sidebar channel, and the typed `t`
 * seat.
 *
 * The injected face carries only whether the launcher renders INSIDE the shared
 * strip or as its own pinned bar. That difference is geometry the component
 * cannot read off the slot it occupies — both seats are root-scope list seats
 * with an empty owner share, so they are indistinguishable from props alone.
 *
 * There is deliberately no other injected business face. Both panels speak to the
 * host over their own routes and to the frame through these hooks, so the
 * launcher needs no service from `apply` — which keeps its registration identity
 * stable across reloads.
 */
export type LauncherProps =
  & PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>
  & {
    readonly inRow: boolean
    /** Where another plugin's "open this in the sidebar" requests arrive. */
    readonly requests: WebSidebarChannel
  }
