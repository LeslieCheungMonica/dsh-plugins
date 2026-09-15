import { URL_BASE } from './scripts/live.mjs'
const playwright = await import('playwright')
const browser = await playwright.chromium.launch({ executablePath: process.env['CHROME'] })
const qrSrc = /<iframe src="([^"]*qrconnect[^"]*)"/.exec((await (await fetch(`${URL_BASE}/login`)).text()).replaceAll('&amp;', '&'))?.[1]

for (const size of [{ w: 300, h: 300 }, { w: 420, h: 520 }, { w: 460, h: 600 }]) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
  await page.setContent(`<style>html,body{margin:0}iframe{width:${size.w}px;height:${size.h}px;border:0}</style><iframe src="${qrSrc}"></iframe>`)
  await page.waitForTimeout(5000)
  const frame = page.frames().find(f => /accounts\.feishu\.cn/.test(f.url()))
  if (!frame) { console.log(size, 'no frame'); await page.close(); continue }
  const m = await frame.evaluate(() => {
    const el = document.querySelector('.new-scan-qrcode-container') ?? document.querySelector('canvas')
    const r = el?.getBoundingClientRect()
    return {
      view: { w: window.innerWidth, h: window.innerHeight },
      scrollH: document.documentElement.scrollHeight,
      qr: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) } : null,
      firstText: (document.body.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
    }
  })
  const visible = m.qr !== null && m.qr.y >= 0 && m.qr.bottom <= m.view.h && m.qr.x >= 0
  console.log(`iframe ${size.w}x${size.h} → 视口 ${m.view.w}x${m.view.h}, 页面高 ${m.scrollH}, 二维码 y=${m.qr?.y} bottom=${m.qr?.bottom} → ${visible ? '完整可见 ✅' : '被裁切 ❌'}`)
  await page.close()
}
await browser.close()
