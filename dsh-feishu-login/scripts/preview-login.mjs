/**
 * Render the login page from the real renderer and screenshot it.
 *
 * The page is produced by the host half itself (through a fake webserver, the
 * same way `smoke.mjs` drives it), written to a temp file, and opened in a
 * browser with Feishu's QR endpoint stubbed — so the layout, the brand row, the
 * QR frame and the fallback affordances can be seen without an application id,
 * a secret, or a phone.
 *
 * Usage: node scripts/preview-login.mjs [mode] [qrEmbed]
 *   node scripts/preview-login.mjs                # embed + page iframe (default)
 *   node scripts/preview-login.mjs embed sdk      # the official QR SDK variant
 *   node scripts/preview-login.mjs redirect       # Feishu's own hosted page
 */
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const MODE = process.argv[2] ?? 'embed'
const QR_EMBED = process.argv[3] ?? 'page'
const EXECUTABLE = process.env['CHROME']

/** A webserver double that only needs to capture routes. */
function createContext() {
  const routes = new Map()
  return {
    routes,
    ctx: {
      baseUrl: join(process.env['HOME'] ?? '', '.dsh', 'profiles', 'web'),
      effect: fn => fn(),
      get: () => undefined,
      logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
      webServer: {
        register: ({ path, handler }) => { routes.set(path, handler); return () => {} },
        tapIndex: () => () => {},
        applyIndexTaps: html => html,
      },
    },
  }
}

/**
 * Invoke a captured route with a minimal node:http double.
 * @param {object} harness - the context double.
 * @param {string} url - path + query.
 * @returns {Promise<object>} the recorded response.
 */
async function call(harness, url) {
  const res = {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers) { res.status = status; res.headers = headers ?? {}; res.headersSent = true; return res },
    end(chunk) { if (typeof chunk === 'string') res.body += chunk; return res },
  }
  await harness.routes.get(url.split('?')[0])({ url, method: 'GET', headers: { host: '127.0.0.1:3080' } }, res)
  return res
}

const harness = createContext()
apply(harness.ctx, {
  appId: 'cli_preview_app_id',
  appSecret: 'preview-secret',
  brandName: 'ForgeX',
  mode: MODE,
  qrEmbed: QR_EMBED,
})

const response = await call(harness, '/login?next=%2F')
const target = join(tmpdir(), `dsh-feishu-login-preview-${MODE}-${QR_EMBED}.html`)
writeFileSync(target, response.body)
console.log(`login page: status ${String(response.status)}, ${String(response.body.length)} bytes → ${target}`)

const playwright = await import('playwright').catch(() => null)
if (playwright === null) {
  console.log('playwright unavailable: the HTML was written, open it manually.')
  process.exit(0)
}

const browser = await playwright.chromium.launch(EXECUTABLE === undefined ? {} : { executablePath: EXECUTABLE })
const page = await browser.newPage({ viewport: { width: 900, height: 800 } })
const problems = []
page.on('pageerror', error => { problems.push(`pageerror: ${error.message}`) })
page.on('console', message => { if (message.type() === 'error') problems.push(`console.error: ${message.text()}`) })

// Stand in for Feishu: the QR frame and the session poll, so the page reaches
// the state a user would see while waiting for a scan.
await page.route('**/connect/qrconnect/**', route => route.fulfill({
  status: 200,
  contentType: 'text/html; charset=utf-8',
  body: `<!doctype html><html><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100%;font:13px -apple-system,sans-serif;color:#8a94a6;background:#fff">
    <div style="text-align:center">
      <div style="width:170px;height:170px;margin:6px auto 10px;background:
        repeating-conic-gradient(#111 0% 25%, #fff 0% 50%) 50%/16px 16px"></div>
      飞书二维码（预览占位）
    </div></body></html>`,
}))
await page.route('**/feishu-auth/session', route => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ configured: true, authenticated: false, loginUrl: '/login' }),
}))
await page.route('**/open-apis/authen/**', route => route.fulfill({
  status: 200,
  contentType: 'text/html; charset=utf-8',
  body: '<!doctype html><title>FEISHU-AUTHORIZE</title><p>飞书授权页（预览占位）</p>',
}))

await page.goto(`file://${target}`, { waitUntil: 'load' })
await page.waitForTimeout(1500)
const shot = join(tmpdir(), `dsh-feishu-login-preview-${MODE}-${QR_EMBED}.png`)
await page.screenshot({ path: shot, fullPage: true })
console.log(`screenshot: ${shot}`)

// A layout report, so the page can be checked without looking at the picture:
// the card is centred, the QR frame has the square the design asks for, the
// brand mark drew, and the fallback affordances are present.
const report = await page.evaluate(() => {
  const box = (selector) => {
    const node = document.querySelector(selector)
    if (node === null) return null
    const rect = node.getBoundingClientRect()
    return { w: Math.round(rect.width), h: Math.round(rect.height), x: Math.round(rect.x) }
  }
  return {
    title: document.title,
    heading: document.querySelector('h1')?.textContent ?? '',
    subtitle: document.querySelector('p.sub')?.textContent ?? '',
    status: document.querySelector('#status')?.textContent ?? '',
    card: box('.card'),
    mark: box('.mark'),
    qr: box('.qr'),
    iframeSrc: document.querySelector('.qr iframe')?.getAttribute('src') ?? null,
    buttons: [...document.querySelectorAll('a.btn')].map(node => node.textContent?.trim() ?? ''),
    foot: (document.querySelector('.foot')?.textContent ?? '').trim().slice(0, 120),
    viewport: { w: window.innerWidth, h: window.innerHeight },
  }
})
console.log(JSON.stringify(report, null, 2))
const problemsFound = []
if (report.card === null) problemsFound.push('no card rendered')
else if (Math.abs((report.card.x + report.card.w / 2) - report.viewport.w / 2) > 3) problemsFound.push('card is not centred')
if (report.heading === '') problemsFound.push('no headline')
if (report.mark === null) problemsFound.push('the brand mark did not draw')
if (MODE === 'embed' && (report.qr === null || report.qr.w < 250)) problemsFound.push('the QR frame is missing or too small')
if (MODE === 'embed' && QR_EMBED === 'page' && report.iframeSrc === null) problemsFound.push('no QR iframe')
if (MODE === 'embed' && !report.buttons.some(text => text.includes('飞书'))) problemsFound.push('the top-level fallback button is missing')
if (problemsFound.length > 0) console.log(`LAYOUT PROBLEMS:\n  ${problemsFound.join('\n  ')}`)
if (problems.length > 0) console.log(`page problems:\n  ${problems.join('\n  ')}`)
await browser.close()
process.exit(problemsFound.length === 0 && problems.length === 0 ? 0 : 1)
