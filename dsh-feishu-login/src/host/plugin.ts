/**
 * The host half's body: what gets registered, and what each request does.
 *
 * Five routes, one index tap, and one decision that precedes all of them —
 * **is this plugin allowed to gate at all?**
 *
 * A gate that cannot be satisfied is not a gate, it is a locked door with no
 * key: with no `appId`, or with a secret that does not resolve, this plugin
 * registers nothing (or, per request, lets the document through) and says so in
 * the host log. Everything else about the gate then has exactly one meaning — a
 * request whose session cookie verifies passes, and every other request is sent
 * to the login page.
 *
 * The three layers, in the order a browser meets them:
 *
 * 1. `GET /` and `GET /index.html` — the server-side gate. An unauthenticated
 *    document request is answered `302 <loginPath>?next=…`, so the GUI's HTML is
 *    never handed to a visitor without a session.
 * 2. The **index tap** — a pre-boot script injected into every index render
 *    (including the SPA fallback the frontend answers a deep link with). It
 *    bounces to the login page before the application bundle executes; see
 *    `gate.ts`.
 * 3. The **browser half** — a `shell.overlay` occupant that re-checks against
 *    `<prefix>/session` and re-gates when the answer disagrees (a session that
 *    expired while the tab stayed open, or a hand-set hint cookie).
 *
 * @module dsh-feishu-login/host/plugin
 */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Config, ResolvedConfig } from './config.ts'
import { isAllowed, resolveConfig, unmatchedRuleHints } from './config.ts'
import type { Endpoints, FeishuUser } from './feishu.ts'
import { authorizeUrl, exchangeCode, fetchUserInfo, resolveEndpoints } from './feishu.ts'
import { injectGateScript, renderGateScript } from './gate.ts'
import { renderCallbackBridge, renderLoginPage, renderMessagePage } from './pages.ts'
import {
  clearCookies, issueSession, issueState, readState, sessionCookies, sessionFromRequest,
} from './session.ts'
import { parseQuery, safeNext, sanitizeHost } from './util.ts'

/** Structured logger shape (the subset of cordis's logger this plugin uses). */
interface Logger {
  /** Informational line. */
  info: (format: unknown, ...params: unknown[]) => void
  /** Warning line. */
  warn: (format: unknown, ...params: unknown[]) => void
  /** Failure line. */
  error: (format: unknown, ...params: unknown[]) => void
}

/** The credential seam's read face (structural: no runtime import of the package). */
interface CredentialService {
  /** Resolve one reference; undefined while unconfigured. */
  resolve: (ref: string) => Promise<{ value: string; source: string } | undefined>
}

/** Everything one request's handlers need. */
interface Runtime {
  /** Normalized configuration. */
  config: ResolvedConfig
  /** Resolved endpoint table. */
  endpoints: Endpoints
  /** Structured logger. */
  log: Logger
  /** Read the application secret, or undefined while it does not resolve. */
  secret: () => Promise<string | undefined>
  /** The webserver's index-tap application (boot-manifest injection). */
  applyIndexTaps: (html: string) => string
  /** Absolute path of the served `index.html`, when it could be resolved. */
  distIndex: string | undefined
}

/** Content type of every HTML page this plugin serves. */
const HTML = 'text/html; charset=utf-8'

/**
 * Resolve the served `index.html`.
 *
 * Same mechanism the shipped composition uses: `@deepseek-ai/dsh-web-frontend`
 * is resolved from the profile that owns `cordis.yml` (`ctx.baseUrl`), not from
 * this package, because where the frontend dist lives is a fact about the
 * deployment. When it cannot be resolved the server-side gate is simply not
 * registered — the plugin never guesses a path it would then serve as every
 * page in the app.
 * @param ctx - the plugin context (for `baseUrl`).
 * @param config - normalized configuration.
 * @param log - logger for the failure path.
 * @returns the absolute path, or undefined.
 */
function resolveDistIndex(ctx: Context, config: ResolvedConfig, log: Logger): string | undefined {
  if (config.distIndex !== undefined) return config.distIndex
  const base = ctx.baseUrl
  if (base === undefined || base === '') {
    log.warn('ctx.baseUrl is unset: cannot resolve the frontend dist, the "/" gate is not registered')
    return undefined
  }
  // `ctx.baseUrl` is a FILE URL with a trailing slash (`app-boot` sets
  // `pathToFileURL(dirname(config)).href + '/'`), which `createRequire` accepts
  // verbatim — this is exactly what client-modules does. It is NOT a plain
  // directory: running it through `join()` first produces `file:/…` and a
  // resolution that fails for reasons that look nothing like the real cause.
  const anchor = base.endsWith('/') ? base : `${base}/`
  try {
    return createRequire(anchor).resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
    log.warn(`cannot resolve @deepseek-ai/dsh-web-frontend/dist/index.html from "${anchor}": ${reason}`)
    log.warn('the server-side "/" gate is OFF — the pre-boot script and the browser half still gate the page')
    return undefined
  }
}

/**
 * Read the application secret.
 *
 * The credential seam comes first (a reference, resolved per operation, so a
 * rotation reaches the next request); `process.env` is the fallback for a host
 * that does not compose `dsh-credentials`; an inline `appSecret` is the last
 * resort, for a host that has neither.
 * @param ctx - the plugin context.
 * @param config - normalized configuration.
 * @returns the secret, or undefined while it does not resolve.
 */
async function resolveSecret(ctx: Context, config: ResolvedConfig): Promise<string | undefined> {
  if (config.appSecret !== undefined) return config.appSecret
  const credentials = ctx.get('credentials') as CredentialService | undefined
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(config.appSecretRef)
      if (resolved !== undefined && resolved.value !== '') return resolved.value
    } catch {
      // A provider failure is handled exactly like an unconfigured reference:
      // the gate cannot be satisfied, so it must not be enforced.
    }
  }
  const ambient = process.env[config.appSecretRef]
  return ambient === undefined || ambient === '' ? undefined : ambient
}

/** Write an HTML response. */
function sendHtml(res: ServerResponse, status: number, html: string, cookies: string[] = []): void {
  const headers: Record<string, string | string[]> = {
    'content-type': HTML,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  }
  if (cookies.length > 0) headers['set-cookie'] = cookies
  res.writeHead(status, headers)
  res.end(html)
}

/** Write a redirect response. */
function sendRedirect(res: ServerResponse, location: string, cookies: string[] = []): void {
  const headers: Record<string, string | string[]> = { location, 'cache-control': 'no-store' }
  if (cookies.length > 0) headers['set-cookie'] = cookies
  res.writeHead(302, headers)
  res.end()
}

/** Write a JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown, cookies: string[] = []): void {
  const headers: Record<string, string | string[]> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }
  if (cookies.length > 0) headers['set-cookie'] = cookies
  res.writeHead(status, headers)
  res.end(JSON.stringify(body))
}

/** Write an empty response. */
function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'cache-control': 'no-store' })
  res.end()
}

/**
 * The origin the browser used to reach this host, used to build the
 * `redirect_uri`. Deriving it per request (rather than pinning one configured
 * URL) is what lets `127.0.0.1`, `localhost`, a LAN address, and an
 * SSH-forwarded hostname all work against the same row — each one must be
 * registered in the console, and the login page prints the exact string.
 * @param req - the request.
 * @returns `scheme://host`.
 */
function originOf(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-proto']
  const scheme = forwarded === 'https' ? 'https' : 'http'
  return `${scheme}://${sanitizeHost(req.headers.host) ?? '127.0.0.1'}`
}

/** The exact `redirect_uri` of this request. */
function redirectUriOf(req: IncomingMessage, runtime: Runtime): string {
  return `${originOf(req)}${runtime.config.routePrefix}/callback`
}

/** Options accepted by the local message-page helper. */
interface MessageOptions {
  /** Extra label/value rows (identities, the redirect URI, an error text). */
  rows?: Array<{ label: string; value: string }> | undefined
  /** Optional primary action. */
  action?: { label: string; href: string } | undefined
  /** Whether the headline reads as a failure (the default) or as a notice. */
  bad?: boolean | undefined
}

/**
 * Render an operator-facing message page in this deployment's brand.
 * @param runtime - the runtime (for the brand name).
 * @param title - headline.
 * @param message - one-line explanation.
 * @param extras - rows, action, severity.
 * @returns the HTML document.
 */
function messagePage(runtime: Runtime, title: string, message: string, extras: MessageOptions = {}): string {
  return renderMessagePage({
    title: `${runtime.config.brandName} · ${title}`,
    message,
    rows: extras.rows,
    action: extras.action,
    bad: extras.bad ?? true,
  })
}

/** The identity rows printed on the denied page and stored in the log line. */
function identityRows(user: FeishuUser): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [{ label: 'open_id', value: user.openId }]
  if (user.unionId !== undefined) rows.push({ label: 'union_id', value: user.unionId })
  if (user.userId !== undefined) rows.push({ label: 'user_id', value: user.userId })
  if (user.name !== undefined) rows.push({ label: 'name', value: user.name })
  if (user.email !== undefined) rows.push({ label: 'email', value: user.email })
  if (user.enterpriseEmail !== undefined) rows.push({ label: 'enterprise_email', value: user.enterpriseEmail })
  if (user.mobile !== undefined) rows.push({ label: 'mobile', value: user.mobile })
  return rows
}

/** One-line identity summary for the host log. */
function describeIdentity(user: FeishuUser): string {
  const parts = [user.name ?? '(no name)', `open_id=${user.openId}`]
  if (user.email !== undefined) parts.push(`email=${user.email}`)
  if (user.enterpriseEmail !== undefined) parts.push(`enterprise_email=${user.enterpriseEmail}`)
  if (user.userId !== undefined) parts.push(`user_id=${user.userId}`)
  return parts.join(' ')
}

/**
 * Turn a Feishu error code into a sentence a user can act on.
 * @param code - the `error` query value.
 * @returns the sentence.
 */
function describeLoginError(code: string): string {
  if (code === 'access_denied') return '你在飞书侧取消了授权。'
  if (code === '20029') return 'redirect_uri 未在飞书开放平台登记，或登记值与本次访问的地址不一致。'
  if (code === '20010') return '该飞书账号不在应用的可用范围内。'
  if (code === '20009') return '该企业尚未安装此应用。'
  if (code === '20027') return '授权页请求了应用未开通的权限。'
  return `飞书返回：${code}`
}

/**
 * Serve the login page (or bounce to where the visitor was headed).
 * @param req - the request.
 * @param res - the response.
 * @param runtime - the runtime.
 */
async function handleLogin(req: IncomingMessage, res: ServerResponse, runtime: Runtime): Promise<void> {
  const { config, endpoints, log } = runtime
  const { query } = parseQuery(req.url)
  const next = safeNext(query.get('next'), '/')
  const redirectUri = redirectUriOf(req, runtime)
  const secret = await runtime.secret()
  if (secret === undefined) {
    log.error(
      `the application secret does not resolve (reference "${config.appSecretRef}") — `
      + 'the login page cannot complete an exchange; set the credential or disable the gate',
    )
    sendHtml(res, 503, messagePage(runtime, '登录未配置', '无法读取飞书应用密钥，登录不可用。', {
      rows: [
        { label: 'appId', value: config.appId },
        { label: '密钥引用', value: config.appSecretRef },
        { label: '登记回调', value: redirectUri },
      ],
    }))
    return
  }

  if (sessionFromRequest(config, secret, req.headers.cookie) !== undefined) {
    sendRedirect(res, next)
    return
  }

  // The embedded flag rides the signed state, never the redirect URI: Feishu
  // compares that URI against the console's list, and a query suffix is exactly
  // the kind of difference that turns into `20029`.
  const state = issueState(secret, { next, embedded: config.mode === 'embed', redirectUri })
  if (config.mode === 'redirect') {
    // The documented path: Feishu owns the login page entirely.
    sendRedirect(res, authorizeUrl(endpoints, {
      appId: config.appId, redirectUri, state, scopes: config.scopes,
    }))
    return
  }

  const error = query.get('error')
  sendHtml(res, 200, renderLoginPage({
    config,
    endpoints,
    redirectUri,
    next,
    state,
    error: error === undefined ? undefined : describeLoginError(error),
    denied: query.get('denied') === '1',
  }))
}

/**
 * Handle Feishu's return trip: verify the signed `state`, redeem the code, read
 * the identity, apply the allowlist, and mint the session.
 * @param req - the request.
 * @param res - the response.
 * @param runtime - the runtime.
 */
async function handleCallback(req: IncomingMessage, res: ServerResponse, runtime: Runtime): Promise<void> {
  const { config, endpoints, log } = runtime
  const { query } = parseQuery(req.url)
  const secret = await runtime.secret()
  if (secret === undefined) {
    log.error(`callback reached without a resolvable secret (reference "${config.appSecretRef}")`)
    sendHtml(res, 503, messagePage(runtime, '登录未配置', '无法读取飞书应用密钥，登录不可用。'))
    return
  }

  const retry = { label: '重新扫码', href: config.loginPath }
  const errorParam = query.get('error')
  if (errorParam !== undefined) {
    sendHtml(res, 400, messagePage(runtime, '登录已取消', describeLoginError(errorParam), {
      action: retry, bad: false,
    }))
    return
  }

  const state = readState(secret, query.get('state'))
  const code = query.get('code')
  if (state === undefined) {
    sendHtml(res, 400, messagePage(runtime, '登录状态已失效', '这次回调的 state 校验失败或已过期，请回到登录页重新扫码。', {
      action: retry,
    }))
    return
  }
  if (code === undefined) {
    sendHtml(res, 400, messagePage(runtime, '登录失败', '飞书没有带回授权码（code）。', { action: retry }))
    return
  }

  let user: FeishuUser
  try {
    const token = await exchangeCode(endpoints, config, secret, code, state.redirectUri)
    user = await fetchUserInfo(endpoints, token.accessToken)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log.error(`code exchange failed: ${reason}`)
    sendHtml(res, 400, messagePage(runtime, '登录失败', reason, {
      rows: [{ label: '登记回调', value: state.redirectUri }],
      action: retry,
    }))
    return
  }

  if (!isAllowed(config, user)) {
    const hints = unmatchedRuleHints(config, user)
    log.warn(`login refused by the allowlist: ${describeIdentity(user)}`)
    for (const hint of hints) log.warn(hint)
    if (state.embedded) {
      // The denial belongs on the page the user is looking at, not inside a
      // 300px iframe: hand the top window the login page with its notice flag.
      // The identity is in the host log for whoever maintains the allowlist.
      sendHtml(res, 200, renderCallbackBridge(`${config.loginPath}?denied=1`))
      return
    }
    sendHtml(res, 403, messagePage(runtime, '无访问权限', '飞书已确认你的身份，但该账号不在允许访问的名单内。', {
      rows: [...identityRows(user), ...hints.map(hint => ({ label: '提示', value: hint }))],
      action: retry,
    }))
    return
  }

  const { token } = issueSession(config, secret, user)
  if (config.logIdentity) log.info(`login ok: ${describeIdentity(user)}`)
  const next = safeNext(state.next, '/')
  if (state.embedded) {
    // Inside the login page's iframe: answer with a bridge that moves the top
    // window (same-origin, so it may) and still works when the flow ran
    // top-level after all.
    sendHtml(res, 200, renderCallbackBridge(next), sessionCookies(config, token))
    return
  }
  sendRedirect(res, next, sessionCookies(config, token))
}

/**
 * Report the current session to the browser half and to the login page's poll.
 * @param req - the request.
 * @param res - the response.
 * @param runtime - the runtime.
 */
async function handleSession(req: IncomingMessage, res: ServerResponse, runtime: Runtime): Promise<void> {
  const { config } = runtime
  const secret = await runtime.secret()
  if (secret === undefined) {
    sendJson(res, 200, { configured: false, authenticated: false, loginUrl: config.loginPath })
    return
  }
  const session = sessionFromRequest(config, secret, req.headers.cookie)
  if (session === undefined) {
    sendJson(res, 200, { configured: true, authenticated: false, loginUrl: config.loginPath })
    return
  }
  sendJson(res, 200, {
    configured: true,
    authenticated: true,
    loginUrl: config.loginPath,
    user: {
      name: session.name ?? session.openId,
      openId: session.openId,
      email: session.email,
      avatarUrl: session.avatarUrl,
      expiresAt: session.expiresAt,
    },
  })
}

/**
 * End the session: a GET redirects back to the login page, a POST answers JSON
 * for the browser half's logout button.
 * @param req - the request.
 * @param res - the response.
 * @param runtime - the runtime.
 */
function handleLogout(req: IncomingMessage, res: ServerResponse, runtime: Runtime): void {
  const cookies = clearCookies(runtime.config)
  if (req.method === 'POST') {
    sendJson(res, 200, { ok: true }, cookies)
    return
  }
  sendRedirect(res, runtime.config.loginPath, cookies)
}

/**
 * The server-side document gate: serve the app to a signed-in request, and send
 * everybody else to the login page.
 *
 * This handler deliberately reads and re-taps `index.html` instead of
 * delegating: the frontend's static server owns the *fallback* seat and offers
 * no way to call through to it, so the gate claims the two exact paths the
 * fallback would answer as a document and reproduces the same render —
 * `applyIndexTaps` is the public half of that contract, and it is what injects
 * the boot manifest (and this plugin's own pre-boot gate).
 * @param req - the request.
 * @param res - the response.
 * @param runtime - the runtime.
 */
async function handleRoot(req: IncomingMessage, res: ServerResponse, runtime: Runtime): Promise<void> {
  const { config, log, distIndex } = runtime
  /* v8 ignore next -- the routes are only registered when distIndex resolved */
  if (distIndex === undefined) { sendEmpty(res, 404); return }

  // A document route answers documents only — the same 405 posture the
  // frontend's static server takes for a non-GET on an unmatched path.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
    res.end()
    return
  }

  const secret = await runtime.secret()
  if (secret === undefined) {
    // Fail open, loudly: an unresolvable secret means this plugin cannot
    // authenticate anybody, and a gate nobody can pass is a locked door.
    log.error(
      `the application secret does not resolve (reference "${config.appSecretRef}") — `
      + 'the gate is OPEN for this request; set the credential or disable the plugin',
    )
  } else if (sessionFromRequest(config, secret, req.headers.cookie) === undefined) {
    const target = safeNext(parseQuery(req.url).path, '/')
    sendRedirect(res, `${config.loginPath}?next=${encodeURIComponent(target)}`)
    return
  }

  let source: string
  try {
    source = await readFile(distIndex, 'utf8')
  } catch (error) {
    // A configured-but-unreadable dist is a misconfiguration (a pinned
    // `distIndex` after the checkout moved, or a frontend that was never
    // built). Answer something an operator can act on instead of a bare 500.
    const reason = error instanceof Error ? error.message : String(error)
    log.error(`cannot read the frontend document at "${distIndex}": ${reason}`)
    sendHtml(res, 502, messagePage(runtime, '前端未就绪', `读不到前端页面文件：${distIndex}`, {
      rows: [{ label: '原因', value: reason }],
    }))
    return
  }
  const html = runtime.applyIndexTaps(source)
  res.writeHead(200, { 'content-type': HTML, 'cache-control': 'no-cache' })
  if (req.method === 'HEAD') { res.end(); return }
  res.end(html)
}

/**
 * Register everything this plugin contributes.
 * @param ctx - the plugin context.
 * @param raw - the Loader row's validated configuration.
 */
export function applyFeishuLogin(ctx: Context, raw: Config): void {
  const config = resolveConfig(raw)
  const log = ctx.logger('feishu-login') as unknown as Logger

  if (!config.gate) {
    log.info('gate disabled (gate: false) — this plugin is loaded but transparent')
    return
  }
  if (config.appId === '') {
    log.warn(
      'no appId configured — the login gate is INACTIVE. Set appId (and the app secret reference '
      + `"${config.appSecretRef}") on this plugin's Loader row to arm it.`,
    )
    return
  }

  const distIndex = resolveDistIndex(ctx, config, log)
  const runtime: Runtime = {
    config,
    endpoints: resolveEndpoints(config.brand),
    log,
    distIndex,
    applyIndexTaps: html => ctx.webServer.applyIndexTaps(html),
    secret: () => resolveSecret(ctx, config),
  }

  const route = (
    path: string,
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
    label: string,
  ): void => {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path, handler }),
      `feishu-login: ${label}`,
    )
  }

  const guard = (
    handler: (req: IncomingMessage, res: ServerResponse, runtime: Runtime) => void | Promise<void>,
    label: string,
  ) => async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await handler(req, res, runtime)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      log.error(`${label} threw: ${reason}`)
      if (!res.headersSent) sendEmpty(res, 500)
      else res.end()
    }
  }

  route(config.loginPath, guard(handleLogin, 'login page'), `login page (${config.loginPath})`)
  route(`${config.routePrefix}/callback`, guard(handleCallback, 'oauth callback'), 'oauth callback')
  route(`${config.routePrefix}/session`, guard(handleSession, 'session probe'), 'session probe')
  route(`${config.routePrefix}/logout`, guard((req, res, rt) => { handleLogout(req, res, rt) }, 'logout'), 'logout')
  route(`${config.routePrefix}/start`, guard(async (req, res, rt) => {
    const secret = await rt.secret()
    if (secret === undefined) { sendEmpty(res, 503); return }
    const next = safeNext(parseQuery(req.url).query.get('next'), '/')
    const redirectUri = redirectUriOf(req, rt)
    sendRedirect(res, authorizeUrl(rt.endpoints, {
      appId: rt.config.appId,
      redirectUri,
      state: issueState(secret, { next, embedded: false, redirectUri }),
      scopes: rt.config.scopes,
    }))
  }, 'authorize start'), 'authorize start')

  if (distIndex !== undefined) {
    const gate = guard(handleRoot, 'document gate')
    route('/', gate, 'document gate (/)')
    route('/index.html', gate, 'document gate (/index.html)')
  }

  const tapHtml = renderGateScript(config)
  ctx.effect(
    () => ctx.webServer.tapIndex(html => injectGateScript(html, tapHtml)),
    'feishu-login: pre-boot gate',
  )

  const allowlist = config.allowNobody
    ? 'allowlist DENIES EVERYONE (allow: [none])'
    : config.allow.length === 0
      ? 'allowlist unrestricted (allow: [] means anyone the app can see)'
      : `allowlist: ${String(config.allow.length)} rule(s)`
  log.info(
    `armed — login page ${config.loginPath}, endpoints under ${config.routePrefix}, `
    + `mode ${config.mode}/${config.qrEmbed}, document gate ${distIndex === undefined ? 'OFF' : 'ON'}, ${allowlist}`,
  )
  log.info(
    'if this gate ever locks you out: set `gate: false` on this plugin\'s row in the profile\'s '
    + 'cordis.patch.yml (the patch file is watched, so the next request is already ungated)',
  )
}
