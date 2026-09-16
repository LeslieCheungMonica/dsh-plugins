/**
 * Measure the skills modal's CARD GRID in a real browser, and screenshot it.
 *
 * The complaint this was written for is a layout one — cards in the installed
 * block's 公共 tab do not line up — and jsdom cannot see it: alignment is a
 * property of a layout engine, not of a DOM. So this page loads the REAL
 * stylesheet (`src/client/styles.ts`, the same string the plugin injects) against
 * the component's REAL DOM shape, and reports each card's box so "not aligned" is
 * a number rather than an impression.
 *
 * It is a static page rather than the real React tree on purpose: one bundle of
 * React, the shipped primitives and the plugin's client half is a lot of machinery
 * to look at a grid, and the question here is what the STYLESHEET does with the
 * markup the component emits. The markup below is copied from `SkillsDialog.tsx`
 * attribute for attribute, so the thing under test is the same thing the modal
 * renders.
 *
 * Usage: CHROME=<chromium> node scripts/preview/skills-cards.mjs [--keep]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STYLES } from '../../src/client/styles.ts'

/**
 * The host modal's own stylesheet, read from the package (not copied).
 *
 * It matters here for ONE rule: `.dialog { width: min(380px, 100%) }`. The plugin
 * widens the dialog through a class plus `:has()`, and whether that override WINS is
 * a cascade question no jsdom render can answer — so the page carries the host's real
 * card and measures the width that comes out.
 */
const MODAL_CSS = readFileSync(
  new URL('../../node_modules/@deepseek-ai/dsh-client-ui-primitives/src/Modal.module.css', import.meta.url),
  'utf8',
)

const EXECUTABLE = process.env['CHROME']
const playwright = await import('playwright').catch(() => {
  console.error('skills-cards: playwright is not resolvable from this package — see README, "Verifying".')
  process.exit(2)
})

/** One installed card, in the 公共 tab: name, a source tag, a description. */
const installedCard = (name, tag, description, lines) => `
  <li data-wui="skillCard">
    <span data-wui="skillCardHead">
      <strong data-wui="skillName">${name}</strong>
      ${tag === null ? '' : `<span data-wui="skillTag">${tag}</span>`}
    </span>
    <p data-wui="skillDescription">${description}${' 补充说明'.repeat(lines)}</p>
  </li>`

/** One marketplace card: the same, plus an action row. */
/** One marketplace card: the same, plus the identity line and an action row. */
const marketCard = (name, tag, description, lines, busy, meta) => `
  <li data-wui="skillMarketCard">
    <span data-wui="skillCardHead">
      <strong data-wui="skillName">${name}</strong>
      ${tag === null ? '' : `<span data-wui="skillTag">${tag}</span>`}
    </span>
    ${description === null ? '' : `<p data-wui="skillDescription">${description}${' 补充说明'.repeat(lines)}</p>`}
    ${meta === null ? '' : `<span data-wui="skillMeta">${meta}</span>`}
    <span data-wui="skillCardActions">
      ${busy ? '<span data-wui="skillInstallDone">已安装</span>' : '<button type="button" data-wui="skillInstallButton">安装</button>'}
    </span>
  </li>`

// The host's CSS-module class names are hashed in the real bundle; the NAME does not
// matter for specificity (one class is one class), only the shape does, so the
// page keeps them as written.
const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>skills cards</title>
<style>${MODAL_CSS}</style>
<style>${STYLES}</style>
<style>
  /* The modal's own card geometry, from the shipped primitives, so the grids are
     measured at the width the modal gives them (720px minus the 24px pads). */
  body { margin: 0; padding: 24px; background: var(--dsw-alias-bg-layer-2, #fff); font-family: system-ui, sans-serif; }
</style>
</head><body>
<!-- The dialog exactly as the host's Modal renders it: mask, then the card whose
     class the plugin's widening rule targets, then the body the content sits in. -->
<div class="root" role="presentation">
  <div class="mask" aria-hidden="true"></div>
  <div class="dialog dsh-web-ui-skills" role="dialog" aria-modal="true" aria-label="技能">
  <div class="content"><div class="body">
<div data-wui="skillsDialog">
  <div data-wui="skillSearch">
    <span data-wui="skillSearchField"><input type="text" placeholder="搜索技能" value=""></span>
  </div>
  <section data-wui="skillInstalled">
    <div data-wui="skillInstalledHeading"><h3>已安装的技能</h3><span>4</span></div>
    <nav data-wui="skillTabs" role="tablist">
      <button type="button" role="tab" data-wui="skillTab" data-active="true">公共</button>
      <button type="button" role="tab" data-wui="skillTab">个人</button>
    </nav>
    <div data-wui="skillPane" role="tabpanel">
      <ul data-wui="skillGrid">
        ${installedCard('project-skill', '项目', '项目自带的。', 0)}
        ${installedCard('linked-skill', '共享', '根据需求文档生成测试用例，支持 Markdown 源文件输出，并可自动转换为 FreeMind、Excel 等其他格式。融合 ISTQB 标准测试设计方法，确保业务规则全覆盖。', 0)}
        ${installedCard('flat-skill', '项目', '单文件的技能。', 1)}
        ${installedCard('another-skill', '共享', '另一个很短的简介。', 0)}
      </ul>
    </div>
  </section>
  <div data-wui="skillDivider" role="separator"></div>
  <section data-wui="skillMarket">
    <div data-wui="skillMarketHeading"><h3>技能市场</h3><span>3</span></div>
    <p data-wui="skillMarketIdentity">以 li.yh9@asiainfo-sec.com 的身份读取。</p>
    <ul data-wui="skillMarketGrid">
      ${marketCard('命名空间测试', null, null, 0, true, 'ywaqtest/jcbfai7e · v2.0.3')}
      ${marketCard('权限测试', null, null, 0, false, 'global/fquulq4i · v2.0.3')}
      ${marketCard('一个名字很长的技能用于把标题挤到换行', null, '一段描述。', 3, false, 'fde/long-name-skill · v20260805.022120')}
      ${marketCard('有包内描述的技能', null, '根据需求文档生成测试用例，支持 Markdown 源文件输出，并可自动转换为 FreeMind、Excel 等其他格式。', 0, false, 'fde/k8s-ops · v1.0.0')}
    </ul>
  </section>
</div>
  </div></div>
  </div>
</div>
</body></html>`

const path = join(tmpdir(), 'dsh-web-ui-skills-cards.html')
writeFileSync(path, page, 'utf8')
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(readFileSync(path))
})
await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
const port = server.address().port

const browser = await playwright.chromium.launch(EXECUTABLE === undefined ? {} : { executablePath: EXECUTABLE })
// A GUI-ish viewport: the dialog is 936px, and the modal layer pads 24px a side, so
// anything narrower than 984px measures the CAP rather than the width under test.
const WIDE = { width: 1440, height: 1000 }
// And a narrow one, where the cap is the whole point: the dialog must shrink rather
// than overflow.
const NARROW = { width: 700, height: 1000 }
const view = await browser.newPage({ viewport: WIDE })
await view.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })

/** Every card's box, grouped by grid, with the row it landed in. */
const boxes = await view.evaluate(() => {
  const read = (grid) => [...document.querySelectorAll(`${grid} > li`)].map((card) => {
    const rect = card.getBoundingClientRect()
    const name = card.querySelector('[data-wui="skillName"]')?.textContent ?? ''
    const action = card.querySelector('[data-wui="skillCardActions"]')
    const description = card.querySelector('[data-wui="skillDescription"]')
    const head = card.querySelector('[data-wui="skillCardHead"]')
    const tag = card.querySelector('[data-wui="skillTag"]')
    return {
      name: name.slice(0, 12),
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      height: Math.round(rect.height),
      headH: head === null ? null : Math.round(head.getBoundingClientRect().height),
      descH: description === null ? null : Math.round(description.getBoundingClientRect().height),
      metaH: card.querySelector('[data-wui="skillMeta"]') === null ? null : Math.round(card.querySelector('[data-wui="skillMeta"]').getBoundingClientRect().height),
      tagTop: tag === null ? null : Math.round(tag.getBoundingClientRect().top),
      actionTop: action === null ? null : Math.round(action.getBoundingClientRect().top),
    }
  })
  return { installed: read('[data-wui="skillGrid"]'), market: read('[data-wui="skillMarketGrid"]') }
})

/**
 * Report, per grid, how ragged the cards are.
 * @param {string} label - the grid's name.
 * @param {Array<object>} cards - its cards in DOM order (two per row).
 * @returns {boolean} whether every row's bottoms line up.
 */
const report = (label, cards) => {
  console.log(`\n${label}`)
  for (const card of cards) {
    console.log(`  ${String(card.name).padEnd(14)} top=${String(card.top).padStart(4)} bottom=${String(card.bottom).padStart(4)} h=${String(card.height).padStart(3)} head=${String(card.headH).padStart(3)} desc=${String(card.descH).padStart(3)} meta=${String(card.metaH).padStart(3)}${card.tagTop === null ? '' : ` tagTop=${String(card.tagTop).padStart(4)}`}${card.actionTop === null ? '' : ` actionTop=${String(card.actionTop).padStart(4)}`}`)
  }
  let aligned = true
  // Cards are two per row, so a row is a pair; a row is aligned when both bottoms
  // are equal, and the actions (when both have one) sit at the same height.
  for (let index = 0; index + 1 < cards.length; index += 2) {
    const a = cards[index]
    const b = cards[index + 1]
    const bottomsMatch = a.bottom === b.bottom
    const actionsMatch = a.actionTop === null || b.actionTop === null || a.actionTop === b.actionTop
    if (!bottomsMatch || !actionsMatch) aligned = false
    console.log(`  row ${String(index / 2 + 1)}: bottoms ${bottomsMatch ? 'aligned' : `RAGGED (${String(a.bottom)} vs ${String(b.bottom)})`}${a.actionTop === null ? '' : `, actions ${actionsMatch ? 'aligned' : `RAGGED (${String(a.actionTop)} vs ${String(b.actionTop)})`}`}`)
  }
  return aligned
}

const narrow = await (async () => {
  await view.setViewportSize(NARROW)
  const width = await view.evaluate(() => Math.round(document.querySelector('.dialog.dsh-web-ui-skills').getBoundingClientRect().width))
  await view.setViewportSize(WIDE)
  return width
})()

const dialog = await view.evaluate(() => {
  const card = document.querySelector('.dialog.dsh-web-ui-skills')
  const rect = card.getBoundingClientRect()
  return { width: Math.round(rect.width), computed: getComputedStyle(card).width }
})
// 936 = 720 + 30%. The host's own rule is min(380px, 100%), so a measurement of
// either 380 or the padded viewport width means the override did not apply.
const EXPECTED = 936
const EXPECTED_NARROW = NARROW.width - 48
console.log(`\ndialog at ${String(WIDE.width)}px viewport: ${String(dialog.computed)} (measured ${String(dialog.width)}px)`)
console.log(`dialog at ${String(NARROW.width)}px viewport: ${String(narrow)}px`)
const widthOk = dialog.width === EXPECTED
if (!widthOk) console.log(`  ✗ expected ${String(EXPECTED)}px — the widening rule lost the cascade, or the number moved`)
const capOk = narrow === EXPECTED_NARROW
if (!capOk) console.log(`  ✗ expected the narrow viewport to cap it at ${String(EXPECTED_NARROW)}px`)

const installedAligned = report('已安装 / 公共 (skillGrid)', boxes.installed)
const marketAligned = report('技能市场 (skillMarketGrid)', boxes.market)

// Into the ignored `out/` directory: the screenshot is evidence for a measurement
// run, not an artifact of the repo (the committed ones under `preview/` illustrate
// surfaces a reader cannot run).
const out = new URL('./out', import.meta.url).pathname
mkdirSync(out, { recursive: true })
const shot = join(out, 'skills-cards.png')
await view.screenshot({ path: shot, fullPage: true })
console.log(`\nscreenshot: ${shot}`)

await browser.close()
server.close()
console.log(`\nRESULT: dialog ${widthOk ? `${String(dialog.width)}px` : `WRONG WIDTH (${String(dialog.width)}px)`}${capOk ? `, capped to ${String(narrow)}px when narrow` : `, BAD CAP (${String(narrow)}px)`} · installed ${installedAligned ? 'aligned' : 'NOT aligned'} · market ${marketAligned ? 'aligned' : 'NOT aligned'}`)
process.exit(widthOk && capOk && installedAligned && marketAligned ? 0 : 1)
