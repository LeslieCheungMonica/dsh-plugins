/**
 * Ask Feishu which redirect URIs this application actually accepts.
 *
 * The authorize/QR page answers `20029 redirect_uri unmatch` for anything not
 * in the console's list, so loading that page once per candidate is a direct
 * read of the registered entries — no console access, no guesses. That turns
 * "20029" into "you registered X, and the plugin sends Y".
 *
 * It loads pages only; nothing logs in, and no credential is involved (the app
 * id is public).
 *
 * Usage: node scripts/probe-redirect.mjs [appId]
 *   DSH_URL=http://127.0.0.1:3080 node scripts/probe-redirect.mjs
 */
import { probeHost, readAppId } from './live.mjs'

const EXECUTABLE = process.env['CHROME']
const appId = process.argv[2] ?? readAppId()

if (appId === undefined) {
  console.error('probe-redirect: no app id given and none in the profile patch.')
  process.exit(2)
}

/**
 * The candidates, in the order a misconfiguration usually explains itself:
 * our own URI first, then the near-misses.
 * @param origin - the live origin (host:port) the GUI is served on.
 * @returns candidate redirect URIs.
 */
function candidates(origin) {
  return [
    `${origin}/feishu-auth/callback`,
    `${origin}/feishu-auth/callback/`,
    `${origin}/feishu-auth`,
    `${origin}/`,
    origin,
    `http://localhost:${new URL(origin).port}/feishu-auth/callback`,
    `http://localhost:${new URL(origin).port}/`,
    `http://localhost:${new URL(origin).port}`,
  ]
}

const playwright = await import('playwright').catch(() => {
  console.error('probe-redirect: playwright is not resolvable — see README, "Verifying".')
  process.exit(2)
})

const host = await probeHost()
const url = new URL(process.env['DSH_URL'] ?? 'http://127.0.0.1:3080')
const origin = `${url.protocol}//${url.host}`
console.log(`app id ${appId} · origin ${origin} · gate ${host.configured === true ? 'ARMED' : 'unarmed'}`)

const browser = await playwright.chromium.launch(EXECUTABLE === undefined ? {} : { executablePath: EXECUTABLE })
const page = await browser.newPage()

for (const redirectUri of candidates(origin)) {
  const target = 'https://open.feishu.cn/connect/qrconnect/page/sso/'
    + `?app_id=${encodeURIComponent(appId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + '&state=probe'
  let verdict = 'unreachable'
  let note = ''
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 25_000 })
    await page.waitForTimeout(2500)
    const body = ((await page.evaluate(() => document.body?.innerText ?? '')).replace(/\s+/gu, ' ').trim())
    const code = /错误码[：:]\s*(\d+)/u.exec(body)?.[1]
    if (code !== undefined) {
      verdict = `REFUSED (${code})`
      note = body.slice(0, 90)
    } else {
      verdict = 'ACCEPTED'
      note = body.slice(0, 90)
    }
  } catch (error) {
    note = String(error).split('\n')[0].slice(0, 90)
  }
  console.log(`${verdict.padEnd(16)} ${redirectUri}${note === '' ? '' : `\n                 ↳ ${note}`}`)
}

await browser.close()
