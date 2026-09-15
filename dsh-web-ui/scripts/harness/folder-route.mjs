/**
 * Offline harness for the host's Feishu folder routes.
 *
 * These routes are where "this project" turns into "this folder in Feishu", in
 * both directions: `/folder` creates and RECORDS the folder a new project owns,
 * and its GET resolves which folder that is — from the record, or by adopting a
 * folder the archive already holds. They are worth pinning down without
 * restarting a live `dsh web`, so this script registers the REAL routes
 * (`registerLarkRoutes`) against a fake webserver that hands back the handlers,
 * then drives those handlers with synthetic requests while `lark-cli` is stubbed
 * on disk and the project record points at a temporary file.
 *
 * It answers the questions a reviewer would otherwise have to trust:
 *
 * 1. Which methods are accepted, and what a wrong one answers.
 * 2. What a malformed request answers — and that it never reaches the CLI. That
 *    covers the name (a "name" that means a path is refused, never repaired), the
 *    folder token (the one field that becomes an ARGV element), and the URL.
 * 3. Which NAME becomes the folder: the request's `name` (the PROJECT's name, as
 *    the form collected it) when it is sent, the path's last segment when it is
 *    not; and that a caller cannot choose the parent folder.
 * 4. That creating CREATES unconditionally — exactly one `+create-folder` per
 *    request, and NO read of the parent first — while the GET is the half that
 *    LOOKS, so a project created before its token was recorded still finds the
 *    folder it made instead of making a second one.
 * 5. That a create RECORDS the folder onto the project, and that a recorded
 *    folder is then answered without any listing at all.
 * 6. Every resolution outcome — `record`, `adopted`, `missing`, `ambiguous` —
 *    and that `missing`/`ambiguous` are content (HTTP 200, `ok: true`) rather
 *    than errors, because neither is a Feishu failure.
 * 7. That a Feishu failure travels as HTTP 200 with `ok: false` inside — the
 *    envelope the panel renders, including the `scope-missing` code that lets it
 *    name the scope to ask for — while a bug stays a 500.
 * 8. That the wiki routes this panel replaced are gone rather than left behind.
 *
 * Usage: node scripts/harness/folder-route.mjs
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'

const STUB_DIR = '/tmp/dsh-web-ui-folder-route'
const STUB = `${STUB_DIR}/lark-cli`
const PARENT = 'IE6SfqKh3lRv2odSLkHccYh5nog'
const PROJECT = '/Users/liyanhui/vscodeProjects/prd-demo-designer'
const PROJECT_NAME = '陕西内生安全2期'

/** The stub's answer files, rewritten per scenario. */
await mkdir(STUB_DIR, { recursive: true })
await writeFile(STUB, `#!/usr/bin/env bash
# Stub lark-cli for the folder-route harness: it records every argv and answers
# from the scenario files below.
argv="$*"
echo "$argv" >> ${STUB_DIR}/argv.log
case "$argv" in
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

// The route module reads both of these at import time, so they are set before
// the import. The record file is redirected into the stub directory because
// creating a folder now RECORDS it: a harness run must never write into the
// operator's real ~/.dsh/storages/web_ui_projects.json.
process.env['DSH_WEB_UI_LARK_CLI'] = STUB
const RECORDS = `${STUB_DIR}/projects.json`
process.env['DSH_WEB_UI_PROJECTS_FILE'] = RECORDS

const { registerLarkRoutes } = await import('../../src/host/routes.ts')

/** Every path this module registers, after one registration. */
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
const methodNotAllowed = handlers.get('/dsh-web-ui/lark/state')

/** One synthetic request. */
function fakeRequest({ method = 'POST', url = '/dsh-web-ui/lark/folder', body = undefined } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
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
 * Point the stub at one scenario and clear its call counters.
 *
 * Re-registering gives the routes a fresh `lark-cli` handle, which is what a
 * `dsh web` restart does in production, and clears the adapter's caches with it.
 * The record file is rewritten too, so each scenario starts from the state it
 * describes rather than from the previous one's writes.
 * @param input - the archive listing and the create answer to serve.
 * @returns the handlers for the fresh registration.
 */
async function scenario({ list, create, records } = {}) {
  await writeFile(`${STUB_DIR}/list.json`, JSON.stringify(list ?? { ok: true, data: { files: [], has_more: false } }))
  await writeFile(`${STUB_DIR}/create.json`, JSON.stringify(create ?? {}))
  if (records === undefined) await rm(RECORDS, { force: true })
  else await writeFile(RECORDS, JSON.stringify(records))
  await rm(`${STUB_DIR}/list.count`, { force: true })
  await rm(`${STUB_DIR}/create.count`, { force: true })
  await rm(`${STUB_DIR}/argv.log`, { force: true })
  return collectRoutes()
}

/**
 * Read one of the stub's counters.
 * @param name - `list` or `create`.
 * @returns how many times that call was made.
 */
async function calls(name) {
  const text = await readFile(`${STUB_DIR}/${name}.count`, 'utf8').catch(() => '0')
  return Number.parseInt(text.trim(), 10) || 0
}

/** Everything the stubbed CLI was asked to do, one argv per line. */
async function argvLog() {
  return readFile(`${STUB_DIR}/argv.log`, 'utf8').catch(() => '')
}

/** The project-record document, as the route left it. */
async function records() {
  const text = await readFile(RECORDS, 'utf8').catch(() => '{"projects":{}}')
  return JSON.parse(text)
}

/**
 * Drive one request through one real handler.
 * @param routes - the registered handlers.
 * @param path - the exact pathname to drive.
 * @param options - the request to synthesize.
 * @returns the status, the parsed body, the stub's counters, and the argv log.
 */
async function call(routes, path, options = {}) {
  const res = fakeResponse()
  await routes.get(path)(fakeRequest(options), res)
  let body = null
  try { body = JSON.parse(res.body) } catch { body = res.body }
  return {
    status: res.status,
    body,
    createCalls: await calls('create'),
    listCalls: await calls('list'),
    argv: await argvLog(),
  }
}

/** One archive listing holding folders of the given names. */
function archive(...names) {
  return {
    ok: true,
    data: {
      files: names.map((name, index) => ({
        token: `fld${String(index)}`,
        type: 'folder',
        name,
        url: `https://feishu.cn/drive/folder/fld${String(index)}`,
      })),
      has_more: false,
    },
  }
}

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

// 1. The route set: the reads keep their own routes, and the wiki routes the
//    panel used to browse are gone rather than left registered behind it.
check('the folder route is registered', typeof handlers.get('/dsh-web-ui/lark/folder') === 'function')
check('the file listing has its own route', typeof handlers.get('/dsh-web-ui/lark/files') === 'function')
check('the attach route is registered', typeof handlers.get('/dsh-web-ui/lark/folder/attach') === 'function')
check('the identity route is registered', typeof methodNotAllowed === 'function')
check('the wiki space route is gone', handlers.get('/dsh-web-ui/lark/spaces') === undefined)
check('the wiki node route is gone', handlers.get('/dsh-web-ui/lark/nodes') === undefined)

// 2. Posting a malformed body is answered before the CLI is involved. The stub's
//    counters start clean here, so any CLI call inside this block is visible.
let routes = await scenario()
const post = (body) => call(routes, '/dsh-web-ui/lark/folder', { body })
const emptyBody = await post(undefined)
const badJson = await post('{nope')
const noPath = await post(JSON.stringify({ path: '   ' }))
const rootPath = await post(JSON.stringify({ path: '/' }))
check('an empty body is a 400 that never reaches Feishu',
  emptyBody.status === 400 && emptyBody.body.error.code === 'bad-request' && emptyBody.createCalls === 0,
  JSON.stringify(emptyBody.body))
check('a non-JSON body is a 400',
  badJson.status === 400 && badJson.body.error.code === 'bad-request',
  JSON.stringify(badJson.body))
check('a blank path is a 400',
  noPath.status === 400 && noPath.body.error.code === 'bad-request',
  JSON.stringify(noPath.body))
check('a path naming no directory is a 400',
  rootPath.status === 400 && rootPath.body.error.code === 'bad-request',
  JSON.stringify(rootPath.body))

// 3. The project's name is the folder's name, so it is refused as a NAME when it
//    is really a path — silently repairing it would make the sidebar and the
//    archive disagree about what the project is called.
const pathAsName = await post(JSON.stringify({ path: '/tmp/project', name: 'a/b' }))
const parentAsName = await post(JSON.stringify({ path: '/tmp/project', name: '..' }))
const nameWrongType = await post(JSON.stringify({ path: '/tmp/project', name: 7 }))
check('a name carrying a path separator is refused',
  pathAsName.status === 400 && pathAsName.body.error.code === 'bad-request' && pathAsName.createCalls === 0,
  JSON.stringify(pathAsName.body))
check('a `..` name is refused',
  parentAsName.status === 400 && parentAsName.createCalls === 0,
  JSON.stringify(parentAsName.body))
check('a non-string name is refused',
  nameWrongType.status === 400 && nameWrongType.createCalls === 0,
  JSON.stringify(nameWrongType.body))

// 4. Creating: the folder is made unconditionally AND recorded on the project,
//    which is what lets every later open answer without listing the archive.
routes = await scenario({ create: { ok: true, data: { folder_token: 'fldnamed', url: 'https://x/fldnamed' } } })
const created = await call(routes, '/dsh-web-ui/lark/folder', {
  body: JSON.stringify({ path: '/Users/liyanhui/work/sx-model', name: PROJECT_NAME }),
})
check('the project\'s name becomes the folder, not the directory\'s',
  created.status === 200
  && created.body.ok === true
  && created.body.name === PROJECT_NAME
  && created.body.folderToken === 'fldnamed'
  && created.createCalls === 1
  && created.argv.includes(`--name ${PROJECT_NAME}`)
  && !created.argv.includes('sx-model'),
  `${JSON.stringify(created.body)} argv=${created.argv.trim()}`)
check('creating does not read the parent folder first',
  created.listCalls === 0, `list calls: ${String(created.listCalls)}`)
const afterCreate = await records()
check('creating records the folder on the project',
  afterCreate.projects['/Users/liyanhui/work/sx-model']?.larkFolderToken === 'fldnamed'
  && afterCreate.projects['/Users/liyanhui/work/sx-model']?.larkFolderUrl === 'https://x/fldnamed',
  JSON.stringify(afterCreate.projects['/Users/liyanhui/work/sx-model']))

// A free name falls back to the path's last segment, and the parent is the
// DEPLOYMENT's: a browser-supplied parent would let a page write into any folder
// the login can reach.
routes = await scenario({ create: { ok: true, data: { folder_token: 'fldnew', url: 'https://x/fldnew' } } })
const fallback = await call(routes, '/dsh-web-ui/lark/folder', {
  body: JSON.stringify({ path: '/tmp/another-project', parentFolderToken: '/tmp/attacker' }),
})
check('without a name the folder falls back to the path\'s last segment',
  fallback.status === 200 && fallback.body.name === 'another-project' && fallback.body.folderToken === 'fldnew',
  JSON.stringify(fallback.body))
check('the deployment parent folder travels to the CLI, not the request body',
  fallback.argv.includes(`--folder-token ${PARENT}`)
  && fallback.argv.includes('+create-folder')
  && !fallback.argv.includes('/tmp/attacker'),
  fallback.argv.trim().split('\n')[0] ?? '')

// 5. Resolving. A recorded folder wins, and answering it costs NO listing: the
//    panel's common case must not depend on the archive read at all.
routes = await scenario({
  list: archive('something-else'),
  records: {
    version: 1,
    projects: {
      [PROJECT]: {
        path: PROJECT, name: PROJECT_NAME, background: 'new', productCardId: '',
        larkFolderToken: 'fldrecorded', larkFolderUrl: 'https://x/fldrecorded', updatedAt: 1,
      },
    },
  },
})
const fromRecord = await call(routes, '/dsh-web-ui/lark/folder', {
  method: 'GET',
  url: `/dsh-web-ui/lark/folder?path=${encodeURIComponent(PROJECT)}&name=${encodeURIComponent(PROJECT_NAME)}`,
})
check('a recorded folder is answered as `record` without listing the archive',
  fromRecord.status === 200
  && fromRecord.body.ok === true
  && fromRecord.body.source === 'record'
  && fromRecord.body.folder.folderToken === 'fldrecorded'
  && fromRecord.listCalls === 0,
  `${JSON.stringify(fromRecord.body)} list=${String(fromRecord.listCalls)}`)

// 5b. No record, but the archive already holds exactly one folder of this name:
//     it is ADOPTED — written to the record — rather than duplicated.
routes = await scenario({ list: archive('unrelated', PROJECT_NAME) })
const adopted = await call(routes, '/dsh-web-ui/lark/folder', {
  method: 'GET',
  url: `/dsh-web-ui/lark/folder?path=${encodeURIComponent(PROJECT)}&name=${encodeURIComponent(PROJECT_NAME)}`,
})
const afterAdopt = await records()
check('an existing same-named folder is adopted',
  adopted.status === 200
  && adopted.body.source === 'adopted'
  && adopted.body.folder.folderToken === 'fld1'
  && adopted.listCalls === 1,
  `${JSON.stringify(adopted.body)} list=${String(adopted.listCalls)}`)
check('adoption is written to the record, so it happens once',
  afterAdopt.projects[PROJECT]?.larkFolderToken === 'fld1',
  JSON.stringify(afterAdopt.projects[PROJECT]))

// 5c. Nothing of that name: a state, not a failure — the operator is offered the
//     create action, which is a decision this route must not make for them.
routes = await scenario({ list: archive('unrelated') })
const missing = await call(routes, '/dsh-web-ui/lark/folder', {
  method: 'GET',
  url: `/dsh-web-ui/lark/folder?path=${encodeURIComponent(PROJECT)}&name=${encodeURIComponent(PROJECT_NAME)}`,
})
check('no folder of that name is `missing`, as content rather than an error',
  missing.status === 200
  && missing.body.ok === true
  && missing.body.source === 'missing'
  && missing.body.folder === null
  && Array.isArray(missing.body.candidates)
  && missing.body.candidates.length === 0,
  JSON.stringify(missing.body))

// 5d. Two folders of that name: Feishu permits it, so only the operator can say
//     which one is theirs. Both are offered, and NOTHING is recorded.
routes = await scenario({ list: archive(PROJECT_NAME, 'other', PROJECT_NAME) })
const ambiguous = await call(routes, '/dsh-web-ui/lark/folder', {
  method: 'GET',
  url: `/dsh-web-ui/lark/folder?path=${encodeURIComponent(PROJECT)}&name=${encodeURIComponent(PROJECT_NAME)}`,
})
const afterAmbiguous = await records()
check('two same-named folders are `ambiguous`, and both are offered',
  ambiguous.status === 200
  && ambiguous.body.source === 'ambiguous'
  && ambiguous.body.folder === null
  && ambiguous.body.candidates.length === 2,
  JSON.stringify(ambiguous.body))
check('an ambiguous adoption records nothing',
  afterAmbiguous.projects?.[PROJECT] === undefined,
  JSON.stringify(afterAmbiguous.projects ?? {}))

// 5e. The project's name travels as a parameter, and the path is required.
const noPathParam = await call(routes, '/dsh-web-ui/lark/folder', { method: 'GET', url: '/dsh-web-ui/lark/folder' })
check('a GET without `path` is a 400',
  noPathParam.status === 400 && noPathParam.body.error.code === 'bad-request',
  JSON.stringify(noPathParam.body))
const namedFallback = await call(routes, '/dsh-web-ui/lark/folder', {
  method: 'GET',
  url: `/dsh-web-ui/lark/folder?path=${encodeURIComponent('/tmp')}`,
})
check('without a name the archive is searched for the path\'s last segment',
  namedFallback.status === 200 && namedFallback.body.name === 'tmp' && namedFallback.body.source === 'missing',
  JSON.stringify(namedFallback.body))

// 6. Attaching: the answer to "several could be it", and the way an operator
//    points a project at a folder it already has.
routes = await scenario()
const attached = await call(routes, '/dsh-web-ui/lark/folder/attach', {
  body: JSON.stringify({ path: PROJECT, folderToken: 'fldpicked', name: PROJECT_NAME }),
})
const afterAttach = await records()
check('attaching records the chosen folder',
  attached.status === 200
  && attached.body.folderToken === 'fldpicked'
  && afterAttach.projects[PROJECT]?.larkFolderToken === 'fldpicked',
  `${JSON.stringify(attached.body)} ${JSON.stringify(afterAttach.projects[PROJECT])}`)
const badToken = await call(routes, '/dsh-web-ui/lark/folder/attach', {
  body: JSON.stringify({ path: PROJECT, folderToken: 'fld; rm -rf /' }),
})
const badUrl = await call(routes, '/dsh-web-ui/lark/folder/attach', {
  body: JSON.stringify({ path: PROJECT, folderToken: 'fldok', url: 'javascript:alert(1)' }),
})
check('an argv-shaped token is refused before the CLI can see it',
  badToken.status === 400 && badToken.body.error.code === 'bad-request',
  JSON.stringify(badToken.body))
check('a non-http URL is refused',
  badUrl.status === 400 && badUrl.body.error.code === 'bad-request',
  JSON.stringify(badUrl.body))

// 7. Listing a folder: one page, `hasMore`/`pageToken` passed through, and the
//    folder token inside the command's `--params` JSON.
routes = await scenario({
  list: {
    ok: true,
    data: {
      files: [
        { token: 'doxcnA', type: 'docx', name: '方案', url: 'https://feishu.cn/docx/doxcnA' },
        { token: 'fldcnB', type: 'folder', name: '子目录' },
        { token: 'flinkC', type: 'shortcut', name: '快捷方式', shortcut_info: { target_token: 'fldcnD', target_type: 'folder' } },
        { token: 'fileE', type: 'file', name: '归档.zip' },
      ],
      has_more: true,
      next_page_token: 'page2',
    },
  },
})
const listing = await call(routes, '/dsh-web-ui/lark/files', {
  method: 'GET',
  url: '/dsh-web-ui/lark/files?folder=fldroot',
})
check('a listing answers one page with its continuation token',
  listing.status === 200
  && listing.body.ok === true
  && listing.body.nodes.length === 4
  && listing.body.hasMore === true
  && listing.body.pageToken === 'page2',
  JSON.stringify(listing.body))
check('the folder token travels inside the command\'s params JSON',
  listing.argv.includes('drive files list') && listing.argv.includes('"folder_token":"fldroot"'),
  listing.argv.trim())
const [doc, folder, shortcut, file] = listing.body.nodes
check('a document is a leaf and carries its link',
  doc.expandToken === '' && doc.url === 'https://feishu.cn/docx/doxcnA',
  JSON.stringify(doc))
check('a folder expands by its own token, and gets a link built for it',
  folder.expandToken === 'fldcnB' && folder.url === 'https://feishu.cn/drive/folder/fldcnB',
  JSON.stringify(folder))
check('a shortcut into a folder expands by its target\'s token',
  shortcut.expandToken === 'fldcnD' && shortcut.url === 'https://feishu.cn/drive/folder/fldcnD',
  JSON.stringify(shortcut))
check('an uploaded file is a leaf',
  file.expandToken === '', JSON.stringify(file))

const noFolderParam = await call(routes, '/dsh-web-ui/lark/files', { method: 'GET', url: '/dsh-web-ui/lark/files' })
const badFolderParam = await call(routes, '/dsh-web-ui/lark/files', {
  method: 'GET',
  url: '/dsh-web-ui/lark/files?folder=..%2Fetc',
})
check('a listing without `folder` is a 400',
  noFolderParam.status === 400 && noFolderParam.body.error.code === 'bad-request',
  JSON.stringify(noFolderParam.body))
check('a malformed folder token is a 400 that never reaches Feishu',
  badFolderParam.status === 400 && badFolderParam.body.error.code === 'bad-request',
  JSON.stringify(badFolderParam.body))

// 8. A Feishu refusal is content, not a transport failure: 200 with ok:false.
//    The CODE is what lets the panel name the fix, so the scope one is checked
//    specifically — browsing a project's folder needs `space:document:retrieve`,
//    which a login made for the old panel may not carry.
routes = await scenario({ create: { ok: false, error: { type: 'authorization', subtype: 'permission_denied', message: 'no permission' } } })
const refused = await call(routes, '/dsh-web-ui/lark/folder', { body: JSON.stringify({ path: PROJECT }) })
check('a Feishu failure is a 200 with ok:false inside',
  refused.status === 200 && refused.body.ok === false && refused.body.error.code === 'forbidden',
  JSON.stringify(refused.body))

routes = await scenario({
  list: {
    ok: false,
    identity: 'user',
    error: {
      type: 'authorization',
      subtype: 'missing_scope',
      message: 'unauthorized: user authorization does not cover the required scope(s): space:document:retrieve',
    },
  },
})
const scoped = await call(routes, '/dsh-web-ui/lark/files', {
  method: 'GET',
  url: '/dsh-web-ui/lark/files?folder=fldroot',
})
check('a missing scope is reported with its own code and the scope named',
  scoped.status === 200
  && scoped.body.ok === false
  && scoped.body.error.code === 'scope-missing'
  && scoped.body.error.message.includes('space:document:retrieve'),
  JSON.stringify(scoped.body))

let failed = 0
for (const entry of results) {
  if (!entry.ok) failed += 1
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name}${entry.detail === '' ? '' : `\n      ${entry.detail}`}`)
}
console.log(failed === 0 ? `\n${String(results.length)} checks passed` : `\n${String(failed)} of ${String(results.length)} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
