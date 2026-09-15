/**
 * The wire contract of the bottom command bar.
 *
 * It mirrors `gitwire.ts` on purpose — same envelope, same "a domain failure is
 * a value, not a status code" rule — because the browser half talks to both and
 * two conventions on one page would be one convention too many.
 *
 * The one structural difference is the transport. A git read answers a question;
 * a command answers with a STREAM, and this contract carries it by POLLING: a
 * run has an immutable id and a monotonic byte count, and each poll asks for
 * everything appended after an offset it already holds. Polling rather than
 * server-sent events is a deliberate trade: a command's output is bursty, a
 * 400 ms poll is indistinguishable from a stream at human scale, and it keeps
 * the transport to the same plain request the rest of this plugin uses — no
 * long-lived sockets to be buffered by a proxy, capped by a browser, or leaked
 * when a panel unmounts. Offsets are ABSOLUTE, so a client that reconnects,
 * reloads, or falls behind simply asks again from where it was and the host
 * answers within its retained window (marked `truncated` when it cannot).
 *
 * @module dsh-web-ui/shared/termwire
 */

/** Path prefix of every route the command bar owns. */
export const TERM_ROUTE_PREFIX = '/dsh-web-ui/term'

/** Start one command. */
export const TERM_RUN_PATH = `${TERM_ROUTE_PREFIX}/run`

/** Read everything a run has produced after an offset. */
export const TERM_POLL_PATH = `${TERM_ROUTE_PREFIX}/poll`

/** Stop one running command. */
export const TERM_KILL_PATH = `${TERM_ROUTE_PREFIX}/kill`

/** Every run this host process still remembers. */
export const TERM_LIST_PATH = `${TERM_ROUTE_PREFIX}/list`

/** How the browser reads every route: a result, never a thrown transport error. */
export type TermResponse<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: TermError }

/** A domain failure, already phrased for a human. */
export interface TermError {
  /** Stable machine code; the bar switches on it to pick its follow-up advice. */
  readonly code: TermErrorCode
  /** One sentence. */
  readonly message: string
}

/** Every failure this surface distinguishes. */
export type TermErrorCode =
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
  /** A bug in this plugin. */
  | 'internal'

/** One command's identity and state, without its output. */
export interface TermRun {
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
   * buffer. Output before {@link TermPoll.from} is then gone for good.
   */
  readonly truncated: boolean
  /**
   * True when the run was stopped because it outlived the configured budget
   * rather than because the command decided to exit.
   */
  readonly timedOut: boolean
  /**
   * The file-effect policy this run actually executed under, resolved on the
   * host. It is reported rather than assumed: a terminal that silently cannot
   * write where the operator expects is worse than one that says so, and this
   * is the fact that explains a surprising failure.
   */
  readonly sandboxMode: string
}

/** One poll's answer: the run, and whatever followed the caller's offset. */
export interface TermPoll {
  /** The run's identity and state. */
  readonly run: TermRun
  /** The bytes to append, decoded as UTF-8. Empty when nothing is new. */
  readonly output: string
  /** The offset this answer began at; already-clamped to the retained window. */
  readonly from: number
  /** The offset to send next time. */
  readonly next: number
}

/** One poll request's parameters. */
export interface TermPollRequest {
  /** Which run to read. */
  readonly id: string
  /** The offset the caller already holds; 0 for "everything retained". */
  readonly from: number
}

/** One start request. */
export interface TermRunRequest {
  /** Absolute directory the command runs in. */
  readonly dir: string
  /** The command line, evaluated by a shell — see the README. */
  readonly command: string
}
