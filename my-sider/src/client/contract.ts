/**
 * What this plugin's browser half registers, and the types that go with it.
 *
 * The seat is `shell.overlay`: the frame's additive, root-scope, click-through
 * floating layer (declared by ui-layout inside AppFrame). Additive is the whole
 * reason it is the right seat — a fresh `id` sits BESIDE whatever else is there
 * (a git control, a status pill) instead of shadowing it, and a `single` seat
 * like `sidebar` or `details` would instead make this plugin the sole owner of a
 * region another plugin already renders into.
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

/** Dictionary namespace owned by this plugin. */
export const NS = 'mysider'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's panel copy. */
    mysider: MySiderKey
  }
}

/**
 * Composed props of the launcher: the frame's global session/workspace hooks and
 * this plugin's typed `t` seat.
 *
 * There is deliberately no injected business face. Both panels speak to the host
 * over their own routes and to the frame through these hooks, so the launcher
 * needs no service from `apply` — which keeps the registration's identity stable
 * across reloads.
 */
export type LauncherProps =
  & PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>
