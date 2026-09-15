/**
 * The pre-boot gate: the index.html tap.
 *
 * This is the plugin's first line and the one that makes the requirement
 * literal — *before* the GUI opens, the login page opens. The script is
 * injected into every `index.html` the frontend serves (`/` and every SPA
 * fallback), as a classic inline script in `<head>`: module scripts are
 * deferred, so this runs before the application bundle executes, and a
 * synchronous cookie read is enough to decide.
 *
 * The decision reads the **hint cookie** — the non-HttpOnly `1` written beside
 * the signed session cookie — and nothing else, because nothing else is
 * available synchronously. That is safe in the direction that matters: a
 * *missing* hint bounces the visitor to the login page, and the hint is only
 * ever set together with a session the server itself signed. Forging it buys a
 * GUI shell whose every host data route still refuses the request; the plugin's
 * browser half re-checks against the server and re-gates when it disagrees.
 *
 * The redirect is guarded against a loop for the one environment where the
 * check cannot succeed: with JavaScript cookies disabled the hint is never
 * visible, and `/login` would bounce an authenticated visitor straight back to
 * `/` forever. A short-lived `sessionStorage` marker breaks that cycle — it can
 * only ever skip the client-side check, never the server-side one.
 *
 * @module dsh-feishu-login/host/gate
 */
import type { ResolvedConfig } from './config.ts'

/** `sessionStorage` key of the loop guard. */
const SKIP_KEY = 'dsh-feishu-gate-skip'

/**
 * Global name the browser half reads its deployment facts from. Duplicated as a
 * literal rather than imported from the client module: the two halves are
 * separate bundles with no shared code by design (a cross-plugin value import
 * would be a contract violation), so the name is a wire fact, documented on
 * both sides.
 */
const CONFIG_GLOBAL = '__DSH_FEISHU_LOGIN__'

/** How long the loop guard suppresses a repeated client-side bounce. */
const SKIP_WINDOW_MS = 15_000

/**
 * Build the `<script>` tag appended to the index document's `<head>`.
 *
 * Injection goes through the webserver's index taps, which run on every index
 * render — including the ones the frontend's SPA fallback produces for a deep
 * link, which is why a relink to a sub-path is gated too and not just `/`.
 *
 * The same tag carries `window.__DSH_FEISHU_LOGIN__`: the browser half is
 * loaded by URL and sees no host configuration, so the two facts it needs (the
 * endpoint prefix and the login page's path) are handed over here, before the
 * app boots.
 * @param config - normalized configuration (cookie names, login path).
 * @returns the script tag.
 */
export function renderGateScript(config: ResolvedConfig): string {
  const injected = {
    prefix: config.routePrefix,
    loginUrl: config.loginPath,
    accountChip: config.accountChip,
    hideSessionLog: config.hideSessionLog,
    brandName: config.brandName,
  }
  const program = `(function () {
  try {
    window[${JSON.stringify(CONFIG_GLOBAL)}] = ${JSON.stringify(injected)};
  } catch (error) { /* a frozen global scope must not stop the gate below */ }
  try {
    var name = ${JSON.stringify(config.hintCookieName)};
    var pattern = new RegExp('(?:^|;\\\\s*)' + name + '=');
    if (pattern.test(document.cookie)) return;
    var key = ${JSON.stringify(SKIP_KEY)};
    try {
      var last = Number(window.sessionStorage.getItem(key)) || 0;
      if (Date.now() - last < ${String(SKIP_WINDOW_MS)}) {
        window.sessionStorage.removeItem(key);
        return;
      }
      window.sessionStorage.setItem(key, String(Date.now()));
    } catch (error) { /* private mode: no guard available, still gate */ }
    var next = window.location.pathname + window.location.search + window.location.hash;
    window.location.replace(${JSON.stringify(config.loginPath)} + '?next=' + encodeURIComponent(next));
  } catch (error) { /* a broken gate must never brick the page: fail open */ }
})();`
  return `<script data-dsh-feishu-login="gate">${program}</script>`
}

/** Where the gate script is inserted: right after the opening `<head>` tag. */
const HEAD_OPEN = /<head[^>]*>/iu

/**
 * Insert the gate script as the first thing in `<head>`, so it precedes the
 * boot-manifest script and the application bundle.
 *
 * The transform is applied by the index tap on every render, so it must be
 * idempotent: a document that already carries the tag is returned untouched.
 * @param html - the index document body.
 * @param script - the tag from {@link renderGateScript}.
 * @returns the transformed document.
 */
export function injectGateScript(html: string, script: string): string {
  if (html.includes('data-dsh-feishu-login="gate"')) return html
  const match = HEAD_OPEN.exec(html)
  if (match === null) {
    // No <head>: a document without one cannot be relied on to run a module
    // script before the body, so prefixing the whole document is the closest
    // equivalent (and still executes before anything else in it).
    return script + html
  }
  const at = match.index + match[0].length
  return html.slice(0, at) + script + html.slice(at)
}
