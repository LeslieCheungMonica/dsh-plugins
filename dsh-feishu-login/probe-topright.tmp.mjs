import { URL_BASE, cookieDescriptors, mintSession } from './scripts/live.mjs'
const playwright = await import('playwright')
const browser = await playwright.chromium.launch({ executablePath: process.env['CHROME'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.addCookies(cookieDescriptors(mintSession({ name: '探针' })))
const page = await context.newPage()
await page.goto(`${URL_BASE}/`, { waitUntil: 'load' })
await page.waitForTimeout(4000)
const info = await page.evaluate(() => {
  const out = []
  for (const el of document.querySelectorAll('button, a[role="button"], [role="button"]')) {
    const r = el.getBoundingClientRect()
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().slice(0, 40)
    if (!label) continue
    out.push({
      label,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      slot: el.closest('[data-slot]')?.getAttribute('data-slot') ?? null,
      cls: (el.className || '').toString().slice(0, 60),
      testid: el.getAttribute('data-testid') ?? null,
      proto: el.getAttribute('data-dsw') ?? null,
    })
  }
  // Anything in the top 120px of the viewport, right half.
  const topRight = out.filter(e => e.y < 120 && e.x > window.innerWidth / 2)
  return { total: out.length, topRight, logish: out.filter(e => /log|下载|download|export/i.test(e.label)).slice(0, 8) }
})
console.log(JSON.stringify(info, null, 1).slice(0, 2600))
await browser.close()
