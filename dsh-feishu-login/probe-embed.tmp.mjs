import { URL_BASE, readAppId } from './scripts/live.mjs'
const playwright = await import('playwright')
const browser = await playwright.chromium.launch({ executablePath: process.env['CHROME'] })
const appId = readAppId()
const redirectUri = `${URL_BASE}/feishu-auth/callback`
const legacy = `https://passport.feishu.cn/suite/passport/oauth/authorize?client_id=${appId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&state=probe`
const candidates = {
  'A) qrconnect 页（当前实现）': `https://open.feishu.cn/connect/qrconnect/page/sso/?app_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=probe`,
  'B) SDK 内部 iframe（passport/sso/qr）': `https://passport.feishu.cn/suite/passport/sso/qr?goto=${encodeURIComponent(legacy)}&sdk_version=1.0.3`,
}

for (const [label, src] of Object.entries(candidates)) {
  for (const box of [{ w: 300, h: 300 }, { w: 320, h: 460 }]) {
    const page = await browser.newPage({ viewport: { width: box.w, height: box.h } })
    await page.goto(src, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.waitForTimeout(5500)
    const m = await page.evaluate(() => {
      const el = document.querySelector('.new-scan-qrcode-container') ?? document.querySelector('canvas')
      const r = el?.getBoundingClientRect()
      return {
        url: location.href.slice(0, 55),
        scrollH: document.documentElement.scrollHeight,
        qr: r ? { y: Math.round(r.y), bottom: Math.round(r.bottom), w: Math.round(r.width) } : null,
        text: (document.body.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 70),
      }
    })
    const fits = m.qr !== null && m.qr.bottom <= box.h
    console.log(`${label}\n  框 ${box.w}x${box.h} → 页高 ${m.scrollH} · 二维码 ${m.qr ? `y${m.qr.y}~${m.qr.bottom} (${m.qr.w}px)` : '无'} → ${fits ? '完整可见 ✅' : '被裁切 ❌'}\n  文本: ${m.text}`)
    await page.close()
  }
  console.log()
}
await browser.close()
