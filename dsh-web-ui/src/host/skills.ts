/**
 * The skill marketplace's host half: the one place this plugin talks to
 * SkillHub, and the only place a SkillHub token exists.
 *
 * ## The identity problem, and why this module makes a loopback call
 *
 * The marketplace is per-reader: SkillHub authenticates with
 * `Bearer <handle>-skillhub`, derived from the reader's Feishu email address. The
 * address exists in exactly one place — the signed session `dsh-feishu-login`
 * issues at the end of its QR login — and that plugin exposes it to the browser
 * (`GET <prefix>/session`) but provides no host-side service, no shared secret,
 * and no way for another plugin to read its cookie.
 *
 * So this module VERIFIES rather than trusts. It takes the `Cookie` header the
 * browser sent it and asks the login plugin's own session route over loopback
 * who that cookie belongs to, then uses the address THE LOGIN PLUGIN named. Two
 * consequences are the whole point of doing it this way:
 *
 * - **The browser sends no identity.** There is nothing to compare and nothing to
 *   forge: a caller can only act as whoever its own cookie proves it is. A
 *   client-supplied email would have let any page that reaches this route read
 *   somebody else's PRIVATE assets.
 * - **The token is derived here and never leaves the host.** The browser receives
 *   a list of skills, never a token, exactly as the git and terminal routes never
 *   hand it an argv.
 *
 * The loopback hop is what makes this possible without a second plugin's secret:
 * the webserver is this process, and `ctx.webServer.port` is the port it listens
 * on, so the session route is one local request away. It is the ONLY self-call in
 * this plugin; it exists because a cross-plugin contract this composition does not
 * have would otherwise have to be invented.
 *
 * ## The two SkillHub calls, in order
 *
 * 1. `GET /api/cli/v1/auth/whoami` VALIDATES the derived token. A token that was
 *    never provisioned and a search that simply matched nothing are different
 *    answers, and only the first is actionable ("ask SkillHub to enable your
 *    account"); folding them together is what makes an empty list look like a
 *    broken feature. Its `data.email` also names the account the list was read as.
 * 2. `GET /api/cli/v1/skills/search?packageType=SKILL&label=FDE` reads the
 *    catalogue. The parameters are constants of this deployment's one question
 *    (see `shared/skillswire.ts`); nothing else is sent, so SkillHub's own
 *    defaults apply — including its `limit` of 20 and its `assetOwnership`
 *    default of "public plus your own private assets".
 *
 * The rate limit that matters is the documented 60 searches per minute for an
 * authenticated caller. One modal open is two requests, and the modal reads on
 * mount, so a reader would have to open it thirty times a minute to approach it.
 *
 * ## Every failure is content
 *
 * Nothing here throws to the route: an unreachable internal host, an expired
 * session, and a refused token all come back as a coded failure the modal renders
 * in place, because all three are states a reader can be looking at. The provider
 * URL is configurable (`skills.baseUrl`) because it is the one fact that differs
 * between environments.
 *
 * @module dsh-web-ui/host/skills
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  INSTALLED_ROOTS, MARKET_LABEL, MARKET_PACKAGE_TYPE, SKILLS_INSTALL_PATH,
  SKILLS_INSTALLED_PATH, SKILLS_MARKET_PATH, SKILL_QUERY_MAX_LENGTH, SKILL_SOURCE_FILE,
  skillToken,
} from '../shared/skillswire.ts'
import type {
  AssetOwnership, InstalledSkill, InstalledSkillMarketSource, InstalledSkillRoot,
  InstalledSkillSnapshot, InstalledSkillSource, SkillError, SkillFailure, SkillInstallRequest,
  SkillInstallResult, SkillMarketItem, SkillMarketSnapshot, SkillResponse,
} from '../shared/skillswire.ts'
import { readFeishuSession } from './feishu-session.ts'
import { parseSkillFacts, readSkillFacts, skillDirectoryName } from './skillmd.ts'
import { extractZipInto, readZip } from './zip.ts'

/** Content type of every response this module writes. */
const JSON_TYPE = 'application/json; charset=utf-8'

/** The SkillHub deployment this plugin talks to unless the row says otherwise. */
const DEFAULT_BASE_URL = 'http://acp.asiainfo-sec.com'

/**
 * The login plugin's route prefix unless the row says otherwise. It is
 * `dsh-feishu-login`'s own default (`/feishu-auth`), repeated here because this
 * plugin must ask for the session by URL and a client bundle may not import a
 * peer's values — the same "restate the contract" move the seats make.
 */
const DEFAULT_FEISHU_PREFIX = '/feishu-auth'

/** How long any one hop may take, in ms. */
const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Largest package this host will download, in bytes.
 *
 * Streaming is capped too (see `downloadArchive`), so a server that lies about
 * `content-length` cannot buffer past this.
 */
const DEFAULT_MAX_ARCHIVE_BYTES = 32 * 1024 * 1024

/**
 * The loader's own resolution of the two skill homes: `$DSH_HOME` or `~/.dsh`,
 * and `$DSH_AGENTS_HOME` or `~/.agents`.
 *
 * Restated rather than imported for the reason the seats are: a client bundle may
 * not import a peer package's values, and the host half of THIS plugin may not
 * either — but a skill installed where the loader does not look is a skill that
 * silently never appears, so the resolution is spelled out with its source named.
 * @param env - the environment variable that overrides the default.
 * @param fallback - the directory under the home directory.
 * @returns the absolute directory.
 */
function resolveHome(env: string, fallback: string): string {
  const configured = process.env[env]
  if (configured !== undefined && configured.trim() !== '') return resolve(configured.trim())
  return join(homedir(), fallback)
}

/** What this module is configured with. */
export interface SkillOptions {
  /** SkillHub's origin, without a trailing slash. */
  readonly baseUrl: string
  /** The login plugin's route prefix, e.g. `/feishu-auth`. */
  readonly feishuPrefix: string
  /** Per-hop deadline in ms. */
  readonly timeoutMs: number
  /**
   * The user skill root's PARENT — the loader's `dshHome`.
   *
   * Defaults to `$DSH_HOME` or `~/.dsh`, the same resolution the loader makes, and
   * the install directory is its `skills` child. It is configurable for one
   * reason that matters: pointing it at a scratch directory is how the install
   * path can be exercised without writing into the operator's real skills.
   */
  readonly dshHome: string
  /** The shared agents root's parent: `$DSH_AGENTS_HOME` or `~/.agents`. */
  readonly agentsHome: string
  /** The bundled skill root, when the deployment sets one. */
  readonly bundledSkillDir: string | undefined
  /** Largest package this host will download, in bytes. */
  readonly maxArchiveBytes: number
}

/**
 * Validate one row's `skills` config, at boot, so a bad value fails with the
 * field named instead of surfacing later as odd behaviour inside the modal.
 * @param raw - `config.skills` as the Loader row carried it.
 * @returns the options, defaulted where the row said nothing.
 */
export function readSkillOptions(raw: unknown): SkillOptions {
  const defaults: SkillOptions = {
    baseUrl: DEFAULT_BASE_URL,
    feishuPrefix: DEFAULT_FEISHU_PREFIX,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    dshHome: resolveHome('DSH_HOME', '.dsh'),
    agentsHome: resolveHome('DSH_AGENTS_HOME', '.agents'),
    bundledSkillDir: (() => {
      const configured = process.env['DSH_BUNDLED_SKILL_DIR']
      return configured === undefined || configured.trim() === '' ? undefined : resolve(configured.trim())
    })(),
    maxArchiveBytes: DEFAULT_MAX_ARCHIVE_BYTES,
  }
  if (raw === undefined || raw === null) return defaults
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-web-ui: config.skills must be an object')
  }
  const record = raw as Record<string, unknown>
  const text = (key: 'baseUrl' | 'feishuPrefix', fallback: string): string => {
    const value = record[key] ?? fallback
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`dsh-web-ui: config.skills.${key} must be a non-empty string`)
    }
    return value.trim()
  }
  const timeoutMs = record['timeoutMs'] ?? defaults.timeoutMs
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('dsh-web-ui: config.skills.timeoutMs must be a positive number')
  }
  const positive = (key: 'maxArchiveBytes', fallback: number): number => {
    const value = record[key] ?? fallback
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`dsh-web-ui: config.skills.${key} must be a positive number`)
    }
    return Math.trunc(value)
  }
  // A trailing slash would double up against the paths below; a MISSING leading
  // one would resolve the session path off the origin root, so the prefix is
  // normalized on both ends rather than only the one a config file tends to
  // forget.
  const trimTrailing = (value: string): string => (value.endsWith('/') ? value.slice(0, -1) : value)
  const lead = (value: string): string => (value.startsWith('/') ? value : `/${value}`)
  return {
    baseUrl: trimTrailing(text('baseUrl', defaults.baseUrl)),
    feishuPrefix: trimTrailing(lead(text('feishuPrefix', defaults.feishuPrefix))),
    timeoutMs: Math.trunc(timeoutMs),
    // The three roots are resolved HERE rather than read from config: they are the
    // loader's own environment facts, and the one thing a deployment must not be
    // able to get subtly wrong is where skills are installed.
    dshHome: defaults.dshHome,
    agentsHome: defaults.agentsHome,
    bundledSkillDir: defaults.bundledSkillDir,
    maxArchiveBytes: positive('maxArchiveBytes', defaults.maxArchiveBytes),
  }
}

/**
 * Write one JSON response.
 * @param res - the response to own.
 * @param status - HTTP status.
 * @param body - the value to serialize.
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    // A marketplace read is a snapshot of what is published RIGHT NOW; a cached
    // answer would show a skill that has since been withdrawn.
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** Largest request body this family will read, in bytes. */
const MAX_BODY_BYTES = 8 * 1024

/**
 * Read the query string of a request.
 * @param req - the request.
 * @returns the parsed parameters (a malformed URL yields an empty set).
 */
function query(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}

/**
 * Answer a request whose method this route does not accept.
 * @param res - the response.
 * @param allow - the method it does accept.
 */
function sendMethodNotAllowed(res: ServerResponse, allow: string): void {
  res.writeHead(405, { allow, 'cache-control': 'no-store' })
  res.end()
}

/**
 * Build a failure response.
 * @param code - the machine code.
 * @param message - one sentence for a human.
 * @returns the failure envelope.
 */
function fail(code: SkillFailure, message: string): { ok: false; error: SkillError } {
  return { ok: false, error: { code, message } }
}

/** What one hop answered, before this module interprets it. */
type Hop =
  | { readonly kind: 'answer'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'unreachable'; readonly message: string }
  | { readonly kind: 'unreadable'; readonly message: string }

/**
 * Perform one JSON GET.
 *
 * A transport refusal, a non-2xx status, and a body that is not JSON are three
 * different facts, so they are three different outcomes rather than one thrown
 * error — the caller decides which of them is a *state* and which is a *failure*.
 * @param url - the absolute URL.
 * @param init - headers and method.
 * @param timeoutMs - the hop's deadline.
 * @returns what the hop answered.
 */
async function hop(url: string, init: RequestInit, timeoutMs: number): Promise<Hop> {
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    // DNS, a refused socket, a proxy, and a deadline all land here. They are one
    // outcome for the reader — "the host cannot reach it" — and the underlying
    // reason is carried verbatim because that is what the reader needs to fix.
    //
    // `fetch` reports all of them as the same `TypeError: fetch failed` and puts
    // the actual reason in `cause`, so the cause is what gets carried: for the
    // one case a reader off the company network will hit, the difference between
    // "fetch failed" and "getaddrinfo ENOTFOUND acp.asiainfo-sec.com" is the
    // whole diagnosis.
    return { kind: 'unreachable', message: describeTransportError(error) }
  }
  const text = await response.text()
  try {
    return { kind: 'answer', status: response.status, body: JSON.parse(text) as unknown }
  } catch {
    return {
      kind: 'unreadable',
      message: `answered ${String(response.status)} with a body that is not JSON`,
    }
  }
}

/**
 * Turn a `fetch` rejection into the most specific sentence available.
 * @param error - what `fetch` threw.
 * @returns the reason, with its cause appended when Node provides one.
 */
function describeTransportError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause: unknown = error.cause
  if (cause instanceof Error && cause.message !== '' && cause.message !== error.message) {
    return `${error.message}: ${cause.message}`
  }
  return error.message
}

/**
 * Read an object field defensively: SkillHub's payload is not this plugin's to
 * type-check at the wire, and one renamed field must degrade a card rather than
 * fail the whole list.
 * @param value - the container.
 * @param key - the field.
 * @returns the string, or '' when it is missing or not a string.
 */
function str(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  return typeof field === 'string' ? field : ''
}

/**
 * Read the envelope's `code`, which the documentation defines as 0 on success
 * and an error code otherwise.
 * @param body - the parsed envelope.
 * @returns the code, or undefined when the body carries none.
 */
function envelopeCode(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const code = (body as Record<string, unknown>)['code']
  return typeof code === 'number' ? code : undefined
}

/**
 * Read the envelope's `msg`, for a failure sentence in the service's own words.
 * @param body - the parsed envelope.
 * @returns the message, or '' when there is none.
 */
function envelopeMessage(body: unknown): string {
  if (typeof body !== 'object' || body === null) return ''
  return str(body as Record<string, unknown>, 'msg')
}

/**
 * Read the envelope's `data` object.
 * @param body - the parsed envelope.
 * @returns the data object, or undefined.
 */
function envelopeData(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const data = (body as Record<string, unknown>)['data']
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? data as Record<string, unknown>
    : undefined
}

/**
 * Map one search result into the card the modal renders.
 *
 * `displayName` is the title and falls back to `slug`: a card with an empty
 * heading would be unclickable noise, and the slug is at least the skill's own
 * identifier. `summary` is allowed to be empty — a skill may genuinely have no
 * introduction, and inventing one is worse than showing a card with a title.
 * @param raw - one element of `data.items`.
 * @returns the item.
 */
function toItem(raw: unknown): SkillMarketItem {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const slug = str(record, 'slug')
  const ownership = str(record, 'assetOwnership').toUpperCase()
  return {
    namespace: str(record, 'namespace'),
    slug,
    displayName: str(record, 'displayName') === '' ? slug : str(record, 'displayName'),
    summary: str(record, 'summary'),
    latestVersion: str(record, 'latestVersion'),
    // An ownership this plugin does not know is reported as PUBLIC: it is the
    // quieter of the two labels, so an unrecognized value cannot make a shared
    // skill look like somebody's private one.
    assetOwnership: (ownership === 'PRIVATE' ? 'PRIVATE' : 'PUBLIC') as AssetOwnership,
  }
}

/**
 * Ask the login plugin who the caller's cookie belongs to.
 * @param ctx - the plugin context (for the listening port).
 * @param options - this module's configuration.
 * @param cookie - the caller's `Cookie` header, verbatim.
 * @returns the verified email address, or the failure to render.
 */
async function verifySession(
  ctx: Context,
  options: SkillOptions,
  cookie: string | undefined,
): Promise<{ ok: true; email: string } | { ok: false; error: SkillError }> {
  if (cookie === undefined || cookie === '') {
    return { ok: false, error: { code: 'no-session', message: 'this browser carries no Feishu session' } }
  }
  // The hop itself lives in `./feishu-session.ts`, shared with the docs panel's
  // identity rule: two copies of a security-relevant read would eventually
  // disagree about what counts as "no session".
  const reading = await readFeishuSession({
    port: ctx.webServer.port,
    feishuPrefix: options.feishuPrefix,
    timeoutMs: options.timeoutMs,
    cookie,
  })
  // Every way of not having a session is one code, because the modal renders
  // them the same: an absent gate, an expired cookie and a gate that is
  // unreachable all leave the reader with the same next step. The differences
  // ride in the message.
  if (reading.kind === 'no-gate') return fail('no-session', reading.message)
  if (reading.kind === 'anonymous') {
    return fail('no-session', 'no Feishu session is signed in on this browser')
  }
  const email = reading.session.email.trim()
  if (email === '') {
    // A real state rather than a bug: the Feishu login only returns an address
    // when its own configuration granted the email scope.
    return fail('no-email', 'the Feishu login carries no email address, so no SkillHub token can be derived')
  }
  return { ok: true, email }
}

/**
 * Interpret one SkillHub hop for a caller that wants its `data`.
 * @param answer - what the hop answered.
 * @param what - a short name for the call, for the failure sentence.
 * @returns the envelope's data, or the failure to render.
 */
function readEnvelope(
  answer: Hop,
  what: string,
): { ok: true; data: Record<string, unknown> } | { ok: false; error: SkillError } {
  if (answer.kind === 'unreachable') {
    return fail('unreachable', `SkillHub is unreachable from this host: ${answer.message}`)
  }
  if (answer.kind === 'unreadable') {
    return fail('unreadable', `SkillHub ${answer.message}`)
  }
  if (answer.status === 401 || answer.status === 403) {
    return fail('unauthorized', `SkillHub refused the token for ${what} (HTTP ${String(answer.status)})`)
  }
  if (answer.status < 200 || answer.status >= 300) {
    return fail('http-error', `SkillHub answered ${String(answer.status)} for ${what}`)
  }
  const code = envelopeCode(answer.body)
  if (code === undefined) {
    return fail('unreadable', `SkillHub answered ${what} without a \`code\` field`)
  }
  if (code !== 0) {
    const message = envelopeMessage(answer.body)
    return fail('http-error', `SkillHub refused ${what} (code ${String(code)}${message === '' ? '' : `: ${message}`})`)
  }
  const data = envelopeData(answer.body)
  if (data === undefined) {
    return fail('unreadable', `SkillHub answered ${what} without a \`data\` object`)
  }
  return { ok: true, data }
}

/**
 * Read the marketplace through SkillHub.
 * @param ctx - the plugin context.
 * @param options - this module's configuration.
 * @param cookie - the caller's `Cookie` header, verbatim.
 * @returns the snapshot, or a coded failure the modal renders.
 */
export async function searchMarket(
  ctx: Context,
  options: SkillOptions,
  cookie: string | undefined,
  searchTerm?: string,
): Promise<SkillResponse<SkillMarketSnapshot>> {
  // The reader's own search term, and NOTHING else: the frame (asset type, label)
  // stays fixed below. A term can only narrow within that frame — it cannot name an
  // identity, widen the scope, or ask for a different kind of asset — which is what
  // makes accepting it compatible with this route's stance that the browser does not
  // choose what is searched.
  const term = (searchTerm ?? '').trim()
  if (term.length > SKILL_QUERY_MAX_LENGTH) {
    return fail('bad-request', `a search term longer than ${String(SKILL_QUERY_MAX_LENGTH)} characters is not accepted`)
  }

  const session = await verifySession(ctx, options, cookie)
  if (!session.ok) return { ok: false, error: session.error }

  const token = skillToken(session.email)
  if (token === undefined) {
    return fail('no-email', `the login address \`${session.email}\` has no local part to derive a token from`)
  }

  // Step one: validate the token. A token SkillHub does not know is the one
  // failure whose fix ("have your account enabled") is different from every
  // other, so it is asked about BEFORE the search rather than inferred from a
  // later refusal. The token's NAME travels in the failure sentence on purpose:
  // it is the identifier the reader has to have provisioned in SkillHub, and it
  // is a name, not a secret.
  const whoami = await hop(
    `${options.baseUrl}/api/cli/v1/auth/whoami`,
    { method: 'GET', headers: { authorization: `Bearer ${token}` } },
    options.timeoutMs,
  )
  const whoamiData = readEnvelope(whoami, `the token \`${token}\``)
  if (!whoamiData.ok) {
    // A non-zero envelope code on THIS call means the token was rejected, which
    // is `unauthorized` however SkillHub numbered its error.
    return whoamiData.error.code === 'http-error'
      ? fail('unauthorized', whoamiData.error.message)
      : { ok: false, error: whoamiData.error }
  }
  // `whoami` names the account the token belongs to. The host already proved the
  // session, so this is a LABEL rather than a second source of truth — and it
  // falls back to the verified address when the field is absent, because a
  // missing label is not a reason to refuse a list.
  const whoamiEmail = str(whoamiData.data, 'email').trim()

  // Step two: the catalogue. The two parameters that define this deployment's
  // question always travel, and the reader's term rides WITH them (an empty term is
  // omitted entirely — SkillHub treats a present-but-empty `q` as "return
  // everything", and saying so explicitly would be a request nobody made).
  // SkillHub's defaults answer the rest, and it searches asset METADATA only: a
  // term that appears solely inside a package's files matches nothing.
  const query = new URLSearchParams({ packageType: MARKET_PACKAGE_TYPE, label: MARKET_LABEL })
  if (term !== '') query.set('q', term)
  const search = await hop(
    `${options.baseUrl}/api/cli/v1/skills/search?${query.toString()}`,
    { method: 'GET', headers: { authorization: `Bearer ${token}` } },
    options.timeoutMs,
  )
  const searchData = readEnvelope(search, 'the skill search')
  if (!searchData.ok) return { ok: false, error: searchData.error }

  const rawItems = searchData.data['items']
  const items = Array.isArray(rawItems) ? rawItems.map(toItem) : []
  const total = searchData.data['total']
  return {
    ok: true,
    data: {
      items,
      // The server's own count, falling back to what it actually returned: a
      // count of zero beside a non-empty list would be a lie the modal shows.
      total: typeof total === 'number' && Number.isFinite(total) ? total : items.length,
      verifiedEmail: whoamiEmail === '' ? session.email : whoamiEmail,
    },
  }
}

/**
 * Download one skill's package.
 *
 * ## Two hops, and the token rides only the first
 *
 * SkillHub answers the download with a 302 to a pre-signed MinIO URL — a DIFFERENT
 * ORIGIN (`acp.asiainfo-sec.com:7075` against `:80`) valid for 600 seconds. That
 * split is what makes this a function rather than one `fetch`:
 *
 * - the `Authorization` header must NOT travel to the second hop. It is
 *   SkillHub's credential and MinIO is a third party, and it is also pointless:
 *   the pre-signed URL carries its own signature, and MinIO REFUSES a request that
 *   sends both (a real 400, measured against the live service, not a theory);
 * - the redirect is therefore followed BY HAND, exactly one hop, over http(s) —
 *   so a chain of redirects cannot walk this host somewhere else.
 *
 * The response body is read with a running byte cap rather than through
 * `arrayBuffer()`, because a `content-length` is the SERVER's claim and this is
 * the one place this plugin buffers something a stranger chose the size of.
 * @param options - this module's configuration.
 * @param token - the derived bearer token.
 * @param namespace - the skill's namespace.
 * @param slug - the skill's slug.
 * @returns the package's bytes, or the failure to render.
 */
async function downloadArchive(
  options: SkillOptions,
  token: string,
  namespace: string,
  slug: string,
): Promise<{ ok: true; archive: Buffer } | { ok: false; error: SkillError }> {
  const url = `${options.baseUrl}/api/cli/v1/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}/download`
  let first: Response
  try {
    first = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
    })
  } catch (error) {
    return fail('unreachable', `SkillHub is unreachable from this host: ${describeTransportError(error)}`)
  }
  if (first.status === 401 || first.status === 403) {
    return fail('unauthorized', `SkillHub refused the token \`${token}\` for the download (HTTP ${String(first.status)})`)
  }
  const location = first.headers.get('location')
  if (first.status >= 300 && first.status < 400) {
    if (location === null || location === '') {
      return fail('no-archive', `SkillHub answered ${String(first.status)} for the download without a location`)
    }
  } else if (first.status >= 200 && first.status < 300) {
    // Not every asset type is a ZIP: the documentation says MCP and KNOWLEDGE
    // redirect to a service address instead, and a 200 here means SkillHub
    // answered the bytes itself, which this route does not know how to read.
    return fail('no-archive', `SkillHub answered the download with ${String(first.status)} and no redirect, so there is no package to unpack`)
  } else {
    return fail('http-error', `SkillHub answered ${String(first.status)} for the download`)
  }

  let target: URL
  try {
    target = new URL(location)
  } catch {
    return fail('no-archive', 'SkillHub sent a download location this host cannot read')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return fail('no-archive', `the download location uses ${target.protocol}, which this host does not fetch`)
  }

  // The second hop: no Authorization, by construction rather than by hoping the
  // runtime strips it.
  let second: Response
  try {
    second = await fetch(target, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs) })
  } catch (error) {
    return fail('unreachable', `the package host is unreachable from this host: ${describeTransportError(error)}`)
  }
  if (second.status !== 200) {
    // A pre-signed URL that has expired answers 403 here, and the fix is to
    // install again (a fresh URL) rather than to change anything.
    return fail('http-error', `the package host answered ${String(second.status)} (an expired signature needs another attempt)`)
  }
  const declared = Number(second.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > options.maxArchiveBytes) {
    return fail('archive-too-large', `the package declares ${String(declared)} bytes, past this host's limit of ${String(options.maxArchiveBytes)}`)
  }
  const read = await readBounded(second, options.maxArchiveBytes)
  if (!read.ok) return { ok: false, error: { code: 'archive-too-large', message: read.message } }
  return { ok: true, archive: read.buffer }
}

/**
 * Read a response body with a hard byte cap.
 *
 * `content-length` is a claim, so the cap is enforced against what actually
 * arrives, chunk by chunk, and the stream is cancelled the moment it is passed.
 * @param response - the response to read.
 * @param limit - the most bytes to accept.
 * @returns the body, or the reason it was refused.
 */
async function readBounded(
  response: Response,
  limit: number,
): Promise<{ ok: true; buffer: Buffer } | { ok: false; message: string }> {
  const body = response.body
  if (body === null) return { ok: true, buffer: Buffer.alloc(0) }
  const chunks: Buffer[] = []
  let total = 0
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done === true) break
      const chunk = Buffer.from(value)
      total += chunk.length
      if (total > limit) {
        await reader.cancel()
        return { ok: false, message: `the package is larger than this host's limit of ${String(limit)} bytes` }
      }
      chunks.push(chunk)
    }
  } catch (error) {
    return { ok: false, message: `the package download failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true, buffer: Buffer.concat(chunks) }
}

/**
 * Install one marketplace skill into this host's personal skill root.
 *
 * The order is the point: everything that can be validated is validated BEFORE
 * anything is written, and the destination directory is claimed with `mkdir`
 * (which fails if it exists) rather than created and then checked — so two
 * concurrent installs of the same skill cannot both believe they won.
 *
 * A failure after the claim removes the directory it claimed, because a
 * half-unpacked skill is worse than none: it would be listed by the scan with the
 * provenance file missing, and the loader would read a directory of partial
 * files. `rm` on the directory this call created is the only deletion this module
 * performs, and it can only ever remove what this call made.
 * @param options - this module's configuration.
 * @param token - the derived bearer token.
 * @param request - the namespace and slug to install.
 * @returns where it landed, or the failure to render.
 */
export async function installSkill(
  options: SkillOptions,
  token: string,
  request: SkillInstallRequest,
): Promise<SkillResponse<SkillInstallResult>> {
  // Both fields end up in a URL path. They are validated rather than escaped
  // alone, so a slug that is not a slug cannot even reach `encodeURIComponent`.
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
  if (!identifier.test(request.namespace) || !identifier.test(request.slug)) {
    return fail('bad-request', 'namespace and slug must be plain identifiers')
  }

  // Before spending a download on it: is this exact asset already here? The answer
  // is local (the personal root's provenance records), and asking it FIRST is what
  // keeps a second click from pulling tens of megabytes to then refuse them. The
  // name-level collision below is the second layer — that one can only be checked
  // once the package's own name is known, and it is what catches a hand-copied
  // directory of the same name.
  const existing = await findInstalledByMarket(options, request)
  if (existing !== undefined) {
    return fail('already-installed', `\`${request.namespace}/${request.slug}\` is already installed in ${existing}`)
  }

  const downloaded = await downloadArchive(options, token, request.namespace, request.slug)
  if (!downloaded.ok) return { ok: false, error: downloaded.error }

  const zip = readZip(downloaded.archive)
  if (!zip.ok) return { ok: false, error: { code: zip.error.code, message: zip.error.message } }

  // The skill's own name decides the directory, and the loader's rule decides
  // whether that name is usable at all. Refusing a package whose name the loader
  // would reject is the honest outcome: unpacking it would put files on the
  // machine that no session can ever invoke.
  const manifest = zip.entries.find(entry => !entry.directory && entry.path === 'SKILL.md')
  if (manifest === undefined) {
    return fail('not-a-skill', 'the package has no SKILL.md at its root, so it is not a skill this host can load')
  }
  const facts = parseSkillFacts(manifest.content.toString('utf8'))
  if (facts === undefined) {
    return fail('not-a-skill', 'the package\'s SKILL.md has no readable name and description, so the loader would ignore it')
  }
  const named = skillDirectoryName(facts.name)
  if (!named.ok) return fail('not-a-skill', named.message)

  const root = join(options.dshHome, 'skills')
  // The ROOT is created recursively, the SKILL directory is not: the root may not
  // exist yet (a first install on a fresh machine), while the leaf's `mkdir` is what
  // claims the name — and `EEXIST` from that call is the refusal, not an error.
  try {
    await mkdir(root, { recursive: true })
  } catch (error) {
    return fail('install-failed', `could not create ${root}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const directory = join(root, named.name)
  try {
    await mkdir(directory, { recursive: false })
  } catch (error) {
    if (hasCode(error, 'EEXIST')) {
      return fail('already-installed', `\`${named.name}\` is already installed in ${directory}`)
    }
    return fail('install-failed', `could not create ${directory}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const extracted = await extractZipInto(directory, zip.entries)
  if (!extracted.ok) {
    await rm(directory, { recursive: true, force: true })
    return fail('install-failed', `the package could not be unpacked: ${extracted.message}`)
  }

  const version = facts.version ?? ''
  const source: InstalledSkillMarketSource = {
    namespace: request.namespace,
    slug: request.slug,
    version,
    installedAt: new Date().toISOString(),
  }
  try {
    await writeFile(join(directory, SKILL_SOURCE_FILE), `${JSON.stringify(source, null, 2)}\n`, 'utf8')
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    return fail('install-failed', `the install record could not be written: ${error instanceof Error ? error.message : String(error)}`)
  }

  return {
    ok: true,
    data: { name: named.name, directory, files: extracted.files, bytes: extracted.bytes, version: version === '' ? undefined : version },
  }
}

/**
 * Find the directory this asset is already installed in, if it is.
 *
 * Only the PERSONAL root is searched, and only one level of it: that is the one
 * directory this module ever writes, so it is the only place its own record can
 * be — and a record anywhere else would be a record this plugin did not write.
 * @param options - this module's configuration.
 * @param request - the namespace and slug to look for.
 * @returns the directory holding it, or undefined.
 */
async function findInstalledByMarket(
  options: SkillOptions,
  request: SkillInstallRequest,
): Promise<string | undefined> {
  const root = join(options.dshHome, 'skills')
  let names: string[]
  try {
    names = (await readdir(root, { withFileTypes: true, encoding: 'utf8' }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    // No root yet is the ordinary first-install state, not a failure.
    return undefined
  }
  for (const name of names) {
    const directory = join(root, name)
    const record = await readMarketSource(directory)
    if (record !== undefined && record.namespace === request.namespace && record.slug === request.slug) {
      return directory
    }
  }
  return undefined
}

/**
 * Whether an error carries one Node error code.
 * @param error - the thrown value.
 * @param code - the code to look for.
 * @returns whether it matches.
 */
function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

/**
 * Resolve the roots to scan and the base each one hangs off.
 * @param options - this module's configuration.
 * @param project - the calling project's directory, when the caller named one.
 * @returns each root with its absolute path, in the loader's rank order.
 */
function resolveRoots(
  options: SkillOptions,
  project: string | undefined,
): Array<{ source: InstalledSkillSource; scope: 'personal' | 'public'; path: string }> {
  const resolved: Array<{ source: InstalledSkillSource; scope: 'personal' | 'public'; path: string }> = []
  for (const spec of INSTALLED_ROOTS) {
    const base = spec.base === 'dshHome'
      ? options.dshHome
      : spec.base === 'agentsHome'
        ? options.agentsHome
        : spec.base === 'bundled'
          ? options.bundledSkillDir
          : project
    // A root with no base does not exist in this deployment (no project named, no
    // bundled dir configured) and is left out of the answer entirely rather than
    // reported as an empty directory.
    if (base === undefined) continue
    resolved.push({ source: spec.source, scope: spec.scope, path: spec.relative === '' ? resolve(base) : join(resolve(base), spec.relative) })
  }
  return resolved
}

/**
 * Read what is installed on this host.
 *
 * The enumeration mirrors the loader's own: ONE level of a root, a directory
 * entry meaning `<dir>/SKILL.md`, a flat `.md` file being a skill in its own
 * right, `.system` skipped in the user root, and a file the loader would ignore
 * (no frontmatter, no name, no description, an invalid name) left out here too.
 * A name found in an earlier root SHADOWS the same name in a later one, which is
 * why the roots are walked in rank order and the first sighting wins — otherwise
 * this list would show a skill twice and disagree with what a session can invoke.
 * @param options - this module's configuration.
 * @param project - the calling project's directory, when the caller named one.
 * @returns the snapshot, or a failure when the personal root cannot be read.
 */
export async function listInstalledSkills(
  options: SkillOptions,
  project: string | undefined,
): Promise<SkillResponse<InstalledSkillSnapshot>> {
  const roots = resolveRoots(options, project)
  const personal: InstalledSkill[] = []
  const shared: InstalledSkill[] = []
  const rootViews: InstalledSkillRoot[] = []
  const seen = new Set<string>()

  for (const root of roots) {
    let names: string[]
    try {
      const entries = await readdir(root.path, { withFileTypes: true, encoding: 'utf8' })
      names = entries
        .filter(entry => !(root.source === 'user-dsh' && entry.name === '.system'))
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b))
    } catch (error) {
      // A root that is not there is an ordinary state — most projects have no
      // `.dsh/skills` — and is reported as such rather than as a failure.
      if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) {
        rootViews.push({ source: root.source, path: root.path, exists: false, count: 0 })
        continue
      }
      return fail('install-failed', `could not read ${root.path}: ${error instanceof Error ? error.message : String(error)}`)
    }

    let count = 0
    for (const name of names) {
      if (name.startsWith('.')) continue
      const entryPath = join(root.path, name)
      const entry = await resolveSkillEntry(entryPath, name)
      if (entry === undefined) continue
      const facts = await readSkillFacts(entry.file)
      if (facts === undefined) continue
      if (seen.has(facts.name)) continue
      seen.add(facts.name)
      count += 1
      const skill: InstalledSkill = {
        name: facts.name,
        description: facts.description,
        version: facts.version,
        source: root.source,
        scope: root.scope,
        // Only a DIRECTORY skill can carry a provenance file: the installer always
        // writes `<skill>/SKILL.md`, so a flat `.md` skill was never installed by
        // this plugin and looking for a record beside it would only ever find one
        // belonging to somebody else's directory.
        market: entry.directory === undefined ? undefined : await readMarketSource(entry.directory),
      }
      if (root.scope === 'personal') personal.push(skill)
      else shared.push(skill)
    }
    rootViews.push({ source: root.source, path: root.path, exists: true, count })
  }

  return { ok: true, data: { personal, shared, roots: rootViews } }
}

/**
 * Decide whether a root entry is a skill, and which file holds its definition.
 *
 * A symlink is followed, exactly as the loader follows one — this plugin's own
 * checkout installs its skills that way — so a link to a directory counts as that
 * directory and a link to a file counts as that file.
 * @param entryPath - the entry's absolute path.
 * @param name - the entry's name within the root.
 * @returns the file to parse plus the skill's own directory when it has one, or
 * undefined when the entry is not a skill.
 */
async function resolveSkillEntry(
  entryPath: string,
  name: string,
): Promise<{ file: string; directory: string | undefined } | undefined> {
  let info
  try {
    info = await stat(entryPath)
  } catch {
    return undefined
  }
  if (info.isDirectory()) return { file: join(entryPath, 'SKILL.md'), directory: entryPath }
  if (info.isFile() && name.endsWith('.md')) return { file: entryPath, directory: undefined }
  return undefined
}

/**
 * Read the provenance file the installer leaves inside a directory it created.
 * @param skillDir - the skill's directory.
 * @returns the recorded origin, or undefined when the skill was not installed here.
 */
async function readMarketSource(skillDir: string): Promise<InstalledSkillMarketSource | undefined> {
  let text: string
  try {
    text = await readFile(join(skillDir, SKILL_SOURCE_FILE), 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    const string = (key: string): string => (typeof record[key] === 'string' ? record[key] as string : '')
    const namespace = string('namespace')
    const slug = string('slug')
    // A record without both identifiers answers nothing the caller can match on,
    // so it is reported as "not from the marketplace" rather than as a half-truth.
    if (namespace === '' || slug === '') return undefined
    return { namespace, slug, version: string('version'), installedAt: string('installedAt') }
  } catch {
    return undefined
  }
}

/**
 * Register this family's three routes for this plugin's fiber lifetime.
 *
 * One read of the catalogue, one WRITE, and one read of this host. They share a
 * module because they share a subject and a token derivation, and they are exact
 * routes rather than one prefix so the surface stays inspectable.
 * @param ctx - the plugin context (the webserver is already injected).
 * @param options - this module's validated configuration.
 */
export function registerSkillRoutes(ctx: Context, options: SkillOptions): void {
  const log = ctx.logger('web-ui')

  /**
   * Wrap a handler so one throwing route cannot take the carrier down.
   * @param label - the route's name, for the log line.
   * @param body - the route's own work.
   * @returns the registered handler.
   */
  const guard = (
    label: string,
    body: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  ) => async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await body(req, res)
    } catch (error) {
      // Only a bug reaches here, and a bug is a 500 the browser reports generically.
      const reason = error instanceof Error ? error.message : String(error)
      log.error(`skills ${label} route threw: ${reason}`)
      if (!res.headersSent) sendJson(res, 500, fail('install-failed', reason))
    }
  }

  /**
   * Register one exact route for this plugin's fiber lifetime.
   * @param path - the exact pathname.
   * @param handler - the route body.
   * @param label - a short name for the effect's diagnostic label.
   */
  const route = (
    path: string,
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
    label: string,
  ): void => {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path, handler: guard(label, handler) }),
      `dsh-web-ui: skills ${label} route`,
    )
  }

  route(SKILLS_MARKET_PATH, async (req, res) => {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return }
    const answer = await searchMarket(ctx, options, req.headers.cookie, query(req).get('q') ?? undefined)
    // A marketplace failure is content the modal renders, not a transport
    // failure: HTTP 200 with `ok: false`, exactly like every Feishu-backed route
    // in this plugin.
    if (!answer.ok) log.warn(`skills market: ${answer.error.code}: ${answer.error.message}`)
    sendJson(res, 200, answer)
  }, 'market')

  route(SKILLS_INSTALLED_PATH, async (req, res) => {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return }
    const project = query(req).get('project') ?? undefined
    const answer = await listInstalledSkills(options, project === '' ? undefined : project)
    if (!answer.ok) log.warn(`skills installed: ${answer.error.code}: ${answer.error.message}`)
    sendJson(res, 200, answer)
  }, 'installed')

  route(SKILLS_INSTALL_PATH, async (req, res) => {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return }
    // Every install needs a verified reader: the token IS the reader's, so an
    // unauthenticated caller has nothing to download with. That is also why this
    // route needs no separate gate — the session probe is the gate.
    const session = await verifySession(ctx, options, req.headers.cookie)
    if (!session.ok) { sendJson(res, 200, { ok: false, error: session.error }); return }
    const token = skillToken(session.email)
    if (token === undefined) {
      sendJson(res, 200, fail('no-email', `the login address \`${session.email}\` has no local part to derive a token from`))
      return
    }
    const body = await readJsonBody(req)
    if (!body.ok) { sendJson(res, 400, fail('bad-request', body.message)); return }
    const request = asInstallRequest(body.value)
    if (!request.ok) { sendJson(res, 400, fail('bad-request', request.message)); return }

    const answer = await installSkill(options, token, request.value)
    if (answer.ok) {
      log.info(`skills install: ${answer.data.name} (${request.value.namespace}/${request.value.slug}) -> ${answer.data.directory}`)
    } else {
      log.warn(`skills install: ${answer.error.code}: ${answer.error.message}`)
    }
    sendJson(res, 200, answer)
  }, 'install')
}

/**
 * Read a JSON request body under a hard byte cap.
 *
 * The body is the ONLY thing this family accepts from the browser, and it is two
 * identifiers — so the cap is small and the shape is checked field by field
 * rather than cast.
 * @param req - the request.
 * @returns the parsed value, or why it could not be read.
 */
async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > MAX_BODY_BYTES) return { ok: false, message: `the request body exceeds ${String(MAX_BODY_BYTES)} bytes` }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return { ok: false, message: 'the request body is empty' }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, message: 'the request body is not valid JSON' }
  }
}

/**
 * Read an install request's two fields.
 * @param value - the parsed body.
 * @returns the request, or why it is not one.
 */
function asInstallRequest(value: unknown): { ok: true; value: SkillInstallRequest } | { ok: false; message: string } {
  if (typeof value !== 'object' || value === null) return { ok: false, message: 'the body must be a JSON object' }
  const record = value as Record<string, unknown>
  const namespace = record['namespace']
  const slug = record['slug']
  if (typeof namespace !== 'string' || namespace === '') return { ok: false, message: '`namespace` must be a non-empty string' }
  if (typeof slug !== 'string' || slug === '') return { ok: false, message: '`slug` must be a non-empty string' }
  return { ok: true, value: { namespace, slug } }
}
