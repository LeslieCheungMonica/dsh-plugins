/**
 * The browser's `dsh-feishu-login` session, read from the HOST half.
 *
 * ## Why this module exists
 *
 * A plugin's host half has no way to read another plugin's cookie: the session
 * is a signed envelope whose key is derived from the login plugin's own
 * application secret, and that plugin exposes neither the secret nor a host-side
 * service. What it does expose is its session ROUTE to the browser, and the
 * webserver is this process — so the honest way to answer "who is this browser?"
 * is to hand the caller's own `Cookie` header back to the route that owns it
 * over loopback and use the identity THE LOGIN PLUGIN names.
 *
 * That is the same hop `host/skills.ts` makes for the skill marketplace, which is
 * why it lives here now: two copies of a security-relevant read would eventually
 * disagree about what counts as "no session".
 *
 * ## Fail open, refuse only on a clear answer
 *
 * The whole point of the module is the distinction its callers need:
 *
 * - **A gate that is not there is not a gate.** A deployment may run without the
 *   login plugin, or under a different route prefix, or behind a frontend
 *   fallback that answers unknown paths with HTML. None of those are a reason to
 *   break a feature that has nothing to do with logging in, so they are reported
 *   as `no-gate` and the caller proceeds.
 * - **A gate that IS there and says nobody signed in** is an answer, and the
 *   caller refuses.
 *
 * @module dsh-web-ui/host/feishu-session
 */

/** What the login plugin reports about a signed-in browser. */
export interface FeishuSessionFacts {
  /** The user's Feishu `open_id`, as the LOGIN plugin's application scoped it. */
  readonly openId: string
  /** Primary email when the login plugin's own scopes returned one. */
  readonly email: string
  /** Display name when it returned one. */
  readonly name: string
  /**
   * The application the `openId` was issued by, `''` when the login plugin is
   * too old to report it. Two `open_id`s are only comparable when this matches
   * the other side's application.
   */
  readonly appId: string
}

/** What one read of the login session found. */
export type SessionReading =
  /** No login gate answered like one: absent, unreachable, or not its JSON. */
  | { readonly kind: 'no-gate'; readonly message: string }
  /** A gate answered, and nobody is signed in on this browser. */
  | { readonly kind: 'anonymous' }
  /** A gate answered with an identity. */
  | { readonly kind: 'signed-in'; readonly session: FeishuSessionFacts }

/** One read's inputs. */
export interface SessionReadInput {
  /** The webserver's listening port; `undefined` means there is no host to ask. */
  readonly port: number | undefined
  /** The login plugin's route prefix, e.g. `/feishu-auth`. */
  readonly feishuPrefix: string
  /** Deadline for the loopback hop. */
  readonly timeoutMs: number
  /** The caller's `Cookie` header, verbatim. */
  readonly cookie: string | undefined
}

/** The default deadline: a loopback request to a process that is already up. */
export const SESSION_HOP_TIMEOUT_MS = 2_000

/**
 * Describe a transport failure the way the reader needs to see it.
 *
 * `fetch` reports DNS failure, a refused socket, a proxy and a deadline all as
 * the same `TypeError: fetch failed`, and puts the real reason in `cause`.
 * @param error - whatever `fetch` threw.
 * @returns one diagnostic line.
 */
function describeTransportError(error: unknown): string {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined
  const detail = cause instanceof Error ? cause.message : undefined
  if (detail !== undefined && detail !== '') return detail
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read one string member of the route's answer.
 * @param source - the decoded body.
 * @param key - the member name.
 * @returns the value, or `''`.
 */
function str(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

/**
 * Ask the login plugin who the caller's cookie belongs to.
 * @param input - port, route prefix, deadline and the caller's `Cookie` header.
 * @returns what the gate said, or why it cannot be treated as a gate.
 */
export async function readFeishuSession(input: SessionReadInput): Promise<SessionReading> {
  const { port, feishuPrefix, timeoutMs, cookie } = input
  // No port means this host is not the webserver (a unit harness, a host without
  // the webserver service): there is no gate to ask, so there is no gate.
  if (port === undefined || !Number.isFinite(port)) {
    return { kind: 'no-gate', message: 'this host has no webserver port to ask' }
  }
  const url = `http://127.0.0.1:${String(port)}${feishuPrefix}/session`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      // A browser's own header, forwarded to the process that issued it. The
      // value is never interpreted here, only carried.
      ...(cookie === undefined || cookie === '' ? {} : { headers: { cookie } }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    // Refused socket, a deadline, or a proxy: no route answered, so nothing was
    // refused. This is the state a deployment without the login plugin is in.
    return { kind: 'no-gate', message: `could not reach the login session route: ${describeTransportError(error)}` }
  }
  if (response.status === 404) {
    return { kind: 'no-gate', message: 'no login session route is registered' }
  }
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    // The frontend's SPA fallback answers unknown paths with a document; so does
    // a reverse proxy's error page. Neither is this route.
    return { kind: 'no-gate', message: `the login session route answered ${String(response.status)} with a body that is not JSON` }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'no-gate', message: 'the login session route answered an unexpected body shape' }
  }
  const record = body as Record<string, unknown>
  // `configured: false` is the login plugin saying it is loaded but cannot arm
  // itself (no appId, or a secret that does not resolve). Its own contract is
  // that such a gate registers nothing and locks nobody out, so it is not a gate.
  if (record['configured'] === false) {
    return { kind: 'no-gate', message: 'the login plugin is loaded but not configured' }
  }
  if (record['authenticated'] !== true) return { kind: 'anonymous' }
  const user = record['user']
  const userRecord = user !== null && typeof user === 'object' && !Array.isArray(user)
    ? user as Record<string, unknown>
    : {}
  return {
    kind: 'signed-in',
    session: {
      openId: str(userRecord, 'openId'),
      email: str(userRecord, 'email'),
      name: str(userRecord, 'name'),
      appId: str(record, 'appId'),
    },
  }
}

/** What the identity rule concluded. */
export type IdentityVerdict =
  /** The read may proceed. */
  | { readonly kind: 'allow'; readonly reason: 'no-gate' | 'match' | 'foreign-app' }
  /** The read must be refused, with the two identities for the message. */
  | {
    readonly kind: 'refuse'
    readonly reason: 'anonymous' | 'mismatch'
    readonly viewer: FeishuSessionFacts | undefined
    readonly docsOpenId: string
  }

/**
 * Decide whether a browser may read the CLI's account's Drive.
 *
 * The rule is one sentence: the panel serves Drive data only when the browser's
 * own session names the SAME Feishu user the CLI is bound to. Two of the three
 * allow cases are about NOT enforcing it:
 *
 * - No gate: see the module note. A deployment without the login plugin keeps
 *   working.
 * - A different application on each side: `open_id` is scoped to the application
 *   that issued it, so the two values are not comparable at all. Comparing them
 *   anyway would report a mismatch for the SAME person and lock every session out
 *   of the panel — the loudest possible failure from the quietest possible
 *   misconfiguration.
 *
 * @param input - the session reading and the CLI's own identity and application.
 * @returns the verdict.
 */
export function judgeIdentity(input: {
  readonly reading: SessionReading
  readonly docsOpenId: string
  readonly docsAppId: string
}): IdentityVerdict {
  const { reading, docsOpenId, docsAppId } = input
  if (reading.kind === 'no-gate') return { kind: 'allow', reason: 'no-gate' }
  if (reading.kind === 'anonymous') {
    return { kind: 'refuse', reason: 'anonymous', viewer: undefined, docsOpenId }
  }
  const viewer = reading.session
  // Nobody is signed in to the CLI: there is no identity to compare against, and
  // the read that follows reports `not-logged-in` by itself — a truer message
  // than a mismatch this rule cannot actually establish.
  if (docsOpenId === '') return { kind: 'allow', reason: 'match' }
  // An unknown application on either side means the comparison cannot be made;
  // allowing keeps a misconfiguration from becoming a lockout.
  if (docsAppId === '' || viewer.appId === '') return { kind: 'allow', reason: 'foreign-app' }
  if (viewer.appId !== docsAppId) return { kind: 'allow', reason: 'foreign-app' }
  if (viewer.openId === '' || viewer.openId === docsOpenId) return { kind: 'allow', reason: 'match' }
  return { kind: 'refuse', reason: 'mismatch', viewer, docsOpenId }
}
