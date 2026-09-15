/**
 * The browser-facing routes of the Feishu document panel.
 *
 * Three exact GET routes under one prefix, each one a single question the panel
 * asks: *who is signed in and where is their personal knowledge base*, *which
 * spaces can I browse*, and *what is in this node*. They are exact rather than
 * prefix routes so the composition stays inspectable — a prefix would hide the
 * whole surface behind one entry.
 *
 * The browser half only ever calls these paths; it never sees the CLI, a token,
 * or a credential. Feishu failures are answered as `{ ok: false, error }` with
 * HTTP 200 because they are *content* the panel renders ("the login expired",
 * "the CLI is not installed"), not transport failures — a 500 is reserved for a
 * genuine bug in this plugin, which the browser then reports generically.
 *
 * @module dsh-web-ui/host/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createLarkCli, type LarkOutcome } from './lark.ts'

/** Path prefix of every route this module registers. */
export const LARK_ROUTE_PREFIX = '/dsh-web-ui/lark'

/** The user + personal knowledge base header facts. */
const STATE_PATH = `${LARK_ROUTE_PREFIX}/state`

/** The readable wiki space roster. */
const SPACES_PATH = `${LARK_ROUTE_PREFIX}/spaces`

/** One level of wiki nodes. */
const NODES_PATH = `${LARK_ROUTE_PREFIX}/nodes`

/** Content type of every response this module writes. */
const JSON_TYPE = 'application/json; charset=utf-8'

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
    // The adapter caches server-side; a browser or proxy cache on top of that
    // would show a stale tree after a refresh.
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Answer a request that is not a GET.
 * @param res - the response.
 */
function sendMethodNotAllowed(res: ServerResponse): void {
  res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
  res.end()
}

/**
 * Project an adapter outcome onto the wire shape.
 * @param res - the response.
 * @param outcome - the adapter's result.
 * @param wrap - how to merge a value into the success envelope.
 */
function sendOutcome<T>(
  res: ServerResponse,
  outcome: LarkOutcome<T>,
  wrap: (value: T) => Record<string, unknown>,
): void {
  if (!outcome.ok) {
    sendJson(res, 200, { ok: false, error: { code: outcome.code, message: outcome.message } })
    return
  }
  sendJson(res, 200, { ok: true, ...wrap(outcome.value) })
}

/**
 * Read the query string of a request.
 * @param req - the request.
 * @returns the parsed parameters (a bad URL yields an empty set).
 */
function query(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}

/**
 * Register the panel's routes.
 *
 * Every registration goes through `ctx.effect`, so unloading this plugin (or a
 * failed fiber) removes the routes with it.
 * @param ctx - a context where `webServer` is available.
 */
export function registerLarkRoutes(ctx: Context): void {
  const log = ctx.logger('web-ui')
  const cli = createLarkCli({
    log: {
      info: (format, ...params) => { log.info(format as string, ...params) },
      warn: (format, ...params) => { log.warn(format as string, ...params) },
    },
  })

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
      log.error(`lark ${label} threw: ${reason}`)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: 'internal', message: reason } })
      else res.end()
    }
  }

  /**
   * Register one route for this plugin's fiber lifetime.
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
      `dsh-web-ui: lark ${label} route`,
    )
  }

  route(STATE_PATH, async (req, res) => {
    if (req.method !== 'GET') { sendMethodNotAllowed(res); return }
    if (query(req).has('refresh')) cli.invalidate()
    sendOutcome(res, await cli.state(), value => ({
      loggedIn: value.loggedIn,
      user: value.user ?? null,
      space: value.space ?? null,
    }))
  }, 'state')

  route(SPACES_PATH, async (req, res) => {
    if (req.method !== 'GET') { sendMethodNotAllowed(res); return }
    if (query(req).has('refresh')) cli.invalidate()
    sendOutcome(res, await cli.spaces(), value => ({ spaces: value }))
  }, 'spaces')

  route(NODES_PATH, async (req, res) => {
    if (req.method !== 'GET') { sendMethodNotAllowed(res); return }
    const params = query(req)
    const spaceId = params.get('space') ?? ''
    if (spaceId === '') {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'the `space` parameter is required' } })
      return
    }
    const parent = params.get('parent')
    const pageToken = params.get('pageToken')
    sendOutcome(res, await cli.nodes({
      spaceId,
      parentNodeToken: parent === null || parent === '' ? undefined : parent,
      pageToken: pageToken === null || pageToken === '' ? undefined : pageToken,
    }), value => ({ nodes: value.nodes, hasMore: value.hasMore, pageToken: value.pageToken ?? null }))
  }, 'nodes')

  log.info(`Feishu document panel routes registered at ${LARK_ROUTE_PREFIX}`)
}
