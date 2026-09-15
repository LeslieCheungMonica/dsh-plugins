import { URL_BASE } from './scripts/live.mjs'
const playwright = await import('playwright')
const browser = await playwright.chromium.launch({ executablePath: process.env['CHROME'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
const failed = []
page.on('requestfailed', r => failed.push(`${r.failure()?.errorText} ${r.url().slice(0, 55)}`))
await page.goto(`${URL_BASE}/login`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(10000)
const frames = page.frames().filter(f => f !== page.mainFrame())
console.log('frames:', frames.map(f => f.url().slice(0, 58)))
for (const f of frames) {
  const m = await f.evaluate(() => {
    const el = document.querySelector('canvas') ?? document.querySelector('.new-scan-qrcode-container')
    const r = el?.getBoundingClientRect()
    return { view: `${window.innerWidth}x${window.innerHeight}`, qr: r ? `y${Math.round(r.y)}~${Math.round(r.bottom)} ${Math.round(r.width)}px` : '无', text: (document.body.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) }
  }).catch(() => null)
  console.log('  frame', JSON.stringify(m))
}
console.log('failed requests:', failed.slice(0, 4))
await page.screenshot({ path: '/tmp/login-sdk-check.png' })
await browser.close()
