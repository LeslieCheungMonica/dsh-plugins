/**
 * Offline harness for the FDE stage gate's host route.
 *
 * The route answers one question — *does this project's Feishu folder hold the
 * outputs the next stage requires* — and it is the only place in this plugin
 * where a rule the operator cannot click past is enforced. That makes it worth
 * pinning down without a live `dsh web` and without a Feishu login: this script
 * registers the REAL routes (`registerLarkRoutes`, which is what registers the
 * gate route too) against a fake webserver, stubs `lark-cli` on disk with a
 * folder TREE, pins the project record to a temporary file, and then drives the
 * route with synthetic requests.
 *
 * It answers the questions a reviewer would otherwise have to trust:
 *
 * 1. **The request surface**: the method guard, and every malformed request — a
 *    missing path, a non-numeric or fractional `to`, and a stage that carries no
 *    gate at all. None of them reaches the CLI.
 * 2. **The walk**: that a project's folder is searched at depth (three levels,
 *    breadth-first), that the bounds are reported rather than silently obeyed
 *    (`truncated`), and that the archive parent is never listed when the project's
 *    folder is on record.
 * 3. **Matched by NAME, with evidence**: which entry satisfied each item, where it
 *    sits (`/需求/需求分析/需求分析 v2`), whether it is a directory, and how many
 *    others matched.
 * 4. **Fail closed, with the right reason**: no folder, several same-named folders
 *    (adoption writes NOTHING), a login that is missing or lacks the scope — each
 *    answered as content rather than as a pass, and none of them as a 500.
 * 5. **A gate reads and never writes**: the check itself creates no folder. The
 *    writes it can produce are the shared resolver's adoption of a single
 *    same-named folder (the same adoption the document panel performs) and the
 *    manual answer the operator gave in the dialog.
 * 6. **Every gate down the flow**: that entry to 代码开发与自测 asks about 详细设计,
 *    to 测试环境验收 about the self-test pair, to 上线部署 about the test pair, and
 *    to 上线验收 about 上线实施文档 AND an installer read from the project's own
 *    directory — including the rules that make the installer check mean something (a
 *    0-byte file is not a build, a pruned directory is not the project, a name with
 *    no useful extension still counts) and that an unreadable workspace is reported
 *    as a state rather than as an absent file.
 * 7. **The manual item, on both sides**: that a folder full of outputs still
 *    BLOCKS while the human item is unanswered, that confirming names the operator
 *    the HOST resolved (and that an unresolvable identity records a blank citation
 *    rather than refusing), that a FOLDER item cannot be answered by hand, that
 *    withdrawing DELETES the entry, that the answer survives the form's own write,
 *    and that it is still reported when the folder cannot be resolved at all.
 *
 * Usage: node scripts/harness/stage-gate.mjs
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'

const STUB_DIR = '/tmp/dsh-web-ui-stage-gate'
const STUB = `${STUB_DIR}/lark-cli`
/**
 * A real project directory for the WORKSPACE half of a checklist.
 *
 * The package item is read from the host's filesystem, so the fixture has to be
 * one: this directory is created per scenario with the files a scenario describes,
 * and the record is keyed by it (the route takes the project's path from the
 * request, so the harness can point at a throwaway tree).
 */
const WORKSPACE = `${STUB_DIR}/workspace`
const PARENT = 'IE6SfqKh3lRv2odSLkHccYh5nog'
const PROJECT = '/Users/liyanhui/vscodeProjects/prd-demo-designer'
const PROJECT_NAME = '陕西内生安全2期'
const ROOT = 'fldroot'
const CHECK = '/dsh-web-ui/stage-gate/check'

await mkdir(`${STUB_DIR}/folders`, { recursive: true })

/**
 * The stub CLI.
 *
 * Node rather than bash, unlike the folder harness's stub, because the gate walks
 * a TREE: the answer depends on which folder was asked for, and reading a
 * per-token document out of `--params` is a JSON parse rather than a shell case.
 * It records every argv (so a scenario can assert WHICH folders were listed and
 * that nothing was created) and answers `{}` for anything it is not asked to
 * model.
 */
await writeFile(STUB, `#!/usr/bin/env node
const fs = require('node:fs')
const DIR = ${JSON.stringify(STUB_DIR)}
const argv = process.argv.slice(2)
fs.appendFileSync(DIR + '/argv.log', argv.join(' ') + '\\n')
const paramsAt = argv.indexOf('--params')
const isList = argv[0] === 'drive' && argv[1] === 'files' && argv[2] === 'list' && paramsAt >= 0
// A FAILURE envelope applies to every verb, the listing included: "the login is
// missing" is not a listing that happens to fail, it is every call failing.
const otherPath = DIR + '/other.json'
const failure = fs.existsSync(otherPath) ? JSON.parse(fs.readFileSync(otherPath, 'utf8')) : null
if (isList && (failure === null || failure.ok !== false)) {
  const params = JSON.parse(argv[paramsAt + 1])
  const tree = JSON.parse(fs.readFileSync(DIR + '/tree.json', 'utf8'))
  const key = params.page_token === undefined
    ? params.folder_token
    : params.folder_token + '#' + params.page_token
  const answer = tree[key] ?? tree[params.folder_token] ?? { files: [], has_more: false }
  process.stdout.write(JSON.stringify({ ok: true, data: answer }))
  process.exit(0)
}
if (failure !== null) {
  process.stdout.write(JSON.stringify(failure))
  process.exit(0)
}
// The identity verbs the confirm route uses to resolve WHO is answering. They are
// answered from their own files so a scenario can be "signed in as X" or "not
// signed in at all".
const read = (name, fallback) => fs.existsSync(DIR + '/' + name)
  ? fs.readFileSync(DIR + '/' + name, 'utf8')
  : fallback
if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write(read('auth.json', '{"identities":{"user":{"status":"active","openId":"ou_operator","userName":"李彦辉"}}}'))
  process.exit(0)
}
if (argv[0] === 'contact') {
  process.stdout.write(read('contact.json', '{"ok":true,"data":{"user":{"name":"李彦辉","open_id":"ou_operator"}}}'))
  process.exit(0)
}
process.stdout.write('{"ok":true,"data":{}}')
process.exit(0)
`, { mode: 0o755 })

// The route module reads these at import time, so both are set before the import.
// The record file is redirected into the stub directory: this harness must never
// write into the operator's real ~/.dsh/storages/web_ui_projects.json.
process.env['DSH_WEB_UI_LARK_CLI'] = STUB
const RECORDS = `${STUB_DIR}/projects.json`
process.env['DSH_WEB_UI_PROJECTS_FILE'] = RECORDS

const { registerLarkRoutes } = await import('../../src/host/routes.ts')
const { STAGE_COUNT } = await import('../../src/client/stage.ts')

/**
 * Register the real routes against a fake webserver.
 * @returns the handlers, by path.
 */
async function collectRoutes() {
  /** Stands in for the host's webserver service. */
  const handlers = new Map()
  /** The subset of a cordis context this registration touches. */
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    effect: (factory) => factory(),
    webServer: {
      register: ({ path, handler }) => { handlers.set(path, handler); return () => {} },
    },
  }
  registerLarkRoutes(ctx)
  return handlers
}

/** One synthetic request. */
function fakeRequest({ method = 'GET', url = CHECK, body = undefined } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
}

/** One synthetic response that records what the route wrote. */
function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; this.headersSent = true },
    end(text = '') { if (text !== '') this.body = text },
  }
}

/**
 * One folder of the stubbed tree.
 * @param entries - the folder's children.
 * @returns the listing document Feishu would answer with.
 */
function folder(entries) {
  return { files: entries, has_more: false }
}

/**
 * One Drive entry.
 * @param name - the entry's name.
 * @param input - its token and type (a `folder` is expandable by its own token).
 * @returns the entry document.
 */
function entry(name, input = {}) {
  const token = input.token ?? `tok${String(Math.abs(hash(name)) % 100000)}`
  const type = input.type ?? 'docx'
  return {
    token,
    type,
    name,
    url: `https://feishu.cn/${type === 'folder' ? 'drive/folder' : 'docx'}/${token}`,
  }
}

/**
 * A stable small hash, so a generated token is reproducible across runs.
 * @param text - the entry name.
 * @returns a signed 32-bit integer.
 */
function hash(text) {
  let value = 0
  for (const character of text) value = (value * 31 + character.codePointAt(0)) | 0
  return value
}

/**
 * Point the stub at one scenario and clear its logs.
 *
 * Re-registering gives the routes a fresh `lark-cli` handle AND clears the
 * adapter's caches with it — which is what a `dsh web` restart does in
 * production, and what makes a second scenario's listing real rather than the
 * first one's cached answer.
 * @param input - the folder tree, the record document, and any non-list envelope.
 * @returns the handlers for the fresh registration.
 */
async function scenario({ tree, records, other, identity, workspace } = {}) {
  await writeFile(`${STUB_DIR}/tree.json`, JSON.stringify(tree ?? {}))
  // The workspace fixture is rebuilt per scenario: a stale installer from the
  // previous case would make the next one pass for the wrong reason.
  await rm(WORKSPACE, { recursive: true, force: true })
  await mkdir(WORKSPACE, { recursive: true })
  for (const file of workspace ?? []) {
    const target = `${WORKSPACE}/${file.path}`
    await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true })
    await writeFile(target, file.contents ?? 'x')
  }
  if (other === undefined) await rm(`${STUB_DIR}/other.json`, { force: true })
  else await writeFile(`${STUB_DIR}/other.json`, JSON.stringify(other))
  // `identity: null` is the deployment with nobody signed in, which is the case a
  // confirmation must still be recordable in.
  if (identity === null) {
    await writeFile(`${STUB_DIR}/auth.json`, '{"identities":{}}')
    await rm(`${STUB_DIR}/contact.json`, { force: true })
  } else {
    await writeFile(`${STUB_DIR}/auth.json`, JSON.stringify({
      identities: { user: { status: 'active', openId: 'ou_operator', userName: identity ?? '李彦辉' } },
    }))
    await writeFile(`${STUB_DIR}/contact.json`, JSON.stringify({
      ok: true, data: { user: { name: identity ?? '李彦辉', open_id: 'ou_operator' } },
    }))
  }
  if (records === undefined) await rm(RECORDS, { force: true })
  else await writeFile(RECORDS, JSON.stringify(records))
  await rm(`${STUB_DIR}/argv.log`, { force: true })
  return collectRoutes()
}

/**
 * A project record pointing at the stubbed root folder.
 * @param token - the folder token to record (`''` for a project that has none).
 * @returns the record document.
 */
function recorded(token = ROOT, path = PROJECT) {
  return {
    version: 1,
    projects: {
      [path]: {
        name: PROJECT_NAME,
        background: 'new',
        productCardId: '',
        larkFolderToken: token,
        larkFolderUrl: token === '' ? '' : `https://feishu.cn/drive/folder/${token}`,
        updatedAt: 1,
      },
    },
  }
}

/**
 * A record for the workspace fixture: the folder is stubbed, the path is real.
 * @param token - the folder token to record.
 * @returns the record document.
 */
function recordedWorkspace(token = ROOT) {
  return recorded(token, WORKSPACE)
}

/** Everything the stubbed CLI was asked to do, one argv per line. */
async function argvLog() {
  return readFile(`${STUB_DIR}/argv.log`, 'utf8').catch(() => '')
}

/**
 * How many calls the stub's log holds.
 * @param argv - the log's text.
 * @returns the number of non-empty lines (the log ends with a newline).
 */
function lines(argv) {
  return argv.split('\n').filter(line => line.trim() !== '').length
}

/** The project-record document, as the route left it. */
async function readRecords() {
  const text = await readFile(RECORDS, 'utf8').catch(() => '{"projects":{}}')
  return JSON.parse(text)
}

/**
 * Drive one request through the real handler.
 * @param routes - the registered handlers.
 * @param options - the request to synthesize.
 * @returns the status, the parsed body, and the argv the CLI received.
 */
async function call(routes, options = {}) {
  const res = fakeResponse()
  const path = options.path ?? CHECK
  await routes.get(path)(fakeRequest({ url: options.url ?? path, ...options }), res)
  let body = null
  try { body = JSON.parse(res.body) } catch { body = res.body }
  return { status: res.status, body, headers: res.headers, argv: await argvLog() }
}

/** The confirm route's path. */
const CONFIRM = '/dsh-web-ui/stage-gate/confirm'

/**
 * Confirm (or withdraw) one manual item through the real route.
 * @param routes - the registered handlers.
 * @param body - the request body.
 * @returns the status and the parsed body.
 */
async function confirm(routes, body) {
  return call(routes, { path: CONFIRM, method: 'POST', body })
}

/** The recorded confirmations of the project's record. */
async function recordedConfirmations() {
  const document = await readRecords()
  return document.projects[PROJECT]?.gateConfirmations ?? {}
}

/** The route's URL for one check. */
function url(path = PROJECT, to = 1) {
  return `${CHECK}?path=${encodeURIComponent(path)}&to=${String(to)}`
}

/** The route's URL for a check against the workspace fixture. */
function workspaceUrl(to) {
  return url(WORKSPACE, to)
}

/** One item of a report, by id. */
function item(body, id) {
  return body?.report?.items?.find(entry => entry.id === id)
}

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

/* ── 1. the request surface ────────────────────────────────────────────── */

{
  const routes = await scenario({ tree: { [ROOT]: folder([]) }, records: recorded() })
  const wrongMethod = await call(routes, { method: 'POST', url: url() })
  check('the gate answers GET only, and says which method it does answer',
    wrongMethod.status === 405 && wrongMethod.headers.allow === 'GET',
    `${wrongMethod.status} allow=${wrongMethod.headers.allow}`)

  const noPath = await call(routes, { url: `${CHECK}?to=1` })
  check('a request naming no project is a 400',
    noPath.status === 400 && noPath.body?.error?.code === 'bad-request', JSON.stringify(noPath.body))

  const notANumber = await call(routes, { url: `${CHECK}?path=${encodeURIComponent(PROJECT)}&to=abc` })
  const fractional = await call(routes, { url: `${CHECK}?path=${encodeURIComponent(PROJECT)}&to=1.5` })
  const missingTo = await call(routes, { url: `${CHECK}?path=${encodeURIComponent(PROJECT)}` })
  check('a stage index that is not a whole number is a 400',
    notANumber.status === 400 && fractional.status === 400 && missingTo.status === 400,
    `${notANumber.status}/${fractional.status}/${missingTo.status}`)

  // Entry stages 1..5 carry a gate; the terminal 完成 node (6) does NOT — the gate
  // guards being able to START a piece of work, and the end of the flow has none.
  const ungated = await call(routes, { url: url(PROJECT, STAGE_COUNT - 1) })
  check('a stage that carries no gate is refused as a caller bug, naming the stage',
    ungated.status === 400
      && ungated.body?.error?.message?.includes(`stage ${String(STAGE_COUNT - 1)} carries no gate`) === true,
    JSON.stringify(ungated.body))

  check('no malformed request reaches the CLI',
    (await argvLog()) === '', (await argvLog()).trim())
}

/* ── 2. a project that has everything, at the root ─────────────────────── */

{
  const routes = await scenario({
    tree: {
      [ROOT]: folder([
        entry('需求分析 v2.docx'),
        entry('功能清单.xlsx', { type: 'sheet' }),
        entry('demo.html', { type: 'file' }),
      ]),
    },
    records: recorded(),
  })
  // The manual item is answered first, because a folder full of outputs is only
  // HALF of this gate: see the "both halves" checks below.
  const first = await call(routes, { url: url() })
  check('a folder with every required output still BLOCKS while the manual item is unanswered',
    first.body?.report?.status === 'blocked'
      && first.body.report.items.every(row => row.met === true)
      && first.body.report.confirmations.length === 1
      && first.body.report.confirmations[0].item === 'customer-confirmation'
      && first.body.report.confirmations[0].confirmed === false
      && first.body.report.confirmations[0].at === 0,
    JSON.stringify(first.body?.report?.confirmations))
  const written = await confirm(routes, { path: PROJECT, to: 1, item: 'customer-confirmation', confirmed: true })
  check('confirming the manual item names the operator the HOST resolved',
    written.status === 200 && written.body?.ok === true
      && written.body.confirmation.confirmed === true && written.body.confirmation.by === '李彦辉'
      && written.body.confirmation.at > 0,
    JSON.stringify(written.body))

  const passed = await call(routes, { url: url() })
  check('every required output found AND the manual item confirmed: the gate PASSES',
    passed.status === 200 && passed.body?.ok === true && passed.body.report.status === 'passed'
      && passed.body.report.reason === null && passed.body.report.truncated === false
      && passed.body.report.confirmations[0].confirmed === true,
    JSON.stringify(passed.body))
  check('the pass names the transition it guards, and the folder it read',
    passed.body.report.gate === 'requirement-to-design'
      && passed.body.report.folder?.name === PROJECT_NAME
      && passed.body.report.folder?.url === `https://feishu.cn/drive/folder/${ROOT}`,
    JSON.stringify(passed.body.report.folder))
  check('every item carries the evidence that satisfied it, with its path in the folder',
    passed.body.report.items.length === 3
      && passed.body.report.items.every(row => row.met === true && row.matches === 1)
      && item(passed.body, 'requirement-analysis')?.evidence?.name === '需求分析 v2.docx'
      && item(passed.body, 'requirement-analysis')?.evidence?.path === '/需求分析 v2.docx'
      && item(passed.body, 'requirement-analysis')?.evidence?.directory === false,
    JSON.stringify(passed.body.report.items))
  check('the check reports the manual item beside the folder items, never instead of them',
    passed.body.report.items.length === 3 && passed.body.report.confirmations.length === 1,
    JSON.stringify({ items: passed.body.report.items.length, confirmations: passed.body.report.confirmations.length }))
  check('a recorded folder is read directly: the archive is never listed',
    passed.argv.includes(ROOT) && !passed.argv.includes(PARENT),
    passed.argv.trim().replaceAll('\n', ' | ').slice(0, 200))
  const listings = passed.argv.split('\n').filter(line => line.includes('drive files list')).length
  check('the check itself lists only the project folder, and creates nothing',
    !passed.argv.includes('create-folder') && listings === 1,
    `${listings} listing(s): ${passed.argv.trim().replaceAll('\n', ' | ').slice(0, 200)}`)
  // A check is a READ: it must not touch the record at all — including the
  // confirmation the operator's own answer wrote a moment ago.
  const before = JSON.stringify((await readRecords()).projects[PROJECT])
  await call(routes, { url: url() })
  const after = JSON.stringify((await readRecords()).projects[PROJECT])
  check('a check never rewrites the project record',
    before === after && JSON.parse(after).larkFolderToken === ROOT,
    before === after ? 'identical before and after' : `${before} → ${after}`)
}

/* ── 3. the walk: depth, names, and the evidence of where it was found ─── */

{
  const routes = await scenario({
    tree: {
      [ROOT]: folder([entry('需求', { type: 'folder', token: 'fld-need' }), entry('设计稿', { type: 'folder', token: 'fld-design' })]),
      'fld-need': folder([entry('需求分析', { type: 'folder', token: 'fld-need-2' })]),
      'fld-need-2': folder([entry('需求分析说明书 v3.docx'), entry('功能列表.md', { type: 'file' })]),
      'fld-design': folder([entry('产品原型.HTML', { type: 'file' })]),
    },
    records: recorded(),
  })
  await confirm(routes, { path: PROJECT, to: 1, item: 'customer-confirmation', confirmed: true })
  const nested = await call(routes, { url: url() })
  check('outputs are found at depth, not only at the root',
    nested.body?.report?.status === 'passed', JSON.stringify(nested.body?.report?.status))
  check('an item’s path says WHERE in the folder it was found',
    item(nested.body, 'requirement-analysis')?.evidence?.path === '/需求/需求分析'
      && item(nested.body, 'feature-list')?.evidence?.path === '/需求/需求分析/功能列表.md'
      && item(nested.body, 'html-demo')?.evidence?.path === '/设计稿/产品原型.HTML',
    JSON.stringify(nested.body?.report?.items?.map(row => row.evidence?.path)))
  check('matching is case-insensitive, and a version-bearing name still counts',
    item(nested.body, 'html-demo')?.met === true && item(nested.body, 'feature-list')?.met === true,
    JSON.stringify(nested.body?.report?.items?.map(row => `${row.id}:${String(row.met)}`)))
  check('the FIRST match in breadth-first order is the evidence, and a matching DIRECTORY is one',
    item(nested.body, 'requirement-analysis')?.evidence?.directory === true
      && item(nested.body, 'requirement-analysis')?.evidence?.name === '需求分析'
      && nested.argv.includes('fld-need'),
    JSON.stringify(item(nested.body, 'requirement-analysis')?.evidence))
}

{
  const routes = await scenario({
    tree: {
      [ROOT]: folder([entry('需求分析', { type: 'folder', token: 'fld-a' })]),
      'fld-a': folder([]),
    },
    records: recorded(),
  })
  const asFolder = await call(routes, { url: url() })
  check('a directory that matches is accepted, and is marked as a directory',
    item(asFolder.body, 'requirement-analysis')?.met === true
      && item(asFolder.body, 'requirement-analysis')?.evidence?.directory === true,
    JSON.stringify(item(asFolder.body, 'requirement-analysis')))
}

{
  // Five levels down: the walk stops at three, and SAYS SO rather than reporting
  // a bare "missing" that hides the difference.
  const routes = await scenario({
    tree: {
      [ROOT]: folder([entry('L1', { type: 'folder', token: 'fld-l1' })]),
      'fld-l1': folder([entry('L2', { type: 'folder', token: 'fld-l2' })]),
      'fld-l2': folder([entry('L3', { type: 'folder', token: 'fld-l3' })]),
      'fld-l3': folder([entry('L4', { type: 'folder', token: 'fld-l4' })]),
      'fld-l4': folder([
        entry('需求分析.docx'), entry('功能清单.docx'), entry('demo.html', { type: 'file' }),
      ]),
    },
    records: recorded(),
  })
  const deep = await call(routes, { url: url() })
  check('an output below the depth bound is reported as missing by a PARTIAL read',
    deep.body?.report?.status === 'blocked' && deep.body.report.truncated === true
      && item(deep.body, 'requirement-analysis')?.met === false,
    JSON.stringify({ truncated: deep.body?.report?.truncated, items: deep.body?.report?.items?.map(row => row.met) }))
}

{
  // More folders than the walk will list: the bound bites, and is reported.
  const wide = {}
  wide[ROOT] = folder(Array.from({ length: 70 }, (_, index) => entry(`目录${String(index)}`, { type: 'folder', token: `fld-w${String(index)}` })))
  for (let index = 0; index < 70; index += 1) wide[`fld-w${String(index)}`] = folder([])
  const routes = await scenario({ tree: wide, records: recorded() })
  const bounded = await call(routes, { url: url() })
  check('a folder tree wider than the bound is cut short, and the report says so',
    bounded.body?.report?.truncated === true && lines(bounded.argv) <= 60,
    `${lines(bounded.argv)} listings, truncated=${String(bounded.body?.report?.truncated)}`)
}

/* ── 4. what BLOCKS, and why ───────────────────────────────────────────── */

{
  const routes = await scenario({
    tree: {
      [ROOT]: folder([
        entry('需求分析 v2.docx'),
        entry('需求分析 评审版.docx'),
        entry('功能清单.xlsx', { type: 'sheet' }),
      ]),
    },
    records: recorded(),
  })
  const blocked = await call(routes, { url: url() })
  check('a missing output BLOCKS the transition, and the other items still report their evidence',
    blocked.body?.report?.status === 'blocked' && blocked.body.report.items.length === 3
      && item(blocked.body, 'html-demo')?.met === false
      && item(blocked.body, 'html-demo')?.evidence === null
      && item(blocked.body, 'html-demo')?.matches === 0
      && item(blocked.body, 'requirement-analysis')?.met === true,
    JSON.stringify(blocked.body?.report?.items))
  check('several matches are counted, and the first is the evidence',
    item(blocked.body, 'requirement-analysis')?.matches === 2
      && item(blocked.body, 'requirement-analysis')?.evidence?.name === '需求分析 v2.docx',
    JSON.stringify(item(blocked.body, 'requirement-analysis')))
}

{
  // No folder on record, and none in the archive either: the fix is the operator's
  // (create or associate one), so the answer names THAT rather than a checklist.
  const routes = await scenario({
    tree: { [PARENT]: folder([]) },
    records: recorded(''),
  })
  const missing = await call(routes, { url: url() })
  check('a project with no Feishu folder is blocked with its own reason, not an empty checklist',
    missing.body?.ok === true && missing.body.report.status === 'blocked'
      && missing.body.report.reason === 'no-folder' && missing.body.report.items.length === 0
      && missing.body.report.folder === null,
    JSON.stringify(missing.body))
  check('the gate NEVER creates a folder to satisfy itself',
    !missing.argv.includes('create-folder'), missing.argv.trim().replaceAll('\n', ' | ').slice(0, 200))
  const afterMissing = await readRecords()
  check('a folder that was not found is not recorded either',
    afterMissing.projects[PROJECT].larkFolderToken === '', JSON.stringify(afterMissing.projects[PROJECT]))
}

{
  // Two same-named folders: ambiguous, and NOTHING is adopted — the operator picks.
  const routes = await scenario({
    tree: { [PARENT]: folder([entry(PROJECT_NAME, { type: 'folder', token: 'fld-dup-1' }), entry(PROJECT_NAME, { type: 'folder', token: 'fld-dup-2' })]) },
    records: recorded(''),
  })
  const ambiguous = await call(routes, { url: url() })
  check('several same-named folders block with the AMBIGUOUS reason',
    ambiguous.body?.report?.reason === 'ambiguous-folder' && ambiguous.body.report.folder === null,
    JSON.stringify(ambiguous.body?.report))
  const afterAmbiguous = await readRecords()
  check('an ambiguous answer adopts nothing: the record is left as it was',
    afterAmbiguous.projects[PROJECT].larkFolderToken === '', JSON.stringify(afterAmbiguous.projects[PROJECT]))
}

{
  // Exactly one: the shared resolver adopts it — the same adoption the document
  // panel performs — and the check then proceeds against the adopted folder.
  const routes = await scenario({
    tree: {
      [PARENT]: folder([entry(PROJECT_NAME, { type: 'folder', token: 'fld-adopt' })]),
      'fld-adopt': folder([
        entry('需求分析.docx'), entry('功能清单.docx'), entry('demo.html', { type: 'file' }),
      ]),
    },
    records: recorded(''),
  })
  await confirm(routes, { path: PROJECT, to: 1, item: 'customer-confirmation', confirmed: true })
  const adopted = await call(routes, { url: url() })
  check('exactly one same-named folder is adopted, and the check runs against it',
    adopted.body?.report?.status === 'passed' && adopted.argv.includes(PARENT) && adopted.argv.includes('fld-adopt'),
    JSON.stringify({ status: adopted.body?.report?.status, argv: adopted.argv.trim().replaceAll('\n', ' | ').slice(0, 200) }))
  const afterAdopted = await readRecords()
  check('the adopted folder is written to the record, so the next check needs no archive read',
    afterAdopted.projects[PROJECT].larkFolderToken === 'fld-adopt',
    JSON.stringify(afterAdopted.projects[PROJECT]))
}

{
  // Failures travel as content: a gate that cannot be checked must not look like
  // one that passed, and the panel needs the code to name the fix.
  for (const [label, envelope, code] of [
    ['a login that is missing', { ok: false, error: { type: 'authorization', subtype: 'missing_scope', message: 'missing scope', hint: 'space:document:retrieve' } }, 'scope-missing'],
    ['a tenant that cannot be reached', { ok: false, error: { type: 'network', message: 'dial tcp: i/o timeout' } }, 'cli-network'],
  ]) {
    const routes = await scenario({ tree: { [ROOT]: folder([]) }, records: recorded(), other: envelope })
    const failed = await call(routes, { url: url() })
    check(`${label} is answered as content with its own code, not as a 500 and not as a pass`,
      failed.status === 200 && failed.body?.ok === false && failed.body.error.code === code,
      `${failed.status} ${JSON.stringify(failed.body)}`)
  }
}

  /* ── 5. the confirm route: the one write a gate owns ───────────────────── */

{
  const routes = await scenario({
    tree: { [ROOT]: folder([entry('需求分析.docx'), entry('功能清单.docx'), entry('demo.html', { type: 'file' })]) },
    records: recorded(),
  })

  const wrongMethod = await call(routes, { path: CONFIRM, method: 'GET' })
  check('the confirm route takes POST only',
    wrongMethod.status === 405 && wrongMethod.headers.allow === 'POST',
    `${wrongMethod.status} allow=${wrongMethod.headers.allow}`)

  const noPath = await confirm(routes, { to: 1, item: 'customer-confirmation', confirmed: true })
  const badTo = await confirm(routes, { path: PROJECT, to: 'one', item: 'customer-confirmation', confirmed: true })
  const ungated = await confirm(routes, { path: PROJECT, to: 2, item: 'customer-confirmation', confirmed: true })
  check('a malformed confirmation is a 400: no path, a non-numeric stage, a stage with no gate',
    noPath.status === 400 && badTo.status === 400 && ungated.status === 400,
    `${noPath.status}/${badTo.status}/${ungated.status}`)

  // The item is scoped to the gate's OWN manual list, so a caller cannot record
  // an answer to something the host reads from the folder.
  const folderItem = await confirm(routes, { path: PROJECT, to: 1, item: 'requirement-analysis', confirmed: true })
  const unknownItem = await confirm(routes, { path: PROJECT, to: 1, item: 'vibes', confirmed: true })
  check('a FOLDER item cannot be answered by hand, and neither can an unknown one',
    folderItem.status === 400 && unknownItem.status === 400
      && folderItem.body?.error?.message?.includes('not a manual item') === true,
    `${JSON.stringify(folderItem.body)} / ${JSON.stringify(unknownItem.body)}`)

  const written = await confirm(routes, { path: PROJECT, to: 1, item: 'customer-confirmation', confirmed: true })
  const stored = await recordedConfirmations()
  check('a confirmation is recorded as a citation, under the gate-and-item key',
    written.body?.confirmation?.by === '李彦辉' && written.body.confirmation.at > 0
      && stored['requirement-to-design:customer-confirmation']?.by === '李彦辉',
    JSON.stringify(stored))

  const cleared = await confirm(routes, { path: PROJECT, to: 1, item: 'customer-confirmation', confirmed: false })
  const clearedStored = await recordedConfirmations()
  check('withdrawing DELETES the entry, so a withdrawn answer cannot read as standing permission',
    cleared.body?.confirmation?.confirmed === false
      && Object.prototype.hasOwnProperty.call(clearedStored, 'requirement-to-design:customer-confirmation') === false,
    JSON.stringify(clearedStored))
}

{
  // With nobody signed in, the answer is still the operator's — only the citation
  // is blank. Refusing the write would make a Feishu outage a gate that cannot be
  // passed at all.
  const routes = await scenario({
    tree: { [ROOT]: folder([]) },
    records: recorded(),
    identity: null,
  })
  const written = await confirm(routes, { path: PROJECT, to: 1, item: 'customer-confirmation', confirmed: true })
  const stored = await recordedConfirmations()
  check('an unresolvable identity records the answer with a blank citation rather than refusing it',
    written.status === 200 && written.body?.ok === true
      && written.body.confirmation.confirmed === true && written.body.confirmation.by === ''
      && stored['requirement-to-design:customer-confirmation']?.by === '',
    JSON.stringify({ answer: written.body, stored }))
}

{
  // A confirmation survives the OTHER writes: the edit form asks about the
  // product, not about the customer conversation.
  const routes = await scenario({
    tree: { [ROOT]: folder([]) },
    records: recorded(),
  })
  await confirm(routes, { path: PROJECT, to: 1, item: 'customer-confirmation', confirmed: true })
  const posted = await call(routes, {
    path: '/dsh-web-ui/lark/project',
    method: 'POST',
    body: { path: PROJECT, name: PROJECT_NAME, background: 'existing', productCardId: 'card-fde' },
  })
  const stored = await recordedConfirmations()
  check('a form write keeps the manual answer (and the folder) it does not carry',
    posted.body?.ok === true && stored['requirement-to-design:customer-confirmation'] !== undefined,
    JSON.stringify(stored))
}

{
  // The manual item is reported even when the folder could not be resolved at all:
  // they are different gates, and a dialog that hid the question would look like a
  // pass waiting on a folder.
  const routes = await scenario({ tree: { [PARENT]: folder([]) }, records: recorded('') })
  const blocked = await call(routes, { url: url() })
  check('a gate with no folder still reports its manual item as unanswered',
    blocked.body?.report?.reason === 'no-folder'
      && blocked.body.report.confirmations.length === 1
      && blocked.body.report.confirmations[0].confirmed === false,
    JSON.stringify(blocked.body?.report?.confirmations))
}


/* ── 6. the four gates down the flow ──────────────────────────────────────
   Each transition guards the outputs the stage BEFORE it owes, and the last one
   reaches outside Feishu: a built installer is a file on this host. */

{
  // 技术选型与详设 → 代码开发与自测: 详细设计 in the project's folder.
  const routes = await scenario({
    tree: { [ROOT]: folder([entry('详细设计说明书 v2.docx'), entry('需求分析.docx')]) },
    records: recorded(),
  })
  const blocked = await call(routes, { url: url(PROJECT, 2) })
  check('entry to 代码开发与自测 asks about the design, and asks no person',
    blocked.body?.report?.gate === 'design-to-development'
      && blocked.body.report.items.length === 1
      && blocked.body.report.items[0].id === 'detail-design'
      && blocked.body.report.items[0].source === 'folder'
      && blocked.body.report.items[0].met === true
      && blocked.body.report.confirmations.length === 0
      // Only the first transition asks a person; this one is blocked by nothing.
      && blocked.body.report.status === 'passed',
    JSON.stringify(blocked.body?.report?.items))

  const missing = await scenario({
    tree: { [ROOT]: folder([entry('概要设计.docx')]) },
    records: recorded(),
  })
  const withoutDesign = await call(missing, { url: url(PROJECT, 2) })
  check('a design that is not there BLOCKS the transition, with no evidence invented',
    withoutDesign.body?.report?.status === 'blocked'
      && withoutDesign.body.report.items[0].met === false
      && withoutDesign.body.report.items[0].evidence === null,
    JSON.stringify(withoutDesign.body?.report?.items))
}

{
  // 代码开发与自测 → 测试环境验收: 自测用例 + 自测报告.
  const routes = await scenario({
    tree: { [ROOT]: folder([entry('自测用例.xlsx', { type: 'sheet' }), entry('自测报告.md', { type: 'file' })]) },
    records: recorded(),
  })
  const passed = await call(routes, { url: url(PROJECT, 3) })
  check('entry to 测试环境验收 needs the self-test pair, and passes on both',
    passed.body?.report?.gate === 'development-to-test' && passed.body.report.status === 'passed'
      && passed.body.report.items.map(row => row.id).join(',') === 'self-test-cases,self-test-report'
      && passed.body.report.items.every(row => row.met === true),
    JSON.stringify(passed.body?.report?.items?.map(row => `${row.id}:${String(row.met)}`)))
  check('a self-test item reports the name and link of what satisfied it',
    passed.body.report.items.every(row => row.evidence.name !== '' && row.evidence.url !== ''),
    JSON.stringify(passed.body?.report?.items?.map(row => row.evidence?.name)))
}

{
  // 测试环境验收 → 上线部署: 测试用例 + 测试报告.
  const routes = await scenario({
    tree: { [ROOT]: folder([entry('测试案例集.xlsx', { type: 'sheet' })]) },
    records: recorded(),
  })
  const partial = await call(routes, { url: url(PROJECT, 4) })
  check('entry to 上线部署 needs BOTH the test cases and the test report',
    partial.body?.report?.gate === 'test-to-deploy' && partial.body.report.status === 'blocked'
      && item(partial.body, 'test-cases')?.met === true
      && item(partial.body, 'test-report')?.met === false,
    JSON.stringify(partial.body?.report?.items?.map(row => `${row.id}:${String(row.met)}`)))
}

{
  // 上线部署 → 上线验收: 上线实施文档 in Feishu AND a built installer in the workspace.
  const routes = await scenario({
    tree: { [ROOT]: folder([entry('上线实施方案.docx')]) },
    records: recordedWorkspace(),
    workspace: [
      { path: 'README.md', contents: 'not a package' },
      { path: 'src/main.ts', contents: 'source' },
      { path: 'dist/订单中心-1.2.0.dmg', contents: 'a real installer, with bytes in it' },
    ],
  })
  const passed = await call(routes, { url: workspaceUrl(5) })
  check('entry to 上线验收 needs the release document AND an installer, and passes on both',
    passed.body?.report?.gate === 'deploy-to-acceptance' && passed.body.report.status === 'passed'
      && item(passed.body, 'release-doc')?.met === true
      && item(passed.body, 'release-package')?.met === true,
    JSON.stringify(passed.body?.report?.items?.map(row => `${row.id}:${String(row.met)}`)))
  check('a workspace item says where it came from, with its path and size as evidence',
    item(passed.body, 'release-package')?.source === 'workspace'
      && item(passed.body, 'release-package')?.evidence?.path === '/dist/订单中心-1.2.0.dmg'
      && item(passed.body, 'release-package')?.evidence?.url === ''
      && item(passed.body, 'release-package')?.evidence?.sizeBytes > 0
      && passed.body.report.workspace?.path === WORKSPACE
      && passed.body.report.workspace.readable === true,
    JSON.stringify({ item: item(passed.body, 'release-package'), workspace: passed.body?.report?.workspace }))
  check('the folder item of that gate still reports its Feishu evidence',
    item(passed.body, 'release-doc')?.source === 'folder'
      && item(passed.body, 'release-doc')?.evidence?.name === '上线实施方案.docx',
    JSON.stringify(item(passed.body, 'release-doc')))
}

{
  // The workspace rules: an EMPTY file is not a built package, and only the
  // project's own tree counts (pruned directories are not searched).
  const empty = await scenario({
    tree: { [ROOT]: folder([entry('上线实施方案.docx')]) },
    records: recordedWorkspace(),
    workspace: [{ path: 'dist/setup.exe', contents: '' }],
  })
  const zero = await call(empty, { url: workspaceUrl(5) })
  check('a 0-byte file does not satisfy the installer item: nothing was built',
    item(zero.body, 'release-package')?.met === false && zero.body.report.status === 'blocked',
    JSON.stringify(item(zero.body, 'release-package')))

  const pruned = await scenario({
    tree: { [ROOT]: folder([entry('上线实施方案.docx')]) },
    records: recordedWorkspace(),
    workspace: [
      { path: 'node_modules/pkg/setup.exe', contents: 'a dependency, not our build' },
      { path: '.git/objects/abc', contents: 'vcs metadata' },
    ],
  })
  const ignored = await call(pruned, { url: workspaceUrl(5) })
  check('an installer inside a pruned directory (node_modules, .git) does not count',
    item(ignored.body, 'release-package')?.met === false,
    JSON.stringify(item(ignored.body, 'release-package')))

  const names = await scenario({
    tree: { [ROOT]: folder([entry('上线实施方案.docx')]) },
    records: recordedWorkspace(),
    workspace: [{ path: 'release/订单中心-安装包-v1.2.0', contents: 'x' }],
  })
  const byName = await call(names, { url: workspaceUrl(5) })
  check('a package with no useful extension is matched by NAME (安装包 / installer / setup)',
    item(byName.body, 'release-package')?.met === true
      && item(byName.body, 'release-package')?.evidence?.path === '/release/订单中心-安装包-v1.2.0',
    JSON.stringify(item(byName.body, 'release-package')))
}

{
  // A workspace this host cannot enter is a STATE, not a missing file: the report
  // says the read failed instead of claiming the installer is absent.
  const routes = await scenario({
    tree: { [ROOT]: folder([entry('上线实施方案.docx')]) },
    records: recorded(ROOT, `${WORKSPACE}/gone`),
    workspace: [],
  })
  const unreadable = await call(routes, { url: url(`${WORKSPACE}/gone`, 5) })
  check('an unreadable workspace is reported as such, and the item is unmet',
    unreadable.body?.report?.workspace?.readable === false
      && unreadable.body.report.workspace.path === `${WORKSPACE}/gone`
      && item(unreadable.body, 'release-package')?.met === false
      && unreadable.body.report.status === 'blocked',
    JSON.stringify(unreadable.body?.report?.workspace))
}

{
  // The workspace half is reported even when the FOLDER half cannot be resolved:
  // they are different reads, and one failing must not hide the other.
  const routes = await scenario({
    tree: { [PARENT]: folder([]) },
    records: recordedWorkspace(''),
    workspace: [{ path: 'dist/app-1.0.0.zip', contents: 'bytes' }],
  })
  const mixed = await call(routes, { url: workspaceUrl(5) })
  check('a gate with no folder still reports the workspace half it could read',
    mixed.body?.report?.reason === 'no-folder'
      && mixed.body.report.items.length === 1
      && mixed.body.report.items[0].source === 'workspace'
      && mixed.body.report.items[0].met === true
      && mixed.body.report.status === 'blocked',
    JSON.stringify(mixed.body?.report))
}

await rm(`${STUB_DIR}/argv.log`, { force: true })
const failures = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.name}${result.detail === '' ? '' : `\n      ${result.detail}`}`)
}
console.log(`\n${results.length - failures.length} checks passed${failures.length === 0 ? '' : `, ${failures.length} FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
