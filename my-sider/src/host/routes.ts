/**
 * Every HTTP route this plugin owns, registered on one webserver.
 *
 * Two families, and the difference in their shape is the difference in what they
 * carry:
 *
 * - **The command panel** (`/my-sider/shell/*`) speaks the JSON envelope, and one
 *   route per verb: start / poll / kill / list, plus `context` (the fallback
 *   working directory and whether this surface is switched on at all).
 * - **The web panel's relay** (`/my-sider/url/*`) answers with the relayed
 *   DOCUMENT on `fetch` — an iframe can only consume a body — and with the JSON
 *   envelope on `probe`, which is a question about a URL rather than the URL's
 *   content.
 *
 * The two families are registered by two separate calls because they are mounted
 * from two different injection scopes: the relay needs only a webserver, while
 * the command panel additionally needs the process and confinement seams. A host
 * without the latter therefore loses the command panel and keeps the web panel,
 * instead of losing both.
 *
 * The command routes exist only when `config.shell.enabled` is true, because a
 * disabled feature must not leave a live command-execution endpoint behind. The
 * relay's routes always exist and answer "switched off" when
 * `config.relay.enabled` is false — a relayed iframe has no other way to be told,
 * and an SPA fallback body inside an iframe is a worse answer than a sentence.
 *
 * Everything a route does NOT carry is refused explicitly: an unknown id, an
 * absent body, a body that is not JSON, a body past the cap, a method the route
 * does not accept. One throwing route must never take the carrier down, so every
 * handler is wrapped.
 *
 * @module my-sider/host/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { asRecord, param, query, readJsonBody, sendJson, sendMethodNotAllowed } from './http.ts'
import type { RelayService } from './relay.ts'
import type { ShellService } from './shell.ts'
import type { WireError, WireErrorCode, WireResponse } from '../shared/wire.ts'
import {
  RELAY_FETCH_PATH, RELAY_PROBE_PATH, SHELL_CONTEXT_PATH, SHELL_KILL_PATH,
  SHELL_LIST_PATH, SHELL_POLL_PATH, SHELL_RUN_PATH,
} from '../shared/wire.ts'

/** The route-registration kit both families share. */
interface Router {
  /**
   * Register one exact route for this plugin's fiber lifetime.
   * @param path - the exact pathname.
   * @param handler - the route body.
   * @param label - a short name for the effect's diagnostic label.
   */
  route(path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>, label: string): void
  /**
   * Read a JSON body that must be an object, answering 400 when it is not.
   * @param req - the request.
   * @param res - the response.
   * @returns the record, or undefined when a 400 was already sent.
   */
  body(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined>
  /** Answer a service result, keeping domain failures inside the 200 envelope. */
  answer<T>(res: ServerResponse, value: WireResponse<T>): void
  /** Answer one JSON failure with a status code, for requests that never reached a service. */
  refuse(res: ServerResponse, status: number, code: WireErrorCode, message: string): void
}

/**
 * Build the registration kit over one webserver context.
 * @param ctx - a context where `webServer` is available.
 * @returns the kit.
 */
function createRouter(ctx: Context): Router {
  const log = ctx.logger('my-sider')

  const guard = (
    label: string,
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  ) => async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await handler(req, res)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      log.error(`route ${label} threw: ${reason}`)
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: { code: 'internal', message: reason } })
      } else {
        res.end()
      }
    }
  }

  return {
    route(path, handler, label) {
      ctx.effect(
        () => ctx.webServer.register({ kind: 'exact', path, handler: guard(label, handler) }),
        `my-sider: ${label} route`,
      )
    },
    async body(req, res) {
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
    },
    answer(res, value) {
      sendJson(res, 200, value)
    },
    refuse(res, status, code, message) {
      const error: WireError = { code, message }
      sendJson(res, status, { ok: false, error })
    },
  }
}

/**
 * Register the command panel's routes.
 *
 * Registered in BOTH cases: with a service when the surface is on, and with
 * `undefined` when `config.shell.enabled` is false — the routes then exist and
 * answer "disabled", so the panel can tell a switched-off deployment apart from
 * a host half that was never mounted.
 * @param ctx - a context where `webServer` is available.
 * @param shell - the command service, or undefined when the surface is off.
 * @param fallbackDir - the directory `context` reports when no session names one.
 */
export function registerShellRoutes(ctx: Context, shell: ShellService | undefined, fallbackDir: string): void {
  const router = createRouter(ctx)
  const { route, body, answer, refuse } = router

  route(SHELL_CONTEXT_PATH, async (req, res) => {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return }
    answer(res, { ok: true, data: { dir: fallbackDir, enabled: shell !== undefined } })
  }, 'shell/context')

  if (shell === undefined) {
    const text = 'the command panel is switched off in this plugin row\'s config.shell.enabled'
    for (const [path, label] of [
      [SHELL_RUN_PATH, 'run'], [SHELL_POLL_PATH, 'poll'], [SHELL_KILL_PATH, 'kill'], [SHELL_LIST_PATH, 'list'],
    ] as const) {
      route(path, async (_req, res) => { refuse(res, 200, 'disabled', text) }, `shell/${label}`)
    }
    ctx.logger('my-sider').info(`Command panel is switched off (config.shell.enabled) — ${SHELL_RUN_PATH.replace('/run', '')} answers "disabled"`)
    return
  }

  route(SHELL_RUN_PATH, async (req, res) => {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return }
    const record = await body(req, res)
    if (record === undefined) return
    const dir = record['dir']
    const command = record['command']
    if (typeof dir !== 'string' || typeof command !== 'string') {
      refuse(res, 400, 'bad-request', '`dir` and `command` must both be strings')
      return
    }
    answer(res, await shell.start(dir, command))
  }, 'shell/run')

  route(SHELL_POLL_PATH, async (req, res) => {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return }
    const params = query(req)
    const id = param(params, 'id')
    if (id === undefined) {
      refuse(res, 400, 'bad-request', 'the `id` parameter is required')
      return
    }
    const from = Number(param(params, 'from') ?? '0')
    answer(res, shell.poll(id, Number.isFinite(from) ? from : 0))
  }, 'shell/poll')

  route(SHELL_KILL_PATH, async (req, res) => {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return }
    const record = await body(req, res)
    if (record === undefined) return
    const id = record['id']
    if (typeof id !== 'string') {
      refuse(res, 400, 'bad-request', '`id` must be a string')
      return
    }
    answer(res, shell.kill(id))
  }, 'shell/kill')

  route(SHELL_LIST_PATH, async (req, res) => {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return }
    answer(res, shell.list())
  }, 'shell/list')

  ctx.logger('my-sider').info(`Command panel routes registered at ${SHELL_RUN_PATH.replace('/run', '')}`)
}

/**
 * Present the relayed-document error for a switched-off relay.
 * @param res - the response.
 */
function writeRelayDisabled(res: ServerResponse): void {
  const body = '<!doctype html><meta charset="utf-8">'
    + '<body style="font:13px/1.6 system-ui;color:#8a8f98;padding:24px">'
    + '<strong>URL relay is switched off.</strong> '
    + 'This plugin row sets <code>config.relay.enabled: false</code>, so relayed tabs cannot load. '
    + 'Direct tabs still work.</body>'
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Register the web panel's relay routes.
 * @param ctx - a context where `webServer` is available.
 * @param relay - the relay, or undefined when it is switched off.
 */
export function registerRelayRoutes(ctx: Context, relay: RelayService | undefined): void {
  const { route, answer, refuse } = createRouter(ctx)

  route(RELAY_FETCH_PATH, async (req, res) => {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return }
    if (relay === undefined) { writeRelayDisabled(res); return }
    await relay.fetch(req, res)
  }, 'url/fetch')

  route(RELAY_PROBE_PATH, async (req, res) => {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return }
    const raw = param(query(req), 'url')
    if (raw === undefined) {
      refuse(res, 400, 'bad-request', 'the `url` parameter is required')
      return
    }
    if (relay === undefined) {
      refuse(res, 200, 'disabled', 'the URL relay is switched off in this plugin row\'s config.relay.enabled')
      return
    }
    answer(res, await relay.probe(raw))
  }, 'url/probe')

  ctx.logger('my-sider').info(`Web panel relay registered at ${RELAY_FETCH_PATH.replace('/fetch', '')}`)
}
