/**
 * The browser half's face over the host's routes.
 *
 * Two properties are worth stating, because both panels depend on them:
 *
 * 1. **A transport failure is phrased, never thrown.** Every call answers the
 *    same envelope the host uses, so a caller handles one shape whether the host
 *    said "no such run" or the host was not there at all. The SPA fallback is
 *    detected by its body (`index.html` starts with `<`): that is what "the host
 *    half is not mounted" looks like from the browser, and naming it is the
 *    difference between a five-minute fix and an afternoon.
 * 2. **The reader owns its offset.** `pollRun` carries the byte offset the panel
 *    already rendered and gets back whatever followed. A reload, a remount, or a
 *    slow frame therefore resumes exactly where it was, and the host never has to
 *    remember which browser saw what.
 *
 * @module my-sider/client/api
 */
import type {
  RelayProbe, ShellContext, ShellPoll, ShellRun, WireError, WireErrorCode, WireResponse,
} from '../shared/wire.ts'
import {
  RELAY_FETCH_PATH, RELAY_PROBE_PATH, SHELL_CONTEXT_PATH, SHELL_KILL_PATH,
  SHELL_LIST_PATH, SHELL_POLL_PATH, SHELL_RUN_PATH,
} from '../shared/wire.ts'

/**
 * Build one failure this module raises on its own — a transport problem, as
 * opposed to a domain answer the host phrased.
 * @param code - the stable machine code.
 * @param message - the human sentence.
 * @returns the failure arm of a response.
 */
function transportFail(code: WireErrorCode, message: string): { ok: false; error: WireError } {
  return { ok: false, error: { code, message } }
}

/**
 * Fetch one route and unwrap its envelope.
 * @param url - the absolute path plus query.
 * @param init - the request init; omitted for a plain GET.
 * @returns the host's answer, or a transport failure this module phrased.
 */
async function request<T>(url: string, init?: RequestInit): Promise<WireResponse<T>> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return transportFail('internal', `could not reach the DSH host: ${reason}`)
  }
  const text = await response.text()
  // The SPA fallback answers index.html for any unknown path, which is how "the
  // host half is not mounted" stops looking like "the command produced nothing".
  if (text.trimStart().startsWith('<')) {
    return transportFail(
      'internal',
      'the my-sider host routes are not mounted — build the plugin and restart `dsh web`',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return transportFail('internal', `the host answered ${String(response.status)} with a non-JSON body`)
  }
  if (typeof parsed !== 'object' || parsed === null || !('ok' in parsed)) {
    return transportFail('internal', 'the host answered with an unrecognized shape')
  }
  const envelope = parsed as WireResponse<T>
  if (!envelope.ok) return envelope
  if (!response.ok) return transportFail('internal', `the host answered ${String(response.status)}`)
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
export function startRun(dir: string, command: string): Promise<WireResponse<ShellRun>> {
  return request<ShellRun>(SHELL_RUN_PATH, post({ dir, command }))
}

/**
 * Read a run's output after an offset.
 * @param id - the run id.
 * @param from - the offset the caller already holds.
 * @returns the run and the text that followed.
 */
export function pollRun(id: string, from: number): Promise<WireResponse<ShellPoll>> {
  const query = new URLSearchParams({ id, from: String(from) })
  return request<ShellPoll>(`${SHELL_POLL_PATH}?${query.toString()}`)
}

/**
 * Stop one running command.
 * @param id - the run id.
 * @returns the run's state after the request was issued.
 */
export function killRun(id: string): Promise<WireResponse<ShellRun>> {
  return request<ShellRun>(SHELL_KILL_PATH, post({ id }))
}

/**
 * List every run the host still holds.
 * @returns the run list, newest first.
 */
export function listRuns(): Promise<WireResponse<readonly ShellRun[]>> {
  return request<readonly ShellRun[]>(SHELL_LIST_PATH)
}

/**
 * Read the host's context: its fallback directory and whether the command panel
 * is switched on.
 * @returns the context, or a transport failure.
 */
export function readContext(): Promise<WireResponse<ShellContext>> {
  return request<ShellContext>(SHELL_CONTEXT_PATH)
}

/**
 * Ask the host about a URL before an iframe is committed to it.
 * @param url - the address to probe.
 * @returns reachability and framing facts.
 */
export function probeUrl(url: string): Promise<WireResponse<RelayProbe>> {
  const query = new URLSearchParams({ url })
  return request<RelayProbe>(`${RELAY_PROBE_PATH}?${query.toString()}`)
}

/**
 * The `src` a relayed tab's iframe loads.
 *
 * This is the relay route with the target as a parameter — the iframe cannot
 * carry an envelope, so the document itself is the answer.
 * @param url - the address to relay.
 * @returns the route URL.
 */
export function relaySrc(url: string): string {
  return `${RELAY_FETCH_PATH}?${new URLSearchParams({ url }).toString()}`
}
