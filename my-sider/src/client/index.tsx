/**
 * `my-sider` — browser half.
 *
 * What this plugin does, in one line: two operator panels, opened from a floating
 * launcher — a sidebar whose tabs each open a web address, and a bottom panel that
 * runs bash command lines in the current project.
 *
 * Why it can be built entirely out of one slot: both surfaces are this plugin's
 * OWN floating chrome, so neither needs a region of the frame. They register as
 * one entry in `shell.overlay` — the additive, root-scope, click-through list seat
 * inside AppFrame — and the panels themselves render through a portal onto
 * `document.body`, because a docked panel must not live inside a column whose grid
 * tracks animate.
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
import { en, zh } from './locales.ts'
import { STYLES, STYLE_TAG_ID } from './styles.ts'

/** Services this plugin reaches for; every one must exist or the fiber waits. */
export const inject = ['slots', 'locale']

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

  // The seat is declared by ui-layout's AppFrame, which may register after this
  // plugin does; `inject` waits for the declaration instead of assuming it, and
  // hands back the disposer this effect owns.
  ctx.slots.inject('shell.overlay', () => {
    try {
      return ctx.slots.register({
        name: 'shell.overlay',
        // A fresh id: this entry is ADDED beside the seat's other occupants
        // rather than shadowing them.
        id: 'my-sider-panels',
        order: 20,
        label: 'my-sider',
        locale: NS,
        registrant: 'my-sider',
      }, Launcher)
    } catch (error) {
      // The panels are chrome: without them the page is still a working page.
      console.warn('my-sider: could not register the panel launcher', error)
      return () => {}
    }
  })
}
