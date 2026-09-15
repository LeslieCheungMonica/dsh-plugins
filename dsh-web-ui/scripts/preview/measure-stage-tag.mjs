/**
 * Drive the stage tag's preview in a real browser: assert what it renders, and
 * screenshot it.
 *
 * The companion to `stage-tag.mjs`, and it exists for the two things a preview
 * page cannot say by itself:
 *
 * 1. **The sequence rules.** The tag's whole contract is positional — every
 *    stage behind the current one is checked, the current one is marked as
 *    running, everything ahead of it is grey, and clicking a node moves the
 *    project there. Those are DOM facts, so they are read back out of the
 *    rendered panel and compared against the model in `stage.ts`.
 * 2. **The geometry.** The connector rail is drawn by each row's pseudo-elements
 *    and has to land exactly on the node centres, and the portaled panel has to
 *    stay inside the viewport. A screenshot shows neither numerically.
 *
 * The page is SERVED over HTTP (a `file://` origin refuses `localStorage`, and
 * the tag's stage lives there), and each scenario seeds that stage before the
 * component first renders — through the app's own storage key, so the tag reads
 * it exactly as it reads a stage recorded by an earlier session.
 *
 * Usage: CHROME=<chromium> node scripts/preview/measure-stage-tag.mjs
 *        (CHROME is needed here: playwright's own browser download is absent.)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { STAGE_COUNT, STAGE_KEYS, stageStateAt } from '../../src/client/stage.ts'
import { zh } from '../../src/client/locales.ts'
import { decodePng, isGreen } from './pixel.mjs'

const EXECUTABLE = process.env['CHROME']
const preview = new URL('./stage-tag.html', import.meta.url).pathname
// Regenerate the artifact first: driving a stale preview is worse than useless.
execFileSync(process.execPath, [new URL('./stage-tag.mjs', import.meta.url).pathname], { stdio: 'inherit' })

const playwright = await import('playwright').catch(() => {
  console.error('measure-stage-tag: playwright is not resolvable from this package — see README, "Verifying".')
  process.exit(2)
})

const html = readFileSync(preview, 'utf8')

// A one-page server on an ephemeral port: the tag's stage is stored through
// localStorage, which needs a real origin.
const server = createServer((request, response) => {
  if (request.url === '/' || request.url === '/index.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(html)
    return
  }
  // The browser's own favicon request is not a page problem.
  if (request.url === '/favicon.ico') {
    response.writeHead(204)
    response.end()
    return
  }
  response.writeHead(404, { 'content-type': 'text/plain' })
  response.end('not found')
})
await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
const origin = `http://127.0.0.1:${server.address().port}/`

/** The expanded column's selectors: the rail renders a second tag, and a
    Playwright click is strict — two matches is an error, not a choice. */
const WIDE = '[data-wui="column"]:not([data-rail="true"]) '

const results = []
/**
 * Record one assertion.
 * @param name - what was checked.
 * @param ok - whether it held.
 * @param detail - what was observed.
 */
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }) }

const browser = await playwright.chromium.launch(EXECUTABLE === undefined ? {} : { executablePath: EXECUTABLE })
const problems = []

/**
 * Open the preview with a stage already recorded for both columns.
 * @param stage - the stage index to seed.
 * @returns the page, with the preview loaded.
 */
async function open(stage) {
  return openRaw(JSON.stringify({ 'demo-wide': stage, 'demo-rail': stage }))
}

/**
 * Open the preview with an arbitrary raw document in the tag's storage slot.
 * @param document - the exact string to store under the app's own key.
 * @returns the page, with the preview loaded.
 */
async function openRaw(document) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  page.on('pageerror', error => { problems.push(`pageerror: ${error.message}`) })
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`)
  })
  await page.addInitScript((stored) => {
    window.localStorage.setItem('dsh-web-ui.fde-stage', stored)
  }, document)
  await page.goto(origin, { waitUntil: 'load' })
  return page
}

/**
 * Read the panel, the tag, and every row out of the browser.
 *
 * One self-contained reader rather than several small ones: the numbers that
 * matter are RELATIVE (a node centre against its row's left edge, a node's
 * colour against its neighbour's), so they have to be read in one pass to
 * describe one layout.
 * @returns everything the assertions below look at.
 */
function readState() {
  const tag = document.querySelector('[data-wui="stageTag"]')
  const ring = tag.querySelector('[data-wui="stageRing"]')
  const panel = document.querySelector('[data-wui="stagePanel"]')
  const tagBox = tag.getBoundingClientRect()
  const panelBox = panel?.getBoundingClientRect()
  const rows = [...document.querySelectorAll('[data-wui="stageRow"]')].map((row) => {
    const node = row.querySelector('[data-wui="stageNode"]')
    const label = row.querySelector('[data-wui="stageLabel"]')
    const status = row.querySelector('[data-wui="stageStatus"]')
    const above = getComputedStyle(row, '::before')
    const below = getComputedStyle(row, '::after')
    const dot = node.getBoundingClientRect()
    const box = row.getBoundingClientRect()
    return {
      state: row.dataset['state'],
      label: label.textContent,
      status: status.textContent,
      check: node.querySelector('svg') !== null,
      checkSize: node.querySelector('svg')?.getAttribute('width') ?? null,
      ariaCurrent: row.querySelector('[data-wui="stageNodeButton"]').getAttribute('aria-current'),
      node: {
        fill: getComputedStyle(node).backgroundColor,
        border: Number.parseFloat(getComputedStyle(node).borderTopWidth),
        // The node's centre from the row's own left edge: the rail must be
        // centred on exactly this x, and the CSS derives it from the marker cell.
        centre: dot.left + dot.width / 2 - box.left,
      },
      labelColor: getComputedStyle(label).color,
      labelWeight: getComputedStyle(label).fontWeight,
      statusColor: getComputedStyle(status).color,
      rowFill: getComputedStyle(row).backgroundColor,
      above: { display: above.display, line: above.backgroundColor },
      below: { display: below.display, line: below.backgroundColor },
      top: box.top,
      bottom: box.bottom,
    }
  })
  return {
    rows,
    tag: {
      step: tag.dataset['step'],
      label: tag.querySelector('[data-wui="stageTagLabel"]')?.textContent ?? null,
      count: tag.querySelector('[data-wui="stageTagCount"]')?.textContent ?? null,
      ariaLabel: tag.getAttribute('aria-label'),
      expanded: tag.getAttribute('aria-expanded'),
      ringFill: getComputedStyle(ring).getPropertyValue('--wui-stage-fill').trim(),
      ring: ring.getBoundingClientRect().width,
      width: tagBox.width,
      height: tagBox.height,
    },
    panel: panel === null || panelBox === undefined ? null : {
      title: panel.querySelector('[data-wui="stagePanelTitle"]').textContent,
      scope: panel.querySelector('[data-wui="stagePanelScope"]').textContent,
      count: panel.querySelector('[data-wui="stagePanelCount"]').textContent,
      fill: getComputedStyle(panel).backgroundColor,
      inViewport: panelBox.top >= 0 && panelBox.left >= 0
        && panelBox.bottom <= window.innerHeight && panelBox.right <= window.innerWidth,
      gapBelowTag: Math.round(panelBox.top - tagBox.bottom),
      leftOfTag: Math.round(panelBox.left - tagBox.left),
    },
    stored: window.localStorage.getItem('dsh-web-ui.fde-stage'),
    // Where the column's own controls sit: the panel is an overlay, so opening
    // it must not move anything in the column.
    column: {
      newSession: document.querySelector('[data-wui="column"]:not([data-rail="true"]) [data-wui="newSession"]')
        .getBoundingClientRect().top,
      tag: tagBox.top,
    },
    text: document.body.innerText,
  }
}

/**
 * Seed a stage, open the panel from the expanded column's tag, and read it back.
 * @param stage - the stage index to seed.
 * @param click - whether to open the panel (false reads the closed tag alone).
 * @returns the page, what the browser reported, and the same read taken BEFORE
 * the panel opened (the no-reflow comparison).
 */
async function inspect(stage, click = true) {
  const page = await open(stage)
  const before = await page.evaluate(readState)
  if (click) await page.click(`${WIDE}[data-wui="stageTag"]`)
  // Past the panel's 140ms entry animation, so the measured box is the final one.
  await page.waitForTimeout(300)
  return { page, before, data: await page.evaluate(readState) }
}

/**
 * Assert one stage's rendering against the flow model in `stage.ts`.
 * @param name - the scenario's label.
 * @param stage - the seeded stage index.
 * @param data - what the browser reported.
 */
function checkModel(name, stage, data) {
  const labels = STAGE_KEYS.map(key => zh[key])
  check(`${name}: all six stages render, in delivery order`,
    JSON.stringify(data.rows.map(row => row.label)) === JSON.stringify(labels),
    data.rows.map(row => row.label).join(' → '))
  check(`${name}: every node is done / running / not-started by its position`,
    JSON.stringify(data.rows.map(row => row.state))
      === JSON.stringify(labels.map((_, index) => stageStateAt(index, stage))),
    data.rows.map(row => `${row.label}:${row.state}`).join(', '))
  check(`${name}: the tag names the current stage and its place in the flow`,
    data.tag.label === labels[stage] && data.tag.count === `${stage + 1}/${STAGE_COUNT}`
      && data.tag.step === String(stage),
    `${data.tag.label} ${data.tag.count} step=${data.tag.step}`)
  check(`${name}: the ring is filled to the reached share of the flow`,
    data.tag.ringFill === `${Number(((stage + 1) / STAGE_COUNT * 100).toFixed(3))}%`,
    data.tag.ringFill)
}

/* ── scenario 1: the default stage ─────────────────────────────────────── */

{
  const { page, data } = await inspect(0)
  checkModel('stage 1', 0, data)
  const first = data.rows[0]
  const last = data.rows[STAGE_COUNT - 1]
  check('stage 1: nothing is behind the first node, so it is the only one running',
    first.state === 'current' && data.rows.slice(1).every(row => row.state === 'pending'),
    data.rows.map(row => row.state).join(', '))
  check('the running node says so, in its own colour',
    first.status === zh['stage.status.current'] && first.statusColor !== first.labelColor,
    `${first.status} / ${first.statusColor}`)
  check('a node ahead of the running one is greyed out',
    last.status === zh['stage.status.pending'] && last.labelColor !== first.labelColor
      && last.labelColor !== data.rows[0].labelColor,
    `${last.labelColor} vs ${first.labelColor}`)
  check('the flow starts and ends at a node: no rail above the first or below the last',
    first.above.display === 'none' && last.below.display === 'none',
    `${first.above.display} / ${last.below.display}`)
  await page.screenshot({ path: new URL('./stage-tag-light.png', import.meta.url).pathname })
  await page.close()
}

/* ── scenario 2: mid-flow, where all three states are on screen ─────────── */

{
  const stage = 2
  const { page, before, data } = await inspect(stage)
  const current = data.rows[stage]
  const ahead = data.rows[stage + 1]
  checkModel('mid-flow', stage, data)
  check('mid-flow: the nodes behind the running one carry a check, the ones ahead do not',
    data.rows.every((row, index) => row.check === (index <= stage)),
    data.rows.map(row => `${row.label}:${row.check ? 'check' : 'empty'}`).join(', '))
  check('mid-flow: the running node is checked too — it is reached, and still running',
    current.check && current.checkSize === '13' && current.ariaCurrent === 'step',
    `check=${current.check} size=${current.checkSize} aria-current=${current.ariaCurrent}`)
  check('mid-flow: a reached node is a filled disc, an unreached one a hollow circle',
    current.node.fill !== 'rgba(0, 0, 0, 0)' && ahead.node.fill === 'rgba(0, 0, 0, 0)'
      && ahead.node.border > 0,
    `${current.node.fill} vs ${ahead.node.fill} + ${ahead.node.border}px border`)
  check('mid-flow: only the running row is tinted and bolded',
    data.rows.filter(row => row.rowFill !== 'rgba(0, 0, 0, 0)').length === 1
      && current.rowFill !== 'rgba(0, 0, 0, 0)' && current.labelWeight === '600'
      && data.rows[stage - 1].labelWeight !== '600' && ahead.labelWeight !== '600',
    `tint ${current.rowFill}, weight ${current.labelWeight}`)
  check('mid-flow: the rail is green into the running node and grey out of it',
    current.above.line === data.rows[0].above.line
      && data.rows.slice(1, stage + 1).every(row => row.above.line === current.above.line)
      && current.below.line !== current.above.line
      && data.rows.slice(stage + 1).every(row => row.below.line === current.below.line),
    `above ${current.above.line}, below ${current.below.line}`)
  check('mid-flow: the rail is centred on the node centres',
    data.rows.every(row => Math.abs(row.node.centre - 21) < 0.5),
    data.rows.map(row => row.node.centre.toFixed(2)).join(', '))
  check('mid-flow: the rows are flush, so neighbouring rail segments meet',
    data.rows.every((row, index) => index === 0
      || Math.abs(row.top - data.rows[index - 1].bottom) < 0.5),
    data.rows.map(row => `${row.top.toFixed(1)}-${row.bottom.toFixed(1)}`).join(' '))
  check('the panel names the flow and the project it belongs to',
    data.panel.title === zh['stage.flow.title'] && data.panel.scope === '订单中心重构'
      && data.panel.count === `${stage + 1} / ${STAGE_COUNT}`,
    `${data.panel.title} / ${data.panel.scope} / ${data.panel.count}`)
  check('the panel opens below the tag, aligned to it, inside the viewport',
    data.panel.inViewport && data.panel.gapBelowTag === 6 && data.panel.leftOfTag === 0,
    `gap ${data.panel.gapBelowTag}, dx ${data.panel.leftOfTag}, inside ${data.panel.inViewport}`)
  check('the tag announces its state to assistive tech',
    data.tag.expanded === 'true' && data.tag.ariaLabel === zh['stage.tag.label']
      .replace('{stage}', zh[STAGE_KEYS[stage]])
      .replace('{n}', String(stage + 1))
      .replace('{total}', String(STAGE_COUNT)),
    data.tag.ariaLabel)
  const focused = await page.evaluate(() => ({
    current: document.activeElement?.getAttribute('aria-current'),
    // The row's own text is the stage plus its status word.
    label: document.activeElement?.textContent ?? null,
  }))
  check('opening the panel moves focus onto the running stage',
    focused.current === 'step' && focused.label?.startsWith(zh[STAGE_KEYS[stage]]) === true,
    `${focused.label} (aria-current=${focused.current})`)
  check('the panel is an overlay: opening it moves nothing in the column',
    before.column.newSession === data.column.newSession && before.column.tag === data.column.tag
      && data.text.includes(zh['session.new']),
    `newSession ${before.column.newSession} → ${data.column.newSession}`)

  /* ── clicking a node moves the project there ─────────────────────────── */
  // Unscoped on purpose: the panel is portaled out of the column, and only one
  // panel can be open at a time (opening the rail's closes the expanded one's).
  await page.click('[data-wui="stageRow"]:nth-child(5) [data-wui="stageNodeButton"]')
  await page.waitForTimeout(80)
  const after = await page.evaluate(readState)
  check('clicking a node moves the project, and the tag follows immediately',
    after.tag.step === '4' && after.tag.label === zh['stage.deploy'] && after.panel !== null,
    `step ${after.tag.step} / ${after.tag.label}`)
  check('the panel re-states the flow around the new stage',
    JSON.stringify(after.rows.map(row => row.state))
      === JSON.stringify(STAGE_KEYS.map((_, index) => stageStateAt(index, 4))),
    after.rows.map(row => row.state).join(', '))
  check('the click is persisted, so a reload keeps the stage',
    JSON.parse(after.stored)['demo-wide'] === 4, after.stored)

  // Re-placing the panel hands it a fresh position object, which is a dependency
  // of the focus effect — so this asserts the once-per-open guard, not the CSS.
  const held = await page.evaluate(() => document.activeElement?.textContent ?? null)
  await page.evaluate(() => { window.dispatchEvent(new Event('scroll')) })
  await page.waitForTimeout(80)
  const stillHeld = await page.evaluate(() => document.activeElement?.textContent ?? null)
  check('re-placing the panel does not steal the keyboard back to the running stage',
    held === stillHeld && held?.startsWith(zh[STAGE_KEYS[4]]) === true, `${held} → ${stillHeld}`)

  /* ── dismissal ───────────────────────────────────────────────────────── */
  await page.keyboard.press('Escape')
  await page.waitForTimeout(80)
  check('Escape closes the panel',
    await page.evaluate(() => document.querySelector('[data-wui="stagePanel"]') === null))
  await page.click(`${WIDE}[data-wui="stageTag"]`)
  await page.waitForTimeout(80)
  // Outside means outside the panel: it opens BELOW the tag, so the button under
  // the tag is behind it — the project row above is the honest target.
  await page.click(`${WIDE}[data-wui="projectRow"]`)
  await page.waitForTimeout(80)
  check('a click outside closes the panel',
    await page.evaluate(() => document.querySelector('[data-wui="stagePanel"]') === null))
  await page.close()
}

/* ── scenario 3: everything reached ────────────────────────────────────── */

{
  const stage = STAGE_COUNT - 1
  const { page, data } = await inspect(stage)
  checkModel('last stage', stage, data)
  check('last stage: every node is checked, and only the last one is running',
    data.rows.slice(0, -1).every(row => row.state === 'done' && row.check)
      && data.rows[stage].state === 'current' && data.rows[stage].check,
    data.rows.map(row => `${row.state}${row.check ? '+' : '-'}`).join(', '))
  check('last stage: the rail is green all the way down',
    data.rows.filter(row => row.above.display !== 'none')
      .every(row => row.above.line === data.rows[1].above.line)
      && data.rows[STAGE_COUNT - 2].below.line === data.rows[1].above.line,
    data.rows[1].above.line)
  await page.close()
}

/* ── scenario 4: the rail, where the tag is the ring alone ─────────────── */

{
  const stage = 3
  const page = await open(stage)
  await page.waitForTimeout(200)
  const rail = await page.evaluate(() => {
    const tag = document.querySelector('[data-wui="column"][data-rail="true"] [data-wui="stageTag"]')
    const ring = tag.querySelector('[data-wui="stageRing"]')
    const box = tag.getBoundingClientRect()
    return {
      width: box.width,
      height: box.height,
      text: tag.textContent,
      ring: ring.getBoundingClientRect().width,
      fill: getComputedStyle(ring).getPropertyValue('--wui-stage-fill').trim(),
      ariaLabel: tag.getAttribute('aria-label'),
    }
  })
  check('the rail keeps the tag as a 36px square showing the ring alone',
    rail.width === 36 && rail.height === 36 && rail.ring === 18 && rail.text === '',
    `${rail.width}x${rail.height}, ring ${rail.ring}, text "${rail.text}"`)
  check('the rail tag still states the stage, to a screen reader',
    rail.ariaLabel === zh['stage.tag.label']
      .replace('{stage}', zh[STAGE_KEYS[stage]])
      .replace('{n}', String(stage + 1))
      .replace('{total}', String(STAGE_COUNT)),
    rail.ariaLabel)
  check('the rail keeps the ring honest about the reached share', rail.fill === '66.667%', rail.fill)
  await page.click('[data-wui="column"][data-rail="true"] [data-wui="stageTag"]')
  await page.waitForTimeout(300)
  const panel = await page.evaluate(() => {
    const box = document.querySelector('[data-wui="stagePanel"]').getBoundingClientRect()
    const tag = document.querySelector('[data-wui="column"][data-rail="true"] [data-wui="stageTag"]').getBoundingClientRect()
    return {
      rows: document.querySelectorAll('[data-wui="stageRow"]').length,
      inside: box.left >= 0 && box.right <= window.innerWidth
        && box.top >= 0 && box.bottom <= window.innerHeight,
      gap: Math.round(box.top - tag.bottom),
    }
  })
  check('the rail tag opens the whole flow, clamped inside the viewport',
    panel.rows === STAGE_COUNT && panel.inside && panel.gap === 6,
    `${panel.rows} rows, gap ${panel.gap}, inside ${panel.inside}`)
  await page.screenshot({ path: new URL('./stage-tag-rail.png', import.meta.url).pathname })
  await page.close()
}

/* ── scenario 6: what actually got PAINTED ─────────────────────────────────
   Every check above reads computed styles, and a computed style is a promise,
   not a picture: a masked conic-gradient ring, a white glyph on a green disc,
   and a tinted row can all compute correctly and still paint nothing. Nothing in
   this deployment can look at a screenshot (every configured model takes text
   only), so the screenshot is decoded and sampled instead — see pixel.mjs. */

{
  const stage = 2
  const { page, data } = await inspect(stage)
  const geometry = await page.evaluate(() => {
    const tag = document.querySelector('[data-wui="stageTag"]')
    const ring = tag.querySelector('[data-wui="stageRing"]')
    const rows = [...document.querySelectorAll('[data-wui="stageRow"]')]
    const centre = element => {
      const box = element.getBoundingClientRect()
      return { x: box.left + box.width / 2, y: box.top + box.height / 2, box }
    }
    return {
      ring: centre(ring),
      nodes: rows.map(row => centre(row.querySelector('[data-wui="stageNode"]'))),
      rows: rows.map(row => {
        const box = row.getBoundingClientRect()
        return { left: box.left, right: box.right, centreY: box.top + box.height / 2 }
      }),
    }
  })
  const image = decodePng(await page.screenshot())
  const at = (x, y) => image.at(Math.round(x), Math.round(y))
  const show = colour => `rgb(${colour.r}, ${colour.g}, ${colour.b})`

  // A ring, not a disc: the conic fill starts at twelve o'clock and runs
  // clockwise, so two thirds of the way round is still bare at half-reached.
  const ringFilled = at(geometry.ring.x + 4.8, geometry.ring.y - 4.8)
  const ringBare = at(geometry.ring.x - 4.8, geometry.ring.y - 4.8)
  check('the tag paints a green arc, and leaves the unreached share bare',
    isGreen(ringFilled) && !isGreen(ringBare), `${show(ringFilled)} vs ${show(ringBare)}`)

  // The rail, on the two sides of the running node.
  const railAbove = at(geometry.rows[1].left + 20, (geometry.nodes[1].y + geometry.nodes[2].y) / 2)
  const railBelow = at(geometry.rows[2].left + 20, (geometry.nodes[2].y + geometry.nodes[3].y) / 2)
  check('the rail is painted green into the running node and grey out of it',
    isGreen(railAbove) && !isGreen(railBelow), `${show(railAbove)} vs ${show(railBelow)}`)

  // A reached node: a green disc...
  const disc = at(geometry.nodes[0].x, geometry.nodes[0].y - 6)
  check('a reached node is painted as a green disc', isGreen(disc), show(disc))

  // ...carrying a WHITE check. Counted over the glyph's own box rather than
  // sampled at one pixel: the shipped check is an OUTLINE, so the question is
  // not "is one pixel white" but "did a glyph get painted at all".
  const glyph = []
  for (let dy = -5; dy <= 5; dy += 1) {
    for (let dx = -5; dx <= 5; dx += 1) {
      const colour = at(geometry.nodes[0].x + dx, geometry.nodes[0].y + dy)
      if (colour.r > 200 && colour.g > 200 && colour.b > 200) glyph.push(colour)
    }
  }
  check('the check inside a reached node is painted white on it',
    glyph.length >= 5, `${glyph.length} painted pixels inside an 18px disc`)

  // An unreached node: a hollow circle over the panel's own surface.
  const hollow = at(geometry.nodes[3].x, geometry.nodes[3].y)
  check('an unreached node is painted hollow, not filled',
    hollow.r > 240 && hollow.g > 240 && hollow.b > 240, show(hollow))

  // The running row is the only tinted one — the highlight the flow is read by.
  const runningTint = at(geometry.rows[stage].left + 6, geometry.rows[stage].centreY)
  const doneRow = at(geometry.rows[0].left + 6, geometry.rows[0].centreY)
  const tinted = colour => colour.g > colour.r && colour.g > colour.b && colour.r > 200
  check('the running row is the only row painted with a tint',
    tinted(runningTint) && !tinted(doneRow) && doneRow.r > 240,
    `${show(runningTint)} vs ${show(doneRow)}`)
  await page.close()
}

/* ── scenario 5: the dark theme ────────────────────────────────────────── */

{
  const stage = 2
  const { page, data } = await inspect(stage)
  const light = { tint: data.rows[stage].rowFill, panel: data.panel.fill, label: data.rows[0].labelColor }
  await page.screenshot({ path: new URL('./stage-tag-mid.png', import.meta.url).pathname })
  await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
  // Past the row's 120ms background transition: the settled colour is the point.
  await page.waitForTimeout(250)
  const dark = await page.evaluate(() => ({
    tint: getComputedStyle(document.querySelector('[data-wui="stageRow"][data-state="current"]')).backgroundColor,
    panel: getComputedStyle(document.querySelector('[data-wui="stagePanel"]')).backgroundColor,
    label: getComputedStyle(document.querySelector('[data-wui="stageLabel"]')).color,
  }))
  check('the dark theme re-tints the flow rather than reusing the light colours',
    dark.tint !== light.tint && dark.panel !== light.panel && dark.label !== light.label,
    `light ${light.tint} / ${light.panel} / ${light.label} → dark ${dark.tint} / ${dark.panel} / ${dark.label}`)
  await page.screenshot({ path: new URL('./stage-tag-dark.png', import.meta.url).pathname })
  await page.close()
}

/* ── scenario 7: a record this plugin cannot trust ─────────────────────────
   The stage is the operator's own note, and a note is occasionally garbage: a
   truncated write, a value from a version that had more stages, a hand-edited
   document. None of that may take the column down, and the NEXT click must be
   able to write a clean record — so both halves are asserted here. */

{
  const page = await openRaw(JSON.stringify({ 'demo-wide': 99, 'demo-rail': -1 }))
  const clamped = await page.evaluate(() => [...document.querySelectorAll('[data-wui="stageTag"]')]
    .map(tag => tag.dataset['step']))
  check('a stored stage outside the flow is clamped rather than rendered',
    clamped.join(',') === `${STAGE_COUNT - 1},0`, clamped.join(', '))
  await page.close()
}

{
  const page = await openRaw('{ this is not json')
  const step = await page.evaluate(() => document.querySelector('[data-wui="stageTag"]').dataset['step'])
  check('an unreadable record falls back to the first stage, without an error',
    step === '0' && problems.length === 0, `step ${step}, ${problems.length} page problems`)
  await page.click(`${WIDE}[data-wui="stageTag"]`)
  await page.click('[data-wui="stageRow"]:nth-child(3) [data-wui="stageNodeButton"]')
  const repaired = await page.evaluate(() => window.localStorage.getItem('dsh-web-ui.fde-stage'))
  check('the next click writes a clean record over the unreadable one',
    JSON.parse(repaired)['demo-wide'] === 2, repaired)
  await page.close()
}

await browser.close()
server.close()

const failures = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.name}${result.detail === '' ? '' : `\n      ${result.detail}`}`)
}
for (const problem of problems) console.log(`page problem: ${problem}`)
console.log(`\n${results.length - failures.length} checks passed${failures.length === 0 ? '' : `, ${failures.length} FAILED`}`)
writeFileSync(
  new URL('./stage-tag-report.json', import.meta.url).pathname,
  `${JSON.stringify({ results, problems }, null, 2)}\n`,
)
process.exit(failures.length === 0 && problems.length === 0 ? 0 : 1)
