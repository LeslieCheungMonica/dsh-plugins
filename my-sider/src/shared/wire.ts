/**
 * The wire contract shared by both halves of `my-sider`.
 *
 * Two families of routes, and they answer in deliberately different ways:
 *
 * 1. **The command panel** (`/my-sider/shell/*`) answers JSON envelopes, and a
 *    command's output travels by POLLING: a run has an immutable id and a
 *    monotonic byte count, and each poll asks for everything appended after an
 *    offset the reader already holds. Offsets are absolute, so a reload, a
 *    remount, or a slow frame resumes exactly where it was, and no long-lived
 *    socket has to survive a proxy, a browser tab limit, or a panel unmount.
 * 2. **The web panel's relay** (`/my-sider/url/*`) answers with the fetched
 *    DOCUMENT itself, because an `<iframe src>` can only consume a body — not an
 *    envelope. Its one JSON exception is `probe`, which answers a question *about*
 *    a URL (reachable? will it refuse to be framed?) before the panel commits an
 *    iframe to it.
 *
 * A domain failure is a VALUE (`{ ok: false, error }`) rather than a status code
 * wherever an envelope is used: the panel wants the sentence, not the number.
 *
 * @module my-sider/shared/wire
 */

/** Path prefix of the bottom command panel's routes. */
export const SHELL_ROUTE_PREFIX = '/my-sider/shell'

/** Start one command line. */
export const SHELL_RUN_PATH = `${SHELL_ROUTE_PREFIX}/run`

/** Read everything a run has produced after an offset. */
export const SHELL_POLL_PATH = `${SHELL_ROUTE_PREFIX}/poll`

/** Stop one running command. */
export const SHELL_KILL_PATH = `${SHELL_ROUTE_PREFIX}/kill`

/** Every run this host process still remembers, newest first. */
export const SHELL_LIST_PATH = `${SHELL_ROUTE_PREFIX}/list`

/** The directory a command falls back to when no session names one. */
export const SHELL_CONTEXT_PATH = `${SHELL_ROUTE_PREFIX}/context`

/** Path prefix of the web panel's relay. */
export const RELAY_ROUTE_PREFIX = '/my-sider/url'

/** Stream one fetched document (the iframe `src` of a relayed tab). */
export const RELAY_FETCH_PATH = `${RELAY_ROUTE_PREFIX}/fetch`

/** Ask whether a URL is reachable from the host, and whether it allows framing. */
export const RELAY_PROBE_PATH = `${RELAY_ROUTE_PREFIX}/probe`

/** How the browser reads every JSON route: a result, never a thrown transport error. */
export type WireResponse<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: WireError }

/** A domain failure, already phrased for a human. */
export interface WireError {
  /** Stable machine code; the panels switch on it to pick their follow-up advice. */
  readonly code: WireErrorCode
  /** One sentence. */
  readonly message: string
}

/** Every failure the command panel distinguishes. */
export type WireErrorCode =
  /** The directory does not exist, or is not a directory. */
  | 'no-directory'
  /** A parameter was absent or malformed. */
  | 'bad-request'
  /** The command was empty. */
  | 'no-command'
  /** The process could not be started at all. */
  | 'spawn-failed'
  /** The sandbox refused to wrap the command, so nothing was run. */
  | 'sandbox-refused'
  /** No such run id: it was never started, or the host has forgotten it. */
  | 'unknown-run'
  /** This surface is switched off in the plugin row's config. */
  | 'disabled'
  /** A bug in this plugin. */
  | 'internal'

/** One command's identity and state, without its output. */
export interface ShellRun {
  /** Stable id, unique within the host process. */
  readonly id: string
  /** The command line exactly as the operator typed it. */
  readonly command: string
  /** The directory it runs in. */
  readonly dir: string
  /** When it started, ISO-8601. */
  readonly startedAt: string
  /** True until the process tree has exited. */
  readonly running: boolean
  /** Exit code, or null while running or when the process died from a signal. */
  readonly exitCode: number | null
  /** The signal that ended it, when one did. */
  readonly signal: string | null
  /** Wall-clock duration: elapsed while running, total once settled. */
  readonly durationMs: number
  /** Total bytes produced so far, ever — the absolute output length. */
  readonly bytes: number
  /**
   * True once the host has dropped part of this run's output to stay inside its
   * buffer. Output before {@link ShellPoll.from} is then gone for good.
   */
  readonly truncated: boolean
  /** True when the run was stopped because it outlived its budget. */
  readonly timedOut: boolean
  /**
   * The file-effect policy this run actually executed under, resolved on the
   * host. Reported rather than assumed: a command surface the operator cannot
   * see the confinement of turns a write failure into a mystery.
   */
  readonly sandboxMode: string
}

/** One poll's answer: the run, and whatever followed the caller's offset. */
export interface ShellPoll {
  /** The run's identity and state. */
  readonly run: ShellRun
  /** The text to append, decoded as UTF-8. Empty when nothing is new. */
  readonly output: string
  /** The offset this answer began at; already clamped to the retained window. */
  readonly from: number
  /** The offset to send next time. */
  readonly next: number
}

/** One start request. */
export interface ShellRunRequest {
  /** Absolute directory the command runs in. */
  readonly dir: string
  /** The command line, evaluated by a shell. */
  readonly command: string
}

/** The fallback working directory, when no session names a project. */
export interface ShellContext {
  /** Absolute path of the host process's working directory. */
  readonly dir: string
  /** True when the command panel can start anything at all. */
  readonly enabled: boolean
}

/** What the host learned about a URL before the panel committed an iframe to it. */
export interface RelayProbe {
  /** The URL that was asked about, as normalized by the host. */
  readonly url: string
  /** Where the request actually landed (after redirects). */
  readonly finalUrl: string
  /** The HTTP status of the response the host received. */
  readonly status: number
  /** The response's content type, lower-cased and stripped of parameters. */
  readonly contentType: string
  /**
   * True when the site forbids being framed (`X-Frame-Options` or a
   * `frame-ancestors` directive). A DIRECT iframe will then stay blank; the
   * panel offers the relay or a new browser tab instead.
   */
  readonly frameBlocked: boolean
  /** True when the host could not reach the URL at all. */
  readonly unreachable: boolean
  /** Why it was unreachable, when it was. */
  readonly reason?: string
}
