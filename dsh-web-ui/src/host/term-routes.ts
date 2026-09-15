/**
 * The bottom command bar's routes.
 *
 * Four routes, and the shape is the transport decision stated plainly: a run is
 * started by one POST that returns immediately with an id, read by repeated GETs
 * that carry an offset, and stopped by a POST naming the id. Nothing is held
 * open, so a panel that unmounts, a page that reloads, or a proxy that buffers
 * cannot strand a connection — the reader simply asks again from where it was.
 *
 * The command line is the one input on this plugin's whole surface that a shell
 * evaluates, and the module that runs it (`term.ts`) says why. Everything the
 * ROUTE does is refuse a request that is not shaped like a command: an
 * unknown id, an absent body, a body that is not JSON, a body past the cap.
 *
 * @module dsh-web-ui/host/term-routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { asRecord, param, query, readJsonBody, sendJson, sendMethodNotAllowed } from './http.ts'
import { createTerminalService, type TerminalService } from './term.ts'
import type { TermError, TermResponse } from '../shared/termwire.ts'
import { TERM_KILL_PATH, TERM_LIST_PATH, TERM_POLL_PATH, TERM_RUN_PATH } from '../shared/termwire.ts'

/**
 * Register the command bar's routes.
 * @param ctx - a context where `webServer` is available.
 * @param terminal - the service those routes serve.
 */
export function registerTerminalRoutes(ctx: Context, terminal: TerminalService): void {
  const log = ctx.logger('web-ui')

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
      log.error(`terminal ${label} threw: ${reason}`)
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
      `dsh-web-ui: terminal ${label} route`,
    )
  }

  /**
   * Read a JSON body that must be an object, answering 400 when it is not.
   * @param req - the request.
   * @param res - the response.
   * @returns the record, or undefined when a 400 was already sent.
   */
  const body = async (req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> => {
    const read = await readJsonBody(req)
    if (!read.ok) {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: read.message } })
      return undefined
    }
    const record = asRecord(read.value)
    if (!record.ok) {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: record.message } })
      return undefined
    }
    return record.value
  }

  /**
   * Answer a service result, keeping domain failures inside the 200 envelope.
   * @param res - the response.
   * @param answer - the service's answer.
   */
  const answer = <T>(res: ServerResponse, value: TermResponse<T>): void => {
    sendJson(res, 200, value)
  }

  route(TERM_RUN_PATH, async (req, res) => {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return }
    const record = await body(req, res)
    if (record === undefined) return
    const dir = record['dir']
    const command = record['command']
    if (typeof dir !== 'string' || typeof command !== 'string') {
      const error: TermError = { code: 'bad-request', message: '`dir` and `command` must both be strings' }
      sendJson(res, 400, { ok: false, error })
      return
    }
    answer(res, await terminal.start(dir, command))
  }, 'run')

  route(TERM_POLL_PATH, async (req, res) => {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return }
    const params = query(req)
    const id = param(params, 'id')
    if (id === undefined) {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'the `id` parameter is required' } })
      return
    }
    const from = Number(param(params, 'from') ?? '0')
    answer(res, terminal.poll(id, Number.isFinite(from) ? from : 0))
  }, 'poll')

  route(TERM_KILL_PATH, async (req, res) => {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return }
    const record = await body(req, res)
    if (record === undefined) return
    const id = record['id']
    if (typeof id !== 'string') {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '`id` must be a string' } })
      return
    }
    answer(res, terminal.kill(id))
  }, 'kill')

  route(TERM_LIST_PATH, async (req, res) => {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return }
    answer(res, terminal.list())
  }, 'list')

  log.info(`Terminal routes registered at ${TERM_RUN_PATH.replace('/run', '')}`)
}
