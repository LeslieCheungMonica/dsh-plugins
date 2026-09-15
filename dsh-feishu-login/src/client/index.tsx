/**
 * `dsh-feishu-login` — browser half.
 *
 * One registration into the frame's `shell.overlay` seat (a list slot: additive,
 * and click-through until the entry opts in), plus the small controller behind
 * it. That is all this half is allowed to be: the host owns the OAuth exchange,
 * the identity check, the signed session, and the document gate, and it already
 * refuses to serve the GUI to a tab without a session. What is left for the
 * browser is the case the server cannot see — a session that expires while the
 * page stays open — and the small courtesy of showing who is signed in.
 *
 * Why `shell.overlay` and not `root`: a single slot has exactly one occupant,
 * so registering into `root` would shadow `ui-layout`'s frame and take every
 * seat it declares (sidebar, conversation, details) off the page with it. The
 * overlay seat is the additive one, and a fixed, opaque child of it covers the
 * whole frame while pointer events stay on this entry only.
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
import { Gate, HeaderChip } from './Gate.tsx'
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

  // The session header's utilities row: the chip's home while a session is
  // open, and the seat the shipped Session-log button occupies.
  ctx.slots.inject('conversation.session.header.utilities', () => {
    const disposers: Array<() => void> = []
    try {
      // Replacing a shipped cell is done by id, not by CSS: a list slot holds
      // one cell per id and the lowest priority wins, so claiming this id at
      // priority -1 removes the button from the header (and from the tab order,
      // and from the accessibility tree) without touching the package that
      // ships it — whose download dialog and `/export` command stay intact.
      if (config.hideSessionLog) {
        disposers.push(ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'session-log-download',
          priority: -1,
          registrant: 'dsh-feishu-login',
        }, () => null))
      }
      disposers.push(ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'feishu-login-account',
        order: 100,
        locale: NS,
        inject: () => face,
        registrant: 'dsh-feishu-login',
      }, HeaderChip))
    } catch (error) {
      // A header row is a convenience; the gate itself is host-side.
      console.warn('dsh-feishu-login: could not register the header chip', error)
    }
    return () => { for (const dispose of disposers) dispose() }
  })

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
