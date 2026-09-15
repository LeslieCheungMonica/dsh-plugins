/**
 * The two tokens this plugin mints, and the cookie pair that carries them.
 *
 * Both are stateless: `body.signature`, where the body is a base64url JSON
 * envelope and the signature is an HMAC-SHA256 under `HKDF(appSecret, purpose)`.
 * Nothing is stored on disk and nothing has to be replayed after a host
 * restart, so a reload of the GUI does not force a new scan. The price is that
 * a logout can only clear the cookie — there is no server-side revocation list
 * — which is the right trade for an internal door, not for a bank.
 *
 * **The session cookie is the credential** (`HttpOnly`). The hint cookie
 * beside it is a bare `1`: page scripts may read it, no identity rides it, and
 * the server never trusts it. It exists so the GUI can decide *before it boots*
 * whether to show itself or bounce to the login page.
 *
 * @module dsh-feishu-login/host/session
 */
import type { ResolvedConfig } from './config.ts'
import type { FeishuUser } from './feishu.ts'
import {
  base64url, deriveKey, fromBase64url, randomId, readCookie, serializeCookie, signToken, verifyToken,
} from './util.ts'

/** Purpose label of the session signing key. */
const SESSION_PURPOSE = 'session'
/** Purpose label of the OAuth `state` signing key. */
const STATE_PURPOSE = 'state'

/** What a verified session cookie carries. */
export interface Session {
  /** Feishu `open_id` of the signed-in user. */
  openId: string
  /** Display name, when Feishu returned one. */
  name: string | undefined
  /** Avatar URL, when Feishu returned one. */
  avatarUrl: string | undefined
  /** Email address, when Feishu returned one. */
  email: string | undefined
  /** Session creation time (Unix seconds). */
  issuedAt: number
  /** Session expiry (Unix seconds). */
  expiresAt: number
}

/** What a verified `state` parameter carries. */
export interface OAuthState {
  /** Where to land after a successful login (sanitized before use). */
  next: string
  /** Whether the flow started inside the login page's iframe. */
  embedded: boolean
  /** The exact `redirect_uri` the code will be issued for. */
  redirectUri: string
  /** Expiry (Unix seconds): a stale authorize URL must not be replayable. */
  expiresAt: number
}

/**
 * Serialize one envelope and sign it.
 * @param secret - the application secret.
 * @param purpose - key purpose label.
 * @param payload - the JSON-serializable envelope.
 * @returns the signed, URL-safe token.
 */
function seal(secret: string, purpose: string, payload: unknown): string {
  return signToken(deriveKey(secret, purpose), base64url(JSON.stringify(payload)))
}

/**
 * Verify a token and decode its envelope.
 * @param secret - the application secret.
 * @param purpose - key purpose label.
 * @param token - the token to verify.
 * @returns the decoded envelope, or undefined when the signature fails.
 */
function open(secret: string, purpose: string, token: string | undefined): Record<string, unknown> | undefined {
  const body = verifyToken(deriveKey(secret, purpose), token)
  if (body === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(fromBase64url(body))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Read a string member of an envelope. */
function field(envelope: Record<string, unknown>, key: string): string | undefined {
  const value = envelope[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Read a numeric member of an envelope. */
function numberField(envelope: Record<string, unknown>, key: string): number | undefined {
  const value = envelope[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Mint a session token for a freshly authenticated user.
 * @param config - normalized configuration (cookie names, lifetime).
 * @param secret - the application secret.
 * @param user - the identity Feishu returned.
 * @param now - current time in ms (injectable for tests).
 * @returns the token and the expiry it encodes.
 */
export function issueSession(
  config: ResolvedConfig,
  secret: string,
  user: FeishuUser,
  now = Date.now(),
): { token: string; session: Session } {
  const issuedAt = Math.floor(now / 1000)
  const expiresAt = issuedAt + config.sessionTtlSeconds
  const session: Session = {
    openId: user.openId,
    name: user.name ?? user.enName,
    avatarUrl: user.avatarUrl,
    email: user.email ?? user.enterpriseEmail,
    issuedAt,
    expiresAt,
  }
  const token = seal(secret, SESSION_PURPOSE, {
    s: session.openId,
    n: session.name,
    a: session.avatarUrl,
    m: session.email,
    i: issuedAt,
    x: expiresAt,
  })
  return { token, session }
}

/**
 * Verify a session cookie.
 * @param secret - the application secret.
 * @param token - the cookie value.
 * @param now - current time in ms (injectable for tests).
 * @returns the session, or undefined when the token is forged, malformed or expired.
 */
export function readSession(secret: string, token: string | undefined, now = Date.now()): Session | undefined {
  const envelope = open(secret, SESSION_PURPOSE, token)
  if (envelope === undefined) return undefined
  const openId = field(envelope, 's')
  const issuedAt = numberField(envelope, 'i')
  const expiresAt = numberField(envelope, 'x')
  if (openId === undefined || issuedAt === undefined || expiresAt === undefined) return undefined
  if (expiresAt * 1000 <= now) return undefined
  return {
    openId,
    name: field(envelope, 'n'),
    avatarUrl: field(envelope, 'a'),
    email: field(envelope, 'm'),
    issuedAt,
    expiresAt,
  }
}

/**
 * Mint the signed `state` parameter of one authorize request.
 * @param secret - the application secret.
 * @param payload - next / embedded / redirectUri.
 * @param now - current time in ms (injectable for tests).
 * @returns the `state` value.
 */
export function issueState(
  secret: string,
  payload: { next: string; embedded: boolean; redirectUri: string },
  now = Date.now(),
): string {
  return seal(secret, STATE_PURPOSE, {
    n: payload.next,
    e: payload.embedded,
    r: payload.redirectUri,
    i: randomId(),
    x: Math.floor(now / 1000) + STATE_TTL_SECONDS,
  })
}

/** How long a started authorize flow may take before its `state` expires. */
export const STATE_TTL_SECONDS = 30 * 60

/**
 * Verify a `state` parameter returned by Feishu.
 * @param secret - the application secret.
 * @param token - the `state` query value.
 * @param now - current time in ms (injectable for tests).
 * @returns the decoded state, or undefined when it is forged, malformed or expired.
 */
export function readState(secret: string, token: string | undefined, now = Date.now()): OAuthState | undefined {
  const envelope = open(secret, STATE_PURPOSE, token)
  if (envelope === undefined) return undefined
  const next = field(envelope, 'n')
  const redirectUri = field(envelope, 'r')
  const expiresAt = numberField(envelope, 'x')
  if (next === undefined || redirectUri === undefined || expiresAt === undefined) return undefined
  if (expiresAt * 1000 <= now) return undefined
  return { next, embedded: envelope['e'] === true, redirectUri, expiresAt }
}

/**
 * Read the signed-in session off a request.
 * @param config - normalized configuration (cookie name).
 * @param secret - the application secret.
 * @param cookieHeader - the request's `Cookie` header.
 * @param now - current time in ms (injectable for tests).
 * @returns the session, or undefined when the request is not signed in.
 */
export function sessionFromRequest(
  config: ResolvedConfig,
  secret: string,
  cookieHeader: string | undefined,
  now = Date.now(),
): Session | undefined {
  return readSession(secret, readCookie(cookieHeader, config.cookieName), now)
}

/**
 * The `Set-Cookie` headers that establish a session: the signed credential plus
 * the page-readable hint the pre-boot gate looks for.
 * @param config - normalized configuration.
 * @param token - the session token.
 * @returns two header values.
 */
export function sessionCookies(config: ResolvedConfig, token: string): string[] {
  const maxAge = config.sessionTtlSeconds
  return [
    serializeCookie(config.cookieName, token, {
      maxAge,
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.cookieSecure,
    }),
    serializeCookie(config.hintCookieName, '1', {
      maxAge,
      httpOnly: false,
      sameSite: 'Lax',
      secure: config.cookieSecure,
    }),
  ]
}

/**
 * The `Set-Cookie` headers that end a session (both expire immediately).
 * @param config - normalized configuration.
 * @returns two header values.
 */
export function clearCookies(config: ResolvedConfig): string[] {
  return [
    serializeCookie(config.cookieName, '', { maxAge: 0, httpOnly: true, sameSite: 'Lax', secure: config.cookieSecure }),
    serializeCookie(config.hintCookieName, '', { maxAge: 0, httpOnly: false, sameSite: 'Lax', secure: config.cookieSecure }),
  ]
}
