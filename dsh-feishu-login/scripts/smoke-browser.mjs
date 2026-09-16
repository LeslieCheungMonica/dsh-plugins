/**
 * Browser smoke test for the plugin against a RUNNING dsh web GUI.
 *
 * It asserts what only a browser can show: that the plugin's browser half
 * materializes in this composition, that it is invisible while the host has no
 * credentials (the plugin must not draw on a working page), that the identity
 * renders in the sidebar's bottom-left account dock when the host reports a
 * session, and that the tab is pushed to the login page when the host reports
 * none.
 *
 * The session endpoint is answered at the wire, so the armed states are
 * exercised without arming the host — which matters, because arming it in this
 * checkout would gate the very GUI the test is driving (there are no real
 * credentials yet). The unarmed path is what the host actually serves here.
 *
 * Usage:
 *   node scripts/smoke-browser.mjs
 *   DSH_URL=http://127.0.0.1:3090 node scripts/smoke-browser.mjs
 *   CHROME=/path/to/chrome node scripts/smoke-browser.mjs
 *
 * Playwright is dev-only and resolves from dsh-web-ui's node_modules (see
 * README, "Verifying").
 */
import { URL_BASE, cookieDescriptors, mintSession, probeHost } from './live.mjs'

const URL = `${URL_BASE}/`
const EXECUTABLE = process.env['CHROME']

const playwright = await import('playwright').catch(() => {
  console.error('smoke-browser: playwright is not resolvable — see README, "Verifying".')
  process.exit(2)
})

/** One recorded assertion. */
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }) }

const browser = await playwright.chromium.launch(EXECUTABLE === undefined ? {} : { executablePath: EXECUTABLE })

// Armed or not decides what "correct" means for the first case: on an unarmed
// host the plugin must be invisible; on an armed one the same page must show
// the identity chip instead.
const host = await probeHost()
const ARMED = host.configured === true
console.log(`host: ${ARMED ? 'ARMED' : 'unarmed'} (${URL_BASE})`)

/**
 * Open a page in its own context, carrying a session when the host is armed.
 *
 * Which state this script is testing is a property of the HOST, not of the
 * script: an armed host refuses to serve the GUI document to a request without
 * a session, so the browser checks can only reach the GUI by presenting one.
 * The session is minted by the plugin's own signer, so nothing here depends on
 * a phone — and a wrong signing scheme would simply fail to load the page.
 * @returns {Promise<{page: object, problems: string[]}>} the page and its error log.
 */
async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  if (ARMED) {
    const session = mintSession()
    if (session === undefined) {
      console.error('smoke-browser: the host is armed but this checkout cannot mint a session — check appId / FEISHU_APP_SECRET.')
      process.exit(2)
    }
    await context.addCookies(cookieDescriptors(session))
  }
  const page = await context.newPage()
  const problems = []
  page.on('pageerror', error => { problems.push(`pageerror: ${error.message}`) })
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`)
  })
  return { page, problems }
}

/**
 * Simulate what an ARMED host injects before the app boots: the deployment
 * facts the browser half reads. Without it the client half stays off by design
 * (that is the unarmed case, covered first).
 * @param {object} page - the page to arm.
 * @returns {Promise<void>} resolves once the init script is installed.
 */
async function armPage(page) {
  await page.addInitScript(() => {
    window.__DSH_FEISHU_LOGIN__ = {
      prefix: '/feishu-auth', loginUrl: '/login', accountChip: true, brandName: 'ForgeX',
    }
  })
}

// ── 1. the plugin's footprint on a normal page load ────────────────────────
{
  const { page, problems } = await newPage()
  await page.goto(URL, { waitUntil: 'load' })
  await page.waitForSelector('[data-slot="shell.overlay"], #root', { timeout: 30_000 })
  await page.waitForTimeout(2500)

  const state = await page.evaluate(() => ({
    gate: document.querySelector('[data-dshfl="gate"]') !== null,
    // The identity's PRIMARY home is the sidebar's account dock (declared by
    // dsh-web-ui); the corner capsule is the fallback for a deployment without
    // it. Either counts as "the plugin drew the account".
    chip: document.querySelector('[data-dshfl="account"], [data-dshfl^="chip"]') !== null,
    style: document.querySelector('style[data-plugin="dsh-feishu-login"]') !== null,
    overlaySeat: document.querySelector('[data-shell-overlay]') !== null,
  }))
  check('the overlay seat this plugin registers into exists', state.overlaySeat)
  check('the plugin stylesheet is installed', state.style)
  check('no gate overlay on a normal load', !state.gate)
  if (ARMED) {
    check('armed host: the identity renders for a signed-in tab', state.chip)
  } else {
    check('unarmed host: no identity', !state.chip)
  }
  check('no page errors', problems.length === 0, problems.slice(0, 2).join(' | '))

  // The bundle route is the module table's own contract.
  const served = await page.evaluate(async () => {
    const response = await fetch('/plugins/dsh-feishu-login/client.js')
    return { status: response.status, text: (await response.text()).slice(0, 120) }
  })
  check('the client bundle is served at /plugins/<id>/client.js', served.status === 200, `status=${String(served.status)}`)
  check('the bundle registers under its own id', served.text.includes('"dsh-feishu-login"'))
  await page.close()
}

// ── 2. host reports a session: the identity renders in the sidebar's dock ───
{
  const { page, problems } = await newPage()
  await armPage(page)
  await page.route('**/feishu-auth/session', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      configured: true,
      authenticated: true,
      loginUrl: '/login',
      user: {
        name: '李彦辉',
        openId: 'ou_probe_user',
        email: 'probe@asiainfo.com',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    }),
  }))
  await page.goto(URL, { waitUntil: 'load' })
  const identity = await page
    .waitForSelector('[data-dshfl="account"], [data-dshfl^="chip"]', { timeout: 20_000 })
    .catch(() => null)
  check('signed in: the identity renders', identity !== null)
  const text = identity === null ? '' : (await identity.textContent()) ?? ''
  check('the identity carries the signed-in name', text.includes('李彦辉'), `text="${text.trim()}"`)
  check('no gate overlay while signed in', (await page.$('[data-dshfl="gate"]')) === null)
  check('no page errors (signed in)', problems.length === 0, problems.slice(0, 2).join(' | '))

  // Where it sits, and that the sign-out action is one click away from it. On
  // this composition (dsh-web-ui installed) the identity is the sidebar's
  // bottom-left row and sign-out is a row inside the drawer it opens; on a
  // deployment without that plugin it is the original top-right capsule with its
  // own button. Both are checked as the SAME claim: the corner the reader lands
  // on can reach the session verb.
  const dock = await page.$('[data-wui="accountRow"]')
  if (dock !== null) {
    const box = await dock.boundingBox()
    const column = await (await page.$('[data-wui="column"]'))?.boundingBox()
    check('the account row is at the column\'s bottom-left',
      box !== null && column !== null && box.x < column.x + column.width / 2 && box.y > column.y + column.height / 2,
      JSON.stringify({ box, column }))
    await dock.click()
    const drawer = await page.waitForSelector('[data-wui="accountDrawer"]', { timeout: 5000 }).catch(() => null)
    check('clicking it opens the drawer', drawer !== null)
    const drawerBox = await drawer?.boundingBox()
    check('the drawer opens UPWARD from the row',
      drawerBox !== null && box !== null && drawerBox !== undefined && drawerBox.y + drawerBox.height <= box.y + 1,
      JSON.stringify({ drawerBox, box }))
    check('the drawer\'s first row is the usage block',
      ((await page.textContent('[data-wui="drawerRow"]')) ?? '').includes('使用情况') ||
      ((await page.textContent('[data-wui="drawerRow"]')) ?? '').includes('Usage'),
      String(await page.textContent('[data-wui="drawerRow"]')))
    check('the drawer holds the shipped settings trigger',
      (await page.$('[data-wui="accountDrawer"] button[aria-haspopup="dialog"]')) !== null)
    check('the drawer holds the plugin\'s sign-out row', (await page.$('[data-dshfl="signOut"]')) !== null)
    // Nothing in the frame's top-right corner is this plugin's any more.
    const topRightChip = await page.evaluate(() => {
      const el = document.querySelector('[data-dshfl^="chip"]')
      if (el === null) return null
      const r = el.getBoundingClientRect()
      return { y: Math.round(r.y), right: Math.round(window.innerWidth - r.right) }
    })
    check('no account capsule in the top-right corner', topRightChip === null, JSON.stringify(topRightChip))
  } else {
    // Fallback deployment: the original capsule, in its original corner, with
    // its own sign-out button.
    const chip = await page.$('[data-dshfl^="chip"]')
    const box = await chip?.boundingBox()
    check('the fallback capsule sits in the top-right', box !== null && box !== undefined && box.y < 60, JSON.stringify(box))
    check('the fallback capsule carries a sign-out action', (await page.$('[data-dshfl^="chip"] button')) !== null)
  }

  // The shipped Session-log button must be displaced on EITHER path (this
  // deployment's explicit choice): the header's utilities seat holds one cell per
  // id, so the plugin claims that id at priority -1.
  await page.waitForSelector('[data-wui="sessionOpen"]', { timeout: 15_000 }).catch(() => {})
  const sessionRows = await page.$$('[data-wui="sessionOpen"]')
  check('the sidebar lists a session to open', sessionRows.length > 0, String(sessionRows.length))
  // Try rows until one shows the header chrome: a blank Session hides it (its
  // window is the Hero screen), and only a visible header can host the button
  // whose absence is under test.
  let header = null
  for (const row of sessionRows) {
    await row.click({ force: true }).catch(() => {})
    await page.waitForTimeout(3000)
    header = await page.evaluate(() => {
      const headerEl = document.querySelector('header[class*="header"]')
      const logButton = [...document.querySelectorAll('button')]
        .find(node => (node.textContent ?? '').trim().startsWith('Session log'))
      return {
        headerVisible: headerEl === null ? false : !/headerHidden/u.test(headerEl.className),
        logButton: logButton === undefined || logButton === null,
      }
    })
    if (header.headerVisible) break
  }
  if (header !== null) {
    check('the shipped Session-log header button is displaced', header.logButton)
  }
  await page.close()
}

// ── 3. host reports no session: the tab is pushed to the login page ────────
{
  const { page } = await newPage()
  await armPage(page)
  await page.route('**/feishu-auth/session', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ configured: true, authenticated: false, loginUrl: '/login' }),
  }))
  // The login page is the host's own route; unarmed, that route does not exist,
  // so the sentinel stands in for it and the test asserts the navigation.
  await page.route('**/login*', route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><title>LOGIN-SENTINEL</title><h1 id="sentinel">login page</h1>',
  }))
  await page.goto(URL, { waitUntil: 'load' })
  const arrived = await page.waitForFunction(
    () => document.title === 'LOGIN-SENTINEL',
    undefined,
    { timeout: 20_000 },
  ).then(() => true).catch(() => false)
  check('signed out: the tab lands on the login page', arrived, `url=${page.url()}`)
  check('the login redirect carries the return path', page.url().includes('next='), page.url())
  await page.close()
}

// ── 4. the Loader row exists (Settings → Plugins lists it) ─────────────────
{
  const { page } = await newPage()
  await page.goto(URL, { waitUntil: 'load' })
  await page.waitForTimeout(2500)
  const clickByText = async (pattern) => {
    for (const node of await page.$$('[role="dialog"] button')) {
      const text = (await node.textContent())?.trim() ?? ''
      if (pattern.test(text)) { await node.click(); return text }
    }
    return null
  }
  // The shipped Settings trigger now renders INSIDE the account drawer rather
  // than in the column's foot, so reaching it is itself part of the walk: open
  // the account row, then the trigger the drawer holds.
  const accountRow = await page.$('[data-wui="accountRow"]')
  if (accountRow !== null) {
    await accountRow.click()
    await page.waitForTimeout(600)
  }
  // `> button` on purpose: SettingsRoot renders the trigger AND the settings
  // panel as siblings inside one slot wrapper, so a descendant selector would
  // also match the panel's own buttons the moment it is open.
  const trigger = await page.$('[data-wui="accountDrawer"] [data-slot="sidebar.settings"] > button')
    ?? await page.$('[data-slot="sidebar.settings"] > button')
  check('settings trigger reachable', trigger !== null)
  if (trigger !== null) {
    await trigger.click()
    await page.waitForTimeout(1200)
    await clickByText(/^Plugins$|^插件$/)
    await page.waitForTimeout(900)
    await clickByText(/Plugin list|插件列表/)
    await page.waitForTimeout(2000)
    const search = await page.$('[role="dialog"] input')
    if (search !== null) { await search.fill('feishu'); await page.waitForTimeout(1200) }
    const listed = await page.evaluate(() => /feishu-login/.test(document.querySelector('[role="dialog"]')?.textContent ?? ''))
    check('the plugin row appears in the plugin list', listed)
    // The status dot is the Loader's own projection of the fiber state, so this
    // is what proves the HOST half actually activated — a throwing `apply`
    // would show `failed` here while the client row still booted. The entry id
    // is the Loader's own (`include:<inserted id>`), hence the suffix match.
    const phase = await page.evaluate(() =>
      document.querySelector('[data-plugin-entry$="feishu-login"] [data-phase]')?.getAttribute('data-phase') ?? null)
    check('the host half activated (fiber is active, not failed)', phase === 'active', `phase=${String(phase)}`)
    await page.keyboard.press('Escape')
  }
  await page.close()
}

await browser.close()

let failed = 0
for (const entry of results) {
  if (!entry.ok) failed += 1
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name}${entry.detail === '' ? '' : `  (${entry.detail})`}`)
}
console.log(failed === 0 ? `\n${String(results.length)} checks passed` : `\n${String(failed)} of ${String(results.length)} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
