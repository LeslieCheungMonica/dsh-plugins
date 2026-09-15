import { writeFileSync } from 'node:fs'
import { URL_BASE, readAppId } from './scripts/live.mjs'
import { internals } from '../dsh-feishu-login/lib/index.js'
const playwright = await import('playwright')

const appId = readAppId()
const config = internals.resolveConfig({ appId, appSecretRef: 'DSH_FEISHU_LOGIN_SECRET', mode: 'embed', qrEmbed: 'page' })
const endpoints = internals.resolveEndpoints(config.brand)
const token = appId.slice(0, 6)
const html = internals.renderLoginPage({
  config, endpoints, redirectUri: `${URL_BASE}/feishu-auth/callback`, next: '/', state: 'probe-state',
})
const file = '/tmp/dsh-login-page-mode.html'
writeFileSync(file, html)
console.log('rendered page-mode login page →', file, `(${html.length} bytes)`)

const browser = await playwright.chromium.launch({ executablePath: process.env['CHROME'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } })
await page.goto(`file://${file}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(8000)
const box = await page.evaluate(() => {
  const el = document.querySelector('.qr'); const r = el.getBoundingClientRect()
  const f = document.querySelector('.qr iframe').getBoundingClientRect()
  return { box: { y: Math.round(r.y), bottom: Math.round(r.bottom), h: Math.round(r.height) }, iframe: { y: Math.round(f.y), h: Math.round(f.height) } }
})
const frame = page.frames().find(f => /feishu/.test(f.url()))
const qr = await frame.evaluate(() => {
  const el = document.querySelector('.new-scan-qrcode-container') ?? document.querySelector('canvas')
  const r = el?.getBoundingClientRect()
  return r ? { y: Math.round(r.y), bottom: Math.round(r.bottom), w: Math.round(r.width) } : null
})
const absTop = box.iframe.y + qr.y
const absBottom = box.iframe.y + qr.bottom
const ok = absTop >= box.box.y - 2 && absBottom <= box.box.bottom + 2
console.log('二维码框:', JSON.stringify(box.box), '· iframe:', JSON.stringify(box.iframe))
console.log('二维码（换算到登录页坐标）:', `y${absTop}~${absBottom} (${qr.w}px)`)
console.log(ok ? 'page 模式修复生效：二维码完整落在框内 ✅' : '仍然被裁切 ❌')
await page.screenshot({ path: '/tmp/login-page-mode-check.png' })
await browser.close()
void token
