/**
 * The Feishu (Lark) side of the flow: the URLs the browser is sent to, and the
 * three server-to-server calls the host makes.
 *
 * The shape of the protocol, as of the current open-platform docs:
 *
 * - The **browser** goes to an authorize page (`accounts.feishu.cn`), which is
 *   where the QR code lives and where the scan is confirmed. It comes back to
 *   the registered redirect URI with `?code=…&state=…` (code: single use,
 *   5-minute life).
 * - The **host** redeems that code for a user access token and reads the
 *   profile. Both calls are server-side only: those endpoints answer without
 *   CORS headers, and the app secret must never reach a browser anyway.
 *
 * Three authorize-code exchange generations are implemented, tried in order:
 * `oauth/v3/token` (current), `authen/v2/oauth/token` (historical), and
 * `authen/v1/oidc/access_token` + an app access token (historical). Enterprises
 * run console configurations of very different vintages, and which one answers
 * is an application fact, not a code fact — so the fallback is what makes one
 * plugin work across them.
 *
 * @module dsh-feishu-login/host/feishu
 */
import type { ResolvedConfig } from './config.ts'
import { encodeQuery } from './util.ts'

/** Which open-platform brand the application belongs to. */
export type Brand = 'feishu' | 'lark'

/**
 * Identity of the person who just scanned. Only `openId` is guaranteed:
 * every other field appears only when the application holds the scope that
 * gates it (`email` needs `contact:user.email:readonly`, `user_id` needs
 * `contact:user.employee_id:readonly`, `mobile` needs
 * `contact:user.phone:readonly`).
 */
export interface FeishuUser {
  /** Tenant-scoped user id — always returned. */
  openId: string
  /** Cross-application user id. */
  unionId?: string | undefined
  /** Tenant user id. */
  userId?: string | undefined
  /** Display name. */
  name?: string | undefined
  /** Latin-script display name. */
  enName?: string | undefined
  /** Avatar image URL. */
  avatarUrl?: string | undefined
  /** Email address. */
  email?: string | undefined
  /** Enterprise email address. */
  enterpriseEmail?: string | undefined
  /** Mobile number. */
  mobile?: string | undefined
}

/** Resolved API endpoints for one brand. */
export interface Endpoints {
  /** The QR-connect page: Feishu's own hosted QR login, embeddable and self-polling. */
  qrPage: string
  /** OAuth 2.0 authorize page (the `redirect` mode destination; also the QR SDK `goto` target, older form). */
  authorize: string
  /**
   * The legacy passport authorize URL. The official QR SDK only accepts this
   * form as its `goto` — the docs state the SDK does not support the newer
   * authorize page.
   */
  authorizeLegacy: string
  /** QR SDK script (loads into the login page and renders Feishu's QR in an iframe). */
  qrSdk: string
  /** Current authorize-code exchange (`oauth/v3/token`). */
  tokenV3: string
  /** Historical authorize-code exchange (`authen/v2/oauth/token`). */
  tokenV2: string
  /** Oldest authorize-code exchange (`authen/v1/oidc/access_token`). */
  tokenV1: string
  /** App access token mint, required by {@link Endpoints.tokenV1}. */
  appAccessToken: string
  /** Authenticated-user profile read (`authen/v1/user_info`). */
  userInfo: string
}

/** Endpoint table of the Feishu (China) deployment. */
const FEISHU: Endpoints = {
  qrPage: 'https://open.feishu.cn/connect/qrconnect/page/sso/',
  authorize: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
  authorizeLegacy: 'https://passport.feishu.cn/suite/passport/oauth/authorize',
  qrSdk: 'https://lf-package-cn.feishucdn.com/obj/feishu-static/lark/passport/qrcode/LarkSSOSDKWebQRCode-1.0.3.js',
  tokenV3: 'https://accounts.feishu.cn/oauth/v3/token',
  tokenV2: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
  tokenV1: 'https://open.feishu.cn/open-apis/authen/v1/oidc/access_token',
  appAccessToken: 'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal',
  userInfo: 'https://open.feishu.cn/open-apis/authen/v1/user_info',
}

/** Endpoint table of the Lark (international) deployment. */
const LARK: Endpoints = {
  qrPage: 'https://open.larksuite.com/connect/qrconnect/page/sso/',
  authorize: 'https://accounts.larksuite.com/open-apis/authen/v1/authorize',
  authorizeLegacy: 'https://passport.larksuite.com/suite/passport/oauth/authorize',
  qrSdk: 'https://lf-package-us.larksuitecdn.com/obj/lark-static-us/lark/passport/qrcode/LarkSSOSDKWebQRCode-1.0.3.js',
  tokenV3: 'https://accounts.larksuite.com/oauth/v3/token',
  tokenV2: 'https://accounts.larksuite.com/open-apis/authen/v2/oauth/token',
  tokenV1: 'https://open.larksuite.com/open-apis/authen/v1/oidc/access_token',
  appAccessToken: 'https://open.larksuite.com/open-apis/auth/v3/app_access_token/internal',
  userInfo: 'https://open.larksuite.com/open-apis/authen/v1/user_info',
}

/**
 * Pick the endpoint table. A single application belongs to exactly one brand —
 * Feishu answers `20046 Brand inconsistency` for a Lark app on a Feishu host
 * and vice versa — so this is a deployment constant, not a per-request choice.
 * @param brand - the configured brand.
 * @returns the endpoint table.
 */
export function resolveEndpoints(brand: Brand): Endpoints {
  return brand === 'lark' ? LARK : FEISHU
}

/** Parameters shared by every front channel. */
export interface AuthorizeParams {
  /** Application id (`client_id` on the new pages, `app_id` on the legacy ones). */
  appId: string
  /** Absolute redirect URI registered verbatim in the console. */
  redirectUri: string
  /** Opaque anti-CSRF value, signed by this host. */
  state: string
  /** Requested scopes; omitted when empty. */
  scopes: string
}

/**
 * Build the URL Feishu's hosted authorize page is reached at. This is the
 * documented path: the user is redirected to it and the QR code is one of the
 * ways it lets them in.
 * @param endpoints - the resolved endpoint table.
 * @param params - app id, redirect URI, state, scopes.
 * @returns the absolute URL.
 */
export function authorizeUrl(endpoints: Endpoints, params: AuthorizeParams): string {
  const query = [
    `client_id=${encodeQuery(params.appId)}`,
    `response_type=code`,
    `redirect_uri=${encodeQuery(params.redirectUri)}`,
    `state=${encodeQuery(params.state)}`,
  ]
  if (params.scopes !== '') query.push(`scope=${encodeQuery(params.scopes)}`)
  return `${endpoints.authorize}?${query.join('&')}`
}

/**
 * Build the legacy authorize URL the QR SDK needs as its `goto`. The SDK
 * appends `&tmp_code=…` to this URL after a successful scan and Feishu then
 * redirects to the registered `redirect_uri`.
 * @param endpoints - the resolved endpoint table.
 * @param params - app id, redirect URI, state, scopes.
 * @returns the absolute URL.
 */
export function authorizeLegacyUrl(endpoints: Endpoints, params: AuthorizeParams): string {
  const query = [
    `client_id=${encodeQuery(params.appId)}`,
    `response_type=code`,
    `redirect_uri=${encodeQuery(params.redirectUri)}`,
    `state=${encodeQuery(params.state)}`,
  ]
  if (params.scopes !== '') query.push(`scope=${encodeQuery(params.scopes)}`)
  return `${endpoints.authorizeLegacy}?${query.join('&')}`
}

/**
 * Build the URL of Feishu's own QR page for `iframe` embedding. The page owns
 * the QR, its refresh, and the scan polling; on success it navigates *itself*
 * (the iframe) to `redirect_uri` with `code` and `state`.
 *
 * This route is live but no longer documented, which is why it is not the
 * default: {@link qrPageEmbed} users get the login page's top-level fallback
 * button for free, and `mode: redirect` is the fully documented alternative.
 * @param endpoints - the resolved endpoint table.
 * @param params - app id, redirect URI, state, scopes.
 * @returns the absolute URL.
 */
export function qrPageUrl(endpoints: Endpoints, params: AuthorizeParams): string {
  const query = [
    `app_id=${encodeQuery(params.appId)}`,
    `redirect_uri=${encodeQuery(params.redirectUri)}`,
    `state=${encodeQuery(params.state)}`,
  ]
  if (params.scopes !== '') query.push(`scope=${encodeQuery(params.scopes)}`)
  return `${endpoints.qrPage}?${query.join('&')}`
}

/** One decoded JSON object. */
type Json = Record<string, unknown>

/**
 * Read a non-empty string member.
 * @param source - the decoded object.
 * @param key - the member name.
 * @returns the value, or undefined.
 */
function str(source: Json, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Read a nested object member.
 * @param source - the decoded object.
 * @param key - the member name.
 * @returns the nested object, or undefined.
 */
function obj(source: Json, key: string): Json | undefined {
  const value = source[key]
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined
}

/**
 * Describe a failed answer for a log line or an operator-facing page.
 * @param payload - the decoded body.
 * @param fallback - the message to use when the body carries none.
 * @returns a one-line description.
 */
export function describeFailure(payload: Json, fallback: string): string {
  const code = payload['code'] ?? payload['error']
  const message = str(payload, 'msg') ?? str(payload, 'message')
    ?? str(payload, 'error_description') ?? str(payload, 'error')
  const detail = message ?? 'no message'
  return code === undefined ? `${fallback}: ${detail}` : `${fallback} (code ${String(code)}): ${detail}`
}

/**
 * Whether an answer reports success. Feishu marks failures two ways: an OAuth
 * error body (`code` absent or an HTTP 400), or the platform envelope
 * `{ code: 0 }` — where `user_info` in particular answers **HTTP 200 even on
 * failure**, so the envelope is the only reliable signal.
 * @param payload - the decoded body.
 * @returns true when the body says the call succeeded.
 */
function isOk(payload: Json): boolean {
  const code = payload['code']
  if (code === undefined) return payload['error'] === undefined && payload['access_token'] !== undefined
  return code === 0 || code === '0'
}

/**
 * POST a request body and decode the JSON answer.
 * @param url - absolute endpoint.
 * @param init - fetch init (method, headers, body).
 * @returns the decoded body.
 */
async function postJson(url: string, init: { headers: Record<string, string>; body: string }): Promise<Json> {
  const response = await fetch(url, { method: 'POST', headers: init.headers, body: init.body })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${url} answered ${String(response.status)} with a non-JSON body`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${url} answered with an unexpected body shape`)
  }
  return parsed as Json
}

/**
 * GET a JSON resource with a bearer token.
 * @param url - absolute endpoint.
 * @param token - the bearer token.
 * @returns the decoded body.
 */
async function getJson(url: string, token: string): Promise<Json> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${url} answered ${String(response.status)} with a non-JSON body`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${url} answered with an unexpected body shape`)
  }
  return parsed as Json
}

/**
 * Pull a user access token out of an exchange answer, whichever generation
 * produced it (`access_token` at the top level, or inside `data`).
 * @param payload - the decoded body.
 * @returns the token, or undefined when the body carries none.
 */
function accessTokenOf(payload: Json): string | undefined {
  const direct = str(payload, 'access_token')
  if (direct !== undefined) return direct
  const nested = obj(payload, 'data')
  return nested === undefined ? undefined : str(nested, 'access_token')
}

/**
 * Outcome of a code exchange.
 */
export interface ExchangedToken {
  /** The user access token. */
  accessToken: string
  /** Which exchange generation produced it, for diagnostics. */
  via: 'v3' | 'v2' | 'v1'
}

/**
 * Redeem an authorization `code` for a user access token.
 *
 * The three generations run in order, and a failure in one falls through to
 * the next: what an application may use is decided by its console
 * configuration, and the error bodies do not distinguish "this generation is
 * retired" from "this code is bad" reliably enough to stop early. If every
 * generation refuses, the collected reasons are thrown as one message.
 * @param endpoints - the resolved endpoint table.
 * @param config - normalized configuration (app id).
 * @param secret - the resolved application secret.
 * @param code - the authorization code from the callback.
 * @param redirectUri - the exact URI the code was issued for.
 * @returns the user access token.
 */
export async function exchangeCode(
  endpoints: Endpoints,
  config: ResolvedConfig,
  secret: string,
  code: string,
  redirectUri: string,
): Promise<ExchangedToken> {
  const problems: string[] = []
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.appId,
    client_secret: secret,
    code,
    redirect_uri: redirectUri,
  })

  // v3 — current. Form-encoded is what the docs recommend; it also accepts JSON.
  try {
    const payload = await postJson(endpoints.tokenV3, {
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: form.toString(),
    })
    const token = accessTokenOf(payload)
    if (token !== undefined && isOk(payload)) return { accessToken: token, via: 'v3' }
    problems.push(describeFailure(payload, 'oauth/v3/token refused the code'))
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }

  // v2 — historical, still served; JSON body.
  try {
    const payload = await postJson(endpoints.tokenV2, {
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: config.appId,
        client_secret: secret,
        code,
        redirect_uri: redirectUri,
      }),
    })
    const token = accessTokenOf(payload)
    if (token !== undefined && isOk(payload)) return { accessToken: token, via: 'v2' }
    problems.push(describeFailure(payload, 'authen/v2/oauth/token refused the code'))
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }

  // v1 — needs an app access token first.
  try {
    const app = await postJson(endpoints.appAccessToken, {
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: config.appId, app_secret: secret }),
    })
    const appToken = str(app, 'app_access_token') ?? str(app, 'tenant_access_token')
    if (appToken === undefined || !isOk(app)) {
      throw new Error(describeFailure(app, 'no app access token'))
    }
    const payload = await postJson(endpoints.tokenV1, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${appToken}`,
      },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    })
    const token = accessTokenOf(payload)
    if (token !== undefined && isOk(payload)) return { accessToken: token, via: 'v1' }
    problems.push(describeFailure(payload, 'authen/v1/oidc/access_token refused the code'))
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }

  throw new Error(problems.join(' | '))
}

/**
 * Read the authenticated user's profile.
 * @param endpoints - the resolved endpoint table.
 * @param userAccessToken - the token from {@link exchangeCode}.
 * @returns the identity, normalized to {@link FeishuUser}.
 */
export async function fetchUserInfo(endpoints: Endpoints, userAccessToken: string): Promise<FeishuUser> {
  const payload = await getJson(endpoints.userInfo, userAccessToken)
  if (!isOk(payload)) throw new Error(describeFailure(payload, 'user_info refused the token'))
  const source = obj(payload, 'data') ?? payload
  const openId = str(source, 'open_id')
  if (openId === undefined) throw new Error(describeFailure(payload, 'user_info returned no open_id'))
  return {
    openId,
    unionId: str(source, 'union_id'),
    userId: str(source, 'user_id'),
    name: str(source, 'name'),
    enName: str(source, 'en_name'),
    avatarUrl: str(source, 'avatar_url') ?? str(source, 'avatar_big'),
    email: str(source, 'email'),
    enterpriseEmail: str(source, 'enterprise_email'),
    mobile: str(source, 'mobile'),
  }
}
