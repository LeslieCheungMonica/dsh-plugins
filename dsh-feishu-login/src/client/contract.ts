/**
 * The browser half's contract: what the host told the page before it booted,
 * what the session probe answers, and the business face the slot component
 * receives instead of a `ctx`.
 *
 * The client cannot read the Loader row's configuration — a browser bundle is
 * loaded by URL and sees no host config — so the two facts it genuinely needs
 * (the endpoint prefix and the login page's path) arrive through the same
 * injected script that performs the pre-boot gate: `window.__DSH_FEISHU_LOGIN__`,
 * written by the host's index tap. Everything here degrades to a safe default
 * when that global is missing (a stale page served before the plugin armed),
 * and a missing global never blocks anything.
 */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { FeishuLoginKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
export const NS = 'feishulogin'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's browser copy. */
    feishulogin: FeishuLoginKey
  }
}

/** The global the host's index tap writes before the app boots. */
export const CONFIG_GLOBAL = '__DSH_FEISHU_LOGIN__'

/** What the host tells the browser about this deployment. */
export interface ClientConfig {
  /**
   * Whether the host actually armed the gate. The index tap writes this object
   * only when it has an application id and a resolvable secret, so its absence
   * *is* the "not armed" signal — and the browser half then does nothing at
   * all: no probe, no DOM, no request.
   */
  armed: boolean
  /** Route prefix of the JSON/OAuth endpoints (no trailing slash). */
  prefix: string
  /** Path of the host-rendered login page. */
  loginUrl: string
  /** Whether the signed-in chip is wanted. */
  accountChip: boolean
  /**
   * Whether to hide the shipped "Session log" download button from the session
   * header. This deployment puts the account chip in that corner instead, and
   * two controls fighting over 28px is one too many.
   */
  hideSessionLog: boolean
  /** Product name, for the chip's title attribute. */
  brandName: string
}

/** The fallback used when the injected global is absent (an unarmed host). */
export const DEFAULT_CONFIG: ClientConfig = {
  armed: false,
  prefix: '/feishu-auth',
  loginUrl: '/login',
  accountChip: true,
  hideSessionLog: true,
  brandName: 'ForgeX',
}

/**
 * Read the injected configuration.
 * @returns the host's values; `armed: false` when the host injected nothing.
 */
export function readClientConfig(): ClientConfig {
  const raw = (globalThis as Record<string, unknown>)[CONFIG_GLOBAL]
  if (raw === null || typeof raw !== 'object') return DEFAULT_CONFIG
  const source = raw as Partial<ClientConfig>
  return {
    armed: true,
    prefix: typeof source.prefix === 'string' && source.prefix !== '' ? source.prefix : DEFAULT_CONFIG.prefix,
    loginUrl: typeof source.loginUrl === 'string' && source.loginUrl !== '' ? source.loginUrl : DEFAULT_CONFIG.loginUrl,
    accountChip: source.accountChip !== false,
    hideSessionLog: source.hideSessionLog !== false,
    brandName: typeof source.brandName === 'string' && source.brandName !== '' ? source.brandName : DEFAULT_CONFIG.brandName,
  }
}

/** The identity the host reports for a signed-in tab. */
export interface SessionUser {
  /** Display name (falls back to the open id on the host side). */
  name: string
  /** Feishu `open_id`. */
  openId: string
  /** Email address, when the application may read it. */
  email?: string | undefined
  /** Avatar image URL, when Feishu returned one. */
  avatarUrl?: string | undefined
  /** Session expiry, in Unix seconds. */
  expiresAt: number
}

/** What `<prefix>/session` answers. */
export interface SessionProbe {
  /** False when the gate is not armed (no appId, or no resolvable secret). */
  configured: boolean
  /** Whether this browser carries a valid session. */
  authenticated: boolean
  /** The login page's path. */
  loginUrl?: string | undefined
  /** The signed-in identity. */
  user?: SessionUser | undefined
}

/** The gate's snapshot. */
export type GateState =
  /** Nothing is known yet (first paint, or the probe failed): render nothing. */
  | { kind: 'unknown' }
  /** The host says the gate is not armed: this plugin is transparent. */
  | { kind: 'off' }
  /** Signed in. */
  | { kind: 'in'; user: SessionUser }
  /** Not signed in: the app must not be usable. */
  | { kind: 'out'; loginUrl: string }

/** A pull-model snapshot handle (the `useSyncExternalStore` contract). */
export interface GateStore {
  /** Subscribe to snapshot changes. */
  subscribe: (listener: () => void) => () => void
  /** Read the current snapshot (a stable object between changes). */
  getSnapshot: () => GateState
}

/** The business face this plugin's `apply` hands its slot component. */
export interface GateFace {
  /** Deployment facts from the host. */
  config: ClientConfig
  /** The gate's snapshot handle. */
  store: GateStore
  /** Re-probe the host. */
  refresh: () => void
  /** End the session on the host and land on the login page. */
  logout: () => Promise<void>
}

/**
 * Composed props of the gate entry: this plugin's injected face plus the typed
 * `t` seat. `shell.overlay` is a list slot in the root scope, so there are no
 * owner props to merge.
 */
export type GateProps = PropsRuntime<'shell.overlay'> & PropsLocale<typeof NS> & GateFace

/**
 * Composed props of the session-header entry. The seat's own owner share is
 * empty (the header hands an action nothing but the session scope), so this is
 * the standard runtime kit, the typed `t` seat, and this plugin's face.
 */
export type HeaderChipProps =
  & PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof NS>
  & GateFace
