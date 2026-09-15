/**
 * The `lark-cli` adapter: the one place in this plugin that talks to Feishu.
 *
 * Feishu credentials, token refresh, and the QR login all live in `lark-cli`
 * (the operator's own integration), so this plugin owns none of them. What it
 * owns is the seam: run the CLI with a fixed argv, parse its JSON envelope, and
 * hand the browser a small, stable shape — the signed-in user, one level of a
 * Drive folder's children, and the folders created for a project.
 *
 * The folders this adapter reads are the PROJECT's own: creating a project
 * creates one folder per project in this deployment's archive folder, and the
 * panel shows that folder's contents rather than a knowledge base. Two reads
 * serve that: `files` lists one page of one folder, and `children` walks a
 * folder's pages for the name lookup that adopts a folder a project created
 * before its token was recorded (see `GET /folder` in `./routes.ts`).
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

/** One entry in a Drive folder: a document, an uploaded file, or a subfolder. */
export interface LarkEntry {
  /** The entry's own token: what a Feishu link addresses and what names it. */
  readonly token: string
  /**
   * The token to LIST when this entry is a directory, `''` when it is a leaf.
   *
   * A plain folder lists by its own token; a SHORTCUT into a folder lists by its
   * target's. Keeping both facts in one field is what makes "is this a
   * directory" and "what do I expand" the same question in the browser, rather
   * than two that could disagree.
   */
  readonly expandToken: string
  /** `folder` | `docx` | `sheet` | `bitable` | `mindnote` | `slides` | `file` | `shortcut` | … */
  readonly type: string
  /** Title, empty for the few entries Feishu reports without one. */
  readonly name: string
  /**
   * Browser link. This adapter always sets it — Feishu reports one for most
   * entries, and the rest are built from the type and token below — so the
   * panel never has to know Feishu's per-type URL layout.
   */
  readonly url: string
}

/** One page of one folder's children. */
export interface LarkLevel {
  /** The entries of this page, in Feishu's order. */
  readonly nodes: readonly LarkEntry[]
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
}

/** One Drive folder: a project's own folder in this deployment's archive. */
export interface LarkFolder {
  /** Folder name — the project's name, as the operator typed it. */
  readonly name: string
  /** The folder's token: what lists its contents and what a record stores. */
  readonly folderToken: string
  /** Shareable URL; always set by this adapter. */
  readonly url: string
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
  /**
   * The login does not carry a scope this call needs. Distinct from
   * `cli-failed` because the fix is a re-login with that scope, and the
   * envelope names which one.
   */
  | 'scope-missing'
  /** The caller may not do this to that resource: a folder they cannot read. */
  | 'forbidden'

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

/** Header facts change when someone signs in, not per click. */
const STATE_TTL_MS = 30_000

/** A level is re-read on every expand, so a short grace period is enough. */
const NODES_TTL_MS = 20_000

/**
 * How long a resolved folder listing is reused by the name lookup.
 *
 * The archive folder changes when a project is created — rare, and the operator
 * has just asked us to look — so this is short enough that a folder created a
 * moment ago is seen, and long enough that the panel's resolve and its first
 * listing cost one walk rather than two.
 */
const CHILDREN_TTL_MS = 15_000

/**
 * Ceiling on pages walked by `children`.
 *
 * The archive holds one folder per project; at 200 entries a page, 10 pages is
 * 2000 projects. A bounded walk is what keeps a listing from becoming an
 * unbounded fan-out against a live API, and a walk that hits the ceiling says so
 * in the log rather than pretending the folder was fully read.
 */
const CHILDREN_MAX_PAGES = 10

/** Feishu's own ceiling on a folder name. */
const FOLDER_NAME_MAX_BYTES = 256

/**
 * The last path segment of a project directory, which is the project's name.
 *
 * Kept here — the host — rather than in the browser: it is the host that hands
 * the value to the CLI, and a name is the one argument in this adapter that is
 * NOT an opaque token, so it is worth normalizing in the same module that
 * validates it. Windows separators are handled too, so a project added from a
 * Windows host does not produce a folder called `C:\work\demo`.
 * @param path - the project's absolute directory.
 * @returns the segment, or `''` when the path names no directory.
 */
export function folderNameFromPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return (at < 0 ? trimmed : trimmed.slice(at + 1)).trim()
}

/**
 * Drive tokens — folders, documents, and files — share one alphabet.
 *
 * They are opaque to this adapter: the only thing it does with one is prove it
 * cannot be argv-shaped text before handing it to the CLI. Feishu's current
 * tokens are URL-safe base32-ish (`fldcn…`, `doxcn…`), and older ones are plain
 * alphanumerics.
 */
export const DRIVE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/**
 * A name this adapter will hand to Feishu: no control characters (`U+0000`–`U+001F`
 * and `U+007F`, which is what a device path can smuggle in), not blank, and
 * within Feishu's byte ceiling. Everything else — spaces, dots, emoji, CJK — is
 * a legitimate folder name and is passed through untouched, because this
 * adapter's job is to carry the operator's own directory name, not to rewrite
 * it.
 */
const FOLDER_NAME_PATTERN = /^[^\u0000-\u001F\u007F]+$/

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

/**
 * Classify one of the CLI's own error envelopes into this adapter's vocabulary.
 *
 * The CLI already names the reason (`type`/`subtype`); collapsing all of them
 * into `cli-failed` would make two very different operator problems — "your
 * network is wrong" and "your login is missing a permission" — read the same in
 * the panel.
 * @param type - the envelope's `error.type`.
 * @param subtype - the envelope's `error.subtype`.
 * @returns the failure code to report.
 */
function failureCode(type: string | undefined, subtype: string | undefined): LarkFailure {
  if (type === 'network') return 'cli-network'
  if (type === 'authorization') {
    return subtype === 'missing_scope' || subtype === 'insufficient_scope' ? 'scope-missing' : 'forbidden'
  }
  // Feishu's own refusals arrive under a generic type with a permission-flavoured
  // subtype (`permission_denied`), which is the shape a folder the caller cannot
  // read produces.
  if (subtype !== undefined && /permission|forbidden|denied|no_permission/i.test(subtype)) return 'forbidden'
  return 'cli-failed'
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
  /** Read the signed-in user. */
  state: () => Promise<LarkOutcome<LarkState>>
  /**
   * List one page of one folder's children.
   *
   * This is the only read the panel needs per directory it opens, which is why
   * it is a page rather than a walk: a folder with 300 documents costs one
   * request until the operator asks for the next page.
   */
  files: (input: {
    folderToken: string
    pageToken?: string | undefined
  }) => Promise<LarkOutcome<LarkLevel>>
  /**
   * List EVERY child of one folder, walking its pages.
   *
   * Read for one purpose: the name lookup that adopts the folder a project
   * created before its token was recorded. It is bounded (see
   * `CHILDREN_MAX_PAGES`) and cached briefly, because it answers a question
   * about the archive folder rather than about a directory the operator is
   * browsing.
   */
  children: (input: { folderToken: string }) => Promise<LarkOutcome<readonly LarkEntry[]>>
  /**
   * Create a Drive folder named `name` inside `parentFolderToken`.
   *
   * It CREATES, unconditionally: it does not look for an existing folder of
   * that name first. That is a deliberate product decision rather than an
   * oversight — Feishu allows two sibling folders with the same name and never
   * refuses the second, so the check could only ever be a read plus a guess; see
   * the note on `createFolder` below for what that trades away. The panel's own
   * ADOPTION of an existing folder (`GET /folder`) is the other half of that
   * decision: it looks, and offers what it found, rather than creating.
   */
  createFolder: (input: {
    parentFolderToken: string
    name: string
  }) => Promise<LarkOutcome<LarkFolder>>
  /** Drop every cached read, so the next call reaches Feishu again. */
  invalidate: () => void
}

/**
 * Feishu's per-type browser URL for a Drive resource.
 *
 * The listing usually reports its own `url`, and that is preferred — it is the
 * link Feishu itself considers canonical for the tenant. This is the fallback
 * for the entries that omit it, and it exists here, in the host, because the
 * per-type path layout is Feishu's vocabulary and not the panel's: the browser
 * half only ever opens a URL it was handed.
 *
 * A SHORTCUT's `url` addresses its target, which is exactly what opening one
 * should do.
 * @param type - the entry's `type` as Feishu reported it.
 * @param token - the entry's token.
 * @returns an absolute Feishu URL, or `''` when the type has no known layout.
 */
export function feishuUrl(type: string, token: string): string {
  const segment = ((): string => {
    switch (type) {
      case 'folder': return 'drive/folder'
      case 'docx': return 'docx'
      case 'doc': return 'docs'
      case 'sheet': return 'sheets'
      case 'bitable': return 'base'
      case 'mindnote': return 'mindnotes'
      case 'slides': return 'slides'
      case 'file': return 'file'
      default: return ''
    }
  })()
  return segment === '' || token === '' ? '' : `${FEISHU_ORIGIN}/${segment}/${token}`
}

/**
 * Feishu's brand-less origin: it redirects to the caller's own tenant, so a link
 * built here opens in whichever tenant the reader is signed in to.
 */
const FEISHU_ORIGIN = 'https://feishu.cn'


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
 * Normalize one raw Drive entry.
 *
 * The directory question is answered HERE, once, because two shapes mean "this
 * has children": a plain `folder`, whose own token lists it, and a `shortcut`
 * whose target is a folder, which lists by the target's token. Collapsing them
 * into `expandToken` is what lets the panel treat both as one kind of row.
 * @param raw - the CLI's file record.
 * @returns the entry, or undefined when it carries no usable token.
 */
function toEntry(raw: unknown): LarkEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const token = str(record, 'token')
  if (token === '') return undefined
  const type = str(record, 'type')
  const shortcut = typeof record['shortcut_info'] === 'object' && record['shortcut_info'] !== null
    ? record['shortcut_info'] as Record<string, unknown>
    : undefined
  const targetToken = shortcut === undefined ? '' : str(shortcut, 'target_token')
  const targetType = shortcut === undefined ? '' : str(shortcut, 'target_type')
  const expandToken = type === 'folder'
    ? token
    : (type === 'shortcut' && targetType === 'folder' ? targetToken : '')
  // A shortcut is a pointer, so its link must address the TARGET rather than the
  // shortcut itself: opening a shortcut should open what it points at, and its
  // target's type is what says which URL layout applies. Everything else links
  // to itself.
  const linkType = type === 'shortcut' && targetType !== '' ? targetType : type
  const linkToken = type === 'shortcut' && targetToken !== '' ? targetToken : token
  return {
    token,
    expandToken,
    type,
    name: str(record, 'name'),
    // Feishu reports a link for most entries; the rest get one built from their
    // type, so the panel never has to know the layout itself.
    url: str(record, 'url') || feishuUrl(linkType, linkToken),
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
  const filesCache = new Map<string, Cached<LarkLevel>>()
  const childrenCache = new Map<string, Cached<readonly LarkEntry[]>>()


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
          // distinguishing because the fix is the network, not the account, and
          // an authorization one because the fix is a re-login, not a retry.
          code: failureCode(error?.type, error?.subtype),
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
      // status gave us. Nothing else in this adapter depends on the profile, so
      // this is a warning rather than a failure.
      log.warn(`could not read the Feishu profile: ${profile.message}`)
    }

    const value: LarkState = { loggedIn: true, user }
    stateCache.set('state', { at: Date.now(), value })
    return { ok: true, value }
  }

  /**
   * One page of one folder's children.
   * @param input - the folder to list and the page to continue from.
   * @returns the page, or a typed failure.
   */
  const files: LarkCli['files'] = async (input) => {
    const { folderToken } = input
    if (!DRIVE_TOKEN_PATTERN.test(folderToken)) {
      return { ok: false, code: 'cli-failed', message: `not a Drive folder token: ${folderToken}` }
    }
    const pageToken = input.pageToken
    if (pageToken !== undefined && !PAGE_TOKEN_PATTERN.test(pageToken)) {
      return { ok: false, code: 'cli-failed', message: 'not a Drive page token' }
    }

    const key = `${folderToken}\u0000${pageToken ?? ''}`
    const cached = filesCache.get(key)
    if (cached !== undefined && Date.now() - cached.at < NODES_TTL_MS) return { ok: true, value: cached.value }

    // The native command takes its whole query in `--params` rather than in
    // flags (see the `lark-drive` skill's reference): the JSON is built here, so
    // no part of it can be reshaped by a caller's text.
    const result = await call([
      'drive', 'files', 'list',
      '--params', JSON.stringify({
        folder_token: folderToken,
        page_size: 50,
        ...(pageToken === undefined ? {} : { page_token: pageToken }),
      }),
    ], { userIdentity: true, timeoutMs: CALL_TIMEOUT_MS })
    if (!result.ok) return result

    const data = result.value.data as {
      files?: unknown[]
      has_more?: unknown
      next_page_token?: unknown
    } | undefined
    const rows = data?.files ?? []
    const level: LarkLevel = {
      nodes: rows.flatMap((row) => {
        const entry = toEntry(row)
        return entry === undefined ? [] : [entry]
      }),
      hasMore: data?.has_more === true,
      pageToken: typeof data?.next_page_token === 'string' && data.next_page_token !== ''
        ? data.next_page_token
        : undefined,
    }
    filesCache.set(key, { at: Date.now(), value: level })
    return { ok: true, value: level }
  }

  /**
   * Every child of one folder, walking its pages.
   *
   * Used by the name lookup that adopts an existing project folder. The walk
   * stops at `CHILDREN_MAX_PAGES` — and says so in the log — rather than
   * following a hostile or mistaken `has_more` forever: an adoption that missed
   * an entry at project 2001 is a readable outcome, while an unbounded request
   * loop against a live API is not.
   * @param input - the folder to walk.
   * @returns every entry the walk collected, or a typed failure.
   */
  const children: LarkCli['children'] = async (input) => {
    const { folderToken } = input
    if (!DRIVE_TOKEN_PATTERN.test(folderToken)) {
      return { ok: false, code: 'cli-failed', message: `not a Drive folder token: ${folderToken}` }
    }
    const cached = childrenCache.get(folderToken)
    if (cached !== undefined && Date.now() - cached.at < CHILDREN_TTL_MS) return { ok: true, value: cached.value }

    const collected: LarkEntry[] = []
    let pageToken: string | undefined
    for (let page = 0; page < CHILDREN_MAX_PAGES; page += 1) {
      const level = await files({
        folderToken,
        ...(pageToken === undefined ? {} : { pageToken }),
      })
      if (!level.ok) return level
      collected.push(...level.value.nodes)
      if (!level.value.hasMore || level.value.pageToken === undefined) {
        childrenCache.set(folderToken, { at: Date.now(), value: collected })
        return { ok: true, value: collected }
      }
      pageToken = level.value.pageToken
    }
    log.warn(`stopped walking ${folderToken} after ${String(CHILDREN_MAX_PAGES)} pages; the listing is partial`)
    // Deliberately NOT cached: a truncated walk must not become the answer the
    // next lookup reuses.
    return { ok: true, value: collected }
  }

  /** Forget every cached read (the panel's Refresh gesture). */
  const invalidate = (): void => {
    stateCache.clear()
    filesCache.clear()
    childrenCache.clear()
  }


  /**
   * Create one Drive folder under a parent.
   *
   * ## Why there is no "does it already exist" check here
   *
   * Feishu Drive accepts two sibling folders with the same name and never
   * refuses the second, so a create call cannot answer "already taken" — the
   * only way to know is to LIST the parent first and compare names. This
   * deployment decided against that read on the CREATE path: creating the folder
   * is the operator's intent, and the consequence is deliberate and worth
   * stating: if a folder of that name is already present, this creates a SECOND
   * one. Re-adding the same project therefore adds a folder, it does not reuse
   * the first. The panel's adoption path (`GET /folder`) is where an existing
   * folder is LOOKED for instead — with the operator deciding which one a
   * project uses.
   *
   * Everything that IS still checked is checked before any call: the parent
   * token and the name are validated here, and a name is an ARGV ELEMENT (never
   * a shell word), so nothing from a request can reshape the command.
   *
   * @param input - the parent folder token and the folder name.
   * @returns the new folder's identity, or a typed failure.
   */
  const createFolder: LarkCli['createFolder'] = async (input) => {
    const { parentFolderToken, name } = input
    if (!DRIVE_TOKEN_PATTERN.test(parentFolderToken)) {
      return { ok: false, code: 'cli-failed', message: `not a Drive folder token: ${parentFolderToken}` }
    }
    // A name is written INTO Feishu, so an empty or control-bearing one would
    // create a folder that is impossible to address from a terminal afterwards.
    if (!FOLDER_NAME_PATTERN.test(name) || name.trim() === '') {
      return { ok: false, code: 'cli-failed', message: `not a usable folder name: ${JSON.stringify(name)}` }
    }
    if (Buffer.byteLength(name, 'utf8') > FOLDER_NAME_MAX_BYTES) {
      return {
        ok: false,
        code: 'cli-failed',
        message: `the folder name is ${String(Buffer.byteLength(name, 'utf8'))} bytes, over Feishu's ${String(FOLDER_NAME_MAX_BYTES)}-byte ceiling`,
      }
    }

    const result = await call([
      'drive', '+create-folder',
      '--folder-token', parentFolderToken,
      '--name', name,
    ], { userIdentity: true, timeoutMs: CALL_TIMEOUT_MS })
    if (!result.ok) return result
    const data = result.value.data as { folder_token?: unknown; url?: unknown } | undefined
    const token = typeof data?.folder_token === 'string' ? data.folder_token : ''
    // A create that reported no token is a failure, not a success: the caller
    // would have nothing to link to or upload into.
    if (token === '') {
      return { ok: false, code: 'cli-unreadable', message: `${BIN_NAME} created a folder but reported no token` }
    }
    const reported = typeof data?.url === 'string' ? data.url : ''
    return {
      ok: true,
      // The new folder's link is recorded with it, so the panel can offer
      // "open in Feishu" even when this response carried no URL.
      value: { name, folderToken: token, url: reported === '' ? feishuUrl('folder', token) : reported },
    }
  }

  return { state, files, children, createFolder, invalidate }
}
