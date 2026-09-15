/**
 * The command bar's read and write face over the host's terminal routes.
 *
 * Four calls, and the poll is the interesting one: it carries the offset the
 * reader already holds and gets back whatever followed plus the offset to send
 * next time. That makes the reader's position the CLIENT's state, so a reload, a
 * remount, or a slow render resumes from where it truly was instead of
 * replaying or skipping — and the host never has to remember where any
 * particular browser got to.
 *
 * Transport failures are phrased here, exactly as in `gitapi.ts`: a route that
 * answers HTML is the SPA fallback (the host half is not mounted, which names
 * the fix), while a rejecting `fetch` is the host being gone.
 *
 * @module dsh-web-ui/client/termapi
 */
import type {
  TermError, TermErrorCode, TermPoll, TermResponse, TermRun,
} from '../shared/termwire.ts'
import { TERM_KILL_PATH, TERM_LIST_PATH, TERM_POLL_PATH, TERM_RUN_PATH } from '../shared/termwire.ts'

/**
 * Build one failure this module raises on its own — a transport problem, as
 * opposed to a domain answer the host phrased.
 * @param message - the human sentence.
 * @returns the failure arm of a response.
 */
function transportFail(message: string): { ok: false; error: TermError } {
  const code: TermErrorCode = 'internal'
  return { ok: false, error: { code, message } }
}

/**
 * Fetch one route and unwrap its envelope.
 * @param url - the absolute path plus query.
 * @param init - the request init; omitted for a plain GET.
 * @returns the host's answer, or a transport failure this module phrased.
 */
async function request<T>(url: string, init?: RequestInit): Promise<TermResponse<T>> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return transportFail(`could not reach the DSH host: ${reason}`)
  }
  const text = await response.text()
  // The SPA fallback answers index.html for any unknown path, which is how "the
  // host half is not mounted" stops looking like "the command produced nothing".
  if (text.trimStart().startsWith('<')) {
    return transportFail('the terminal routes are not mounted on this host — rebuild the plugin and restart `dsh web`')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return transportFail(`the host answered ${String(response.status)} with a non-JSON body`)
  }
  if (typeof parsed !== 'object' || parsed === null || !('ok' in parsed)) {
    return transportFail('the host answered with an unrecognized shape')
  }
  const envelope = parsed as TermResponse<T>
  if (!envelope.ok) return envelope
  if (!response.ok) return transportFail(`the host answered ${String(response.status)}`)
  return envelope
}

/**
 * Build a POST init carrying a JSON body.
 * @param body - the value to send.
 * @returns the request init.
 */
function post(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

/**
 * Start one command.
 * @param dir - the absolute directory to run in.
 * @param command - the command line.
 * @returns the new run, or why it was refused.
 */
export function startRun(dir: string, command: string): Promise<TermResponse<TermRun>> {
  return request<TermRun>(TERM_RUN_PATH, post({ dir, command }))
}

/**
 * Read a run's output after an offset.
 * @param id - the run id.
 * @param from - the offset the caller already holds.
 * @returns the run and the bytes that followed.
 */
export function pollRun(id: string, from: number): Promise<TermResponse<TermPoll>> {
  const query = new URLSearchParams({ id, from: String(from) })
  return request<TermPoll>(`${TERM_POLL_PATH}?${query.toString()}`)
}

/**
 * Stop one running command.
 * @param id - the run id.
 * @returns the run's state after the request was issued.
 */
export function killRun(id: string): Promise<TermResponse<TermRun>> {
  return request<TermRun>(TERM_KILL_PATH, post({ id }))
}

/**
 * List every run the host still holds.
 * @returns the run list, newest first.
 */
export function listRuns(): Promise<TermResponse<readonly TermRun[]>> {
  return request<readonly TermRun[]>(TERM_LIST_PATH)
}
