import { URL_BASE } from './scripts/live.mjs'
const playwright = await import('playwright')
const browser = await playwright.chromium.launch({ executablePath: process.env['CHROME'] })
const qrSrc = /<iframe src="([^"]*qrconnect[^"]*)"/.exec((await (await fetch(`${URL_BASE}/login`)).text()).replaceAll('&amp;', '&'))?.[1]
console.log('probe url:', qrSrc?.slice(0, 120), '…\n')

for (const w of [300, 360, 420, 500, 700, 1000]) {
  const page = await browser.newPage({ viewport: { width: w, height: 700 } })
  await page.goto(qrSrc, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForTimeout(5500)
  const m = await page.evaluate(() => {
    const el = document.querySelector('.new-scan-qrcode-container') ?? document.querySelector('canvas')
    const r = el?.getBoundingClientRect()
    return {
      finalUrl: location.href.slice(0, 60),
      scrollH: document.documentElement.scrollHeight,
      canvas: document.querySelectorAll('canvas').length,
      qr: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
      text: (document.body.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 110),
    }
  })
  console.log(`宽 ${String(w).padStart(4)} → 页高 ${String(m.scrollH).padStart(5)} canvas=${m.canvas} qr=${m.qr ? `y${m.qr.y} ${m.qr.w}x${m.qr.h}` : '无'}\n        文本: ${m.text}\n`)
  await page.close()
}
await browser.close()
