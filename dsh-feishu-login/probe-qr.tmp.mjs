import { URL_BASE } from './scripts/live.mjs'
const playwright = await import('playwright')
const browser = await playwright.chromium.launch({ executablePath: process.env['CHROME'] })

/** Inspect whatever document is in `page`: does it look like a QR page? */
async function inspect(page, label) {
  const data = await page.evaluate(() => {
    const q = (sel) => document.querySelector(sel)
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } }
    const imgs = [...document.querySelectorAll('img')].slice(0, 6).map(i => ({
      src: (i.currentSrc || i.src || '').slice(0, 70), w: i.naturalWidth, h: i.naturalHeight, box: rect(i),
    }))
    const canvases = [...document.querySelectorAll('canvas')].map(c => ({ box: rect(c), tag: c.tagName }))
    const qrish = [...document.querySelectorAll('[class*=qr],[id*=qr],[class*=QR]')].slice(0, 6)
      .map(e => ({ tag: e.tagName, cls: (e.className || '').toString().slice(0, 50), box: rect(e) }))
    return {
      url: location.href.slice(0, 90),
      title: document.title,
      text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 260),
      imgs, canvases, qrish,
      iframes: [...document.querySelectorAll('iframe')].map(f => (f.src || '').slice(0, 90)),
      htmlLen: document.documentElement.innerHTML.length,
    }
  })
  console.log(`\n### ${label}\n` + JSON.stringify(data, null, 1))
  return data
}

// A) the real login page, exactly as the user sees it
const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } })
const page = await ctx.newPage()
const netFail = []
page.on('requestfailed', r => netFail.push(`${r.failure()?.errorText} ${r.url().slice(0, 70)}`))
await page.goto(`${URL_BASE}/login`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6000)
const frames = page.frames().filter(f => f !== page.mainFrame())
console.log('frames in the login page:', frames.length)
for (const f of frames) {
  try { await inspect(f, `iframe: ${f.url().slice(0, 70)}`) } catch (e) { console.log('iframe read error', String(e).split('\n')[0]) }
}
console.log('failed requests on the login page:', netFail.slice(0, 6))

// B) the same QR URL top-level, as a control
const qrSrc = /<iframe src="([^"]*qrconnect[^"]*)"/.exec((await (await fetch(`${URL_BASE}/login`)).text()).replaceAll('&amp;', '&'))?.[1]
const top = await ctx.newPage()
await top.goto(qrSrc, { waitUntil: 'domcontentloaded' }).catch(() => {})
await top.waitForTimeout(6000)
await inspect(top, 'top-level QR page (control)')
await browser.close()
