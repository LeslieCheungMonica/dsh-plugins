/**
 * The `lark-cli` adapter: the one place in this plugin that talks to Feishu.
 *
 * Feishu credentials, token refresh, and the QR login all live in `lark-cli`
 * (the operator's own integration), so this plugin owns none of them. What it
 * owns is the seam: run the CLI with a fixed argv, parse its JSON envelope, and
 * hand the browser a small, stable shape — the signed-in user, the personal
 * knowledge base (`my_library`), and one level of wiki nodes at a time.
 *
 * Three rules make that seam safe to expose to a page:
 *
 * 1. **No shell.** Every call is `execFile` with an argv array, so a token from
 *    a query string can never become a shell word. Tokens are additionally
 *    validated against the CLI's own alphabet before they are used at all.
 * 2. **Serialized.** The CLI refreshes an expiring user token on the first user
 *    call, and two concurrent refreshes race on one credential file. Calls go
 *    through one queue, so the browser's parallel expansions cannot.
 * 3. **Failure is data.** A missing binary, an expired login, a stale node
 *    token, and a CLI error are all returned as typed outcomes rather than
 *    thrown: the panel renders the reason instead of an empty list.
 *
 * @module dsh-web-ui/host/lark
 */
import { execFile } from 'node:child_process'
import type { ExecFileException } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** The user `lark-cli` is signed in as. */
export interface LarkUser {
  /** Display name, e.g. `李彦辉`. */
  readonly name: string
  /** English name when the tenant publishes one. */
  readonly enName: string
  /** The user's `open_id`, the stable identity this plugin reports. */
  readonly openId: string
  /** Avatar URL, empty when the CLI reported none. */
  readonly avatarUrl: string
}

/** One wiki space the caller can read. */
export interface LarkSpace {
  /** Space id, or the literal `my_library` for the personal library. */
  readonly spaceId: string
  /** Space name as Feishu reports it. */
  readonly name: string
  /** `my_library` for the personal library, `team` for a knowledge space. */
  readonly spaceType: string
  /** `private` | `public` | … when reported. */
  readonly visibility: string
}

/** One wiki node: a document, a file, or a node with children (a "directory"). */
export interface LarkNode {
  /** Node token — the identity to expand and the token wiki URLs carry. */
  readonly nodeToken: string
  /** The underlying document token (`obj_type` says what it is). */
  readonly objToken: string
  /** `docx` | `sheet` | `bitable` | `slides` | `mindnote` | `file` | … */
  readonly objType: string
  /** `origin` for a real node, `shortcut` for a link into another space. */
  readonly nodeType: string
  /** Title, empty for the few nodes Feishu reports without one. */
  readonly title: string
  /** Whether this node has children — i.e. whether it is a directory here. */
  readonly hasChild: boolean
}

/** One page of a node level. */
export interface LarkLevel {
  /** The nodes of this page, in Feishu's order. */
  readonly nodes: readonly LarkNode[]
  /** Whether a further page exists. */
  readonly hasMore: boolean
  /** Token to pass back for that further page; absent when `hasMore` is false. */
  readonly pageToken: string | undefined
}

/** What the panel needs to render its header. */
export interface LarkState {
  /** True when a user identity is present and usable. */
  readonly loggedIn: boolean
  /** The signed-in user, when there is one. */
  readonly user: LarkUser | undefined
  /** The personal knowledge base, when it resolved. */
  readonly space: LarkSpace | undefined
}

/** Why an operation could not produce a value. */
export type LarkFailure =
  /** `lark-cli` is not installed where this host can find it. */
  | 'cli-missing'
  /** The CLI ran but has no usable user identity (never signed in, or expired). */
  | 'not-logged-in'
  /** The CLI exceeded its deadline. */
  | 'cli-timeout'
  /** The host cannot reach Feishu at all: DNS, TLS interception, proxy, or VPN. */
  | 'cli-network'
  /** The CLI answered an error envelope. */
  | 'cli-failed'
  /** The CLI wrote something this adapter could not read as its JSON envelope. */
  | 'cli-unreadable'

/** The adapter's result type: a value, or a typed reason there is none. */
export type LarkOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: LarkFailure; readonly message: string }

/** Structured logger shape (the subset of cordis's logger this adapter uses). */
export interface LarkLogger {
  /** Informational line. */
  info: (format: unknown, ...params: unknown[]) => void
  /** Warning line. */
  warn: (format: unknown, ...params: unknown[]) => void
}

/** Environment variable that pins the CLI path for an unusual install. */
const BIN_ENV = 'DSH_WEB_UI_LARK_CLI'

/** Binary name on POSIX hosts (this plugin's deployment). */
const BIN_NAME = 'lark-cli'

/** Deadline for a data call: a cold token refresh plus one list request. */
const CALL_TIMEOUT_MS = 20_000

/** Deadline for the local-only `auth status` read. */
const STATUS_TIMEOUT_MS = 8_000

/** Child output ceiling: a 50-node page is small, but `--page-all` is not. */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024

/** How long a resolved CLI path is trusted (an install can move a binary). */
const BIN_CACHE_MS = 30_000

/** Header facts change when someone signs in or renames a space, not per click. */
const STATE_TTL_MS = 30_000

/** The space roster is nearly static. */
const SPACES_TTL_MS = 120_000

/** A level is re-read on every expand, so a short grace period is enough. */
const NODES_TTL_MS = 20_000

/** The personal document library: a per-user alias, valid only with `--as user`. */
export const PERSONAL_LIBRARY = 'my_library'

/** Wiki space ids: numeric, or the `my_library` alias. */
const SPACE_ID_PATTERN = /^(?:my_library|[0-9]{1,32})$/

/** Node tokens are URL-safe base32-ish ids. */
const NODE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** Page tokens are opaque base64 (padded), sometimes with a `|` separator. */
const PAGE_TOKEN_PATTERN = /^[A-Za-z0-9+/=|_-]{1,1024}$/

/**
 * Normalize a CLI diagnostic into one line worth showing a reader.
 *
 * Used only when no JSON envelope could be read from either stream (the CLI
 * normally writes one to stdout, or to stderr when it fails). The CLI prefixes
 * its progress lines with `[lark-cli] [WARN] …`, which is noise in a narrow
 * panel, and its pretty-printed JSON leaves brace-only lines behind.
 * @param stderr - everything the child wrote to stderr.
 * @returns one cleaned line, or `''` when there was nothing worth showing.
 */
function cleanDetail(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 8 && !/^[{}[\](),;:]+$/.test(line))
  const last = lines[lines.length - 1] ?? ''
  return last.replace(/^(?:\[lark-cli\]\s*)+/i, '').replace(/^\[(?:WARN|INFO|ERROR|DEBUG)\]\s*/i, '').slice(0, 300)
}

/**
 * Read a JSON object from one stream.
 *
 * The CLI's own warnings can precede its JSON on the same stream, so everything
 * before the first `{` is dropped rather than treated as a parse failure.
 * @param text - the stream's content.
 * @returns the parsed value, or undefined when the stream holds no JSON object.
 */
function parseJsonBlock(text: string): unknown {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  try {
    return JSON.parse(text.slice(start)) as unknown
  } catch {
    return undefined
  }
}

/**
 * Whether a CLI diagnostic describes an unreachable network rather than a
 * refused operation.
 *
 * The fallback for a CLI that fails without printing its envelope: a deployment
 * behind a TLS-inspecting proxy, or one whose VPN is not connected, fails every
 * Feishu call at the transport layer while nothing about the account or the
 * request is wrong. Saying so turns a cryptic handshake error into an
 * actionable one.
 * @param detail - the cleaned diagnostic line.
 * @returns true when the failure looks like a transport failure.
 */
function looksLikeNetworkFailure(detail: string): boolean {
  return /tls:|handshake failure|x509|certificate|self[- ]signed|dial tcp|connection refused|connection reset|no such host|i\/o timeout|proxyconnect|EOF/i.test(detail)
}

/** The envelope `lark-cli` prints for a data call. */
interface Envelope {
  readonly ok?: boolean
  readonly data?: unknown
  readonly error?: {
    readonly type?: string
    readonly subtype?: string
    readonly message?: string
    readonly hint?: string
  }
  /**
   * `auth status --json` answers a bare status document instead of the
   * `{ok, data}` envelope every other command prints, so its shape is read
   * here rather than treated as a malformed envelope.
   */
  readonly identities?: {
    readonly user?: Record<string, unknown>
    readonly bot?: Record<string, unknown>
  }
}

/** What one child process produced. */
interface ExecOutcome {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

/** The adapter the routes use. */
export interface LarkCli {
  /** Read the signed-in user and the personal knowledge base. */
  state: () => Promise<LarkOutcome<LarkState>>
  /** List the readable wiki spaces, personal library first. */
  spaces: () => Promise<LarkOutcome<readonly LarkSpace[]>>
  /** List one level of nodes under a parent (or the space root). */
  nodes: (input: {
    spaceId: string
    parentNodeToken?: string | undefined
    pageToken?: string | undefined
  }) => Promise<LarkOutcome<LarkLevel>>
  /** Drop every cached read, so the next call reaches Feishu again. */
  invalidate: () => void
}

/**
 * Whether a path is an executable file.
 * @param path - absolute candidate path.
 * @returns true when it exists and is executable.
 */
async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Find the CLI: an explicit override, then `PATH`, then the usual install spots.
 * @param override - the `DSH_WEB_UI_LARK_CLI` value, when set.
 * @returns the executable's path, or undefined when nothing was found.
 */
async function discoverBin(override: string | undefined): Promise<string | undefined> {
  const candidates: string[] = []
  if (override !== undefined && override !== '') candidates.push(override)
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir !== '') candidates.push(join(dir, BIN_NAME))
  }
  // A GUI host can be launched from a context with a thinner PATH than the
  // operator's shell (Finder, an IDE task, a launchd job): the standard install
  // locations are worth checking before declaring the CLI missing.
  candidates.push(join(homedir(), '.local', 'bin', BIN_NAME), `/opt/homebrew/bin/${BIN_NAME}`, `/usr/local/bin/${BIN_NAME}`)
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate
  }
  return undefined
}

/**
 * Run the CLI once and collect everything it printed.
 * @param bin - the executable path.
 * @param args - the complete argv (already validated).
 * @param timeoutMs - deadline for this call.
 * @returns the exit code and both streams.
 */
function execOnce(bin: string, args: readonly string[], timeoutMs: number): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    execFile(bin, [...args], {
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: true,
      // `NO_COLOR`/`CLICOLOR` keep a terminal-flavoured CLI from wrapping its
      // JSON or its error text in escape sequences this adapter would then have
      // to strip.
      env: { ...process.env, NO_COLOR: '1', CLICOLOR: '0' },
    }, (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
      const timedOut = error !== null && error.killed === true
      const raw = error?.code
      const code = error === null ? 0 : typeof raw === 'number' ? raw : 1
      resolve({
        code,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        timedOut,
      })
    })
  })
}

/**
 * Read one string field of a raw CLI record.
 * @param raw - the record.
 * @param key - the snake_case field name.
 * @returns the value, or `''` when it is absent or not a string.
 */
function str(raw: Record<string, unknown>, key: string): string {
  const value = raw[key]
  return typeof value === 'string' ? value : ''
}

/**
 * Normalize one raw wiki node.
 * @param raw - the CLI's node record.
 * @returns the node, or undefined when it carries no usable token.
 */
function toNode(raw: unknown): LarkNode | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const nodeToken = str(record, 'node_token')
  if (nodeToken === '') return undefined
  return {
    nodeToken,
    objToken: str(record, 'obj_token'),
    objType: str(record, 'obj_type'),
    nodeType: str(record, 'node_type'),
    title: str(record, 'title'),
    hasChild: record['has_child'] === true,
  }
}

/**
 * Normalize one raw wiki space.
 * @param raw - the CLI's space record.
 * @param fallbackId - id to use when the record omits one.
 * @returns the space, or undefined when it carries no id.
 */
function toSpace(raw: unknown, fallbackId = ''): LarkSpace | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const spaceId = str(record, 'space_id') || fallbackId
  if (spaceId === '') return undefined
  return {
    spaceId,
    name: str(record, 'name'),
    spaceType: str(record, 'space_type'),
    visibility: str(record, 'visibility'),
  }
}

/** A value with the instant it was read. */
interface Cached<T> {
  readonly at: number
  readonly value: T
}

/**
 * Build the adapter.
 * @param options - logger and an optional pinned CLI path.
 * @returns the adapter, or undefined-returning operations when the CLI is absent.
 */
export function createLarkCli(options: { log: LarkLogger }): LarkCli {
  const { log } = options
  let bin: Cached<string | undefined> | undefined
  let queue: Promise<unknown> = Promise.resolve()
  const stateCache = new Map<string, Cached<LarkState>>()
  const spacesCache = new Map<string, Cached<readonly LarkSpace[]>>()
  const nodesCache = new Map<string, Cached<LarkLevel>>()

  /**
   * Resolve the executable once per cache window.
   * @returns the path, or undefined when the CLI is not installed.
   */
  const resolveBin = async (): Promise<string | undefined> => {
    const now = Date.now()
    if (bin !== undefined && now - bin.at < BIN_CACHE_MS) return bin.value
    const found = await discoverBin(process.env[BIN_ENV])
    bin = { at: now, value: found }
    if (found === undefined) {
      log.warn(`\`${BIN_NAME}\` was not found on PATH or in the usual install locations; the Feishu document panel has no data source`)
    }
    return found
  }

  /**
   * Serialize one CLI call behind every other call.
   *
   * The queue is the plugin's own, and it deliberately survives a failed call:
   * one rejection must not poison the calls that follow it.
   * @param task - the call to run.
   * @returns its result.
   */
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task)
    queue = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * Read an envelope out of a completed call.
   *
   * Both streams are candidates: a successful call prints its envelope on
   * stdout, while a failed one exits non-zero with the envelope on stderr —
   * where the CLI also tags the reason (`"type": "network"`, `"retryable":
   * true`), which is what lets a transport failure be reported as one instead
   * of as a refused request.
   * @param outcome - what the child produced.
   * @param requireEnvelope - whether a missing `ok: true` counts as a failure
   * (false for the bare-document commands, whose payload has no `ok` field).
   * @returns the parsed envelope, or a failure describing why there is none.
   */
  const parse = (outcome: ExecOutcome, requireEnvelope: boolean): LarkOutcome<Envelope> => {
    const stdout = outcome.stdout.trim()
    const stderr = outcome.stderr.trim()
    const body = stdout === '' ? parseJsonBlock(stderr) : parseJsonBlock(stdout)
    if (typeof body === 'object' && body !== null) {
      const envelope = body as Envelope
      if (envelope.ok === false || (requireEnvelope && envelope.ok !== true)) {
        const error = envelope.error
        const message = error?.message ?? `${BIN_NAME} refused the call`
        const hint = error?.hint
        return {
          ok: false,
          // The CLI classifies its own failures; a transport one is worth
          // distinguishing because the fix is the network, not the account.
          code: error?.type === 'network' ? 'cli-network' : 'cli-failed',
          message: hint === undefined ? message : `${message} (${hint})`,
        }
      }
      return { ok: true, value: envelope }
    }
    if (outcome.timedOut) {
      return { ok: false, code: 'cli-timeout', message: `${BIN_NAME} did not answer within ${String(CALL_TIMEOUT_MS)}ms` }
    }
    const detail = cleanDetail(stderr)
    if (detail !== '') {
      return {
        ok: false,
        code: looksLikeNetworkFailure(detail) ? 'cli-network' : 'cli-failed',
        message: detail,
      }
    }
    return {
      ok: false,
      code: 'cli-unreadable',
      message: stdout === ''
        ? `${BIN_NAME} exited with code ${String(outcome.code)} and printed nothing`
        : `${BIN_NAME} printed no JSON envelope: ${stdout.slice(0, 200)}`,
    }
  }

  /**
   * Run one CLI call and return its envelope.
   * @param args - argv without the trailing identity/format flags.
   * @param options2 - identity choice, deadline, and envelope strictness.
   * @returns the envelope, or a typed failure.
   */
  const call = async (
    args: readonly string[],
    options2: { userIdentity: boolean; timeoutMs: number; requireEnvelope?: boolean },
  ): Promise<LarkOutcome<Envelope>> => {
    const path = await resolveBin()
    if (path === undefined) {
      return {
        ok: false,
        code: 'cli-missing',
        message: `\`${BIN_NAME}\` is not installed where this host can find it (set ${BIN_ENV} to its absolute path)`,
      }
    }
    const argv = [
      ...args,
      ...(options2.userIdentity ? ['--as', 'user', '--format', 'json'] : []),
    ]
    const outcome = await serialize(() => execOnce(path, argv, options2.timeoutMs))
    return parse(outcome, options2.requireEnvelope !== false)
  }

  /**
   * Read the CLI's auth status (identity facts, no network call).
   * @returns the raw parsed status, or a typed failure.
   */
  const authStatus = async (): Promise<LarkOutcome<{
    user: { status: string; openId: string; userName: string } | undefined
  }>> => {
    const result = await call(['auth', 'status', '--json'], {
      userIdentity: false,
      timeoutMs: STATUS_TIMEOUT_MS,
      // This command prints its own bare document rather than the standard
      // envelope, so a missing `ok` is the normal shape here, not a refusal.
      requireEnvelope: false,
    })
    if (!result.ok) return result
    const raw = result.value.identities?.user
    if (raw === undefined) return { ok: true, value: { user: undefined } }
    return {
      ok: true,
      value: {
        user: {
          status: str(raw, 'status'),
          openId: str(raw, 'openId'),
          userName: str(raw, 'userName'),
        },
      },
    }
  }

  const state = async (): Promise<LarkOutcome<LarkState>> => {
    const cached = stateCache.get('state')
    if (cached !== undefined && Date.now() - cached.at < STATE_TTL_MS) return { ok: true, value: cached.value }

    const status = await authStatus()
    if (!status.ok) return status
    const identity = status.value.user
    // `available: false` / a missing identity means nobody ever signed in;
    // `expired` means the refresh window is over and a new login is required.
    if (identity === undefined || identity.status === 'missing') {
      return {
        ok: false,
        code: 'not-logged-in',
        message: `no Feishu user is signed in to ${BIN_NAME} — run \`${BIN_NAME} auth login\``,
      }
    }
    if (identity.status === 'expired') {
      return {
        ok: false,
        code: 'not-logged-in',
        message: `the Feishu login in ${BIN_NAME} has expired — run \`${BIN_NAME} auth login\` again`,
      }
    }

    // The profile call is what actually exercises the token (and therefore what
    // refreshes it); `auth status` alone would report a stale-but-present user.
    const profile = await call(['contact', '+get-user'], { userIdentity: true, timeoutMs: CALL_TIMEOUT_MS })
    let user: LarkUser = { name: identity.userName, enName: '', openId: identity.openId, avatarUrl: '' }
    if (profile.ok) {
      const record = (profile.value.data as { user?: Record<string, unknown> } | undefined)?.user
      if (record !== undefined) {
        user = {
          name: str(record, 'name') || identity.userName,
          enName: str(record, 'en_name'),
          openId: str(record, 'open_id') || identity.openId,
          avatarUrl: str(record, 'avatar_url'),
        }
      }
    } else {
      // The identity is known but the profile read failed: report the user the
      // status gave us, and let the space call below decide if this is fatal.
      log.warn(`could not read the Feishu profile: ${profile.message}`)
    }

    const personal = await call(
      ['wiki', 'spaces', 'get', '--params', JSON.stringify({ space_id: PERSONAL_LIBRARY })],
      { userIdentity: true, timeoutMs: CALL_TIMEOUT_MS },
    )
    // A user who is signed in but has never opened their personal library gets
    // no space record; the panel still renders the user and lists from the
    // default level, so that is a warning rather than a failure.
    const space = personal.ok
      ? toSpace((personal.value.data as { space?: unknown } | undefined)?.space, PERSONAL_LIBRARY)
      : undefined
    if (!personal.ok) log.warn(`could not read the personal knowledge base: ${personal.message}`)

    const value: LarkState = { loggedIn: true, user, space }
    stateCache.set('state', { at: Date.now(), value })
    return { ok: true, value }
  }

  const spaces = async (): Promise<LarkOutcome<readonly LarkSpace[]>> => {
    const cached = spacesCache.get('spaces')
    if (cached !== undefined && Date.now() - cached.at < SPACES_TTL_MS) return { ok: true, value: cached.value }
    // The personal library is not in this list (Feishu's API never returns it),
    // so it is resolved separately and put first — it is the default view.
    const result = await call(
      ['wiki', '+space-list', '--page-all', '--page-limit', '5'],
      { userIdentity: true, timeoutMs: CALL_TIMEOUT_MS },
    )
    if (!result.ok) return result
    const rows = (result.value.data as { spaces?: unknown[] } | undefined)?.spaces ?? []
    const collected = rows.flatMap((row) => {
      const space = toSpace(row)
      return space === undefined ? [] : [space]
    })
    // The personal library's own name comes from its dedicated read; when that
    // has not run yet, run it, so the roster is the same whichever route the
    // panel happens to call first.
    let personal = stateCache.get('state')?.value.space
    if (personal === undefined) {
      const header = await state()
      personal = header.ok ? header.value.space : undefined
    }
    const first: LarkSpace = personal
      ?? { spaceId: PERSONAL_LIBRARY, name: '', spaceType: 'my_library', visibility: 'private' }
    const value = [first, ...collected.filter(space => space.spaceId !== first.spaceId)]
    spacesCache.set('spaces', { at: Date.now(), value })
    return { ok: true, value }
  }

  const nodes: LarkCli['nodes'] = async (input) => {
    const { spaceId } = input
    if (!SPACE_ID_PATTERN.test(spaceId)) {
      return { ok: false, code: 'cli-failed', message: `not a wiki space id: ${spaceId}` }
    }
    const parent = input.parentNodeToken
    if (parent !== undefined && !NODE_TOKEN_PATTERN.test(parent)) {
      return { ok: false, code: 'cli-failed', message: `not a wiki node token: ${parent}` }
    }
    const pageToken = input.pageToken
    if (pageToken !== undefined && !PAGE_TOKEN_PATTERN.test(pageToken)) {
      return { ok: false, code: 'cli-failed', message: 'not a wiki page token' }
    }

    const key = `${spaceId}\u0000${parent ?? ''}\u0000${pageToken ?? ''}`
    const cached = nodesCache.get(key)
    if (cached !== undefined && Date.now() - cached.at < NODES_TTL_MS) return { ok: true, value: cached.value }

    const result = await call([
      'wiki', '+node-list',
      '--space-id', spaceId,
      ...(parent === undefined ? [] : ['--parent-node-token', parent]),
      ...(pageToken === undefined ? [] : ['--page-token', pageToken]),
      '--page-size', '50',
    ], { userIdentity: true, timeoutMs: CALL_TIMEOUT_MS })
    if (!result.ok) return result

    const data = result.value.data as { nodes?: unknown[]; has_more?: unknown; page_token?: unknown } | undefined
    const rows = data?.nodes ?? []
    const level: LarkLevel = {
      nodes: rows.flatMap((row) => {
        const node = toNode(row)
        return node === undefined ? [] : [node]
      }),
      hasMore: data?.has_more === true,
      pageToken: typeof data?.page_token === 'string' && data.page_token !== '' ? data.page_token : undefined,
    }
    nodesCache.set(key, { at: Date.now(), value: level })
    return { ok: true, value: level }
  }

  /** Forget every cached read (the panel's Refresh gesture). */
  const invalidate = (): void => {
    stateCache.clear()
    spacesCache.clear()
    nodesCache.clear()
  }

  return { state, spaces, nodes, invalidate }
}