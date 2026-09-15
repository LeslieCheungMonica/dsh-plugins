import { URL_BASE } from './scripts/live.mjs'
const playwright = await import('playwright')
const browser = await playwright.chromium.launch({ executablePath: process.env['CHROME'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
await page.goto(`${URL_BASE}/login`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(7000)
const frame = page.frames().find(f => /feishu/.test(f.url()))
const box = await page.evaluate(() => { const r = document.querySelector('.qr')?.getBoundingClientRect(); return r ? { y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width) } : null })
const m = await frame.evaluate(() => {
  const el = document.querySelector('.new-scan-qrcode-container') ?? document.querySelector('canvas')
  const r = el?.getBoundingClientRect()
  return { viewH: window.innerHeight, qr: r ? { y: Math.round(r.y), bottom: Math.round(r.bottom), w: Math.round(r.width) } : null, text: (document.body.innerText ?? '').replace(/\s+/g,' ').trim().slice(0, 50) }
})
console.log('登录页里的二维码框:', JSON.stringify(box))
console.log('iframe 视口高:', m.viewH, '· 二维码:', JSON.stringify(m.qr))
console.log('框内可视窗口 = y172~472 →', m.qr && m.qr.y >= 172 && m.qr.bottom <= 472 ? '二维码完整落在窗口内 ✅' : '仍然被裁切 ❌')
console.log('窗口里看到的文字:', m.text)
await page.screenshot({ path: '/tmp/login-qr-check.png' })
await browser.close()
