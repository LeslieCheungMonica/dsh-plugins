/**
 * `dsh-web-ui` — browser half.
 *
 * What this plugin does, in one line: it takes the frame's left column over and
 * re-declares the seats the shipped shell used to own, so the shipped region
 * occupants render inside a column this plugin designed — one whose header
 * carries a project (workspace) dropdown and a New Project button directly
 * above the New Session button.
 *
 * Why it works at all: a slot's occupant is chosen by priority, and a slot's
 * CHILD declarations belong to whoever declares them. Registering `sidebar` at
 * a lower priority would only shadow the shipped shell — the seats it declared
 * would disappear with it, taking the workspace browser and the settings shell
 * off the page. Disabling the shipped shell's Loader row instead leaves the
 * `sidebar` name undeclared, so this plugin declares it together with the same
 * five child keys, and every shipped occupant registers into this column
 * unchanged. That is the zero-loss replacement (see cordis.patch.yml).
 *
 * Everything below the registration is plumbing: a namespaced dictionary, one
 * lifecycle-scoped stylesheet, and the registration itself with a bounded retry
 * for the window in which the disabled shell row is still disposing.
 *
 * One seat is NOT this plugin's to declare: the conversation hero's brand mark
 * belongs to ui-conversation, which falls back to the shipped fish. The rebrand
 * reaches that seat the way the project browser reaches `sidebar.workspaces` —
 * an occupant registered at priority -1 — so the empty-state mark is this
 * deployment's too, wherever the hero is rendered.
 */
import type { ClientContext, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AsiaInfoMark } from './AsiaInfoMark.tsx'
import { FallbackBrandControls } from './FallbackBrandControls.tsx'
import { ActionBar } from './ActionBar.tsx'
import { SessionList } from './SessionList.tsx'
import { Shell } from './Shell.tsx'
import { NS, type ShellInjected } from './contract.ts'
import { en, zh } from './locales.ts'
import { createSelectionStore, type SelectionActions } from './project.ts'
import { STYLES, STYLE_TAG_ID } from './styles.ts'

/** Services this plugin reaches for; every one must exist or the fiber waits. */
export const inject = ['slots', 'sessions', 'workspaces', 'layout', 'locale']

/** How often the takeover registration retries while the old shell disposes. */
const RETRY_INTERVAL_MS = 100

/** Retry budget: ~5s, far longer than a fiber disposal and short enough to give up loudly. */
const RETRY_LIMIT = 50

/**
 * Install the plugin: stylesheet, dictionary, and the column registration.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // One stylesheet per fiber lifetime. The tag carries the ids the HMR driver
  // and the module system use to attribute and drop plugin-owned CSS, and the
  // effect removes it on unload instead of leaving it orphaned.
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset['plugin'] = 'dsh-web-ui'
    tag.dataset['pluginCss'] = STYLE_TAG_ID
    tag.textContent = STYLES
    document.head.append(tag)
    return () => { tag.remove() }
  }, 'dsh-web-ui: stylesheet')

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-web-ui: dictionaries')

  // The host's plugin inventory, as the account drawer's Plugins block reads it.
  //
  // It arrives through `ctx.inject` rather than this plugin's own `inject` list,
  // and that difference is the whole design: a REQUIRED dependency would leave
  // this column — the page's navigation — waiting on a Loader inventory unit that
  // a deployment may not compose. With an optional arm, a host that has one fills
  // the block and a host that does not renders the reason (see PluginsPanel.tsx).
  //
  // BOTH names are injected, which is what the shipped inventory page does too:
  // `remote.pluginInventory` is the namespace service (its presence is the
  // capability), and `remote` is the object the namespace hangs off — cordis
  // refuses to read a service a fiber did not declare, so naming only the
  // namespace leaves `scope.remote` unreachable.
  let listPlugins: ShellInjected['listPlugins'] | undefined
  ctx.inject(['remote', 'remote.pluginInventory'], (scope: ClientContext) => {
    listPlugins = async () => {
      const result = await scope.remote.pluginInventory.list()
      if (!result.ok) {
        throw new Error(`${result.error.code}: ${result.error.message}`)
      }
      return result.value
    }
    scope.effect(() => () => { listPlugins = undefined }, 'dsh-web-ui: plugin inventory capability')
  })

  // The registrant's business face: the runtime services a slot component may
  // not touch directly (a component never sees ctx). The selection writer comes
  // in as the registration's baked action, so the face is built per
  // registration (see the two inject factories below).
  const face = (selectProject: (workspaceId: WorkspaceId | undefined) => void): ShellInjected => ({
    startSession: (workspaceId) => { ctx.workspaces.startSession(workspaceId) },
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
    pickDirectory: () => ctx.workspaces.pickDirectory(),
    createWorkspace: (input) => ctx.workspaces.create(input),
    listDirectory: (path) => ctx.workspaces.listDirectory(path),
    createDirectory: (path, name) => ctx.workspaces.createDirectory(path, name),
    openSession: (sessionId) => { ctx.sessions.open(sessionId) },
    // The shared selection: written by the column, read by both registrations.
    selectProject,
    renameSession: async (sessionId, title) => {
      // Rename is a per-session verb (ISession), not a list-service verb: the
      // binding resolves any listed session.
      const session = ctx.sessions.binding(sessionId)?.session
      if (session === undefined) throw new Error(`unknown session "${sessionId}"`)
      const result = await session.rename(title)
      if (!result.ok) throw new Error(result.error.message)
    },
    archiveSession: (sessionId) => ctx.workspaces.archiveSession(sessionId),
    renameWorkspace: async (workspaceId, title) => { await ctx.workspaces.rename(workspaceId, title) },
    deleteWorkspace: async (workspaceId) => { await ctx.workspaces.delete(workspaceId) },
    // Read lazily, so the block reports "no inventory in this composition" at
    // the moment it is asked rather than at the moment this face was built.
    listPlugins: () => {
      if (listPlugins === undefined) {
        return Promise.reject(new Error('this host composes no plugin inventory unit'))
      }
      return listPlugins()
    },
  })

  // One selection handle, mounted by both root-scope registrations: the column
  // shell (which writes it) and the session list (which reads it). Handles are
  // built in apply, never at module level — a module-level handle would be a
  // singleton surviving plugin reloads.
  const selection = createSelectionStore()

  // The browsing region, scoped to the selected project. It shadows the shipped
  // workspace browser (registered against the same seat at the default
  // priority), and it waits for that seat through slots.inject — the seat is
  // declared by this plugin's own `sidebar` registration above, so the two
  // registrations must not assume each other's timing.
  ctx.slots.inject('sidebar.workspaces', () => {
    try {
      return ctx.slots.register({
        name: 'sidebar.workspaces',
        priority: -1,
        locale: NS,
        store: selection,
        inject: (actions: SelectionActions) => face(workspaceId => { actions.select(workspaceId) }),
        registrant: 'dsh-web-ui',
      }, SessionList)
    } catch (error) {
      // A failed region must not take the column (and the page) down with it.
      console.warn('dsh-web-ui: could not register the project session list', error)
      return () => {}
    }
  })

  // The frame's action bar: ONE registration into a root-scope, additive,
  // click-through list seat. One place for both states — see ActionBar.tsx for
  // why it lives here rather than in the session header, why a single
  // registration is what lets the drawer's open flag stay component state, and
  // which controls are deliberately not in it.
  ctx.slots.inject('shell.overlay', () => {
    try {
      return ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-web-ui-actions',
        // The row's own child seat: the strip at the conversation header's right
        // is ONE row shared with peer plugins, and a row can only be shared by
        // whoever renders it. `my-sider` registers its two panel toggles into
        // this seat (contract.ts has the reasoning); the disposer the registration
        // returns takes the seat — and therefore those toggles — down with it.
        children: {
          'shell.action': { kind: 'list', scope: 'root' },
        },
        locale: NS,
        registrant: 'dsh-web-ui',
      }, ActionBar)
    } catch (error) {
      // The bar is chrome: without it the page is still a working page.
      console.warn('dsh-web-ui: could not register the action bar', error)
      return () => {}
    }
  })

  // The conversation hero's mark is a seat THIS plugin does not declare:
  // ui-conversation owns it and falls back to the shipped fish, so the rebrand
  // arrives as an occupant at priority -1 — the same move that shadows the
  // shipped workspace browser above. Waiting through slots.inject keeps the
  // plugin order-independent: whichever of the two rows activates first, this
  // registration lands once the seat exists. An official build's own occupant
  // sits at the default priority and therefore still wins over this one.
  ctx.slots.inject('conversation.hero.brand.mark', () => {
    try {
      return ctx.slots.register({
        name: 'conversation.hero.brand.mark',
        priority: -1,
        registrant: 'dsh-web-ui',
      }, AsiaInfoMark)
    } catch (error) {
      // A mark is cosmetic: a page without it is still a working page.
      console.warn('dsh-web-ui: could not register the hero brand mark', error)
      return () => {}
    }
  })

  ctx.effect(() => {
    let dispose: (() => void) | undefined
    let timer: number | undefined
    let attempts = 0

    const register = (): void => {
      try {
        dispose = ctx.slots.register({
          name: 'sidebar',
          locale: NS,
          store: selection,
          // The seats the shipped shell declared. Declaring is claiming: this
          // entry is now their only renderer, and the shipped occupants
          // (workspace browser, settings shell, brand, footer actions) register
          // into them through `ctx.slots.inject` exactly as before.
          children: {
            'sidebar.brand.mark': { kind: 'single', scope: 'root' },
            'sidebar.brand.name': { kind: 'single', scope: 'root' },
            'sidebar.workspaces': { kind: 'single', scope: 'root' },
            'sidebar.settings': { kind: 'single', scope: 'root' },
            'sidebar.footer.action': { kind: 'list', scope: 'root' },
            // The two seats this plugin ADDS: the bottom-left account dock and
            // the rows inside its drawer. The shipped sidebar declared five, so
            // an occupant registered against either of these by the plugin that
            // owns the account (dsh-feishu-login) has no home in the shipped
            // shell at all — these keys are this plugin's contract, and
            // contract.ts documents the shape the other side mirrors.
            'sidebar.account': { kind: 'single', scope: 'root' },
            'sidebar.account.menu': { kind: 'list', scope: 'root' },
          },
          inject: (actions: SelectionActions) => face(workspaceId => { actions.select(workspaceId) }),
          registrant: 'dsh-web-ui',
        }, Shell)
      } catch (error) {
        // The disabled shell row can still be disposing when this plugin
        // activates: its `sidebar` occupant and its child declarations are what
        // this registration needs gone. Retry rather than fail the whole page.
        attempts += 1
        if (attempts <= RETRY_LIMIT) {
          timer = window.setTimeout(register, RETRY_INTERVAL_MS)
          return
        }
        console.warn(
          'dsh-web-ui: could not take the sidebar column over — is the ui-sidebar row still enabled? '
          + 'Falling back to the brand-row controls.',
          error,
        )
        // Degraded path: never leave the page without navigation.
        dispose = ctx.slots.register({
          name: 'sidebar.brand.name',
          priority: -1,
          locale: NS,
          // No store here: with the shipped shell still mounted, its browser owns
          // the scope, so selecting a project means switching to it.
          inject: () => face(workspaceId => { ctx.workspaces.startSession(workspaceId) }),
          registrant: 'dsh-web-ui',
        }, FallbackBrandControls)
      }
    }

    register()
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      dispose?.()
    }
  }, 'dsh-web-ui: sidebar column registration')
}
