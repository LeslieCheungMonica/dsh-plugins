/**
 * `dsh-feishu-login` — browser half.
 *
 * Three registrations and the small controller behind them. The host owns the
 * OAuth exchange, the identity check, the signed session, and the document gate,
 * and it already refuses to serve the GUI to a tab without a session. What is
 * left for the browser is the case the server cannot see — a session that expires
 * while the page stays open — and the small courtesy of showing who is signed in.
 *
 * - `shell.overlay` (a list slot: additive, and click-through until the entry
 *   opts in) carries the blocking gate. Why not `root`: a single slot has
 *   exactly one occupant, so registering into `root` would shadow `ui-layout`'s
 *   frame and take every seat it declares (sidebar, conversation, details) off
 *   the page with it. The overlay seat is the additive one, and a fixed, opaque
 *   child of it covers the whole frame while pointer events stay on this entry
 *   only.
 * - `sidebar.account` and `sidebar.account.menu` carry the identity and the
 *   sign-out row, inside the sidebar column's bottom-left account dock. Both
 *   keys belong to `dsh-web-ui`; this plugin fills them (see contract.ts for why
 *   the share is declared on both sides).
 * - `conversation.session.header.utilities` carries the shipped Session-log
 *   button's removal, plus the ORIGINAL corner capsule as a bounded fallback for
 *   a deployment with no `dsh-web-ui` to put the account dock on the page.
 *
 * @module dsh-feishu-login/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls ui-layout's SlotMap merge, which is what declares
// `shell.overlay` (owner share: none — a list seat).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls ui-conversation's SlotMap merge, which declares the session
// header's list seats (owner share: empty).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AccountMenu, AccountTrigger, Gate, HeaderChip } from './Gate.tsx'
import {
  NS, readClientConfig,
  type ClientConfig, type GateFace, type GateState, type GateStore, type SessionProbe,
} from './contract.ts'
import { en, zh } from './locales.ts'
import { STYLES, STYLE_TAG_ID } from './styles.ts'

/** Services this plugin reaches for; every one must exist or the fiber waits. */
export const inject = ['slots', 'locale']

/** The gate entry's id inside the `shell.overlay` cell table. */
const ENTRY_ID = 'feishu-login-gate'

/**
 * How long the account seats get to appear before the header capsule is armed
 * as a fallback (ms). `dsh-web-ui` declares them synchronously in its own apply,
 * so anything measurable here already means it is absent — or still inside its
 * own ~5s takeover retry, which is why this grace period is generous rather than
 * tight: a double-drawn account control for a moment is worse than a corner
 * capsule for a moment.
 */
const HEADER_FALLBACK_MS = 2000

/**
 * The gate's controller: a pull-model snapshot plus the two host calls it
 * wraps. Built per activation (never at module level: a module-level store
 * would survive a plugin reload as a stale singleton).
 * @param config - the deployment facts injected by the host's index tap.
 * @returns the store handle and the verbs the component calls.
 */
function createController(config: ClientConfig): {
  store: GateStore
  refresh: () => void
  logout: () => Promise<void>
} {
  let snapshot: GateState = { kind: 'unknown' }
  const listeners = new Set<() => void>()

  const set = (next: GateState): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }

  const probe = async (): Promise<void> => {
    try {
      const response = await fetch(`${config.prefix}/session`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      // No route at all: this plugin is not armed (or not installed at all).
      // Silence is the correct rendering for that.
      if (response.status === 404) { set({ kind: 'off' }); return }
      if (!response.ok) return
      const body = await response.json() as SessionProbe
      if (body.configured !== true) { set({ kind: 'off' }); return }
      const loginUrl = typeof body.loginUrl === 'string' && body.loginUrl !== ''
        ? body.loginUrl
        : config.loginUrl
      if (body.authenticated === true && body.user !== undefined) set({ kind: 'in', user: body.user })
      else set({ kind: 'out', loginUrl })
    } catch {
      // A transport failure is not an answer: keep the current snapshot, and
      // never gate on a probe that did not come back.
    }
  }

  const logout = async (): Promise<void> => {
    const response = await fetch(`${config.prefix}/logout`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`logout failed with ${String(response.status)}`)
    set({ kind: 'out', loginUrl: config.loginUrl })
    globalThis.location.replace(config.loginUrl)
  }

  void probe()

  return {
    store: {
      subscribe: (listener) => {
        listeners.add(listener)
        // A late subscriber (a remount) must still learn where things stand.
        if (snapshot.kind === 'unknown') void probe()
        return () => { listeners.delete(listener) }
      },
      getSnapshot: () => snapshot,
    },
    refresh: () => { void probe() },
    logout,
  }
}

/**
 * Install the plugin: stylesheet, dictionary, and the overlay entry.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset['plugin'] = 'dsh-feishu-login'
    tag.dataset['pluginCss'] = STYLE_TAG_ID
    tag.textContent = STYLES
    document.head.append(tag)
    return () => { tag.remove() }
  }, 'dsh-feishu-login: stylesheet')

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-feishu-login: dictionaries')

  const config = readClientConfig()
  // Not armed: the host told us nothing, because it has no application id or no
  // resolvable secret. Registering nothing is the honest rendering of that —
  // and it keeps the plugin at zero cost on a host that never configured it.
  if (!config.armed) return

  const controller = createController(config)
  const face: GateFace = {
    config,
    store: controller.store,
    refresh: controller.refresh,
    logout: controller.logout,
  }

  // Replacing a shipped cell is done by id, not by CSS: a list slot holds one
  // cell per id and the lowest priority wins, so claiming this id at priority -1
  // removes the button from the header (and from the tab order, and from the
  // accessibility tree) without touching the package that ships it — whose
  // download dialog and `/export` command stay intact. This one is NOT a
  // fallback: the account no longer lives in that corner either way.
  if (config.hideSessionLog) {
    ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'session-log-download',
      priority: -1,
      registrant: 'dsh-feishu-login',
    }, () => null))
  }

  // The sidebar column's account seats: where the identity and the sign-out
  // action live now. `dsh-web-ui` declares both keys in its own `sidebar`
  // registration, so `slots.inject` is what makes this order-independent —
  // whichever row activates first, these land once the seats exist.
  //
  // The header chip stays registered as a BOUNDED fallback, because a deployment
  // that installs this plugin WITHOUT `dsh-web-ui` never declares those keys:
  // `slots.inject` would then simply never fire, and that page would have no way
  // to sign out at all — a worse outcome than the corner chip this change
  // exists to remove. Two things bound it: the timer (the seat is declared
  // synchronously in `dsh-web-ui`'s own apply, so the fallback only ever
  // survives when that plugin is genuinely absent or still retrying its own
  // takeover), and the seat itself arriving, which retires the fallback for
  // good.
  ctx.effect(() => {
    let accountLive = false
    let disposeHeader: (() => void) | undefined

    const armHeaderChip = (): void => {
      if (accountLive || disposeHeader !== undefined) return
      disposeHeader = ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'feishu-login-account',
        order: 100,
        locale: NS,
        inject: () => face,
        registrant: 'dsh-feishu-login',
      }, HeaderChip))
    }

    const timer = globalThis.setTimeout(armHeaderChip, HEADER_FALLBACK_MS)

    const disposeWait = ctx.slots.inject('sidebar.account', () => {
      accountLive = true
      globalThis.clearTimeout(timer)
      disposeHeader?.()
      disposeHeader = undefined

      const disposers: Array<() => void> = []
      try {
        disposers.push(ctx.slots.register({
          name: 'sidebar.account',
          locale: NS,
          inject: () => face,
          registrant: 'dsh-feishu-login',
        }, AccountTrigger))
        // The drawer's own row. This plugin declares nothing: the seats, and the
        // drawer that renders them, belong to the column. Registering the action
        // inside the identity's own effect keeps the two arriving together — a
        // drawer with an identity and no way out of it would be the one state
        // worth avoiding.
        disposers.push(ctx.slots.inject('sidebar.account.menu', () => ctx.slots.register({
          name: 'sidebar.account.menu',
          // A list slot holds one cell per id; this one signs the tab out.
          id: 'feishu-login-sign-out',
          locale: NS,
          inject: () => face,
          registrant: 'dsh-feishu-login',
        }, AccountMenu)))
      } catch (error) {
        // An identity is a convenience; the gate itself is host-side.
        console.warn('dsh-feishu-login: could not register the sidebar account controls', error)
      }
      return () => {
        for (const dispose of disposers) dispose()
        // The seat is gone again: this is a plugin unload or a reload of the
        // column, and the page is about to lose its only sign-out control with
        // it. Re-arming happens on a later task so the new effect is not created
        // inside this one's teardown; the fiber's own unload disarms it anyway.
        accountLive = false
        globalThis.setTimeout(armHeaderChip, 0)
      }
    })

    return () => {
      globalThis.clearTimeout(timer)
      disposeHeader?.()
      disposeWait()
    }
  }, 'dsh-feishu-login: sidebar account controls')

  // `shell.overlay` is declared by ui-layout's root registration, so this waits
  // for the seat through slots.inject: whichever row activates first, the entry
  // lands once the seat exists. `order` puts it above the shipped overlays.
  ctx.slots.inject('shell.overlay', () => {
    try {
      return ctx.slots.register({
        name: 'shell.overlay',
        id: ENTRY_ID,
        order: 1000,
        locale: NS,
        inject: () => face,
        registrant: 'dsh-feishu-login',
      }, Gate)
    } catch (error) {
      // A gate that cannot mount must not take the page down with it: the
      // server-side gate and the pre-boot script are still in force.
      console.warn('dsh-feishu-login: could not register the gate overlay', error)
      return () => {}
    }
  })
}
