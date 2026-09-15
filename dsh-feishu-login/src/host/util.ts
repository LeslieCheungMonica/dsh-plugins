/**
 * Small self-contained helpers for the host half: cookies, base64url, HMAC
 * signing, HTML escaping, and same-origin path sanitation.
 *
 * Nothing here reaches outside `node:*`, so the plugin keeps its promise of
 * having no runtime dependencies.
 *
 * @module dsh-feishu-login/host/util
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** One cookie as read off a request. */
export interface CookiePair {
  /** Cookie name (no surrounding whitespace). */
  name: string
  /** Raw cookie value, still percent-decoded per RFC 6265 for our own writes. */
  value: string
}

/**
 * Parse a `Cookie` request header into pairs. Malformed segments are skipped
 * rather than thrown on: a hostile cookie header must not turn into a 500.
 * @param header - the raw `Cookie` header value, if any.
 * @returns the parsed pairs in header order.
 */
export function parseCookies(header: string | undefined): CookiePair[] {
  if (header === undefined || header === '') return []
  const pairs: CookiePair[] = []
  for (const segment of header.split(';')) {
    const eq = segment.indexOf('=')
    if (eq < 0) continue
    const name = segment.slice(0, eq).trim()
    if (name === '') continue
    pairs.push({ name, value: segment.slice(eq + 1).trim() })
  }
  return pairs
}

/**
 * Read one cookie value.
 * @param header - the raw `Cookie` header value.
 * @param name - the cookie name to look up.
 * @returns the value, or undefined when the cookie is absent.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const pair of parseCookies(header)) if (pair.name === name) return pair.value
  return undefined
}

/** Options of {@link serializeCookie}. */
export interface CookieOptions {
  /** `Path` attribute; defaults to `/` (every route this plugin serves). */
  path?: string
  /** `Max-Age` in seconds; `0` deletes the cookie on the client. */
  maxAge?: number
  /** Whether the cookie is hidden from `document.cookie`. */
  httpOnly?: boolean
  /**
   * `SameSite` policy. `Lax` is the default and is what makes the Feishu
   * callback work: it is a top-level cross-site GET navigation, and Lax cookies
   * ride those (a Strict cookie would be dropped on the way back from Feishu).
   */
  sameSite?: 'Lax' | 'Strict' | 'None'
  /** `Secure` attribute; only meaningful behind TLS. */
  secure?: boolean
}

/**
 * Serialize one `Set-Cookie` header value.
 * @param name - cookie name.
 * @param value - cookie value (written verbatim; callers keep it ASCII-safe).
 * @param options - attributes to apply.
 * @returns the header value.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${value}`, `Path=${options.path ?? '/'}`]
  if (options.maxAge !== undefined) parts.push(`Max-Age=${String(Math.max(0, Math.floor(options.maxAge)))}`)
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`)
  if (options.httpOnly === true) parts.push('HttpOnly')
  if (options.secure === true) parts.push('Secure')
  return parts.join('; ')
}

/**
 * Base64url-encode a UTF-8 string (no padding).
 * @param text - the text to encode.
 * @returns the base64url form.
 */
export function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

/**
 * Decode a base64url string as UTF-8.
 * @param text - the base64url form.
 * @returns the decoded text.
 */
export function fromBase64url(text: string): string {
  return Buffer.from(text, 'base64url').toString('utf8')
}

/**
 * HMAC-SHA256 a message.
 * @param key - the signing key (a Buffer or a UTF-8 string).
 * @param message - the message to sign.
 * @returns the raw signature bytes.
 */
export function hmac(key: Buffer | string, message: string): Buffer {
  return createHmac('sha256', key).update(message, 'utf8').digest()
}

/**
 * Derive a purpose-scoped key from a secret. Purpose separation keeps one
 * secret from signing two different kinds of token with the same key.
 * @param secret - the base secret (the Feishu app secret here).
 * @param purpose - the purpose label.
 * @returns the derived 32-byte key.
 */
export function deriveKey(secret: string, purpose: string): Buffer {
  return hmac(secret, `dsh-feishu-login/${purpose}/v1`)
}

/**
 * Sign a payload into `body.signature` form.
 * @param key - the signing key.
 * @param body - the base64url payload body.
 * @returns the signed token.
 */
export function signToken(key: Buffer, body: string): string {
  return `${body}.${hmac(key, body).toString('base64url')}`
}

/**
 * Verify and unwrap a `body.signature` token. Comparison is constant-time; a
 * malformed token is a miss, never a throw.
 * @param key - the signing key.
 * @param token - the token to verify.
 * @returns the payload body, or undefined when the signature does not match.
 */
export function verifyToken(key: Buffer, token: string | undefined): string | undefined {
  if (token === undefined) return undefined
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return undefined
  const body = token.slice(0, dot)
  const given = token.slice(dot + 1)
  let expected: Buffer
  let actual: Buffer
  try {
    expected = hmac(key, body)
    actual = Buffer.from(given, 'base64url')
  } catch {
    return undefined
  }
  if (expected.length !== actual.length) return undefined
  return timingSafeEqual(expected, actual) ? body : undefined
}

/**
 * A fresh URL-safe random id (nonce for OAuth `state`, page tokens, …).
 * @returns 24 characters of base64url randomness (144 bits).
 */
export function randomId(): string {
  return randomBytes(18).toString('base64url')
}

/**
 * Escape a string for interpolation into HTML text or a double-quoted
 * attribute. Every EJS-shaped template in this plugin goes through it —
 * identity fields come from Feishu and are never trusted as markup.
 * @param value - the raw text.
 * @returns the escaped text.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

/**
 * Sanitize a post-login destination: only a path on this origin is allowed, so
 * a crafted `?next=` can never turn the login page into an open redirect.
 * @param raw - the candidate value from a query string or a signed state.
 * @param fallback - the path to use when the candidate is unusable.
 * @returns an absolute same-origin path.
 */
export function safeNext(raw: string | undefined, fallback = '/'): string {
  if (raw === undefined || raw === '') return fallback
  if (!raw.startsWith('/')) return fallback
  // `//evil.example` and `/\evil.example` are protocol-relative URLs.
  if (raw.startsWith('//') || raw.startsWith('/\\')) return fallback
  // Control characters (CR/LF) would let a crafted value reach a header.
  // eslint-disable-next-line no-control-regex -- deliberate control-char rejection
  if (/[\u0000-\u001f\u007f]/u.test(raw)) return fallback
  return raw
}

/**
 * Render a query-string value.
 * @param value - the raw value.
 * @returns the percent-encoded form.
 */
export function encodeQuery(value: string): string {
  return encodeURIComponent(value)
}

/** A request's pathname and its decoded query. */
export interface ParsedQuery {
  /** The pathname, still percent-encoded exactly as it arrived. */
  path: string
  /** Decoded query values, keyed by name; a repeated key keeps its first value. */
  query: Map<string, string>
}

/**
 * Split and decode a request URL.
 *
 * Hand-rolled rather than `URLSearchParams` on purpose: the WHATWG form decoder
 * turns `+` into a space, and authorization codes are not form fields. The old
 * Feishu login flow issued codes containing a literal `+` (`1yxlUSU8Rf+7B32HY3HR7g`),
 * which a form decoder would silently corrupt into an unusable code. Here a
 * `+` stays a `+`.
 * @param rawUrl - the request's `url` (path + query, possibly absolute).
 * @returns the pathname and the decoded query.
 */
export function parseQuery(rawUrl: string | undefined): ParsedQuery {
  const raw = rawUrl ?? '/'
  const hashAt = raw.indexOf('#')
  const withoutHash = hashAt < 0 ? raw : raw.slice(0, hashAt)
  const markAt = withoutHash.indexOf('?')
  const path = markAt < 0 ? withoutHash : withoutHash.slice(0, markAt)
  const query = new Map<string, string>()
  if (markAt >= 0) {
    for (const segment of withoutHash.slice(markAt + 1).split('&')) {
      if (segment === '') continue
      const eq = segment.indexOf('=')
      const key = decodeSegment(eq < 0 ? segment : segment.slice(0, eq))
      if (key === undefined || key === '') continue
      const value = eq < 0 ? '' : decodeSegment(segment.slice(eq + 1))
      if (value === undefined) continue
      if (!query.has(key)) query.set(key, value)
    }
  }
  return { path: path === '' ? '/' : path, query }
}

/**
 * Percent-decode one query segment.
 * @param segment - the raw segment.
 * @returns the decoded text, or undefined when the escape is malformed.
 */
function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

/**
 * Validate a `Host` header before it is pasted into a URL that is sent to
 * Feishu and shown to the operator. Anything that is not a plain host[:port] is
 * refused, so a crafted header cannot inject a path or a header of its own.
 * @param host - the raw header value.
 * @returns the host, or undefined when it is unusable.
 */
export function sanitizeHost(host: string | undefined): string | undefined {
  if (typeof host !== 'string' || host === '') return undefined
  if (host.length > 255) return undefined
  return /^[A-Za-z0-9.\-:[\]]+$/u.test(host) ? host : undefined
}
