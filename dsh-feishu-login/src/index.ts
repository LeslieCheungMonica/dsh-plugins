/**
 * `dsh-feishu-login` — host half.
 *
 * Puts a Feishu (Lark) QR-code login page in front of the DeepSeek Harness Web
 * GUI: opening the page without a valid session lands on
 * `<loginPath>` (default `/login`), where a QR code waits for a phone running
 * Feishu; the scan authorizes the account, the host verifies it with Feishu
 * server-side, and only then does the GUI open.
 *
 * The Node half is deliberately the whole security story — it owns the OAuth
 * exchange, the identity check, the signed cookie, and the document gate — and
 * it has no runtime dependency beyond `node:*` (plus the Cordis-provided
 * schema validator). The browser half only *renders* what this half decides.
 *
 * Module exports are the Cordis plugin contract: `name`/`inject`/`Config`/
 * `apply` are read by the Loader, so the config schema and the entry point must
 * live here.
 *
 * @module dsh-feishu-login
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './host/config.ts'
import { resolveConfig } from './host/config.ts'
import { resolveEndpoints } from './host/feishu.ts'
import { renderGateScript, injectGateScript } from './host/gate.ts'
import { renderLoginPage } from './host/pages.ts'
import { issueSession, readSession } from './host/session.ts'
import { applyFeishuLogin } from './host/plugin.ts'

export { Config } from './host/config.ts'

/** Display metadata: labels this plugin in Cordis diagnostics. */
export const name = 'feishu-login'

/** Hard dependency: every route this plugin registers is a webserver route. */
export const inject = ['webServer']

/**
 * Mount the login gate.
 * @param ctx - the plugin context (the webserver service is injected).
 * @param config - this row's validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  applyFeishuLogin(ctx, config)
}

/**
 * Test and tooling hooks. Production never calls these — the Loader reads
 * `name`/`inject`/`Config`/`apply` and ignores the rest.
 *
 * They exist because a deployment has needs the browser flow cannot serve:
 * `verify-armed.mjs` mints a session to rehearse the signed-in path without a
 * phone, and a preview renders the login page without a host. Re-exporting the
 * real implementations (rather than letting such a tool re-implement the token
 * format) is what keeps those rehearsals honest — a second copy of the signing
 * scheme would agree with whatever it was written to agree with.
 */
export const internals = {
  /** Normalize raw configuration into the runtime form. */
  resolveConfig,
  /** Resolve the endpoint table for a brand. */
  resolveEndpoints,
  /** Mint a session token + cookie pair for an identity. */
  issueSession,
  /** Verify a session token. */
  readSession,
  /** Render the login page. */
  renderLoginPage,
  /** Build the pre-boot gate script tag. */
  renderGateScript,
  /** Insert the gate script into an index document. */
  injectGateScript,
}
