/**
 * Host half of `my-sider`.
 *
 * The plugin is browser-first: both panels — the docked web sidebar and the
 * bottom command panel — render in the page from the client half registered by
 * `dsh.client`. This half exists for the three things a browser cannot do:
 *
 * 1. The Loader row that carries the client bundle IS a host entry — the
 *    client-module scan keys on the Loader entry's package name, so a
 *    browser-only plugin still needs a resolvable Node entry with an `apply`.
 * 2. The command panel runs what an operator types, which needs the process and
 *    confinement seams (`ctx.subprocess`, `ctx.sandbox`, `ctx.sandboxPolicy`).
 *    Those four routes are registered ONLY when this row asks for them
 *    (`config.shell.enabled`, true by default), so a deployment that switches
 *    the panel off has no command-execution endpoint at all.
 * 3. A page that refuses to be framed can only be shown through a host-side
 *    relay, because the browser applies `X-Frame-Options` no matter who asked.
 *    Those two routes follow `config.relay.enabled` the same way.
 *
 * TWO injection scopes, deliberately. The relay needs nothing but a webserver,
 * so a deployment that has one keeps the web panel. The command panel
 * additionally needs the process and confinement seams, so it waits for those on
 * its own: composing them is not a precondition for a working web panel, and a
 * host without them loses one panel rather than both.
 *
 * Every `@deepseek-ai/*` import below is TYPE-ONLY and erased at build, which is
 * what lets the Loader resolve this package's bare name from the profile
 * directory without installing a single runtime dependency.
 *
 * @module my-sider
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only, for the three service augmentations the command panel's injection
// names: the process seam, the confinement seam, and the policy that decides the
// mode. All three are erased at build, like every other host import here.
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-subprocess'
import { readOptions } from './host/options.ts'
import { createRelayService } from './host/relay.ts'
import { registerRelayRoutes, registerShellRoutes } from './host/routes.ts'
import { createShellService } from './host/shell.ts'

/** Display metadata: labels this plugin in Cordis diagnostics. */
export const name = 'my-sider'

/**
 * Install the host contributions of this plugin.
 *
 * A value that is present but wrong throws HERE, at boot, with the field named
 * (see `readOptions`) — the Loader surfaces it as this row's failure instead of
 * leaving a panel to fail mysteriously on its first click.
 * @param ctx - the plugin context.
 * @param config - this row's config; both surfaces are tuned under it.
 */
export function apply(ctx: Context, config?: unknown): void {
  const options = readOptions(config)

  // The web panel's relay: a webserver is the only seam it needs.
  ctx.inject(['webServer'], (httpCtx) => {
    const relay = options.relay.enabled ? createRelayService(options.relay) : undefined
    if (relay !== undefined) {
      // One disposal path for the whole relay: unloading this plugin (or a failed
      // fiber) aborts every in-flight upstream request instead of leaving a
      // fetch of someone's page running against a dead context.
      httpCtx.effect(() => () => { relay.dispose() }, 'my-sider: relay teardown')
    }
    registerRelayRoutes(httpCtx, relay)

    // A switched-off command panel is reported from this scope, so the answer
    // exists even on a host that has no process or confinement seam to inject.
    if (!options.shell.enabled) registerShellRoutes(httpCtx, undefined, process.cwd())
  })

  if (!options.shell.enabled) {
    ctx.logger('my-sider').info('Command panel is switched off (config.shell.enabled: false)')
    return
  }

  // Validated here, at boot, so a bad value fails loudly rather than surfacing
  // later as odd behaviour inside the panel.
  ctx.inject(['webServer', 'subprocess', 'sandbox', 'sandboxPolicy'], (shellCtx) => {
    const shell = createShellService({
      subprocess: shellCtx.subprocess,
      sandbox: shellCtx.sandbox,
      sandboxPolicy: shellCtx.sandboxPolicy,
    }, options.shell)
    // Stopping every command this plugin started on unload: an operator's
    // long-running process must not outlive the surface that owns it.
    shellCtx.effect(() => () => { shell.dispose() }, 'my-sider: command panel teardown')
    // `process.cwd()` is the honest fallback for "which directory does a command
    // run in when no session names a project": it is where the host was started,
    // and the panel shows it rather than assuming something invisible.
    registerShellRoutes(shellCtx, shell, process.cwd())
  })
}
