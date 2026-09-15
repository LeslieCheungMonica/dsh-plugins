/**
 * Offline harness for the project RECORD: the store and its two routes.
 *
 * The record is the plugin's own persisted state — the answers a DSH workspace
 * has no field for (product background, product card) plus a copy of the name —
 * and it is the one thing here that outlives the process. So this harness drives
 * the REAL route registration against a fake webserver, with the document pinned
 * to a temporary file (`DSH_WEB_UI_PROJECTS_FILE`), and checks the properties a
 * reviewer would otherwise have to trust:
 *
 * 1. the document lands where it says it does, and reading it back round-trips;
 * 2. a project with no record yet answers `null`, not an invented one;
 * 3. a malformed document, an empty one and a missing one all degrade to "no
 *    records" — never to a refusal of the operator's next write;
 * 4. a write replaces the project's FORM facts and stamps it, a bad request never
 *    reaches the file, and the Feishu folder the record also carries — which the
 *    form knows nothing about — survives that write;
 * 5. the card catalogue: an empty deployment says "none configured", a broken one
 *    says so, and a duplicate id is refused rather than silently collapsed.
 *
 * Usage: node scripts/harness/project-record.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'dsh-web-ui-records-'))
const FILE = join(root, 'web_ui_projects.json')
process.env['DSH_WEB_UI_PROJECTS_FILE'] = FILE
delete process.env['DSH_WEB_UI_PRODUCT_CARDS']

const { registerLarkRoutes } = await import('../../src/host/routes.ts')

/** Register the routes against a fake webserver and collect the handlers. */
async function collectRoutes() {
  const handlers = new Map()
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    effect: (factory) => factory(),
    webServer: { register: ({ path, handler }) => { handlers.set(path, handler); return () => {} } },
  }
  registerLarkRoutes(ctx)
  return handlers
}

const handlers = await collectRoutes()
const project = handlers.get('/dsh-web-ui/lark/project')
const cards = handlers.get('/dsh-web-ui/lark/cards')

/** One synthetic request. */
function request({ method = 'GET', url = '/dsh-web-ui/lark/project', body = undefined } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
}

/** One synthetic response that records what the route wrote. */
function response() {
  return {
    status: 0,
    body: '',
    headersSent: false,
    writeHead(status) { this.status = status; this.headersSent = true },
    end(text = '') { if (text !== '') this.body = text },
  }
}

/** Drive one request through a handler. */
async function call(handler, options) {
  const res = response()
  await handler(request(options), res)
  let body = null
  try { body = JSON.parse(res.body) } catch { body = res.body }
  return { status: res.status, body }
}

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

// 1. A project with no record yet.
const missing = await call(project, { url: '/dsh-web-ui/lark/project?path=%2Fwork%2Falpha' })
check('a project with no record answers null, not an invented one',
  missing.status === 200 && missing.body.ok === true && missing.body.project === null,
  JSON.stringify(missing.body))

// 2. A write round-trips, and lands in the pinned document.
const written = await call(project, {
  method: 'POST',
  body: JSON.stringify({ path: '/work/alpha', name: '订单中心', background: 'existing', productCardId: 'card-acf' }),
})
check('a valid write is stored and echoed back',
  written.status === 200 && written.body.project.name === '订单中心'
  && written.body.project.background === 'existing'
  && written.body.project.productCardId === 'card-acf'
  && written.body.project.updatedAt > 0,
  JSON.stringify(written.body))
const document = JSON.parse(await readFile(FILE, 'utf8'))
check('the document is where it says it is, and versioned',
  document.version === 1 && document.projects['/work/alpha']?.name === '订单中心',
  JSON.stringify(document).slice(0, 200))

const readBack = await call(project, { url: '/dsh-web-ui/lark/project?path=%2Fwork%2Falpha' })
check('the record reads back after a process would have restarted',
  readBack.body.project?.productCardId === 'card-acf',
  JSON.stringify(readBack.body))

// 3. A card id only means something for the "existing product" answer.
await call(project, {
  method: 'POST',
  body: JSON.stringify({ path: '/work/beta', name: 'B', background: 'unsure', productCardId: 'card-acf' }),
})
const beta = await call(project, { url: '/dsh-web-ui/lark/project?path=%2Fwork%2Fbeta' })
check('an answer that needs no card stores none',
  beta.body.project.background === 'unsure' && beta.body.project.productCardId === '',
  JSON.stringify(beta.body))

// An unknown background is a form-level concept, so it degrades to "not decided".
await call(project, { method: 'POST', body: JSON.stringify({ path: '/work/gamma', name: 'G', background: 'nonsense' }) })
const gamma = await call(project, { url: '/dsh-web-ui/lark/project?path=%2Fwork%2Fgamma' })
check('an unrecognized background degrades to "not decided" rather than failing',
  gamma.body.project.background === 'unsure', JSON.stringify(gamma.body))

// 4. Malformed requests never reach the document.
const before = await readFile(FILE, 'utf8')
const noPath = await call(project, { method: 'POST', body: JSON.stringify({ name: 'x' }) })
const noName = await call(project, { method: 'POST', body: JSON.stringify({ path: '/work/x' }) })
const wrongPath = await call(project, { url: '/dsh-web-ui/lark/project' })
check('a write without a path is refused',
  noPath.status === 400 && noPath.body.error.code === 'bad-request', JSON.stringify(noPath.body))
check('a write without a name is refused',
  noName.status === 400 && noName.body.error.code === 'bad-request', JSON.stringify(noName.body))
check('a read without a path is refused',
  wrongPath.status === 400 && wrongPath.body.error.code === 'bad-request', JSON.stringify(wrongPath.body))
check('a refused request leaves the document untouched',
  await readFile(FILE, 'utf8') === before)

// 5. The project's own Feishu FOLDER lives in this record too, and the property
//    that matters is what happens to it when something ELSE writes the record:
//    the edit form knows four fields and nothing about folders, so a rename must
//    not make the panel forget a folder that still exists in Feishu.
const attach = handlers.get('/dsh-web-ui/lark/folder/attach')
const attached = await call(attach, {
  method: 'POST',
  url: '/dsh-web-ui/lark/folder/attach',
  body: JSON.stringify({ path: '/work/alpha', folderToken: 'fldalpha', name: '订单中心' }),
})
const withFolder = await call(project, { url: '/dsh-web-ui/lark/project?path=%2Fwork%2Falpha' })
check('attaching a folder records it on the project',
  attached.status === 200
  && withFolder.body.project?.larkFolderToken === 'fldalpha'
  && withFolder.body.project?.larkFolderUrl === 'https://feishu.cn/drive/folder/fldalpha',
  JSON.stringify(withFolder.body.project))

await call(project, {
  method: 'POST',
  body: JSON.stringify({ path: '/work/alpha', name: '订单中心二期', background: 'existing', productCardId: 'card-acf' }),
})
const afterRename = await call(project, { url: '/dsh-web-ui/lark/project?path=%2Fwork%2Falpha' })
check('a form write keeps the folder it does not carry',
  afterRename.body.project?.name === '订单中心二期'
  && afterRename.body.project?.larkFolderToken === 'fldalpha'
  && afterRename.body.project?.larkFolderUrl === 'https://feishu.cn/drive/folder/fldalpha',
  JSON.stringify(afterRename.body.project))

// A record written before projects had a folder is not a broken record: "none
// recorded yet" is its true state, and the resolve route is what looks for one.
await writeFile(FILE, JSON.stringify({
  version: 1,
  projects: {
    '/work/old': { path: '/work/old', name: '旧项目', background: 'new', productCardId: '', updatedAt: 1 },
  },
}))
const legacy = await call(project, { url: '/dsh-web-ui/lark/project?path=%2Fwork%2Fold' })
check('a record from before folders existed reads as "no folder", not as a failure',
  legacy.status === 200
  && legacy.body.project?.name === '旧项目'
  && legacy.body.project?.larkFolderToken === ''
  && legacy.body.project?.larkFolderUrl === '',
  JSON.stringify(legacy.body.project))

// 6. Broken documents degrade to "no records", never to a refusal.
for (const [label, content] of [
  ['an empty document', ''],
  ['a truncated document', '{"version":1,"proj'],
  ['a future version', '{"version":99,"projects":{}}'],
  ['records of the wrong shape', '{"version":1,"projects":{"/work/alpha":42}}'],
]) {
  await writeFile(FILE, content)
  const answer = await call(project, { url: '/dsh-web-ui/lark/project?path=%2Fwork%2Falpha' })
  check(`${label} reads as "no record"`, answer.status === 200 && answer.body.project === null, JSON.stringify(answer.body))
}
// …and the next write repairs the file rather than being blocked by it.
const repaired = await call(project, {
  method: 'POST',
  body: JSON.stringify({ path: '/work/alpha', name: '修好', background: 'new' }),
})
check('the next write repairs a broken document',
  repaired.status === 200 && JSON.parse(await readFile(FILE, 'utf8')).projects['/work/alpha'].name === '修好',
  JSON.stringify(repaired.body).slice(0, 120))

// 7. The card catalogue.
const emptyCatalogue = await call(cards, { url: '/dsh-web-ui/lark/cards' })
check('an unconfigured deployment serves an EMPTY catalogue, not an error',
  emptyCatalogue.status === 200 && emptyCatalogue.body.ok === true && emptyCatalogue.body.cards.length === 0,
  JSON.stringify(emptyCatalogue.body))

await writeFile(join(root, 'products.json'), JSON.stringify([
  { id: 'card-acf', name: 'ACF', detail: '资产汇聚' },
  { id: 'card-fde', name: 'FDE' },
]))
const configured = await call(cards, { url: '/dsh-web-ui/lark/cards' })
check('a configured catalogue is served with its detail lines',
  configured.body.cards.length === 2 && configured.body.cards[0].detail === '资产汇聚',
  JSON.stringify(configured.body))

await writeFile(join(root, 'products.json'), JSON.stringify({ cards: [{ id: 'a', name: 'A' }] }))
const wrapped = await call(cards, { url: '/dsh-web-ui/lark/cards' })
check('a wrapped catalogue is accepted too',
  wrapped.body.ok === true && wrapped.body.cards.length === 1, JSON.stringify(wrapped.body))

await writeFile(join(root, 'products.json'), '{ not json')
const brokenCatalogue = await call(cards, { url: '/dsh-web-ui/lark/cards' })
check('a broken catalogue is reported as a failure, not as "no cards"',
  brokenCatalogue.status === 200 && brokenCatalogue.body.ok === false
  && brokenCatalogue.body.error.code === 'cards-unreadable',
  JSON.stringify(brokenCatalogue.body))

await writeFile(join(root, 'products.json'), JSON.stringify([{ id: 'dup', name: 'A' }, { id: 'dup', name: 'B' }]))
const duplicate = await call(cards, { url: '/dsh-web-ui/lark/cards' })
check('a duplicate card id is refused rather than silently collapsed',
  duplicate.body.ok === false, JSON.stringify(duplicate.body))

process.env['DSH_WEB_UI_PRODUCT_CARDS'] = JSON.stringify([{ id: 'env', name: 'From the environment' }])
const fromEnv = await call(cards, { url: '/dsh-web-ui/lark/cards' })
check('the inline environment catalogue wins over the file',
  fromEnv.body.cards.length === 1 && fromEnv.body.cards[0].id === 'env',
  JSON.stringify(fromEnv.body))
delete process.env['DSH_WEB_UI_PRODUCT_CARDS']

// A wrong method is refused with the methods it does accept.
const wrongMethod = await call(project, { method: 'DELETE' })
check('a method the route does not accept is refused',
  wrongMethod.status === 405, String(wrongMethod.status))

await rm(root, { recursive: true, force: true })

let failed = 0
for (const entry of results) {
  if (!entry.ok) failed += 1
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name}${entry.detail === '' ? '' : `\n      ${entry.detail}`}`)
}
console.log(failed === 0 ? `\n${String(results.length)} checks passed` : `\n${String(failed)} of ${String(results.length)} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
