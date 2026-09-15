/**
 * The browser-facing routes of the git panel.
 *
 * Seven exact `GET` reads and one `POST` mutation, each one a single question
 * the panel asks. They are exact rather than prefix routes so the whole surface
 * stays inspectable in the composed tree — a prefix would hide an operation
 * surface behind one entry.
 *
 * Three boundary rules, all of them deliberate:
 *
 * - **The mutation route takes a JSON body, and the body is never trusted.**
 *   The action name selects a builder in `git.ts`, and that builder validates
 *   every name it receives through git itself before an argument is placed in
 *   argv. Nothing from the browser is ever concatenated into a command string.
 * - **A git failure is answered as `{ ok: true }` with `ok: false` inside.**
 *   A rejected push and a conflicted merge are *content* the panel renders
 *   where the operator pressed the button; HTTP 500 stays reserved for a bug in
 *   this plugin, which the browser then reports generically.
 * - **The body is bounded.** A request larger than `MAX_BODY_BYTES` is refused
 *   without being read, so a stuck or hostile client cannot grow the host's
 *   heap through this route.
 *
 * @module dsh-web-ui/host/git-routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createGitService } from './git.ts'
import type { GitAction, GitActionArgs, GitActionRequest, GitResponse } from '../shared/gitwire.ts'
import {
  GIT_ACTION_PATH, GIT_BRANCHES_PATH, GIT_CHANGES_PATH, GIT_COMMIT_PATH,
  GIT_DIFF_PATH, GIT_LOG_PATH, GIT_OVERVIEW_PATH, GIT_RECORDS_PATH,
} from '../shared/gitwire.ts'

/** Content type of every response this module writes. */
const JSON_TYPE = 'application/json; charset=utf-8'

/** Largest request body this route will read, in bytes. */
const MAX_BODY_BYTES = 64 * 1024

/** The actions the route accepts; a name outside this set never reaches a builder. */
const ACTIONS: ReadonlySet<string> = new Set<GitAction>([
  'init', 'remote-add', 'remote-set-url', 'remote-rename', 'remote-remove',
  'checkout', 'create-branch', 'rename-branch', 'delete-branch', 'merge', 'rebase',
  'cherry-pick', 'reset', 'fetch', 'pull', 'push', 'push-branch', 'stage', 'unstage',
  'discard', 'clean', 'commit', 'amend', 'stash-save', 'stash-pop', 'stash-apply',
  'stash-drop', 'tag-create', 'tag-delete', 'abort',
])

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
    // A git read answers a question about the tree RIGHT NOW; a cached answer
    // would show the state before the button the operator just pressed.
    'cache-control': 'no-store',
  })
  res.end(text)
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
 * Read one query parameter, treating an empty string as absent.
 * @param params - the parsed query.
 * @param key - the parameter name.
 * @returns the value, or undefined.
 */
function param(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)
  return value === null || value === '' ? undefined : value
}

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
 * Read a JSON request body under a hard byte cap.
 * @param req - the request.
 * @returns the parsed value, or a failure describing why it could not be read.
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
 * Narrow an unknown value to an action request.
 * @param value - the parsed body.
 * @returns the request, or a failure sentence.
 */
function asActionRequest(value: unknown): { ok: true; value: GitActionRequest } | { ok: false; message: string } {
  if (typeof value !== 'object' || value === null) return { ok: false, message: 'the body must be a JSON object' }
  const record = value as Record<string, unknown>
  const dir = record['dir']
  const action = record['action']
  if (typeof dir !== 'string' || dir === '') return { ok: false, message: '`dir` must be a non-empty string' }
  if (typeof action !== 'string' || !ACTIONS.has(action)) {
    return { ok: false, message: `\`action\` must be one of: ${[...ACTIONS].join(', ')}` }
  }
  const args = record['args']
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
    return { ok: false, message: '`args` must be a JSON object when present' }
  }
  // Spread rather than assign: `exactOptionalPropertyTypes` distinguishes "no
  // args key" from "an args key holding undefined", and only the former is a
  // valid GitActionRequest.
  return args === undefined
    ? { ok: true, value: { dir, action: action as GitAction } }
    : { ok: true, value: { dir, action: action as GitAction, args: args as GitActionArgs } }
}

/**
 * Register the git panel's routes.
 *
 * Every registration goes through `ctx.effect`, so unloading this plugin (or a
 * failed fiber) removes the routes with it. The service is built HERE, per
 * registration, so its read cache and journal belong to this fiber's lifetime
 * rather than surviving a reload as a module-level singleton.
 * @param ctx - a context where `webServer` is available.
 */
export function registerGitRoutes(ctx: Context): void {
  const log = ctx.logger('web-ui')
  const git = createGitService()

  /**
   * Wrap a handler so one throwing route cannot take the carrier down.
   * @param label - the route's name, for the log line.
   * @param handler - the route body.
   * @returns the registered handler.
   */
  const guard = (
    label: string,
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  ) => async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await handler(req, res)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      log.error(`git ${label} threw: ${reason}`)
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: { code: 'internal', message: reason } })
      } else {
        res.end()
      }
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
      () => ctx.webServer.register({ kind: 'exact', path, handler: guard(`${label} route`, handler) }),
      `dsh-web-ui: git ${label} route`,
    )
  }

  /**
   * Answer one read that needs only the directory.
   * @param label - the route's diagnostic name.
   * @param read - the service call.
   * @returns the registered handler.
   */
  const readRoute = <T>(
    label: string,
    read: (dir: string, params: URLSearchParams) => Promise<GitResponse<T>>,
  ) => async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return }
    const params = query(req)
    const dir = param(params, 'dir')
    if (dir === undefined) {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'the `dir` parameter is required' } })
      return
    }
    sendJson(res, 200, await read(dir, params))
  }

  route(GIT_OVERVIEW_PATH, readRoute('overview', dir => git.overview(dir)), 'overview')

  route(GIT_BRANCHES_PATH, readRoute('branches', dir => git.branches(dir)), 'branches')

  route(GIT_LOG_PATH, readRoute('log', (dir, params) => {
    const limit = Number(param(params, 'limit') ?? '')
    const ref = param(params, 'ref')
    return git.log(dir, Number.isFinite(limit) && limit > 0 ? limit : 50, ref)
  }), 'log')

  route(GIT_COMMIT_PATH, readRoute('commit', (dir, params) => {
    const sha = param(params, 'sha')
    if (sha === undefined) {
      return Promise.resolve({
        ok: false as const,
        error: { code: 'bad-request' as const, message: 'the `sha` parameter is required' },
      })
    }
    return git.commit(dir, sha)
  }), 'commit')

  route(GIT_CHANGES_PATH, readRoute('changes', dir => git.changes(dir)), 'changes')

  route(GIT_DIFF_PATH, readRoute('diff', (dir, params) => {
    const file = param(params, 'file')
    if (file === undefined) {
      return Promise.resolve({
        ok: false as const,
        error: { code: 'bad-request' as const, message: 'the `file` parameter is required' },
      })
    }
    return git.diff(dir, file, param(params, 'staged') === '1', param(params, 'ref'))
  }), 'diff')

  route(GIT_RECORDS_PATH, readRoute('records', dir => git.records(dir)), 'records')

  route(GIT_ACTION_PATH, async (req, res) => {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return }
    const body = await readJsonBody(req)
    if (!body.ok) {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: body.message } })
      return
    }
    const request = asActionRequest(body.value)
    if (!request.ok) {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: request.message } })
      return
    }
    const answer = await git.act(request.value)
    // An action-level failure is a VALUE (see the module doc), so it travels as
    // a 200 with `ok: false` inside the envelope and the panel renders git's own
    // words. Only the malformed-request cases above are 400s.
    sendJson(res, 200, answer)
  }, 'action')

  log.info(`Git panel routes registered at ${GIT_OVERVIEW_PATH.replace('/overview', '')}`)
}
