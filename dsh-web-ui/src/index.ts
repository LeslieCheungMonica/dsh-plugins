/**
 * Host half of `dsh-web-ui`.
 *
 * The plugin is browser-first: the column, the project row, the session list,
 * the git drawer, and the command bar all render in the page from the client
 * half registered by `dsh.client`. This half exists for four reasons, and only
 * four:
 *
 * 1. The Loader row that carries the client bundle IS a host entry — the
 *    client-module scan keys on the Loader entry's package name, so a
 *    browser-only plugin still needs a resolvable Node entry with an `apply`.
 * 2. The Feishu document panel in the column's lower half needs facts that only
 *    exist on the host: the operator's `lark-cli` login and the wiki tree it can
 *    read. Those arrive as three named JSON routes (`src/host/routes.ts`); the
 *    browser half only fetches them.
 * 3. The git drawer needs the real `git` binary, which a browser cannot run.
 *    Seven reads and one mutation arrive as named JSON routes
 *    (`src/host/git-routes.ts`); every argv is built on this side, so the
 *    browser never composes a command.
 * 4. The command bar runs what an operator types. Its four routes
 *    (`src/host/term-routes.ts`) are the one place a shell is involved, and they
 *    are wired separately from the other two — see the injection notes below.
 *    They are **off unless the row asks for them** (`config.terminal.enabled`),
 *    so a deployment that is not using the bar has no command-execution endpoint
 *    registered at all.
 *
 * The webserver is an OPTIONAL capability, exactly as it is for the settings
 * and theme plugins: a deployment without it (a headless host, or a browser
 * that is not served by this carrier) keeps the whole sidebar working and
 * simply renders no document panel, instead of leaving the column's owner
 * waiting on a service that will never appear.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only, for the three service augmentations the command bar's injection
// names: the process seam, the confinement seam, and the policy that decides
// the mode. All three are erased at build, like every other host import here.
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-subprocess'
import { registerFileRoutes } from './host/file-routes.ts'
import { registerGitRoutes } from './host/git-routes.ts'
import { registerLarkRoutes } from './host/routes.ts'
import { createTerminalService, readTerminalOptions } from './host/term.ts'
import { registerTerminalRoutes } from './host/term-routes.ts'

/**
 * Install the host contributions of this plugin.
 *
 * TWO injection scopes, deliberately. The document panel and the git drawer need
 * nothing but a webserver, so a deployment that has one gets both. The command
 * bar additionally needs the process and confinement seams, so it waits for
 * those on its own — composing them is not a precondition for a working sidebar,
 * and a host without them loses one panel rather than three.
 *
 * The command bar is also INERT by default: `terminal.enabled` must be set on
 * this row before a single route is registered. A disabled feature must not leave
 * a live command-execution endpoint behind, and the client half renders no
 * control for it either way.
 * @param ctx - the plugin context.
 * @param config - this row's config; `config.terminal` tunes the command bar.
 */
export function apply(ctx: Context, config?: unknown): void {
  ctx.inject(['webServer'], (httpCtx) => {
    registerLarkRoutes(httpCtx)
    registerGitRoutes(httpCtx)
    // The file page a transcript's file link opens in the GUI (see
    // host/file-routes.ts and the client's `fileViewer` capability).
    registerFileRoutes(httpCtx)
  })

  // Validated here, at boot, so a bad value fails loudly with the field named
  // rather than surfacing later as odd behaviour inside a panel.
  const options = readTerminalOptions(
    (config as { terminal?: unknown } | undefined)?.terminal,
  )

  if (!options.enabled) return

  ctx.inject(['webServer', 'subprocess', 'sandbox', 'sandboxPolicy'], (termCtx) => {
    const terminal = createTerminalService({
      subprocess: termCtx.subprocess,
      sandbox: termCtx.sandbox,
      sandboxPolicy: termCtx.sandboxPolicy,
    }, options)
    // One disposal path for the whole surface: unloading this plugin (or a
    // failed fiber) stops every command it started, rather than leaving orphans
    // holding the operator's project directories open.
    termCtx.effect(() => () => { terminal.dispose() }, 'dsh-web-ui: terminal teardown')
    registerTerminalRoutes(termCtx, terminal)
  })
}
