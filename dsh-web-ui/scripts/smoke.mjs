/**
 * Smoke test for the plugin against a RUNNING dsh web GUI.
 *
 * It asserts the things that are cheap to get wrong: that this plugin's column
 * actually took the frame's `sidebar` slot, that the shipped seats still render
 * inside it (the whole point of the disable-and-redeclare design), that the
 * project row sits above the New Session button, that the session list is scoped
 * to the selected project, that the rail stacks instead of overflowing, and that
 * the plugin is listed in Settings → Plugins.
 *
 * Two write endpoints (`session.rename`, `workspace.archiveSession`) are answered
 * at the wire so the row actions can be exercised without touching real session
 * data; everything else talks to the live host.
 *
 * Usage:
 *   node scripts/smoke.mjs                    # http://127.0.0.1:3080
 *   DSH_URL=http://127.0.0.1:3090 node scripts/smoke.mjs
 *   CHROME=/path/to/chrome node scripts/smoke.mjs   # non-default browser
 *
 * Playwright is a dev-only dependency here: it resolves from this package's
 * node_modules (see README, "Verifying").
 */
const URL = process.env['DSH_URL'] ?? 'http://127.0.0.1:3080/'
const EXECUTABLE = process.env['CHROME']

const playwright = await import('playwright').catch(() => {
  console.error('smoke: playwright is not resolvable from this package — see README, "Verifying".')
  process.exit(2)
})

const browser = await playwright.chromium.launch(EXECUTABLE === undefined ? {} : { executablePath: EXECUTABLE })
const page = await browser.newPage({ viewport: { width: 1440, height: 920 } })
const problems = []
page.on('pageerror', error => { problems.push(`pageerror: ${error.message}`) })
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console.error: ${message.text()}`)
})

/** One recorded assertion. */
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }) }
/** Requests this test answered itself, keyed by RPC method. */
const mocked = []
const answer = (route, value) => {
  const body = JSON.parse(route.request().postData() ?? '{}')
  mocked.push({ method: body.method, payload: body.payload })
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }),
  })
}
await page.route('**/api/session.rename', route => {
  const body = JSON.parse(route.request().postData() ?? '{}')
  return answer(route, { title: body.payload.title, seq: 1 })
})
await page.route('**/api/workspace.archiveSession', route => answer(route, { archivedSessionIds: [] }))

await page.goto(URL, { waitUntil: 'load' })
const column = await page.waitForSelector('[data-wui="column"]', { timeout: 30_000 }).catch(() => null)
check('column took the sidebar slot', column !== null)
await page.waitForTimeout(2500)

const state = await page.evaluate(() => {
  const q = selector => document.querySelector(selector)
  const seat = key => q(`[data-slot="${key}"]`)?.childElementCount ?? -1
  const rect = (selector) => {
    const el = q(selector)
    if (el === null) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const list = q('[data-wui="sessionList"]')
  return {
    projectRow: rect('[data-wui="projectRow"]'),
    stageTag: rect('[data-wui="stageTag"]'),
    newSession: rect('[data-wui="newSession"]'),
    newProject: q('[data-wui-accent="true"]') !== null,
    trigger: q('[data-wui="projectTrigger"]') !== null,
    brandSeat: seat('sidebar.brand.mark'),
    regionSeat: seat('sidebar.workspaces'),
    settingsSeat: seat('sidebar.settings'),
    fallbackMode: q('[data-wui="brandRowFallback"]') !== null,
    slotErrors: document.querySelectorAll('[data-slot-error]').length,
    conversation: q('[data-conversation-scroll]') !== null,
    listProject: list?.getAttribute('data-project') ?? null,
    listCount: q('[data-wui="sessionCount"]')?.textContent ?? null,
    // The list used to name its project in a header row of its own; that row is
    // gone, so its absence is what this reports.
    listTitleGone: q('[data-wui="sessionHeaderTitle"]') === null,
    rows: [...document.querySelectorAll('[data-wui="sessionRow"]')].map(row => ({
      id: row.getAttribute('data-session'),
      project: list?.getAttribute('data-project') ?? null,
      status: row.getAttribute('data-status'),
      current: row.getAttribute('data-current') === 'true',
    })),
  }
})

check('shipped brand seat renders in this column', state.brandSeat > 0, `children=${String(state.brandSeat)}`)
check('the browsing region is this plugin\'s session list', state.listProject !== null,
  `list rows=${String(state.rows.length)}`)
check('the session list opens with its search row, not a project header',
  state.listCount !== null && state.listTitleGone,
  `count="${String(state.listCount)}" projectHeader=${state.listTitleGone ? 'absent' : 'PRESENT'}`)
check('shipped settings shell renders in this column', state.settingsSeat > 0, `children=${String(state.settingsSeat)}`)
check('project row renders above the FDE stage tag, which renders above New Session',
  state.projectRow !== null && state.stageTag !== null && state.newSession !== null
  && state.projectRow.y < state.stageTag.y && state.stageTag.y < state.newSession.y,
  `row.y=${String(state.projectRow?.y)} stage.y=${String(state.stageTag?.y)} new.y=${String(state.newSession?.y)}`)
check('New Project button renders', state.newProject)
check('project dropdown trigger renders', state.trigger)
check('no slot entry crashed', state.slotErrors === 0, `slotErrors=${String(state.slotErrors)}`)
check('conversation surface still renders', state.conversation)
check('takeover path (not the degraded brand-row fallback)', !state.fallbackMode)

// ── the session list is scoped to the selected project ──────────────────────
const readList = () => page.evaluate(() => {
  const list = document.querySelector('[data-wui="sessionList"]')
  return {
    project: list?.getAttribute('data-project') ?? null,
    // The row that carried the project's name is gone, so the header is not read
    // at all; the count rides the search row now, and the dropdown's own text is
    // the project's name this list must NOT repeat.
    count: document.querySelector('[data-wui="sessionCount"]')?.textContent ?? null,
    titleGone: document.querySelector('[data-wui="sessionHeaderTitle"]') === null,
    projectName: document.querySelector('[data-wui="projectTrigger"]')?.textContent ?? null,
    ids: [...document.querySelectorAll('[data-wui="sessionRow"]')].map(r => r.getAttribute('data-session')),
    empty: document.querySelector('[data-wui="sessionEmpty"]')?.textContent ?? null,
  }
})

const before = await readList()
const projects = await page.evaluate(async () => {
  // The dropdown lists every registered project; open it just long enough to
  // count rows, then close it again.
  return null
})
void projects

// Switch projects through the dropdown and confirm the list changes with it.
await page.click('[data-wui="projectTrigger"]')
await page.waitForTimeout(500)
const projectRows = await page.evaluate(() => [...document.querySelectorAll('[role="menu"] button')]
  .map(node => node.textContent ?? '')
  .filter(text => text.includes('/')))
let switched = false
if (projectRows.length >= 2) {
  const others = await page.$$('[role="menu"] button')
  for (const node of others) {
    const text = (await node.textContent())?.trim() ?? ''
    if (text.includes('/') && !text.startsWith(before.projectName ?? '\u0000') && !/New project|Browse/.test(text)) {
      await node.click()
      switched = true
      break
    }
  }
} else {
  await page.keyboard.press('Escape')
}
await page.waitForTimeout(1200)
const after = await readList()

if (projectRows.length >= 2) {
  check('switching project re-scopes the list',
    switched && after.project !== before.project,
    `${String(before.project)} → ${String(after.project)}`)
  const overlap = before.ids.filter(id => after.ids.includes(id))
  check('no session from the other project remains listed', overlap.length === 0,
    `overlap=${String(overlap.length)}`)
} else {
  check('switching project re-scopes the list (skipped: fewer than two projects)', true, 'only one project')
}

// The list does not name its project under the New Session button: the dropdown
// above already does, and the header row that repeated it is gone. The count that
// row used to hold now rides the search row, so the column keeps the fact and
// loses only the row.
const named = (before.projectName ?? '').trim()
check('the session list has no header row naming the project',
  before.titleGone && named !== '' && !(before.count ?? '').includes(named),
  `titleGone=${String(before.titleGone)} count="${String(before.count)}" project="${named}"`)

// The list's own search narrows within the project and says so when nothing
// matches (the same empty block a project with no sessions uses).
const searchField = await page.$('[data-wui="sessionSearch"] input')
if (searchField !== null) {
  await searchField.fill('zzz-no-such-session-probe')
  await page.waitForTimeout(500)
  const noMatch = await page.evaluate(() => document.querySelector('[data-wui="sessionEmpty"]')?.textContent ?? '')
  check('a query with no match reports it instead of listing rows',
    noMatch.trim().length > 0, `empty="${noMatch.trim()}"`)
  await searchField.fill('')
  await page.waitForTimeout(400)
} else {
  check('the session list carries a search field', false)
}

// The selection is persisted: a reload keeps the scope.
const expected = after.project
await page.reload({ waitUntil: 'load' })
await page.waitForSelector('[data-wui="sessionList"]', { timeout: 30_000 })
await page.waitForTimeout(2500)
const restored = await readList()
check('the selected project survives a reload', restored.project === expected,
  `${String(expected)} → ${String(restored.project)}`)

// ── row actions (write endpoints answered at the wire) ──────────────────────
const hasRow = restored.ids.length > 0
if (hasRow) {
  await page.hover('[data-wui="sessionRow"]')
  await page.click('[data-wui="sessionRow"] [data-wui="sessionMenuButton"]')
  await page.waitForTimeout(400)
  const menuButtons = await page.$$('[role="menu"] button')
  let openedRename = false
  for (const node of menuButtons) {
    const text = (await node.textContent())?.trim() ?? ''
    if (/Rename|重命名/.test(text)) { await node.click(); openedRename = true; break }
  }
  await page.waitForTimeout(600)
  const field = await page.$('[role="dialog"] input')
  check('a session row opens a rename dialog', openedRename && field !== null)
  if (field !== null) {
    await field.fill('smoke-rename-probe')
    const buttons = await page.$$('[role="dialog"] button')
    for (const node of buttons) {
      const text = (await node.textContent())?.trim() ?? ''
      if (/Save|保存/.test(text)) { await node.click(); break }
    }
    await page.waitForTimeout(900)
    const renameCall = mocked.find(call => call.method === 'session.rename')
    check('renaming a row calls session.rename with the typed title',
      renameCall?.payload.title === 'smoke-rename-probe',
      `title=${String(renameCall?.payload.title)}`)
    check('the rename targets the clicked row',
      renameCall?.payload.sessionId === restored.ids[0],
      `sessionId=${String(renameCall?.payload.sessionId)}`)
  }
} else {
  check('a session row opens a rename dialog (skipped: no rows in this project)', true)
}

// ── rail ───────────────────────────────────────────────────────────────────
await page.click('[data-wui="iconButton"]')
await page.waitForTimeout(900)
const rail = await page.evaluate(() => {
  const column = document.querySelector('[data-wui="column"]')
  const row = document.querySelector('[data-wui="projectRow"]')
  const stageTag = document.querySelector('[data-wui="stageTag"]')
  const boxes = [...row.children].map(node => Math.round(node.getBoundingClientRect().x))
  return {
    railAttr: column.getAttribute('data-rail'),
    width: Math.round(column.getBoundingClientRect().width),
    columnOverflow: column.scrollWidth - column.clientWidth,
    rowOverflow: row.scrollWidth - row.clientWidth,
    stacked: new Set(boxes).size === 1,
    railRegion: document.querySelector('[data-wui="sessionRail"]') !== null,
    stageTag: stageTag === null ? null : Math.round(stageTag.getBoundingClientRect().width),
    stageTagText: stageTag?.textContent ?? null,
  }
})
check('rail state engages on collapse', rail.railAttr === 'true' && rail.width < 80, `width=${String(rail.width)}`)
check('rail controls stack inside the track', rail.stacked && rail.rowOverflow <= 3, `overflow=${String(rail.rowOverflow)}`)
check('the rail keeps the stage tag as a square control carrying no words',
  rail.stageTag === 36 && rail.stageTagText === '',
  `width=${String(rail.stageTag)} text="${String(rail.stageTagText)}"`)
check('collapsed column does not overflow horizontally', rail.columnOverflow <= 3, `overflow=${String(rail.columnOverflow)}`)
check('the rail carries the region\'s own control', rail.railRegion)
await page.click('[data-wui="iconButton"]')
await page.waitForTimeout(600)

// ── plugin list ────────────────────────────────────────────────────────────
const clickByText = async (pattern) => {
  for (const node of await page.$$('[role="dialog"] button')) {
    const text = (await node.textContent())?.trim() ?? ''
    if (pattern.test(text)) { await node.click(); return text }
  }
  return null
}
const settingsTrigger = await page.$('[data-slot="sidebar.settings"] button')
check('settings trigger reachable in this column', settingsTrigger !== null)
if (settingsTrigger !== null) {
  await settingsTrigger.click()
  await page.waitForTimeout(1200)
  await clickByText(/^Plugins$|^插件$/)
  await page.waitForTimeout(900)
  await clickByText(/Plugin list|插件列表/)
  await page.waitForTimeout(2000)
  const search = await page.$('[role="dialog"] input')
  if (search !== null) { await search.fill('web-ui'); await page.waitForTimeout(1200) }
  const listed = await page.evaluate(() => /web-ui/.test(document.querySelector('[role="dialog"]')?.textContent ?? ''))
  check('plugin row appears in the plugin list', listed)
  await page.keyboard.press('Escape')
}

await browser.close()

let failed = 0
for (const entry of results) {
  if (!entry.ok) failed += 1
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name}${entry.detail === '' ? '' : `  (${entry.detail})`}`)
}
for (const problem of problems.slice(0, 20)) console.log(`note  ${problem}`)
console.log(failed === 0 ? `\n${String(results.length)} checks passed` : `\n${String(failed)} of ${String(results.length)} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
