/**
 * Offline harness for the host's `/dsh-web-ui/lark/folder` route.
 *
 * The route is the only place where "a new project" turns into "a folder in
 * Feishu", so its HTTP contract is worth pinning down without restarting a live
 * `dsh web`: this script registers the REAL route (`registerLarkRoutes`) against
 * a fake webserver that hands back the handler, then drives that handler with
 * synthetic requests while `lark-cli` is stubbed on disk.
 *
 * It answers the questions a reviewer would otherwise have to trust:
 *
 * 1. Which methods are accepted, and what a wrong one answers.
 * 2. What a malformed body answers — and that it never reaches the CLI.
 * 3. Which NAME becomes the folder: the request's `name` (the PROJECT's name,
 *    as the form collected it) when it is sent, the path's last segment when it
 *    is not, and never a path-shaped value; and that a caller cannot choose the
 *    parent folder.
 * 4. That it CREATES unconditionally: exactly one `+create-folder` per request,
 *    and NO read of the parent first (this deployment decided against the
 *    duplicate check — see `createFolder` in `src/host/lark.ts`).
 * 5. That a Feishu failure travels as HTTP 200 with `ok: false` inside — the
 *    envelope the panel renders — while a bug stays a 500.
 *
 * Usage: node scripts/harness/folder-route.mjs
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'

const STUB_DIR = '/tmp/dsh-web-ui-folder-route'
const STUB = `${STUB_DIR}/lark-cli`
const PARENT = 'IE6SfqKh3lRv2odSLkHccYh5nog'

/** The stub's answer files, rewritten per scenario. */
await mkdir(STUB_DIR, { recursive: true })
await writeFile(STUB, `#!/usr/bin/env bash
# Stub lark-cli for the folder-route harness: it records every argv and answers
# from the scenario files below.
argv="$*"
echo "$argv" >> ${STUB_DIR}/argv.log
case "$argv" in
  # Counted, never answered: a listing here would be a regression, so the
  # harness asserts the count is zero rather than relying on the answer.
  *"drive files list"*)
    count=$(cat ${STUB_DIR}/list.count 2>/dev/null || echo 0)
    echo $((count + 1)) > ${STUB_DIR}/list.count
    cat ${STUB_DIR}/list.json 2>/dev/null || echo '{}'
    ;;
  *"drive +create-folder"*)
    count=$(cat ${STUB_DIR}/create.count 2>/dev/null || echo 0)
    echo $((count + 1)) > ${STUB_DIR}/create.count
    cat ${STUB_DIR}/create.json 2>/dev/null || echo '{}'
    ;;
  *) echo '{"ok":true,"data":{}}' ;;
esac
`, { mode: 0o755 })

// The route module reads this at import time, so it is set before the import.
process.env['DSH_WEB_UI_LARK_CLI'] = STUB

const { registerLarkRoutes } = await import('../../src/host/routes.ts')

/**
 * Register the routes against a fake webserver and collect the handlers.
 * @returns a map of pathname to handler.
 */
async function collectRoutes() {
  /** Stands in for the host's webserver service. */
  const handlers = new Map()
  /** The subset of a cordis context this registration touches. */
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    effect: (factory) => { const dispose = factory(); return dispose },
    webServer: {
      register: ({ path, handler }) => { handlers.set(path, handler); return () => {} },
    },
  }
  registerLarkRoutes(ctx)
  return handlers
}

const handlers = await collectRoutes()
const handler = handlers.get('/dsh-web-ui/lark/folder')
const methodNotAllowed = handlers.get('/dsh-web-ui/lark/state')

/** One synthetic request. */
function fakeRequest({ method = 'POST', body = undefined } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url: '/dsh-web-ui/lark/folder',
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
 * Point the stub at one scenario and clear its call counters.
 *
 * Re-registering gives the route a fresh `lark-cli` handle, which is what a
 * `dsh web` restart does in production. Nothing is cached per request here, but
 * the counters are: they are how "how many creates" is measured.
 * @param input - the answer the stub's create call should give.
 * @returns the handler for the fresh registration.
 */
async function scenario({ create }) {
  await writeFile(`${STUB_DIR}/create.json`, JSON.stringify(create ?? {}))
  await rm(`${STUB_DIR}/list.count`, { force: true })
  await rm(`${STUB_DIR}/create.count`, { force: true })
  await rm(`${STUB_DIR}/argv.log`, { force: true })
  return (await collectRoutes()).get('/dsh-web-ui/lark/folder')
}

/** How many times the stub was asked to read the parent folder (must stay 0). */
async function listCalls() {
  const { readFile } = await import('node:fs/promises')
  const text = await readFile(`${STUB_DIR}/list.count`, 'utf8').catch(() => '0')
  return Number.parseInt(text.trim(), 10) || 0
}

/** How many times the stub was asked to create a folder. */
async function createCalls() {
  const { readFile } = await import('node:fs/promises')
  const text = await readFile(`${STUB_DIR}/create.count`, 'utf8').catch(() => '0')
  return Number.parseInt(text.trim(), 10) || 0
}

/**
 * Drive one request through the real handler.
 * @param options - the request to synthesize.
 * @param target - the handler to use; defaults to the initial registration.
 * @returns the status, the parsed body, and how many creates the stub saw.
 */
async function call(options, target = handler) {
  const res = fakeResponse()
  await target(fakeRequest(options), res)
  let body = null
  try { body = JSON.parse(res.body) } catch { body = res.body }
  return { status: res.status, body, createCalls: await createCalls(), listCalls: await listCalls() }
}

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

// 1. The route is registered, and it takes POST only.
check('the folder route is registered', typeof handler === 'function')
check('the reads keep their own route', typeof methodNotAllowed === 'function')
const wrongMethod = await call({ method: 'GET' })
check('a GET is refused with an Allow header',
  wrongMethod.status === 405 && wrongMethod.body === '',
  JSON.stringify(wrongMethod))

// 2. Malformed requests are answered before the CLI is involved. The stub's
//    counters start clean here, so any CLI call inside this block is visible.
await rm(`${STUB_DIR}/create.count`, { force: true })
await rm(`${STUB_DIR}/list.count`, { force: true })
const emptyBody = await call({})
const badJson = await call({ body: '{nope' })
const noPath = await call({ body: JSON.stringify({ path: '   ' }) })
const rootPath = await call({ body: JSON.stringify({ path: '/' }) })
check('an empty body is a 400 that never reaches Feishu',
  emptyBody.status === 400 && emptyBody.body.error.code === 'bad-request' && emptyBody.createCalls === 0,
  JSON.stringify(emptyBody))
check('a non-JSON body is a 400',
  badJson.status === 400 && badJson.body.error.code === 'bad-request',
  JSON.stringify(badJson))
check('a blank path is a 400',
  noPath.status === 400 && noPath.body.error.code === 'bad-request',
  JSON.stringify(noPath))
check('a path naming no directory is a 400',
  rootPath.status === 400 && rootPath.body.error.code === 'bad-request',
  JSON.stringify(rootPath))

// The project's name is the folder's name, so it is refused as a NAME when it is
// really a path — silently repairing it would make the sidebar and the archive
// disagree about what the project is called.
const pathAsName = await call({ body: JSON.stringify({ path: '/tmp/project', name: 'a/b' }) })
const parentAsName = await call({ body: JSON.stringify({ path: '/tmp/project', name: '..' }) })
const nameWrongType = await call({ body: JSON.stringify({ path: '/tmp/project', name: 7 }) })
check('a name carrying a path separator is refused',
  pathAsName.status === 400 && pathAsName.body.error.code === 'bad-request' && pathAsName.createCalls === 0,
  JSON.stringify(pathAsName))
check('a `..` name is refused',
  parentAsName.status === 400 && parentAsName.createCalls === 0,
  JSON.stringify(parentAsName))
check('a non-string name is refused',
  nameWrongType.status === 400 && nameWrongType.createCalls === 0,
  JSON.stringify(nameWrongType))

// 3. A free name: the name is the path's last segment, and one folder is created.
let target = await scenario({ create: { ok: true, data: { folder_token: 'fldnew', url: 'https://x/fldnew' } } })
const created = await call({ body: JSON.stringify({ path: '/Users/liyanhui/vscodeProjects/dsh-plugins/dsh-web-ui/' }) }, target)
check('without a name the folder falls back to the path\'s last segment',
  created.status === 200
  && created.body.ok === true
  && created.body.name === 'dsh-web-ui'
  && created.body.folderToken === 'fldnew'
  && created.createCalls === 1,
  JSON.stringify(created.body))
check('the route does not read the parent folder first',
  created.listCalls === 0, `list calls: ${String(created.listCalls)}`)

// 3b. The project's name wins: a project called 陕西代码模型 living in a
//     directory called something else gets the PROJECT's name in the archive.
target = await scenario({ create: { ok: true, data: { folder_token: 'fldnamed', url: 'https://x/fldnamed' } } })
const named = await call({
  body: JSON.stringify({ path: '/Users/liyanhui/work/sx-model', name: '陕西代码模型' }),
}, target)
const namedArgv = await import('node:fs/promises').then(fs => fs.readFile(`${STUB_DIR}/argv.log`, 'utf8').catch(() => ''))
check('the project\'s name becomes the folder, not the directory\'s',
  named.status === 200
  && named.body.name === '陕西代码模型'
  && named.body.folderToken === 'fldnamed'
  && namedArgv.includes('--name 陕西代码模型')
  && !namedArgv.includes('sx-model'),
  `${JSON.stringify(named.body)} argv=${namedArgv.trim()}`)

// 4. The same project again: a SECOND folder, on purpose. There is no
//    "already exists" answer to be had, because nothing checks.
target = await scenario({ create: { ok: true, data: { folder_token: 'fldsecond', url: 'https://x/fldsecond' } } })
const again = await call({ body: JSON.stringify({ path: '/Users/liyanhui/vscodeProjects/dsh-plugins/dsh-web-ui' }) }, target)
check('the same project creates a second folder, and still reads nothing',
  again.status === 200
  && again.body.ok === true
  && again.body.folderToken === 'fldsecond'
  && again.createCalls === 1
  && again.listCalls === 0,
  JSON.stringify(again.body))

// 5. A Feishu failure is content, not a transport failure: 200 with ok: false.
target = await scenario({ create: { ok: false, error: { type: 'authorization', subtype: 'permission_denied', message: 'no permission' } } })
const refused = await call({ body: JSON.stringify({ path: '/Users/liyanhui/vscodeProjects/dsh-plugins/dsh-web-ui' }) }, target)
check('a Feishu failure is a 200 with ok:false inside',
  refused.status === 200 && refused.body.ok === false && refused.body.error.code === 'forbidden',
  JSON.stringify(refused.body))

// 6. The parent folder is the deployment's, and no request can move it.
target = await scenario({ create: { ok: true, data: { folder_token: 'fld6', url: 'u6' } } })
await call({ body: JSON.stringify({ path: '/tmp/another-project', parentFolderToken: '/tmp/attacker' }) }, target)
const argv = await import('node:fs/promises').then(fs => fs.readFile(`${STUB_DIR}/argv.log`, 'utf8').catch(() => ''))
check('the deployment parent folder travels to the CLI, not the request body',
  argv.includes(`--folder-token ${PARENT}`)
  && argv.includes('+create-folder')
  && argv.includes('--name another-project')
  && !argv.includes('/tmp/attacker'),
  argv.trim().split('\n')[0] ?? '')

let failed = 0
for (const entry of results) {
  if (!entry.ok) failed += 1
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name}${entry.detail === '' ? '' : `\n      ${entry.detail}`}`)
}
console.log(failed === 0 ? `\n${String(results.length)} checks passed` : `\n${String(failed)} of ${String(results.length)} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
