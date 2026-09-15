/**
 * Browser smoke test for the plugin against a RUNNING dsh web GUI.
 *
 * It asserts what only a browser can show: that the plugin's browser half
 * materializes in this composition, that it is invisible while the host has no
 * credentials (the plugin must not draw on a working page), that the identity
 * chip renders when the host reports a session, and that the tab is pushed to
 * the login page when the host reports none.
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
    chip: document.querySelector('[data-dshfl^="chip"]') !== null,
    style: document.querySelector('style[data-plugin="dsh-feishu-login"]') !== null,
    overlaySeat: document.querySelector('[data-shell-overlay]') !== null,
  }))
  check('the overlay seat this plugin registers into exists', state.overlaySeat)
  check('the plugin stylesheet is installed', state.style)
  check('no gate overlay on a normal load', !state.gate)
  if (ARMED) {
    check('armed host: the identity chip renders for a signed-in tab', state.chip)
  } else {
    check('unarmed host: no identity chip', !state.chip)
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

// ── 2. host reports a session: the identity chip renders ───────────────────
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
  const chip = await page.waitForSelector('[data-dshfl^="chip"]', { timeout: 20_000 }).catch(() => null)
  check('signed in: the identity chip renders', chip !== null)
  const text = chip === null ? '' : (await chip.textContent()) ?? ''
  check('the chip carries the signed-in name', text.includes('李彦辉'), `text="${text.trim()}"`)
  check('the chip carries a sign-out action', (await page.$('[data-dshfl^="chip"] button')) !== null)
  check('no gate overlay while signed in', (await page.$('[data-dshfl="gate"]')) === null)
  check('no page errors (signed in)', problems.length === 0, problems.slice(0, 2).join(' | '))
  // The chip belongs in the session header, and the shipped Session-log button
  // must be displaced by it (this deployment's explicit choice): the header's
  // utilities seat holds one cell per id, so the plugin claims that id.
  await page.waitForSelector('[data-wui="sessionOpen"]', { timeout: 15_000 }).catch(() => {})
  const sessionRows = await page.$$('[data-wui="sessionOpen"]')
  check('the sidebar lists a session to open', sessionRows.length > 0, String(sessionRows.length))
  // Try rows until one shows the header chrome: a blank Session hides it (its
  // window is the Hero screen), and only a visible header can host the chip.
  let header = null
  for (const row of sessionRows) {
    await row.click({ force: true }).catch(() => {})
    await page.waitForTimeout(3000)
    header = await page.evaluate(() => {
      const chip = document.querySelector('[data-dshfl^="chip"]')
      const headerEl = document.querySelector('header[class*="header"]')
      const logButton = [...document.querySelectorAll('button')]
        .find(node => (node.textContent ?? '').trim().startsWith('Session log'))
      const r = chip?.getBoundingClientRect()
      return {
        chipKind: chip?.getAttribute('data-dshfl') ?? null,
        chipTop: r ? Math.round(r.y) : null,
        chipRight: r ? Math.round(window.innerWidth - r.right) : null,
        headerVisible: headerEl === null ? false : !/headerHidden/u.test(headerEl.className),
        logButton: logButton === undefined || logButton === null,
      }
    })
    if (header.headerVisible) break
  }
  if (header !== null) {
    check('the chip sits in the top-right, not the bottom-right', header.chipTop !== null && header.chipTop < 60, JSON.stringify(header))
    if (header.headerVisible) {
      check('with a session open the chip lives in the session header', header.chipKind === 'chipHeader', String(header.chipKind))
    }
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
  const trigger = await page.$('[data-slot="sidebar.settings"] button')
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
