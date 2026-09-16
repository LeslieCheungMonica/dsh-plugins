/**
 * `my-sider` — browser half.
 *
 * What this plugin does, in one line: two operator panels, opened from a floating
 * launcher — a sidebar whose tabs each open a web address, and a bottom panel that
 * runs bash command lines in the current project.
 *
 * Why it can be built almost entirely out of slots: both surfaces are this
 * plugin's OWN floating chrome, so neither needs a region of the frame. The
 * panels render through a portal onto `document.body`, because a docked panel must
 * not live inside a column whose grid tracks animate, and the two toggles that
 * open them register as one entry — in `dsh-web-ui`'s shared action strip when it
 * is there, and in this plugin's own pinned bar when it is not.
 *
 * That choice is also what makes this plugin safe to install beside others: it
 * occupies no `single` seat, declares no child seats, disables no shipped row, and
 * therefore cannot take another plugin's home away. The cost is that it owns its
 * own geometry and z-order, which is exactly what `styles.ts` spells out.
 *
 * Everything below the registration is plumbing: a namespaced dictionary, one
 * lifecycle-scoped stylesheet, and the registration itself — which waits for the
 * seat through `slots.inject`, so load order never matters.
 *
 * @module my-sider/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { Launcher } from './Launcher.tsx'
import { NS } from './contract.ts'
import { createWebSidebar } from './sidebar.ts'
import { en, zh } from './locales.ts'
import { STYLES, STYLE_TAG_ID } from './styles.ts'

/** Services this plugin reaches for; every one must exist or the fiber waits. */
export const inject = ['slots', 'locale']

/**
 * How long the shared action strip gets to appear before this plugin pins its own
 * bar instead (ms). `dsh-web-ui` declares the strip synchronously in its own
 * apply, so anything measurable here already means that plugin is absent — or
 * still inside its own registration wait, which is why the grace period is
 * generous rather than tight.
 */
const STRIP_FALLBACK_MS = 2000

/**
 * Install the plugin: stylesheet, dictionary, and the launcher registration.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // One stylesheet per fiber lifetime. The tag carries the ids the HMR driver and
  // the module system use to attribute and drop plugin-owned CSS, and the effect
  // removes it on unload instead of leaving it orphaned.
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset['plugin'] = 'my-sider'
    tag.dataset['pluginCss'] = STYLE_TAG_ID
    tag.textContent = STYLES
    document.head.append(tag)
    return () => { tag.remove() }
  }, 'my-sider: stylesheet')

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'my-sider: dictionaries')

  // The capability other plugins reach for: show a URL in this sidebar. Provided
  // here and consumed by the launcher below, because the two halves live on
  // different sides of the React boundary (see sidebar.ts). `ctx.webSidebar.open`
  // answers whether the mounted launcher took the request, so a caller can fall
  // back to a plain tab instead of clicking into nothing.
  const sidebar = createWebSidebar()
  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('webSidebar', sidebar.face)
    return () => { void disposeService() }
  }, 'my-sider: web sidebar capability')

  // TWO registration paths, one launcher. The preferred home is the shared
  // action strip `dsh-web-ui` renders at the conversation header's right and
  // declares for exactly this (`shell.action`); the fallback is this plugin's own
  // pinned bar in `shell.overlay`, for a deployment that installs this plugin
  // WITHOUT `dsh-web-ui`.
  //
  // The fallback is bounded rather than permanent: `dsh-web-ui` declares its seats
  // synchronously in its own apply, so the timer only ever fires when that plugin
  // is absent — or while its own registration is still waiting on the overlay
  // seat. Whichever path wins is the one the operator sees; the two are exclusive
  // by construction, because the strip's copy is disposed the moment the fallback
  // is armed and the fallback is disposed the moment the strip appears.
  ctx.effect(() => {
    let inStrip = false
    let disposePinned: (() => void) | undefined

    const pinOwnBar = (): void => {
      if (inStrip || disposePinned !== undefined) return
      disposePinned = ctx.slots.inject('shell.overlay', () => {
        try {
          return ctx.slots.register({
            name: 'shell.overlay',
            // A fresh id: this entry is ADDED beside the seat's other occupants
            // rather than shadowing them.
            id: 'my-sider-panels',
            order: 20,
            label: 'my-sider',
            locale: NS,
            inject: () => ({ inRow: false, requests: sidebar.channel }),
            registrant: 'my-sider',
          }, Launcher)
        } catch (error) {
          // The panels are chrome: without them the page is still a working page.
          console.warn('my-sider: could not register the panel launcher', error)
          return () => {}
        }
      })
    }

    const timer = globalThis.setTimeout(pinOwnBar, STRIP_FALLBACK_MS)

    const disposeWait = ctx.slots.inject('shell.action', () => {
      inStrip = true
      globalThis.clearTimeout(timer)
      disposePinned?.()
      disposePinned = undefined

      let dispose: (() => void) | undefined
      try {
        dispose = ctx.slots.register({
          name: 'shell.action',
          // Same id as the pinned entry: the two are never live at once, and one
          // name for this plugin's launcher keeps diagnostics readable.
          id: 'my-sider-panels',
          order: 20,
          label: 'my-sider',
          locale: NS,
          inject: () => ({ inRow: true, requests: sidebar.channel }),
          registrant: 'my-sider',
        }, Launcher)
      } catch (error) {
        console.warn('my-sider: could not register the panel launcher in the action row', error)
      }
      return () => {
        dispose?.()
        // The strip is gone again (a plugin unload, a reload of `dsh-web-ui`):
        // re-arming happens on a later task so the new effect is not created
        // inside this one's teardown.
        inStrip = false
        globalThis.setTimeout(pinOwnBar, 0)
      }
    })

    return () => {
      globalThis.clearTimeout(timer)
      disposePinned?.()
      disposeWait()
    }
  }, 'my-sider: launcher')
}
