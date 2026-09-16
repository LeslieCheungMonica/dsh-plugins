/**
 * The browser-facing routes of the project's Feishu folder and of the project's
 * own record.
 *
 * The panel's subject is ONE folder: the one this deployment created for the
 * project when it was created. Four exact routes answer it, each a single
 * question the panel asks:
 *
 * - `GET /state` — *who is signed in*, for the header strip;
 * - `GET /folder?path=&name=` — *which folder is this project's*, resolving it
 *   from the project's record, and ADOPTING an existing one by name when the
 *   record has none (see `resolveFolder` below);
 * - `GET /files?folder=&pageToken=` — *what is in that folder*, one page at a
 *   time, plus once per subdirectory the operator expands;
 * - `POST /folder` — *create the folder for this project*, which also RECORDS
 *   it, and `POST /folder/attach` — *use this folder for this project*, which is
 *   how the operator answers an ambiguous adoption or points a project at a
 *   folder it already has.
 *
 * They are exact rather than prefix routes so the composition stays
 * inspectable — a prefix would hide the whole surface behind one entry. Both
 * mutations are POSTs with a JSON body: they change state (a shared drive, and
 * this plugin's own record) and a body is not a URL, so a directory name with
 * `&` or `?` in it cannot reshape the request. `POST /folder` creates
 * UNCONDITIONALLY: it does not read the parent first to look for an existing
 * folder of that name (see `createFolder` in `./lark.ts` for why, and for what
 * that trades away) — looking is what `GET /folder` does, and the operator
 * decides what it finds.
 *
 * A further three routes are not about Feishu at all: the project's own RECORD —
 * the name, the product background, and the product card the project form
 * collects, none of which a DSH workspace has a field for. `GET /project`
 * answers one project's record, `POST /project` writes it, and `GET /cards`
 * answers the product-card catalogue the form offers (`./projects.ts`,
 * `./products.ts`). The catalogue is its own route because the CREATE form needs
 * it before any path exists.
 *
 * This entry point also registers the FDE stage gate's route
 * (`GET /dsh-web-ui/stage-gate/check`, `./stage-gate.ts`), because a gate reads
 * the SAME project's folder and must reuse this module's `lark-cli` adapter —
 * its serialize queue is what keeps two concurrent token refreshes from racing
 * on one credential file. The two families share one folder resolver
 * (`./folder.ts`) for the same reason: adoption writes to the project's record,
 * so the panel and the gate must never adopt different folders for one project.
 *
 * The browser half only ever calls these paths; it never sees the CLI, a token,
 * or a credential. Feishu failures are answered as `{ ok: false, error }` with
 * HTTP 200 because they are *content* the panel renders ("the login expired",
 * "the login lacks a scope"), not transport failures — a 500 is reserved for a
 * genuine bug in this plugin, which the browser then reports generically. Only a
 * malformed request is a 4xx.
 *
 * @module dsh-web-ui/host/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  createLarkCli, DRIVE_TOKEN_PATTERN, feishuUrl, folderNameFromPath,
  type LarkFolder, type LarkOutcome,
} from './lark.ts'
import { createFolderResolver } from './folder.ts'
import { asBackground, createProjectStore } from './projects.ts'
import { readProductCards } from './products.ts'
import { registerStageGateRoutes } from './stage-gate.ts'

/** Path prefix of every route this module registers. */
export const LARK_ROUTE_PREFIX = '/dsh-web-ui/lark'

/** The signed-in user (the panel's header facts). */
const STATE_PATH = `${LARK_ROUTE_PREFIX}/state`

/** The project's own folder in the deployment's archive. */
const FOLDER_PATH = `${LARK_ROUTE_PREFIX}/folder`

/** Use one folder for one project (the adopt answer). */
const ATTACH_PATH = `${LARK_ROUTE_PREFIX}/folder/attach`

/** One page of one folder's children. */
const FILES_PATH = `${LARK_ROUTE_PREFIX}/files`

/**
 * One project's own record.
 *
 * It lives under `/lark` for a HISTORICAL reason, not a semantic one: this prefix
 * started as the Feishu panel's, and these routes replaced a version of
 * themselves that carried the Feishu folder's own bookkeeping. The prefix is a
 * stable address the client already knows; moving it would be a rename with no
 * behaviour behind it.
 */
const PROJECT_PATH = `${LARK_ROUTE_PREFIX}/project`

/** The product-card catalogue this deployment offers. */
const CARDS_PATH = `${LARK_ROUTE_PREFIX}/cards`

/**
 * The Feishu folder that holds one subfolder per project.
 *
 * A deployment-level fact, not a per-request one: this is the operator's own
 * documented location ("FDE实施资产沉淀汇总"), and the point of the feature is
 * that every project lands in the SAME place. `DSH_WEB_UI_LARK_FOLDER` overrides
 * it for another tenant or another archive folder, and no request can move it —
 * a browser-supplied parent would let a page write into any folder the login can
 * reach.
 */
const PROJECT_FOLDER_TOKEN = process.env['DSH_WEB_UI_LARK_FOLDER'] ?? 'IE6SfqKh3lRv2odSLkHccYh5nog'

/**
 * How many same-named folders the adoption answer will offer.
 *
 * Feishu allows duplicates, so "several projects were re-added under one name"
 * is a real state. Offering a handful is enough for the operator to recognize
 * theirs; a list of fifty would be a wall of identical names in a narrow column.
 */
const MAX_CANDIDATES = 20

/** Largest request body this module will read, in bytes. */
const MAX_BODY_BYTES = 8 * 1024

/**
 * A folder NAME, as opposed to a path: what the operator typed into the New
 * Project form, which this route hands to Feishu as the folder's name.
 *
 * A separator or a `.`/`..` segment is refused rather than repaired, because a
 * "name" that means a path is a caller bug this route should not paper over, and
 * `createFolder` would otherwise write the literal text `/tmp/x` as a folder
 * name. Everything else — spaces, dots inside the name, emoji, CJK — is a
 * legitimate name and passes through untouched.
 */
const FOLDER_NAME_PATTERN = /^(?!\.{1,2}$)[^/\\]+$/

/**
 * A Feishu URL a request may hand back.
 *
 * Only http(s), and only as a plain URL: it is stored beside the token and
 * opened by the panel, so anything else — a `javascript:` URL, a data URL, a
 * file path — would be a link this plugin handed the page rather than one Feishu
 * did. The token's own shape is checked against the adapter's
 * `DRIVE_TOKEN_PATTERN`, which is imported rather than restated so the request
 * guard and the ARGV guard are one rule.
 */
const FOLDER_URL_PATTERN = /^https?:\/\/[^\s]{1,512}$/

/** Content type of every response this module writes. */
const JSON_TYPE = 'application/json; charset=utf-8'

/**
 * The wire shape of one folder.
 *
 * camelCase, like every other record this module sends, so the browser half
 * reads one convention rather than two.
 * @param folder - the folder to serialize.
 * @returns the value to merge into a response.
 */
function folderJson(folder: LarkFolder): Record<string, unknown> {
  return { name: folder.name, folderToken: folder.folderToken, url: folder.url }
}

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
 * Answer a request whose method this module does not accept.
 * @param res - the response.
 * @param allow - the method it does accept.
 */
function sendMethodNotAllowed(res: ServerResponse, allow: string): void {
  res.writeHead(405, { allow, 'cache-control': 'no-store' })
  res.end()
}

/**
 * Read a JSON request body under a hard byte cap.
 * @param req - the request.
 * @returns the parsed value, or a message saying why it could not be read.
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
  const projects = createProjectStore()
  const cli = createLarkCli({
    log: {
      info: (format, ...params) => { log.info(format as string, ...params) },
      warn: (format, ...params) => { log.warn(format as string, ...params) },
    },
  })
  // One resolver for both surfaces that ask which folder a project owns: this
  // module's `/folder` route and the FDE stage gate (`./stage-gate.ts`). See
  // `./folder.ts` for the policy and why it must be a single one.
  const folders = createFolderResolver({
    cli,
    projects,
    parentToken: PROJECT_FOLDER_TOKEN,
    maxCandidates: MAX_CANDIDATES,
    log: (message) => { log.info(message) },
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
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return }
    if (query(req).has('refresh')) cli.invalidate()
    sendOutcome(res, await cli.state(), value => ({
      loggedIn: value.loggedIn,
      user: value.user ?? null,
    }))
  }, 'state')

  /**
   * Resolve which archive folder belongs to one project.
   *
   * The POLICY lives in `./folder.ts`, shared with the FDE stage gate: both
   * surfaces ask the same question, adoption WRITES to the project's record, and
   * two policies would let the panel and the gate disagree about which folder a
   * project owns. This route is only the wire half of it.
   */
  const resolveFolder = async (input: { path: string; name: string; refresh: boolean }): Promise<Record<string, unknown>> => {
    const resolved = await folders.resolve(input)
    if (!resolved.ok) {
      return { ok: false, error: { code: resolved.code, message: resolved.message } }
    }
    const value = resolved.value
    return {
      ok: true,
      source: value.source,
      name: value.name,
      // `null` rather than an absent field: the panel distinguishes "no folder
      // resolved" from "the host said nothing", and only the first is a state it
      // offers to fix.
      folder: value.folder === undefined ? null : folderJson(value.folder),
      candidates: value.candidates.map(folderJson),
    }
  }

  route(FOLDER_PATH, async (req, res) => {
    if (req.method === 'GET') {
      const params = query(req)
      const path = (params.get('path') ?? '').trim()
      if (path === '') {
        sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'the `path` parameter is required' } })
        return
      }
      // The caller may name the project it is asking about — the sidebar's title
      // for it — because the record is not the authority on the NAME (see
      // `./projects.ts`). When it does not, the record's copy and then the
      // path's last segment answer for it.
      const requested = (params.get('name') ?? '').trim()
      if (requested !== '' && !FOLDER_NAME_PATTERN.test(requested)) {
        sendJson(res, 400, {
          ok: false,
          error: { code: 'bad-request', message: `\`name\` must be a plain folder name: ${JSON.stringify(requested)}` },
        })
        return
      }
      const record = await projects.get(path)
      const name = requested !== ''
        ? requested
        : (record?.name ?? '') !== '' ? (record?.name ?? '') : folderNameFromPath(path)
      if (name === '') {
        sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: `\`path\` names no directory: ${path}` } })
        return
      }
      sendJson(res, 200, await resolveFolder({ path, name, refresh: params.has('refresh') }))
      return
    }

    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'GET, POST'); return }
    const body = await readJsonBody(req)
    if (!body.ok) {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: body.message } })
      return
    }
    const record = typeof body.value === 'object' && body.value !== null
      ? body.value as Record<string, unknown>
      : {}
    const path = record['path']
    if (typeof path !== 'string' || path.trim() === '') {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '`path` must be a non-empty string' } })
      return
    }
    // The folder is named after the PROJECT, and the project's name is what the
    // operator typed into the New Project form — not the directory's last
    // segment, which is only what the name field SUGGESTS. So the caller may
    // send `name`, and when it does not the path's segment is the fallback.
    //
    // `name` is the one request field that reaches a Drive API as text rather
    // than as an opaque token, so it is validated HERE as a NAME and not as a
    // path: a value carrying a separator or a `.`/`..` segment is refused rather
    // than normalized, because silently renaming what the operator typed would
    // make the sidebar and the archive disagree. `createFolder` re-checks the
    // same rules (blank, control characters, length) on the way out.
    const requested = record['name']
    if (requested !== undefined && typeof requested !== 'string') {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '`name` must be a string when present' } })
      return
    }
    const typed = typeof requested === 'string' ? requested.trim() : undefined
    if (typed !== undefined && !FOLDER_NAME_PATTERN.test(typed)) {
      sendJson(res, 400, {
        ok: false,
        error: {
          code: 'bad-request',
          message: `\`name\` must be a plain folder name (no path separators or . / ..): ${JSON.stringify(typed)}`,
        },
      })
      return
    }
    const name = typed ?? folderNameFromPath(path)
    if (name === '') {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: `\`path\` names no directory: ${path}` } })
      return
    }
    log.info(`creating the Feishu folder \`${name}\` under ${PROJECT_FOLDER_TOKEN}`)
    const created = await cli.createFolder({ parentFolderToken: PROJECT_FOLDER_TOKEN, name })
    if (!created.ok) {
      sendJson(res, 200, { ok: false, error: { code: created.code, message: created.message } })
      return
    }
    // The folder now RECORDS itself onto the project. That write is what lets
    // the panel find it later without reading the archive, so it is attempted
    // here rather than left to the browser — but it is not allowed to turn a
    // folder that exists into a failure: the create already happened, and the
    // record is this plugin's own bookkeeping.
    try {
      await projects.setLarkFolder({
        path,
        name: created.value.name,
        folderToken: created.value.folderToken,
        url: created.value.url,
      })
      log.info(`recorded the Feishu folder \`${created.value.name}\` for ${path}`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      log.warn(`created the Feishu folder \`${created.value.name}\` but could not record it for ${path}: ${reason}`)
    }
    sendJson(res, 200, {
      ok: true,
      name: created.value.name,
      folderToken: created.value.folderToken,
      url: created.value.url,
    })
  }, 'folder')

  route(ATTACH_PATH, async (req, res) => {
    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'POST'); return }
    const body = await readJsonBody(req)
    if (!body.ok) {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: body.message } })
      return
    }
    const record = typeof body.value === 'object' && body.value !== null
      ? body.value as Record<string, unknown>
      : {}
    const path = typeof record['path'] === 'string' ? record['path'].trim() : ''
    if (path === '') {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '`path` must be a non-empty string' } })
      return
    }
    // The token is the one field that becomes an ARGV element below, so it is
    // checked against the CLI's own alphabet here as well as in the adapter. A
    // caller that wants to point a project at a folder it can reach is doing
    // what this route is for; a caller that sends something argv-shaped is not,
    // and the shape is what tells them apart.
    const folderToken = typeof record['folderToken'] === 'string' ? record['folderToken'].trim() : ''
    if (!DRIVE_TOKEN_PATTERN.test(folderToken)) {
      sendJson(res, 400, {
        ok: false,
        error: { code: 'bad-request', message: `\`folderToken\` is not a Drive folder token: ${JSON.stringify(folderToken)}` },
      })
      return
    }
    const rawUrl = typeof record['url'] === 'string' ? record['url'].trim() : ''
    if (rawUrl !== '' && !FOLDER_URL_PATTERN.test(rawUrl)) {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '`url` must be an http(s) URL' } })
      return
    }
    const requestedName = typeof record['name'] === 'string' ? record['name'].trim() : ''
    const existing = await projects.get(path)
    const name = requestedName !== ''
      ? requestedName
      : (existing?.name ?? '') !== '' ? (existing?.name ?? '') : folderNameFromPath(path)
    if (name === '') {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: `\`path\` names no directory: ${path}` } })
      return
    }
    const stored = await projects.setLarkFolder({
      path,
      name,
      folderToken,
      // A caller that pasted a link supplies the URL; one that picked a
      // candidate already has it. The fallback keeps "open in Feishu" working
      // for a bare token.
      url: rawUrl === '' ? feishuUrl('folder', folderToken) : rawUrl,
    })
    log.info(`recorded the Feishu folder ${folderToken} for ${path}`)
    // The same three fields `GET /folder` and `POST /folder` answer, so the
    // browser half reads one folder shape from all three routes. The name is the
    // PROJECT's — what the panel labels this folder with — because the folder's
    // own name in Feishu is whatever the operator called it there.
    sendJson(res, 200, {
      ok: true,
      name: stored.name,
      folderToken,
      url: stored.larkFolderUrl,
    })
  }, 'folder/attach')

  route(FILES_PATH, async (req, res) => {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return }
    const params = query(req)
    const folder = (params.get('folder') ?? '').trim()
    if (folder === '') {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'the `folder` parameter is required' } })
      return
    }
    // A token that cannot be one is refused here rather than inside the adapter:
    // it is a malformed REQUEST, and the adapter's own refusal would read as a
    // Feishu problem in the panel.
    if (!DRIVE_TOKEN_PATTERN.test(folder)) {
      sendJson(res, 400, {
        ok: false,
        error: { code: 'bad-request', message: `\`folder\` is not a Drive folder token: ${JSON.stringify(folder)}` },
      })
      return
    }
    if (params.has('refresh')) cli.invalidate()
    const pageToken = params.get('pageToken')
    sendOutcome(res, await cli.files({
      folderToken: folder,
      pageToken: pageToken === null || pageToken === '' ? undefined : pageToken,
    }), value => ({ nodes: value.nodes, hasMore: value.hasMore, pageToken: value.pageToken ?? null }))
  }, 'files')


  route(PROJECT_PATH, async (req, res) => {
    if (req.method === 'GET') {
      const params = query(req)
      const path = params.get('path') ?? ''
      if (path === '') {
        sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'the `path` parameter is required' } })
        return
      }
      const record = await projects.get(path)
      sendJson(res, 200, {
        ok: true,
        // `null` rather than an empty record: "this project has no record yet" is
        // a real state (it predates this store), and the form shows the stored
        // facts only when there are some.
        project: record ?? null,
      })
      return
    }

    if (req.method !== 'POST') { sendMethodNotAllowed(res, 'GET, POST'); return }
    const body = await readJsonBody(req)
    if (!body.ok) {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: body.message } })
      return
    }
    const record = typeof body.value === 'object' && body.value !== null
      ? body.value as Record<string, unknown>
      : {}
    const path = record['path']
    const name = record['name']
    if (typeof path !== 'string' || path.trim() === '') {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '`path` must be a non-empty string' } })
      return
    }
    if (typeof name !== 'string' || name.trim() === '') {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '`name` must be a non-empty string' } })
      return
    }
    // The background and the card are stored as given: an unknown background
    // falls back to `unsure` (the form's own "not decided yet") rather than being
    // refused, because the field is descriptive — a stale page must not be able
    // to block a project from being recorded.
    const background = asBackground(record['background'])
    const rawCard = record['productCardId']
    const stored = await projects.put({
      path,
      name: name.trim(),
      background,
      // A card id only means something for the "existing product" answer; the
      // others clear it rather than carrying a stale selection forward.
      productCardId: background === 'existing' && typeof rawCard === 'string' ? rawCard.trim() : '',
    })
    log.info(`recorded the project \`${stored.name}\` (${stored.background})`)
    sendJson(res, 200, { ok: true, project: stored })
  }, 'project')

  route(CARDS_PATH, async (req, res) => {
    if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return }
    const cards = await readProductCards()
    // A malformed catalogue is a 200 with `ok: false` inside, like every other
    // content failure this module answers: the form renders the reason instead
    // of an empty picker the operator would believe.
    sendJson(res, 200, cards.ok
      ? { ok: true, cards: cards.cards }
      : { ok: false, error: { code: 'cards-unreadable', message: cards.message } })
  }, 'cards')

  log.info(`Feishu routes registered at ${LARK_ROUTE_PREFIX} (project folder ${PROJECT_FOLDER_TOKEN})`)

  // The FDE stage gate is the second surface over this same Feishu folder, and
  // it is registered from HERE rather than from its own entry point: it must
  // reuse this module's adapter, because the adapter's serialize queue is what
  // keeps two concurrent token refreshes from racing on one credential file.
  registerStageGateRoutes(ctx, { cli, projects, folders })
}
