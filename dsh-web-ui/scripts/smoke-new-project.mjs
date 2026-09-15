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

await page.goto(URL, { waitUntil: 'load' })
await page.waitForSelector('[data-wui="column"]', { timeout: 30_000 })
await page.waitForTimeout(2500)

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }) }

// 1. The "+" action, with the native chooser failing, must open the browser.
await page.click('[data-wui-accent="true"]')
await page.waitForSelector('[role="dialog"]', { timeout: 10_000 }).catch(() => null)
const dialogTitle = await page.evaluate(() => document.querySelector('[role="dialog"] h2')?.textContent ?? null)
check('New Project opens the in-app browser when no native chooser exists', dialogTitle !== null, `title=${String(dialogTitle)}`)
check('browser read the host home level', calls.some(call => call.method === 'host.listDirectory'), JSON.stringify(calls.map(c => c.method)))

const rows = await page.$$('[data-wui="browseRow"]')
check('browser listed the folders', rows.length === 2, `rows=${String(rows.length)}`)

// 2. Descend into a folder (one more listing round).
if (rows.length > 0) {
  await rows[0].click()
  await page.waitForTimeout(600)
  const descended = calls.filter(call => call.method === 'host.listDirectory').map(call => call.payload.path)
  check('descending lists the chosen level', descended.includes(ALPHA), JSON.stringify(descended))
  // Back up to the home level for the adoption step.
  const up = await page.$('[data-wui="browseCrumbs"] button')
  if (up !== null) { await up.click(); await page.waitForTimeout(600) }
}

// 3. Adopt the folder: create the workspace, then start a session in it.
const adopt = await page.$$('[role="dialog"] button')
let adopted = null
for (const node of adopt) {
  const text = (await node.textContent())?.trim() ?? ''
  if (/Use this folder|选择此文件夹/.test(text)) { await node.click(); adopted = text; break }
}
check('adoption action exists', adopted !== null)
await page.waitForTimeout(1500)

const create = calls.find(call => call.method === 'workspace.create')
check('picked folder is registered as a workspace', create?.payload.path === HOME, `path=${String(create?.payload.path)}`)
const session = calls.find(call => call.method === 'session.create')
check('a session starts in the new project', session?.payload.workspaceId === NEW_WORKSPACE_ID, `workspaceId=${String(session?.payload.workspaceId)}`)

// The column follows the new project: its session list re-scopes, and it holds
// only that project's sessions.
const scoped = await page.evaluate(() => {
  const list = document.querySelector('[data-wui="sessionList"]')
  return {
    project: list?.getAttribute('data-project') ?? null,
    header: document.querySelector('[data-wui="sessionHeaderTitle"]')?.textContent ?? null,
    rows: [...document.querySelectorAll('[data-wui="sessionRow"]')].map(r => r.getAttribute('data-session')),
  }
})
check('the session list re-scopes to the new project', scoped.project === NEW_WORKSPACE_ID,
  `data-project=${String(scoped.project)}`)
check('no session from another project stays listed',
  scoped.rows.every(id => id === NEW_SESSION_ID), `rows=${JSON.stringify(scoped.rows)}`)

await browser.close()

let failed = 0
for (const entry of results) {
  if (!entry.ok) failed += 1
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name}${entry.detail === '' ? '' : `  (${entry.detail})`}`)
}
for (const problem of problems.slice(0, 10)) console.log(`note  ${problem}`)
console.log(failed === 0 ? `\n${String(results.length)} checks passed` : `\n${String(failed)} of ${String(results.length)} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
