import { URL_BASE, readAppId } from './scripts/live.mjs'
const playwright = await import('playwright')
const browser = await playwright.chromium.launch({ executablePath: process.env['CHROME'] })
const appId = readAppId()
const redirectUri = `${URL_BASE}/feishu-auth/callback`
const legacy = `https://passport.feishu.cn/suite/passport/oauth/authorize?client_id=${appId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&state=probe`
const SDK = 'https://lf-package-cn.feishucdn.com/obj/feishu-static/lark/passport/qrcode/LarkSSOSDKWebQRCode-1.0.3.js'

const page = await browser.newPage({ viewport: { width: 420, height: 700 } })
const log = []
page.on('requestfailed', r => log.push(`FAILED ${r.failure()?.errorText} ${r.url().slice(0, 60)}`))
page.on('response', r => { if (r.url().includes('LarkSSOSDK')) log.push(`SDK script: HTTP ${r.status()}`) })
await page.setContent(`<!doctype html><body style="margin:0"><div id="dsh-qr" style="width:300px;height:300px"></div></body>`)
await page.addScriptTag({ url: SDK }).then(() => log.push('script tag added without error')).catch(e => log.push('script load error: ' + String(e).split('\n')[0]))
await page.waitForTimeout(1500)
const hasApi = await page.evaluate(() => typeof window.QRLogin === 'function')
log.push(`window.QRLogin is ${hasApi ? 'available ✅' : 'MISSING ❌'}`)
if (hasApi) {
  await page.evaluate((goto) => { window.QRLogin({ id: 'dsh-qr', goto, width: '300', height: '300', style: 'width:300px;height:300px' }) }, legacy)
  await page.waitForTimeout(6000)
}
const m = await page.evaluate(() => {
  const frames = [...document.querySelectorAll('iframe')].map(f => f.src.slice(0, 70))
  return { frames, inner: document.getElementById('dsh-qr')?.innerHTML.slice(0, 120) }
})
log.push(`iframes rendered: ${JSON.stringify(m.frames)}`)
await page.waitForTimeout(500)
for (const f of page.frames().filter(f => f !== page.mainFrame())) {
  const q = await f.evaluate(() => {
    const el = document.querySelector('canvas') ?? document.querySelector('.new-scan-qrcode-container')
    const r = el?.getBoundingClientRect()
    return { url: location.href.slice(0, 50), canvas: document.querySelectorAll('canvas').length, qr: r ? `y${Math.round(r.y)}~${Math.round(r.bottom)} ${Math.round(r.width)}px` : '无' }
  }).catch(() => null)
  if (q) log.push(`  frame: ${q.url} · canvas=${q.canvas} · 二维码 ${q.qr}`)
}
console.log(log.join('\n'))
await browser.close()
