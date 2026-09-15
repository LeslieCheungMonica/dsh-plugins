/**
 * Host half of `dsh-web-ui`.
 *
 * The plugin is browser-first: the column, the project row, and the session
 * list all render in the page from the client half registered by `dsh.client`.
 * This half exists for two reasons, and only two:
 *
 * 1. The Loader row that carries the client bundle IS a host entry — the
 *    client-module scan keys on the Loader entry's package name, so a
 *    browser-only plugin still needs a resolvable Node entry with an `apply`.
 * 2. The Feishu document panel in the column's lower half needs facts that only
 *    exist on the host: the operator's `lark-cli` login and the wiki tree it can
 *    read. Those arrive as three named JSON routes (`src/host/routes.ts`); the
 *    browser half only fetches them.
 *
 * The webserver is an OPTIONAL capability, exactly as it is for the settings
 * and theme plugins: a deployment without it (a headless host, or a browser
 * that is not served by this carrier) keeps the whole sidebar working and
 * simply renders no document panel, instead of leaving the column's owner
 * waiting on a service that will never appear.
 */
import type { Context } from '@deepseek-ai/cordis'
import { registerLarkRoutes } from './host/routes.ts'

/**
 * Install the host contributions of this plugin.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['webServer'], (httpCtx) => {
    registerLarkRoutes(httpCtx)
  })
}
