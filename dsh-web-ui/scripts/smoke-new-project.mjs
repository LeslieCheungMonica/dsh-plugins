/**
 * End-to-end smoke test of the New Project flow, with the host mocked at the
 * wire so nothing is persisted and no OS dialog opens.
 *
 * It exercises the path a browse-only host takes (the native chooser answers a
 * transport failure), then drives the in-app browser and asserts the whole
 * chain: picked folder → `workspace.create {path}` → `session.create
 * {workspaceId}`. That is the feature this plugin exists for — "when adding a
 * project you choose the workspace folder" — verified without touching the
 * operator's real workspace registry.
 *
 * Usage: node scripts/smoke-new-project.mjs   (see scripts/smoke.mjs for env vars)
 */
const URL = process.env['DSH_URL'] ?? 'http://127.0.0.1:3080/'
const EXECUTABLE = process.env['CHROME']

const playwright = await import('playwright').catch(() => {
  console.error('smoke-new-project: playwright is not resolvable from this package — see README, "Verifying".')
  process.exit(2)
})

/** Synthetic host state for the mocked wire. */
const HOME = '/Users/smoke'
const ALPHA = `${HOME}/dsh-demo-alpha`
const BETA = `${HOME}/dsh-demo-beta`
const NEW_WORKSPACE_ID = 'workspace-smoke-0001'
const NEW_SESSION_ID = 'session-smoke-0001'
/** The project name the operator types — deliberately NOT the folder's name. */
const SMOKE_PROJECT_NAME = '陕西代码模型'

const calls = []
const listing = (path, entries) => ({
  path,
  home: HOME,
  crumbs: path === HOME ? [{ name: 'smoke', path: HOME, hidden: false }] : [
    { name: 'smoke', path: HOME, hidden: false },
    { name: path.split('/').pop(), path, hidden: false },
  ],
  entries,
  truncated: false,
})

const browser = await playwright.chromium.launch(EXECUTABLE === undefined ? {} : { executablePath: EXECUTABLE })
const page = await browser.newPage({ viewport: { width: 1440, height: 920 } })
const problems = []
page.on('pageerror', error => { problems.push(`pageerror: ${error.message}`) })

/** Answer one unary RPC in the host's own envelope. */
const answer = (route, request, value, ok = true) => {
  const body = JSON.parse(request.postData() ?? '{}')
  calls.push({ method: body.method, payload: body.payload })
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      type: 'server-response',
      rpcId: body.rpcId,
      result: ok ? { ok: true, value } : { ok: false, error: value },
    }),
  })
}

// The native chooser is unavailable on this host: a transport failure is what
// the flow sees for a browse-only capability.
await page.route('**/api/host.pickDirectory', route => route.fulfill({ status: 500, body: 'no native chooser' }))
await page.route('**/api/host.listDirectory', route => {
  const requested = JSON.parse(route.request().postData() ?? '{}').payload?.path
  const path = requested ?? HOME
  return answer(route, route.request(), listing(path, path === HOME
    ? [
      { name: 'dsh-demo-alpha', path: ALPHA, hidden: false },
      { name: 'dsh-demo-beta', path: BETA, hidden: false },
    ]
    : [{ name: 'nested', path: `${path}/nested`, hidden: false }]))
})
await page.route('**/api/workspace.create', route => answer(route, route.request(), {
  workspace: {
    workspaceId: NEW_WORKSPACE_ID,
    path: JSON.parse(route.request().postData() ?? '{}').payload.path,
    title: 'dsh-demo-alpha',
    sessionIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  created: true,
}))
await page.route('**/api/session.create', route => answer(route, route.request(), { sessionId: NEW_SESSION_ID }))
await page.route('**/api/host.createDirectory', route => answer(route, route.request(), { path: `${HOME}/new-folder` }))
// The form's name field reaches `workspace.rename` only when the operator typed
// something the folder's own last segment does not already imply.
await page.route('**/api/workspace.rename', route => {
  const payload = JSON.parse(route.request().postData() ?? '{}').payload
  return answer(route, route.request(), {
    workspace: {
      workspaceId: payload.workspaceId,
      path: HOME,
      title: payload.title,
      sessionIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  })
})

// The project's own record and the card catalogue: the form now reads the cards
// and the submission writes the record, so both are answered here (and counted,
// because "did the create record the project" is part of the flow's contract).
const recordCalls = []
let cardsAnswer = { ok: true, cards: [{ id: 'card-acf', name: 'ACF', detail: '资产汇聚' }] }
await page.route('**/dsh-web-ui/lark/cards', route => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(cardsAnswer),
}))
await page.route('**/dsh-web-ui/lark/project**', async (route) => {
  const body = route.request().postData() === null ? null : JSON.parse(route.request().postData())
  recordCalls.push({ method: route.request().method(), url: route.request().url(), body })
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, project: recordCalls.at(-1).body === null ? null : recordCalls.at(-1).body }),
  })
})

// The Feishu folder side effect of a new project. Answered as the HOST answers
// it — HTTP 200 with an `ok: false` envelope — because a Feishu failure is
// content the column renders, not a transport failure. This script flips the
// envelope mid-test to prove BOTH the success strip and the failure strip.
//
// The path is matched with a trailing `**` and split by METHOD, because the
// panel's own "which folder is this project's" read is a GET on the same path:
// without the split, a create answer would be served to a resolve read and the
// panel would sit in its "no folder yet" state for the whole run.
const folderCalls = []
let folderAnswer = { ok: true, name: 'smoke', folderToken: 'fldsmoke0001', url: 'https://example.feishu.cn/drive/folder/fldsmoke0001' }
await page.route('**/dsh-web-ui/lark/folder**', async (route) => {
  if (route.request().method() === 'GET') {
    // A project with no folder yet, which is the state this smoke test drives:
    // the panel offers the create action and reads no listing.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, source: 'missing', name: 'smoke', folder: null, candidates: [] }),
    })
    return
  }
  const body = JSON.parse(route.request().postData() ?? '{}')
  folderCalls.push({ method: route.request().method(), path: body.path, name: body.name })
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(folderAnswer),
  })
})

await page.goto(URL, { waitUntil: 'load' })
await page.waitForSelector('[data-wui="column"]', { timeout: 30_000 })
await page.waitForTimeout(2500)

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }) }

/**
 * Walk the form's folder field to completion: open the chooser (which falls back
 * to the in-app browser on this host), then confirm the level it is showing —
 * which hands the path back to the form rather than creating anything.
 * @returns whether the browser's confirm action was found and clicked.
 */
const chooseFolderInBrowser = async () => {
  const chooser = await page.$$('.dsh-web-ui-new-project button')
  for (const node of chooser) {
    const text = (await node.textContent())?.trim() ?? ''
    if (/选择本地目录|Choose a local folder/.test(text)) { await node.click(); break }
  }
  await page.waitForSelector('[data-wui="browseCrumbs"]', { timeout: 10_000 }).catch(() => null)
  const confirm = await page.$$('[role="dialog"] button')
  for (const node of confirm) {
    const text = (await node.textContent())?.trim() ?? ''
    if (/Use this folder|选择此文件夹/.test(text)) { await node.click(); return true }
  }
  return false
}

// 1. The "+" action opens the New Project FORM. With no native chooser on this
//    host, its folder field falls back to the in-app browser.
await page.click('[data-wui-accent="true"]')
await page.waitForSelector('.dsh-web-ui-new-project', { timeout: 10_000 }).catch(() => null)
const formOpened = await page.$('.dsh-web-ui-new-project') !== null
check('New Project opens the form', formOpened)
check('the form opens without reading any directory',
  !calls.some(call => call.method === 'host.listDirectory'),
  JSON.stringify(calls.map(c => c.method)))

const formCopy = await page.evaluate(() => document.querySelector('.dsh-web-ui-new-project')?.textContent ?? '')
check('the form asks for a name, a folder, and a product background',
  formCopy.includes('项目名称') && formCopy.includes('工作空间目录') && formCopy.includes('产品背景'),
  formCopy.slice(0, 120))
check('the background answers are the three expected ones',
  formCopy.includes('新项目') && formCopy.includes('已有产品') && formCopy.includes('不确定'))
check('the product-card row is absent for a brand-new project',
  !formCopy.includes('产品卡'), formCopy.slice(0, 200))

// The conditional row: it appears for "已有产品" and only for it.
const pickBackground = async label => {
  const options = await page.$$('[data-wui="formRadio"]')
  for (const option of options) {
    const text = (await option.textContent())?.trim() ?? ''
    if (text === label) { await option.click(); return true }
  }
  return false
}
check('the "existing product" answer can be picked', await pickBackground('已有产品'))
await page.waitForTimeout(300)
const withCards = await page.evaluate(() => ({
  text: document.querySelector('.dsh-web-ui-new-project')?.textContent ?? '',
  row: document.querySelector('[data-wui="formCardNote"]')?.textContent ?? null,
}))
check('choosing "existing product" reveals the product-card row',
  withCards.text.includes('产品卡') && withCards.row === null, JSON.stringify(withCards.row))
check('the card row offers the catalogue the HOST served',
  await page.evaluate(() => [...document.querySelectorAll('[data-wui="formSelect"] option')]
    .some(option => (option.textContent ?? '').includes('ACF'))),
  await page.evaluate(() => [...document.querySelectorAll('[data-wui="formSelect"] option')]
    .map(option => option.textContent).join(' | ')))
await pickBackground('不确定')
await page.waitForTimeout(300)
const withoutCards = await page.evaluate(() => document.querySelector('.deepseek-new-project')?.textContent
  ?? document.querySelector('.dsh-web-ui-new-project')?.textContent ?? '')
check('answering "not sure" hides the product-card row again', !withoutCards.includes('产品卡'))

// 2. The folder field: no native chooser, so the in-app browser stands in.
const choose = await page.$$('.dsh-web-ui-new-project button')
let chose = null
for (const node of choose) {
  const text = (await node.textContent())?.trim() ?? ''
  if (/选择本地目录|Choose a local folder/.test(text)) { await node.click(); chose = text; break }
}
check('the form offers a folder chooser', chose !== null, String(chose))
await page.waitForSelector('[data-wui="browseCrumbs"]', { timeout: 10_000 }).catch(() => null)
const browserOpen = await page.$('[data-wui="browseCrumbs"]') !== null
check('a host without a native chooser falls back to the in-app browser', browserOpen)
check('the form is not up at the same time as the browser',
  await page.$('.dsh-web-ui-new-project') === null)
check('browser read the host home level', calls.some(call => call.method === 'host.listDirectory'), JSON.stringify(calls.map(c => c.method)))

const rows = await page.$$('[data-wui="browseRow"]')
check('browser listed the folders', rows.length === 2, `rows=${String(rows.length)}`)

// 3. Descend into a folder (one more listing round).
if (rows.length > 0) {
  await rows[0].click()
  await page.waitForTimeout(600)
  const descended = calls.filter(call => call.method === 'host.listDirectory').map(call => call.payload.path)
  check('descending lists the chosen level', descended.includes(ALPHA), JSON.stringify(descended))
  // Back up to the home level for the adoption step.
  const up = await page.$('[data-wui="browseCrumbs"] button')
  if (up !== null) { await up.click(); await page.waitForTimeout(600) }
}

// 4. Adopt the folder — which returns to the FORM with the folder filled in,
//    not straight to a created project: the name and background are still owed.
const adopt = await page.$$('[data-wui="browseList"] ~ * button, [role="dialog"] button')
let adopted = null
for (const node of adopt) {
  const text = (await node.textContent())?.trim() ?? ''
  if (/Use this folder|选择此文件夹/.test(text)) { await node.click(); adopted = text; break }
}
check('the browser offers its confirm action', adopted !== null)
await page.waitForSelector('.dsh-web-ui-new-project', { timeout: 10_000 }).catch(() => null)
check('confirming a folder comes back to the form', await page.$('.dsh-web-ui-new-project') !== null)
check('no project is created before the form is submitted',
  !calls.some(call => call.method === 'workspace.create'),
  JSON.stringify(calls.map(c => c.method)))

const filled = await page.evaluate(() => ({
  path: document.querySelector('[data-wui="formPath"]')?.textContent ?? '',
  name: document.querySelector('.dsh-web-ui-new-project input')?.value ?? '',
}))
check('the chosen folder lands in the form', filled.path === HOME, `path=${filled.path}`)
check('an untouched name field takes the folder\'s last segment',
  filled.name === 'smoke', `name=${filled.name}`)

// 5. Name the project something the DIR stays out of: the Feishu folder takes
//    the project's name, so it must not follow the directory here.
const nameField = page.locator('.dsh-web-ui-new-project input[type="text"]').first()
await nameField.fill(SMOKE_PROJECT_NAME)
await page.waitForTimeout(200)
const typedName = await nameField.inputValue()
check('the form accepts a project name of its own', typedName === SMOKE_PROJECT_NAME, `name=${typedName}`)

// 6. Submit the form — the project is registered only now.
const submit = await page.$$('.dsh-web-ui-new-project button')
for (const node of submit) {
  const text = (await node.textContent())?.trim() ?? ''
  if (/创建项目|Create project/.test(text)) { await node.click(); break }
}
await page.waitForTimeout(1500)
const formGone = await page.$('.dsh-web-ui-new-project') === null
check('submitting the form closes it', formGone)

const create = calls.find(call => call.method === 'workspace.create')
check('picked folder is registered as a workspace', create?.payload.path === HOME, `path=${String(create?.payload.path)}`)
const session = calls.find(call => call.method === 'session.create')
check('a session starts in the new project', session?.payload.workspaceId === NEW_WORKSPACE_ID, `workspaceId=${String(session?.payload.workspaceId)}`)
check('the submission recorded the project\'s own answers',
  recordCalls.some(call => call.method === 'POST' && call.body?.name === SMOKE_PROJECT_NAME
    && call.body?.path === HOME && call.body?.background === 'new'),
  JSON.stringify(recordCalls.filter(call => call.method === 'POST')))
check('a typed project name is applied as the workspace title',
  calls.some(call => call.method === 'workspace.rename' && call.payload.title === SMOKE_PROJECT_NAME),
  JSON.stringify(calls.filter(c => c.method.startsWith('workspace.')).map(c => [c.method, c.payload.title])))

// The column follows the new project: its session list re-scopes, and it holds
// only that project's sessions. The scope travels in `data-project` and not in a
// header row — the list has none, and the project's name is the dropdown directly
// above it — so that attribute is what this reads.
const scoped = await page.evaluate(() => {
  const list = document.querySelector('[data-wui="sessionList"]')
  return {
    project: list?.getAttribute('data-project') ?? null,
    count: document.querySelector('[data-wui="sessionCount"]')?.textContent ?? null,
    titleGone: document.querySelector('[data-wui="sessionHeaderTitle"]') === null,
    rows: [...document.querySelectorAll('[data-wui="sessionRow"]')].map(r => r.getAttribute('data-session')),
  }
})
check('the session list re-scopes to the new project', scoped.project === NEW_WORKSPACE_ID,
  `data-project=${String(scoped.project)}`)
check('no session from another project stays listed',
  scoped.rows.every(id => id === NEW_SESSION_ID), `rows=${JSON.stringify(scoped.rows)}`)

// 4. The Feishu folder side effect: it asks the host for the adopted project's
//    folder — named the way the FORM named the project — it does NOT hold the
//    project open first, and it reports itself.
const folderCall = folderCalls.find(call => call.method === 'POST')
check('the adopted project asks the host for its Feishu folder',
  folderCall?.path === HOME,
  JSON.stringify(folderCalls))
check('the folder request carries the project name from the form',
  folderCall?.name === SMOKE_PROJECT_NAME,
  `name=${String(folderCall?.name)}`)
//    The success is announced through the shell's SYSTEM banner — a top-center
//    element portalled to `document.body` (role="alert", outside the sidebar) —
//    and NOT through a row of the column, which must stay untouched.
const announced = await page.evaluate(() => {
  const banners = [...document.querySelectorAll('[role="alert"]')]
  const column = document.querySelector('[data-wui="column"]')
  return {
    texts: banners.map(node => node.textContent ?? ''),
    insideColumn: banners.some(node => column?.contains(node) === true),
    strip: document.querySelector('[data-wui="folderNotice"]')?.textContent ?? null,
  }
})
check('a created folder is announced by the system banner',
  announced.texts.some(text => text.includes('已在飞书目录中创建项目目录'))
  && announced.texts.some(text => text.includes(SMOKE_PROJECT_NAME)),
  JSON.stringify(announced.texts))
check('the banner is not a row of the sidebar',
  announced.insideColumn === false && announced.strip === null,
  JSON.stringify({ insideColumn: announced.insideColumn, strip: announced.strip }))

// 7. A Feishu failure must not touch the project: the same flow, with the host
//    answering a scope failure, still creates the project and reports the fix.
//    (Under the create-only rule a scope failure is unusual — the create needs
//    `space:folder:create`, not the listing scope — but the failure path is the
//    same one a refused or unreachable Feishu takes.)
folderAnswer = { ok: false, error: { code: 'scope-missing', message: 'unauthorized: user authorization does not cover the required scope(s): space:document:retrieve' } }
await page.click('[data-wui-accent="true"]')
await page.waitForSelector('.dsh-web-ui-new-project', { timeout: 10_000 }).catch(() => null)
await chooseFolderInBrowser()
await page.waitForSelector('.dsh-web-ui-new-project', { timeout: 10_000 }).catch(() => null)
const retryName = page.locator('.dsh-web-ui-new-project input[type="text"]').first()
if (await retryName.count() > 0) await retryName.fill(SMOKE_PROJECT_NAME)
const retryButtons = await page.$$('.dsh-web-ui-new-project button')
for (const node of retryButtons) {
  const text = (await node.textContent())?.trim() ?? ''
  if (/创建项目|Create project/.test(text)) { await node.click(); break }
}
await page.waitForTimeout(1500)
const warned = await page.evaluate(() => {
  const strip = document.querySelector('[data-wui="folderNotice"]')
  return { tone: strip?.getAttribute('data-tone') ?? null, text: strip?.textContent ?? null }
})
check('a Feishu scope failure is reported with the re-login hint',
  warned.tone === 'warn' && (warned.text ?? '').includes('space:document:retrieve'), JSON.stringify(warned))
check('the project is still created when the Feishu folder fails',
  calls.filter(call => call.method === 'workspace.create').length === 2,
  `creates=${String(calls.filter(call => call.method === 'workspace.create').length)}`)
check('every folder request carried the project name',
  folderCalls.length > 0 && folderCalls.every(call => call.name === SMOKE_PROJECT_NAME),
  JSON.stringify(folderCalls))

await browser.close()

let failed = 0
for (const entry of results) {
  if (!entry.ok) failed += 1
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name}${entry.detail === '' ? '' : `  (${entry.detail})`}`)
}
for (const problem of problems.slice(0, 10)) console.log(`note  ${problem}`)
console.log(failed === 0 ? `\n${String(results.length)} checks passed` : `\n${String(failed)} of ${String(results.length)} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
