/**
 * The drawer's read and write face over the host's git routes.
 *
 * This module is deliberately dumb: it builds URLs, POSTs one body, validates
 * only the envelope, and turns every outcome into either a value or a
 * *renderable* failure. It holds no state and knows nothing about what the
 * panel does with the answers.
 *
 * Three failure modes deserve their own handling rather than a generic throw:
 *
 * - **The route answers HTML.** That is the SPA fallback, which means the host
 *   half is not mounted (the plugin was rebuilt but the process was not
 *   restarted, or the webserver is not composed at all). "No answer" and
 *   "answered a page" are different operator problems, so they are different
 *   messages — this one names the restart.
 * - **`fetch` rejects.** The host is gone or the network dropped; the panel says
 *   so instead of rendering an empty branch list that looks like an empty repo.
 * - **`{ ok: false }`.** The host already phrased that for a human (git's own
 *   words for a rejected push), so the message travels through untouched.
 *
 * @module dsh-web-ui/client/gitapi
 */
import type {
  GitActionRequest, GitActionResult, GitBranchList, GitChanges, GitCommit,
  GitCommitDetail, GitDiff, GitError, GitErrorCode, GitOverview, GitRecordList,
  GitRepoList, GitResponse,
} from '../shared/gitwire.ts'
import {
  GIT_ACTION_PATH, GIT_BRANCHES_PATH, GIT_CHANGES_PATH, GIT_COMMIT_PATH,
  GIT_DIFF_PATH, GIT_LOG_PATH, GIT_OVERVIEW_PATH, GIT_RECORDS_PATH, GIT_REPOS_PATH,
} from '../shared/gitwire.ts'

/**
 * Build one failure value this module raises on its own (a transport-level
 * problem, as opposed to a domain answer the host phrased).
 * @param code - the machine code.
 * @param message - the human sentence.
 * @returns the failure arm of a response.
 */
function transportFail(code: GitErrorCode, message: string): { ok: false; error: GitError } {
  return { ok: false, error: { code, message } }
}

/**
 * Fetch one route and unwrap its envelope.
 * @param url - the absolute path plus query.
 * @param init - the request init; omitted for a plain GET.
 * @returns the host's answer, or a transport failure this module phrased.
 */
async function request<T>(url: string, init?: RequestInit): Promise<GitResponse<T>> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return transportFail('internal', `could not reach the DSH host: ${reason}`)
  }

  const text = await response.text()
  // The SPA fallback answers index.html for any unknown path. Detecting it here
  // is what turns "the panel is mysteriously empty" into a named fix.
  if (text.trimStart().startsWith('<')) {
    return transportFail(
      'internal',
      'the git routes are not mounted on this host — rebuild the plugin and restart `dsh web`',
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
  const envelope = parsed as GitResponse<T>
  // A failure arm carries the host's own sentence — better than a status code
  // in every case, including the malformed-request 400s — so it travels as-is.
  if (!envelope.ok) return envelope
  if (!response.ok) return transportFail('internal', `the host answered ${String(response.status)}`)
  return envelope
}

/**
 * Build a query string from defined values only.
 * @param params - the parameter bag.
 * @returns the encoded query, including the leading `?`.
 */
function search(params: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value))
  }
  return `?${query.toString()}`
}

/**
 * Read every repository one project holds.
 *
 * This is the one read that is about the PROJECT rather than about a repository:
 * a project whose packages each carry their own `.git` has no single answer to
 * "what is this repository", so the drawer asks what is here first and picks one.
 * @param dir - the project's absolute directory.
 * @returns the repositories, shallowest first.
 */
export function discoverRepos(dir: string): Promise<GitResponse<GitRepoList>> {
  return request<GitRepoList>(`${GIT_REPOS_PATH}${search({ dir })}`)
}

/**
 * Read the repository identity, HEAD, counts, remotes, and stash/tag totals.
 * @param dir - the absolute directory to inspect.
 * @returns the overview.
 */
export function readOverview(dir: string): Promise<GitResponse<GitOverview>> {
  return request<GitOverview>(`${GIT_OVERVIEW_PATH}${search({ dir })}`)
}

/**
 * Read every local and remote branch.
 * @param dir - the absolute directory to inspect.
 * @returns the branch roster.
 */
export function readBranches(dir: string): Promise<GitResponse<GitBranchList>> {
  return request<GitBranchList>(`${GIT_BRANCHES_PATH}${search({ dir })}`)
}

/**
 * Read one page of commit history.
 * @param dir - the absolute directory to inspect.
 * @param limit - how many commits to ask for.
 * @param ref - the ref to walk from; HEAD when omitted.
 * @returns the commits.
 */
export function readLog(dir: string, limit: number, ref?: string): Promise<GitResponse<readonly GitCommit[]>> {
  return request<readonly GitCommit[]>(`${GIT_LOG_PATH}${search({ dir, limit, ref })}`)
}

/**
 * Read one commit with its patch and per-file stats.
 * @param dir - the absolute directory to inspect.
 * @param sha - the commit id.
 * @returns the detail.
 */
export function readCommit(dir: string, sha: string): Promise<GitResponse<GitCommitDetail>> {
  return request<GitCommitDetail>(`${GIT_COMMIT_PATH}${search({ dir, sha })}`)
}

/**
 * Read the working-tree changes, the stash stack, and any action in flight.
 * @param dir - the absolute directory to inspect.
 * @returns the change set.
 */
export function readChanges(dir: string): Promise<GitResponse<GitChanges>> {
  return request<GitChanges>(`${GIT_CHANGES_PATH}${search({ dir })}`)
}

/**
 * Read the unified diff of one path.
 * @param dir - the absolute directory to inspect.
 * @param file - the repository-relative path.
 * @param staged - whether to diff the index rather than the working tree.
 * @param ref - a revision to diff against; the index/working tree when omitted.
 * @returns the patch.
 */
export function readDiff(
  dir: string,
  file: string,
  staged: boolean,
  ref?: string,
): Promise<GitResponse<GitDiff>> {
  return request<GitDiff>(`${GIT_DIFF_PATH}${search({ dir, file, staged: staged ? '1' : undefined, ref })}`)
}

/**
 * Read this plugin's journal for one repository.
 * @param dir - the absolute directory to inspect.
 * @returns the journal.
 */
export function readRecords(dir: string): Promise<GitResponse<GitRecordList>> {
  return request<GitRecordList>(`${GIT_RECORDS_PATH}${search({ dir })}`)
}

/**
 * Run one mutation.
 *
 * The caller passes a directory and an action name; the HOST builds the argv,
 * so nothing here can compose a command.
 * @param body - the action request.
 * @returns the action's outcome.
 */
export function runAction(body: GitActionRequest): Promise<GitResponse<GitActionResult>> {
  return request<GitActionResult>(GIT_ACTION_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
