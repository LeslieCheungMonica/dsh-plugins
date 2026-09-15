/**
 * Live rehearsal against a RUNNING, ARMED dsh web GUI.
 *
 * A phone is the one thing this script cannot supply, so it verifies everything
 * on both sides of the scan:
 *
 * * the **gate**: `/` is a 302 to the login page, the login page renders, the
 *   static assets still serve;
 * * the **signed-in path**: it mints a session with the plugin's own
 *   `issueSession` (so the signing scheme is the real one) and then checks that
 *   the host accepts that cookie, serves the GUI document, and that the browser
 *   half shows the identity chip;
 * * the **Feishu side**: it loads the QR page that this application id and
 *   redirect URI produce and reports what Feishu actually answers — which is
 *   where a missing redirect URL registration (20029) or a missing 网页应用
 *   capability shows up, long before anyone picks up a phone.
 *
 * It reads the app id from the profile patch and the secret from the same
 * credential document the host uses, and never prints the secret.
 *
 * Usage:
 *   node scripts/verify-armed.mjs              # HTTP-level checks
 *   node scripts/verify-armed.mjs --browser     # + the browser half and the QR page
 *   DSH_URL=http://127.0.0.1:3080 node scripts/verify-armed.mjs
 */
import { readFileSync } from 'node:fs'
import { URL_BASE, mintSession, readAppId, readSecret } from './live.mjs'

const WITH_BROWSER = process.argv.includes('--browser')
const EXECUTABLE = process.env['CHROME']

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }) }

const appId = readAppId()
const secret = readSecret()
if (appId === undefined || secret === undefined) {
  console.error('verify-armed: this deployment is not armed (no appId in the profile patch, or no FEISHU_APP_SECRET credential).')
  process.exit(2)
}
console.log(`rehearsing against ${URL_BASE} (appId ${appId}, secret ${String(secret.length)} chars)`)

// ── the gate ───────────────────────────────────────────────────────────────
const root = await fetch(`${URL_BASE}/`, { redirect: 'manual' })
check('GET / is gated (302, not 200)', root.status === 302, `status=${String(root.status)}`)
const location = root.headers.get('location') ?? ''
check('the redirect points at the login page', /\/login\?next=/u.test(location), location)

const login = await fetch(`${URL_BASE}/login?next=%2F`, { redirect: 'manual' })
const loginHtml = await login.text()
// `mode: redirect` answers a 302 instead of a page, so the login surface has two
// legitimate shapes: an HTML page that carries the QR, or a redirect straight to
// Feishu's own authorize page.
if (login.status === 302) {
  const target = login.headers.get('location') ?? ''
  check('the login route redirects to Feishu\'s authorize page',
    target.startsWith('https://accounts.') && target.includes(`client_id=${appId}`), target.slice(0, 80))
  check('the login page prints the redirect URI to register', true, 'n/a in redirect mode')
} else {
  check('the login page renders', login.status === 200 && loginHtml.includes('扫码登录'), `status=${String(login.status)}`)
  // The app id must reach the browser's flow however the QR is framed: as an
  // `app_id=` on the qrconnect page, or as a `client_id=` inside the legacy
  // authorize URL the QR SDK is handed.
  check('the login page wires this app id into the Feishu flow',
    loginHtml.includes(appId), 'app id in the embedded flow')
  check('the login page carries an embeddable QR surface',
    loginHtml.includes('qrconnect') || loginHtml.includes('LarkSSOSDKWebQRCode'),
    'qrconnect iframe or the official QR SDK')
  check('the login page prints the redirect URI to register', /重定向 URL/u.test(loginHtml))
}

const probe = await (await fetch(`${URL_BASE}/feishu-auth/session`)).json()
check('the session endpoint reports the gate armed', probe.configured === true, JSON.stringify(probe))
check('an anonymous probe is not authenticated', probe.authenticated === false)

const asset = await fetch(`${URL_BASE}/assets/index-CA9Bpko5.js`)
check('static assets are still served', asset.status === 200, `status=${String(asset.status)}`)

// ── the signed-in path, with a token minted by the plugin's own signer ─────
const session = mintSession()
const config = session.config
const cookie = `${session.cookie.name}=${session.cookie.value}; ${session.cookie.hint}=1`

const accepted = await (await fetch(`${URL_BASE}/feishu-auth/session`, { headers: { cookie } })).json()
check('the host ACCEPTS a session minted by this plugin (signing scheme matches)',
  accepted.authenticated === true && accepted.user?.name === '演练账号', JSON.stringify(accepted).slice(0, 120))

const document = await fetch(`${URL_BASE}/`, { headers: { cookie } })
const documentHtml = await document.text()
check('a signed-in request receives the GUI document', document.status === 200 && documentHtml.includes('id="root"'), `status=${String(document.status)}`)
check('that document carries the pre-boot gate script', documentHtml.includes('data-dsh-feishu-login="gate"'))
check('that document carries the browser half\'s deployment facts', documentHtml.includes('__DSH_FEISHU_LOGIN__'))
check('the pre-boot script sits before the app bundle',
  documentHtml.indexOf('data-dsh-feishu-login="gate"') < documentHtml.indexOf('<script type="module"'))

// `redirect: 'manual'` matters here: a followed redirect would land on the
// login page and answer 200, which looks exactly like the gate being open.
const forged = await fetch(`${URL_BASE}/`, {
  headers: { cookie: `${config.cookieName}=forged.${'A'.repeat(43)}` },
  redirect: 'manual',
})
check('a forged session cookie does not open the document', forged.status === 302, `status=${String(forged.status)}`)

const noHint = await fetch(`${URL_BASE}/`, { headers: { cookie }, redirect: 'manual' })
check('a signed-in request is served directly (no redirect)', noHint.status === 200, `status=${String(noHint.status)}`)

// ── the browser half + Feishu's own QR page ────────────────────────────────
if (WITH_BROWSER) {
  const playwright = await import('playwright').catch(() => null)
  if (playwright === null) {
    check('playwright available for the browser checks', false, 'not resolvable — see README, "Verifying"')
  } else {
    const browser = await playwright.chromium.launch(EXECUTABLE === undefined ? {} : { executablePath: EXECUTABLE })
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } })
    await context.addCookies([
      { name: session.cookie.name, value: session.cookie.value, url: URL_BASE, httpOnly: true, sameSite: 'Lax' },
      { name: session.cookie.hint, value: '1', url: URL_BASE, sameSite: 'Lax' },
    ])
    const page = await context.newPage()
    const problems = []
    page.on('pageerror', error => { problems.push(`pageerror: ${error.message}`) })
    await page.goto(`${URL_BASE}/`, { waitUntil: 'load' })
    const chip = await page.waitForSelector('[data-dshfl^="chip"]', { timeout: 20_000 }).catch(() => null)
    check('signed in: the browser half renders the identity chip', chip !== null)
    check('the chip shows the signed-in name', ((await chip?.textContent()) ?? '').includes('演练账号'))
    check('no page errors while signed in', problems.length === 0, problems.slice(0, 2).join(' | '))

    // The QR page itself: what Feishu answers for THIS app id + redirect URI.
    // The probe navigates a page straight to Feishu's authorize page rather
    // than enumerating frames — a cross-origin frame that redirects mid-load is
    // easy to miss, and this way Feishu's own error text is read verbatim. It
    // is the same check the QR leads to, whatever embed technique is
    // configured, so it does not depend on how the code is framed.
    const authorizeProbe = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize'
      + `?client_id=${encodeURIComponent(appId)}&response_type=code`
      + `&redirect_uri=${encodeURIComponent(`${URL_BASE}/feishu-auth/callback`)}&state=probe`
    const qrPage = await context.newPage()
    const qrProblems = []
    qrPage.on('requestfailed', request => { qrProblems.push(`${request.failure()?.errorText ?? 'failed'} ${request.url().slice(0, 60)}`) })
    await qrPage.goto(authorizeProbe, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {})
    await qrPage.waitForTimeout(3000)
    const qrBody = ((await qrPage.evaluate(() => document.body?.innerText ?? '').catch(() => '')))
      .replace(/\s+/gu, ' ').trim()
    const qrCode = /错误码[：:]\s*(\d+)/u.exec(qrBody)?.[1]
    check('Feishu accepts this app id + redirect URI (no 20029)',
      qrCode === undefined, qrCode === undefined ? '' : `错误码 ${qrCode}: ${qrBody.slice(0, 160)}`)
    if (qrProblems.length > 0) console.log(`authorize page network: ${qrProblems.slice(0, 2).join(' | ')}`)
    if (qrBody !== '') console.log(`feishu authorize page says: ${qrBody.slice(0, 200)}`)
    await qrPage.close()

    // Is the QR actually VISIBLE, or merely present? Feishu renders its code
    // below a language switcher at narrow widths, so a frame sized for the page
    // rather than for the code shows the switcher and cuts the code off — the
    // failure this check exists for. Geometry is compared in login-page
    // coordinates, so it holds for every embed technique. It needs its own
    // context: with this tab's session cookie, `/login` would just redirect
    // back into the GUI and there would be no login page to measure.
    const anonymous = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const loginProbe = await anonymous.newPage()
    await loginProbe.goto(`${URL_BASE}/login`, { waitUntil: 'domcontentloaded' })
    await loginProbe.waitForTimeout(8000)
    const geometry = await loginProbe.evaluate(() => {
      const box = document.querySelector('.qr')
      const iframe = document.querySelector('.qr iframe')
      if (box === null || iframe === null) return null
      const b = box.getBoundingClientRect()
      const f = iframe.getBoundingClientRect()
      return { box: { top: b.top, bottom: b.bottom, left: b.left, right: b.right }, frameTop: f.top, frameLeft: f.left }
    })
    const qrFrame = loginProbe.frames().find(frame => /feishu|larksuite/u.test(frame.url()))
    const qrBox = qrFrame === undefined ? null : await qrFrame.evaluate(() => {
      const el = document.querySelector('.new-scan-qrcode-container') ?? document.querySelector('canvas')
      if (el === null) return null
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
    }).catch(() => null)

    check('the login page shows a QR element at all', qrBox !== null && geometry !== null)
    if (qrBox !== null && geometry !== null) {
      const top = geometry.frameTop + qrBox.top
      const bottom = geometry.frameTop + qrBox.bottom
      const left = geometry.frameLeft + qrBox.left
      const right = geometry.frameLeft + qrBox.right
      const inside = top >= geometry.box.top - 2 && bottom <= geometry.box.bottom + 2
        && left >= geometry.box.left - 2 && right <= geometry.box.right + 2
      check('the QR is fully inside its frame (not clipped)', inside,
        `qr ${String(Math.round(top))}~${String(Math.round(bottom))} in box ${String(Math.round(geometry.box.top))}~${String(Math.round(geometry.box.bottom))}`)
    }
    await loginProbe.close()
    await anonymous.close()
    await browser.close()
  }
}

let failed = 0
for (const entry of results) {
  if (!entry.ok) failed += 1
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name}${entry.detail === '' ? '' : `  (${entry.detail})`}`)
}
console.log(failed === 0 ? `\n${String(results.length)} checks passed` : `\n${String(failed)} of ${String(results.length)} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
