/**
 * Drive the stage tag's preview in a real browser: assert what it renders, and
 * screenshot it.
 *
 * The companion to `stage-tag.mjs`, and it exists for the two things a preview
 * page cannot say by itself:
 *
 * 1. **The sequence rules.** The tag's whole contract is positional — every
 *    stage behind the current one is checked, the current one is marked as
 *    running, everything ahead of it is grey — and the MOVE is positional too:
 *    only the next node is enterable, every other row is locked
 *    (`isStageLocked`), and a gated transition is checked against the host before
 *    it moves. Those are DOM facts, so they are read back out of the rendered
 *    panel and compared against the model in `stage.ts`.
 * 2. **The geometry.** The connector rail is drawn by each row's pseudo-elements
 *    and has to land exactly on the node centres, and the portaled panel has to
 *    stay inside the viewport. A screenshot shows neither numerically.
 *
 * The page is SERVED over HTTP (a `file://` origin refuses `localStorage`, and
 * the tag's stage lives there), and each scenario seeds that stage before the
 * component first renders — through the app's own storage key, so the tag reads
 * it exactly as it reads a stage recorded by an earlier session.
 *
 * That server also answers the STAGE GATE's two routes (`gateAnswer` /
 * `confirmAnswer` below), because the gate's verdict arrives from a host: a
 * preview that could not answer them would only ever exercise the refusal path,
 * while the pass, the block and the manual answer are all part of the contract
 * this script pins down.
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

/** Every gate check the page made, in order (the tag's own request). */
const gateRequests = []

/**
 * What the gate route answers, per scenario.
 *
 * A mutable cell rather than a fixed answer, because the interesting half of the
 * gate is that the SAME click blocks or moves depending on what the host says —
 * including after a retry, which is the whole point of the card's own button.
 */
let gateAnswer = report({ status: 'passed', items: [item('requirement-analysis'), item('feature-list'), item('html-demo')] })

/**
 * Every confirmation the page recorded, in order.
 *
 * Cleared per scenario by `clearWrites()`, because the interesting assertion is
 * usually "how many writes did THIS decision produce".
 */
const confirmRequests = []

/**
 * Forget the recorded writes.
 *
 * Called per scenario, because the interesting assertion is usually "how many
 * writes did THIS decision produce" — the array is global to the run.
 */
function clearWrites() {
  confirmRequests.length = 0
}

/**
 * Forget the recorded gate checks.
 *
 * Same reason as `clearWrites`, and it matters more: every scenario's dialog asks
 * the host, so an assertion on `gateRequests[0]` would be reading the PREVIOUS
 * scenario's request.
 */
function clearChecks() {
  gateRequests.length = 0
}

/** Reset both request logs: what one scenario observed is its own. */
function clearRequests() {
  clearChecks()
  clearWrites()
}

/**
 * One item verdict.
 * @param id - the item id.
 * @param met - whether the folder holds it.
 * @returns the wire item.
 */
function item(id, met = true, options = {}) {
  const source = options.source ?? 'folder'
  const workspaceFile = source === 'workspace'
  return {
    id,
    source,
    met,
    evidence: met
      ? (workspaceFile
        // A workspace artifact: no link (a page cannot open a file on the host) and
        // a size, which is what says it is a real build rather than a placeholder.
        ? { name: options.name ?? `${id}-1.2.0.dmg`, url: '', path: options.path ?? `/dist/${id}-1.2.0.dmg`, directory: false, sizeBytes: options.sizeBytes ?? 42_949_672 }
        : { name: options.name ?? `${id} 输出物.docx`, url: `https://example.feishu.cn/docx/${id}`, path: `/${id}`, directory: false, sizeBytes: 0 })
      : null,
    matches: met ? 1 : 0,
  }
}

/**
 * One manual item's answer, as the host reports it.
 * @param input - whether it is confirmed, by whom, and when.
 * @returns the wire confirmation.
 */
function confirmation(input = {}) {
  return {
    item: 'customer-confirmation',
    confirmed: input.confirmed === true,
    by: input.confirmed === true ? (input.by ?? '') : '',
    at: input.confirmed === true ? (input.at ?? 1_760_000_000_000) : 0,
  }
}

/**
 * One report.
 * @param input - the verdict's knobs.
 * @returns the wire report.
 */
function report(input) {
  return {
    ok: true,
    report: {
      gate: 'requirement-to-design',
      status: input.status,
      reason: input.reason ?? null,
      items: input.items,
      // The manual items travel beside the folder items: the dialog asks about
      // these, and a report without them would render as "nothing to ask".
      confirmations: input.confirmations ?? [confirmation()],
      // Where the local half was read from. `null` is a gate with no workspace
      // items; `readable: false` is a directory this host could not enter.
      workspace: input.workspace === undefined
        ? { path: '/tmp/dsh-web-ui-preview/订单中心重构', readable: true }
        : input.workspace,
      folder: input.folder === undefined
        ? { name: '订单中心重构', url: 'https://example.feishu.cn/drive/folder/fldpreview' }
        : input.folder,
      truncated: input.truncated === true,
    },
  }
}

// A one-page server on an ephemeral port: the tag's stage is stored through
// localStorage, which needs a real origin.
const server = createServer((request, response) => {
  if (request.url === '/' || request.url === '/index.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(html)
    return
  }
  if (request.url?.startsWith('/dsh-web-ui/stage-gate/check') === true) {
    gateRequests.push(request.url)
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(gateAnswer))
    return
  }
  if (request.url === '/dsh-web-ui/stage-gate/confirm' && request.method === 'POST') {
    // The body arrives asynchronously, so the answer is written from the request's
    // own events rather than from a value read here.
    let body = ''
    request.on('data', (chunk) => { body += String(chunk) })
    request.on('end', () => {
      const asked = JSON.parse(body)
      confirmRequests.push(asked)
      // The answer mirrors the request, the way the real host does: recording a
      // `true` stores a citation, and a `false` clears the entry. The operator's
      // name is resolved server-side there, so it is filled in here as the host
      // would have.
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({
        ok: true,
        confirmation: confirmation({ confirmed: asked.confirmed === true, by: '李彦辉' }),
      }))
    })
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
    const button = row.querySelector('[data-wui="stageNodeButton"]')
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
      ariaCurrent: button.getAttribute('aria-current'),
      // The lock is the flow's second positional rule: everything that is
      // neither the current stage nor the next one offers no move at all.
      locked: button.dataset['locked'] === 'true',
      disabled: button.disabled,
      title: button.getAttribute('title'),
      // The flow's END marker (see stage.ts / the stylesheet).
      final: row.dataset['final'] === 'true',
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
  // The gate: a MODAL over the page now, not a card in the panel (see
  // StageGateDialog.tsx). Everything below is read from the dialog itself.
  const dialog = document.querySelector('[data-wui="gateDialog"]')
  const enter = dialog?.querySelector('[data-wui="gateEnter"]')
  const manual = dialog?.querySelector('[data-wui="gateManual"]')
  return {
    rows,
    gate: dialog === null || dialog === undefined ? null : {
      // The mask is what makes it modal: without it the page underneath would
      // still be clickable while a decision is pending.
      mask: document.querySelector('[data-wui="gateOverlay"]') !== null,
      // Portaled to the body, and NOT inside the flow panel: a click on a node
      // opens a page dialog, not a wider panel.
      portaled: dialog.parentElement === document.body
        || dialog.parentElement?.parentElement === document.body,
      insidePanel: document.querySelector('[data-wui="stagePanel"]')?.contains(dialog) === true,
      ariaModal: dialog.getAttribute('aria-modal'),
      title: dialog.querySelector('[data-wui="gateTitle"]').textContent,
      target: dialog.querySelector('[data-wui="gateTarget"]').textContent,
      notes: [...dialog.querySelectorAll('[data-wui="gateNote"]')].map(note => note.textContent),
      // The workspace warning is a note with the warn tone, which is how the
      // unreadable case is told apart from the ordinary sentences.
      warnNotes: [...dialog.querySelectorAll('[data-wui="gateNote"][data-tone="warn"]')].map(note => note.textContent),
      items: [...dialog.querySelectorAll('[data-wui="gateItem"]')].map(row => ({
        met: row.dataset['met'] === 'true',
        source: row.dataset['source'],
        label: row.querySelector('[data-wui="gateItemLabel"]').textContent,
        badge: row.querySelector('[data-wui="gateItemBadge"]')?.textContent ?? null,
        // Linked evidence (Feishu) is a button; a host file is plain text with its
        // size, which is the whole difference between the two sources on screen.
        evidence: row.querySelector('[data-wui="gateEvidence"]')?.textContent ?? null,
        evidencePath: row.querySelector('[data-wui="gateEvidence"]')?.getAttribute('title') ?? null,
        proof: row.querySelector('[data-wui="gateItemProof"]')?.textContent ?? null,
        proofPath: row.querySelector('[data-wui="gateItemProof"]')?.getAttribute('title') ?? null,
        note: row.querySelector('[data-wui="gateItemNote"]')?.textContent ?? null,
      })),
      manual: manual === null || manual === undefined ? null : {
        met: manual.dataset['met'] === 'true',
        label: manual.querySelector('[data-wui="gateItemLabel"]').textContent,
        badge: manual.querySelector('[data-wui="gateItemNote"]')?.textContent ?? null,
        question: manual.querySelector('[data-wui="gateManualQuestion"]').textContent,
        choices: [...manual.querySelectorAll('[data-wui="gateChoice"]')].map(choice => ({
          label: choice.textContent,
          checked: choice.dataset['checked'] === 'true',
        })),
        note: manual.querySelector('[data-wui="gateManualRecord"]')?.textContent
          ?? [...manual.querySelectorAll('[data-wui="gateItemNote"]')].pop()?.textContent
          ?? null,
        withdraw: manual.querySelector('[data-wui="gateWithdraw"]') !== null,
      },
      folder: dialog.querySelector('[data-wui="gateFolder"]') !== null,
      retry: dialog.querySelector('[data-wui="gateRetry"]') !== null,
      retryDisabled: dialog.querySelector('[data-wui="gateRetry"]')?.disabled ?? null,
      enterLabel: enter?.textContent ?? null,
      enterDisabled: enter?.disabled ?? null,
      box: (() => {
        const box = dialog.getBoundingClientRect()
        return { top: box.top, bottom: box.bottom, inside: box.top >= 0 && box.bottom <= window.innerHeight }
      })(),
    },
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
 * Click one node of the open flow panel.
 *
 * Through the DOM rather than through Playwright's own click, and that is not a
 * shortcut: a LOCKED row is a `disabled` button, which Playwright refuses to
 * click (it waits for enabled and times out) and which the browser itself
 * swallows — so `element.click()` on a disabled button is the strongest possible
 * statement that the click does nothing, and it is the behaviour under test.
 * @param page - the page holding an open panel.
 * @param index - the stage index whose row to click.
 */
async function clickNode(page, index) {
  await page.evaluate((nth) => {
    document.querySelector(`[data-wui="stageRow"]:nth-child(${String(nth)}) [data-wui="stageNodeButton"]`)?.click()
  }, index + 1)
}

/**
 * Answer the dialog's manual item.
 *
 * Clicked on the label's own text (the chip wraps its input, so the whole chip is
 * the hit target) — which is what an operator does, and what proves the radio is
 * reachable without a mouse aimed at a 12px dot.
 * @param page - the page holding the open dialog.
 * @param which - which answer to pick.
 */
async function answerManual(page, which) {
  await page.click(`[data-wui="gateManual"] [data-wui="gateChoice"]:nth-child(${which === 'yes' ? 1 : 2}) span`)
}

/**
 * Assert one stage's rendering against the flow model in `stage.ts`.
 * @param name - the scenario's label.
 * @param stage - the seeded stage index.
 * @param data - what the browser reported.
 */function checkModel(name, stage, data) {
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
  /* The flow's END is PAINTED differently while it is still ahead: a second
     hairline ring, which is what makes 完成 read as the destination the line runs
     to rather than as one more step. Sampled just OUTSIDE the marker, where an
     ordinary unreached node shows the panel's own surface. */
  const probes = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-wui="stageRow"]')]
    const centreOf = (row) => {
      const node = row.querySelector('[data-wui="stageNode"]').getBoundingClientRect()
      return { x: node.left + node.width / 2, y: node.top + node.height / 2 }
    }
    return { terminal: centreOf(rows[rows.length - 1]), plain: centreOf(rows[rows.length - 2]) }
  })
  const lightImage = decodePng(await page.screenshot())
  const outsideMarker = probe => lightImage.at(Math.round(probe.x + 10), Math.round(probe.y))
  const terminalPixel = outsideMarker(probes.terminal)
  const plainPixel = outsideMarker(probes.plain)
  const showRing = colour => `rgb(${colour.r}, ${colour.g}, ${colour.b})`
  check('the terminal node is painted with its own end-of-flow ring while it is ahead',
    terminalPixel.r !== plainPixel.r || terminalPixel.g !== plainPixel.g || terminalPixel.b !== plainPixel.b,
    `terminal ${showRing(terminalPixel)} vs plain ${showRing(plainPixel)}`)
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

  /* ── the move is ONE step, and only the next node offers it ───────────── */
  const gateRequestsBefore = gateRequests.length
  await clickNode(page, stage + 2)
  await page.waitForTimeout(120)
  const skipped = await page.evaluate(readState)
  check('a node two steps ahead is locked: the click moves nothing',
    skipped.tag.step === String(stage) && skipped.rows[stage + 2].locked
      && skipped.rows[stage + 2].disabled,
    `step ${skipped.tag.step}, locked ${skipped.rows[stage + 2].locked}`)
  await clickNode(page, 0)
  await page.waitForTimeout(120)
  const backwards = await page.evaluate(readState)
  check('a step BACK is locked too, so the flow only ever moves forward',
    backwards.tag.step === String(stage) && backwards.rows.slice(0, stage).every(row => row.locked)
      && backwards.rows[stage].locked === false && backwards.rows[stage].disabled === false,
    `step ${backwards.tag.step}, ${backwards.rows.map(row => `${row.label}:${row.locked ? 'locked' : 'open'}`).join(', ')}`)
  check('the locked rows say why, and the current row does not claim to be a move',
    backwards.rows[stage + 2].title === zh['stage.node.locked']
      && backwards.rows[stage].title === zh['stage.node.current'],
    `${backwards.rows[stage + 2].title} / ${backwards.rows[stage].title}`)

  // Unscoped on purpose: the panel is portaled out of the column, and only one
  // panel can be open at a time (opening the rail's closes the expanded one's).
  // Every transition from stage 1 down the flow is GATED, so the next node opens
  // the dialog instead of moving — which is what is asserted here. The one UNGATED
  // move left in the flow (上线验收 → 完成) is measured on its own page below.
  await clickNode(page, stage + 1)
  await page.waitForTimeout(250)
  const gatedNext = await page.evaluate(readState)
  check('a DOWNSTREAM transition opens the gate instead of moving, and asks its own stage',
    gatedNext.tag.step === String(stage) && gatedNext.gate !== null
      && gateRequests.length === gateRequestsBefore + 1
      && gateRequests[gateRequests.length - 1].includes(`to=${String(stage + 1)}`),
    `step ${gatedNext.tag.step}, ${gateRequests[gateRequests.length - 1] ?? 'no request'}`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(120)

  {
    // The flow's LAST step is the only ungated one: 完成 carries no gate of its own
    // (see stage.ts), so it moves on the click and asks the host nothing.
    // 上线验收 (the stage before the end) → 完成: the flow's only ungated step.
    const from = STAGE_COUNT - 2
    const to = STAGE_COUNT - 1
    const last = await open(from)
    await last.click(`${WIDE}[data-wui="stageTag"]`)
    await last.waitForTimeout(250)
    const checksBefore = gateRequests.length
    await clickNode(last, to)
    await last.waitForTimeout(250)
    const after = await last.evaluate(readState)
    check('the NEXT node moves the project when its transition is ungated, and the tag follows',
      after.tag.step === String(to) && after.tag.label === zh[STAGE_KEYS[to]]
        && after.panel !== null && after.gate === null,
      `step ${after.tag.step} / ${after.tag.label}`)
    check('an UNGATED transition asks the host nothing',
      gateRequests.length === checksBefore,
      `${gateRequests.length - checksBefore} request(s)`)
    check('the panel re-states the flow around the new stage',
      JSON.stringify(after.rows.map(row => row.state))
        === JSON.stringify(STAGE_KEYS.map((_, index) => stageStateAt(index, to))),
      after.rows.map(row => row.state).join(', '))
    check('the click is persisted, so a reload keeps the stage',
      JSON.parse(after.stored)['demo-wide'] === to, after.stored)

    // The move disabled the row that held the keyboard (it is locked now), so focus
    // must have been handed to the row the project moved TO — and re-placing the
    // panel (a fresh position object, which is a dependency of the opening focus
    // effect) must not move it again.
    const held = await last.evaluate(() => document.activeElement?.textContent ?? null)
    await last.evaluate(() => { window.dispatchEvent(new Event('scroll')) })
    await last.waitForTimeout(80)
    const stillHeld = await last.evaluate(() => document.activeElement?.textContent ?? null)
    check('a move hands the keyboard to the row it moved to, and re-placing keeps it there',
      held === stillHeld && held?.startsWith(zh[STAGE_KEYS[to]]) === true, `${held} → ${stillHeld}`)
    await last.close()
  }

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

/* ── scenario 2b: the GATED transition, and the dialog that owns it ────────
   Entering 技术选型与详设 is the one transition this deployment gates, and it is
   the only place a click can be REFUSED. The gate is a MODAL over the page (see
   StageGateDialog.tsx), so what is measured here is the whole decision: what the
   dialog says, what it asks a person, what it refuses to do until every item is
   satisfied, and the write that records a human answer. */

{
  const stage = 0
  const { page } = await inspect(stage)
  clearRequests()

  /* A blocked gate, with the manual item unanswered: the stage does NOT move, the
     dialog names what is missing, and it asks its human question. */
  gateAnswer = report({
    status: 'blocked',
    items: [item('requirement-analysis'), item('feature-list', false), item('html-demo', false)],
  })
  await clickNode(page, 1)
  await page.waitForTimeout(250)
  const blocked = await page.evaluate(readState)
  check('a blocked gate keeps the project where it is, and opens as a MODAL over the page',
    blocked.tag.step === '0' && gateRequests.length === 1
      && gateRequests[0].includes('to=1') && blocked.gate?.mask === true
      && blocked.gate?.ariaModal === 'true' && blocked.gate?.portaled === true
      && blocked.gate?.insidePanel === false,
    `step ${blocked.tag.step}, ${gateRequests[0] ?? 'no request'}, mask ${blocked.gate?.mask}, inPanel ${blocked.gate?.insidePanel}`)
  check('the dialog names the transition, from the real dictionary',
    blocked.gate?.title === zh['stageGate.title']
      && blocked.gate?.target === zh['stageGate.target'].replace('{stage}', zh['stage.design']),
    `${blocked.gate?.title} / ${blocked.gate?.target}`)
  check('the checklist renders one row per required output, with the evidence found',
    blocked.gate?.items.length === 3
      && blocked.gate.items[0].met === true && blocked.gate.items[0].label === zh['stageGate.item.requirement-analysis']
      && blocked.gate.items[0].evidence === 'requirement-analysis 输出物.docx'
      && blocked.gate.items[0].evidencePath === '/requirement-analysis'
      && blocked.gate.items[1].met === false && blocked.gate.items[1].note === zh['stageGate.item.missing'],
    JSON.stringify(blocked.gate?.items))
  check('the manual item is ASKED, with both answers offered and neither chosen yet',
    blocked.gate?.manual?.label === zh['stageGate.item.customer-confirmation']
      && blocked.gate.manual.badge === zh['stageGate.manual.badge']
      && blocked.gate.manual.question === zh['stageGate.manual.question']
      && blocked.gate.manual.choices.map(choice => choice.label).join('|')
        === `${zh['stageGate.manual.yes']}|${zh['stageGate.manual.no']}`
      && blocked.gate.manual.choices.every(choice => choice.checked === false)
      && blocked.gate.manual.met === false,
    JSON.stringify(blocked.gate?.manual))
  check('the dialog offers the folder and a retry, and its one primary action is DISABLED',
    blocked.gate?.folder === true && blocked.gate?.retry === true && blocked.gate?.retryDisabled === false
      && blocked.gate?.enterDisabled === true
      && blocked.gate?.enterLabel === zh['stageGate.enter'].replace('{stage}', zh['stage.design']),
    `folder ${blocked.gate?.folder}, enter ${blocked.gate?.enterLabel} disabled=${blocked.gate?.enterDisabled}`)
  check('the dialog stays inside the viewport',
    blocked.gate?.box.inside === true, JSON.stringify(blocked.gate?.box))

  /* A computed colour is a promise; this is the picture. The unmet mark is the one
     place the checklist paints outside the flow's own green, and the primary
     action's fill is what says "you may proceed". */
  const shot = async () => decodePng(await page.screenshot())
  const markPixels = async () => page.evaluate(() => [...document.querySelectorAll('[data-wui="gateItemMark"]')].map((mark) => {
    const box = mark.getBoundingClientRect()
    return {
      met: mark.closest('[data-wui="gateItem"]')?.dataset['met'] === 'true',
      x: box.left + box.width / 2,
      y: box.top + box.height / 2,
    }
  }))
  const primary = async () => page.evaluate(() => {
    const button = document.querySelector('[data-wui="gateEnter"]')
    const box = button.getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  })
  const showPixel = colour => `rgb(${colour.r}, ${colour.g}, ${colour.b})`
  const warm = colour => colour.r > 200 && colour.r > colour.g && colour.g > colour.b
  const blockedImage = await shot()
  const blockedMarks = await markPixels()
  const blockedPrimary = await primary()
  const primaryPixel = blockedImage.at(Math.round(blockedPrimary.x), Math.round(blockedPrimary.y))
  // The accent fill, as opposed to the same button at 50% opacity over the card:
  // the enabled control is the saturated accent, so the test is the blue-to-red
  // gap rather than a lightness threshold (the accent itself is not light).
  const accentish = colour => colour.b > 200 && colour.b - colour.r > 120
  // Each mark's own box is scanned rather than sampled: the shipped glyphs are
  // OUTLINES, so "did something get painted" is the question, not "is this pixel".
  const painted = await Promise.all(blockedMarks.map(async (mark) => {
    let green = 0
    let amber = 0
    for (let dy = -5; dy <= 5; dy += 1) {
      for (let dx = -5; dx <= 5; dx += 1) {
        const colour = blockedImage.at(Math.round(mark.x + dx), Math.round(mark.y + dy))
        if (isGreen(colour)) green += 1
        else if (warm(colour)) amber += 1
      }
    }
    return { met: mark.met, green, amber }
  }))
  check('the verdict is painted per item: a met mark green, an unmet mark amber',
    painted[0].met === true && painted[0].green > 0 && painted[1].amber > 0,
    JSON.stringify(painted))
  check('the primary action is painted as DISABLED while an item blocks the move',
    !accentish(primaryPixel), showPixel(primaryPixel))

  /* The operator answers the human question. The artifacts are still missing, so
     the move stays refused — the gate needs BOTH halves. */
  await answerManual(page, 'yes')
  await page.waitForTimeout(80)
  const answered = await page.evaluate(readState)
  check('answering the manual item does not let the move through while outputs are missing',
    answered.gate?.manual.met === true && answered.gate?.enterDisabled === true
      && answered.tag.step === '0' && confirmRequests.length === 0,
    `manual met ${answered.gate?.manual.met}, enter disabled ${answered.gate?.enterDisabled}, ${confirmRequests.length} write(s)`)
  check('the chosen answer says what will happen when the operator enters',
    answered.gate?.manual.note === zh['stageGate.manual.willRecord'], String(answered.gate?.manual.note))

  /* The outputs appear; the operator re-checks. The answer they already gave MUST
     survive the re-check — a spinner that ate it would be a trap. */
  gateAnswer = report({ status: 'blocked', items: [item('requirement-analysis'), item('feature-list'), item('html-demo')] })
  await page.click('[data-wui="gateRetry"]')
  await page.waitForTimeout(250)
  const rechecked = await page.evaluate(readState)
  check('re-checking keeps the operator’s answer and now enables the move',
    gateRequests.length === 2 && rechecked.gate?.manual.choices[0].checked === true
      && rechecked.gate?.manual.met === true && rechecked.gate?.enterDisabled === false
      && rechecked.gate?.items.every(row => row.met === true),
    `choices ${JSON.stringify(rechecked.gate?.manual.choices)}, enter disabled ${rechecked.gate?.enterDisabled}`)
  const readyImage = await shot()
  const readyPrimary = await primary()
  const readyPixel = readyImage.at(Math.round(readyPrimary.x), Math.round(readyPrimary.y))
  check('the primary action is painted as AVAILABLE once every item is satisfied',
    accentish(readyPixel) && !accentish(primaryPixel),
    `${showPixel(primaryPixel)} → ${showPixel(readyPixel)}`)

  /* Entering writes the human answer, then moves the stage. */
  await page.click('[data-wui="gateEnter"]')
  await page.waitForTimeout(250)
  const entered = await page.evaluate(readState)
  check('entering RECORDS the manual answer, naming the operator the host resolved',
    confirmRequests.length === 1
      && confirmRequests[0].path === '/tmp/dsh-web-ui-preview/订单中心重构'
      && confirmRequests[0].to === 1 && confirmRequests[0].item === 'customer-confirmation'
      && confirmRequests[0].confirmed === true,
    JSON.stringify(confirmRequests))
  check('and only then does the stage move, with the dialog out of the way',
    entered.tag.step === '1' && entered.gate === null
      && JSON.parse(entered.stored)['demo-wide'] === 1
      && entered.panel !== null,
    `step ${entered.tag.step}, gate ${entered.gate === null ? 'closed' : 'open'}`)

  await page.close()
}

/* ── scenario 2e: the mixed checklist (a folder, a person, and this host) ──
   Entry to 上线验收 is the gate whose checklist reaches outside Feishu: 上线实施文档
   is a document in the project's folder and 安装包 is a file on this machine. Both
   are measured here, plus the state a moved workspace produces. */

{
  const { page } = await inspect(4)
  clearRequests()
  gateAnswer = report({
    status: 'blocked',
    items: [
      item('release-doc'),
      item('release-package', false, { source: 'workspace' }),
    ],
    confirmations: [],
    workspace: { path: '/tmp/dsh-web-ui-preview/订单中心重构', readable: true },
  })
  await clickNode(page, 5)
  await page.waitForTimeout(250)
  const mixed = await page.evaluate(readState)
  check('a gate whose checklist spans two places asks about the right transition',
    gateRequests.length === 1 && gateRequests[0].includes('to=5')
      && mixed.gate?.target === zh['stageGate.target'].replace('{stage}', zh['stage.acceptance']),
    `${gateRequests[0] ?? 'no request'}`)
  check('每一条门禁项都标明来源：飞书目录 / 工作空间',
    mixed.gate?.items.length === 2
      && mixed.gate.items[0].source === 'folder' && mixed.gate.items[0].badge === zh['stageGate.source.folder']
      && mixed.gate.items[1].source === 'workspace'
      && mixed.gate.items[1].badge === zh['stageGate.source.workspace'],
    JSON.stringify(mixed.gate?.items.map(row => `${row.label}:${row.source}:${row.badge}`)))
  check('a Feishu artifact is a link, and a host file is a statement with its size',
    mixed.gate?.items[0].evidence === 'release-doc 输出物.docx'
      && mixed.gate.items[0].evidencePath === '/release-doc'
      && mixed.gate.items[1].proof === null
      && mixed.gate.items[1].note === zh['stageGate.item.missing'],
    JSON.stringify(mixed.gate?.items))
  check('a missing installer keeps the move refused',
    mixed.gate?.enterDisabled === true && mixed.tag.step === '4',
    `enter disabled ${mixed.gate?.enterDisabled}, step ${mixed.tag.step}`)
  await page.close()
}

{
  const { page } = await inspect(4)
  clearRequests()
  gateAnswer = report({
    status: 'passed',
    items: [item('release-doc'), item('release-package', true, { source: 'workspace' })],
    // Only the first transition asks a person; this gate's checklist is documents
    // and a file, so an empty manual list is what the host sends.
    confirmations: [],
    workspace: { path: '/tmp/dsh-web-ui-preview/订单中心重构', readable: true },
  })
  await clickNode(page, 5)
  await page.waitForTimeout(250)
  const found = await page.evaluate(readState)
  check('a built installer is reported where it was found, with its size and no link',
    found.gate?.items[1].source === 'workspace'
      && found.gate.items[1].proof?.startsWith('release-package-1.2.0.dmg · 41.0 MB') === true
      && found.gate.items[1].proofPath === '/dist/release-package-1.2.0.dmg'
      && found.gate.enterDisabled === false,
    JSON.stringify({ item: found.gate?.items[1], enter: found.gate?.enterDisabled, status: found.gate?.warnNotes }))
  await page.close()
}

{
  // The project directory has moved: the installer cannot be found OR looked for,
  // and the dialog says which.
  const { page } = await inspect(4)
  clearRequests()
  gateAnswer = report({
    status: 'blocked',
    items: [item('release-doc'), item('release-package', false, { source: 'workspace' })],
    confirmations: [],
    workspace: { path: '/tmp/dsh-web-ui-preview/订单中心重构', readable: false },
  })
  await clickNode(page, 5)
  await page.waitForTimeout(250)
  const unreadable = await page.evaluate(readState)
  check('an unreadable workspace is stated in its own warning, naming the path',
    unreadable.gate?.warnNotes.some(note =>
      note.includes('/tmp/dsh-web-ui-preview/订单中心重构')) === true
      && unreadable.gate?.enterDisabled === true,
    JSON.stringify(unreadable.gate?.warnNotes))
  await page.close()
}

/* ── scenario 2d: closing the dialog ───────────────────────────────────────
   A gate the operator abandons must leave the project exactly where it was — and
   leave the keyboard inside the flow panel, which is what the modal took over. */

{
  const { page } = await inspect(0)
  clearRequests()
  gateAnswer = report({ status: 'passed', items: [item('requirement-analysis'), item('feature-list'), item('html-demo')] })
  await clickNode(page, 1)
  await page.waitForTimeout(250)
  const opened = await page.evaluate(readState)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  const dismissed = await page.evaluate(readState)
  const focused = await page.evaluate(() => ({
    text: document.activeElement?.textContent ?? null,
    locked: document.activeElement?.hasAttribute('data-locked')
      ? document.activeElement.getAttribute('data-locked')
      : null,
  }))
  check('Escape closes the dialog and moves nothing: the stage is where it was',
    opened.gate !== null && dismissed.gate === null && dismissed.tag.step === '0'
      && JSON.parse(dismissed.stored)['demo-wide'] === 0 && confirmRequests.length === 0,
    `step ${dismissed.tag.step}, ${confirmRequests.length} write(s)`)
  check('closing hands the keyboard back to the row the dialog was opened from, and the panel is still there',
    dismissed.panel !== null && focused.text?.startsWith(zh[STAGE_KEYS[1]]) === true && focused.locked === null,
    `panel ${dismissed.panel !== null}, focus ${focused.text}`)
  await page.close()
}

/* ── scenario 2c: a recorded answer, and the gate that could not run ───────
   A confirmation already on record is EVIDENCE: the dialog shows who said it and
   when, and entering needs no write. A check that cannot run at all is the
   opposite case — it is never permission to enter. */

{
  const { page } = await inspect(0)
  clearRequests()
  gateAnswer = report({
    status: 'passed',
    items: [item('requirement-analysis'), item('feature-list'), item('html-demo')],
    confirmations: [confirmation({ confirmed: true, by: '李彦辉' })],
  })
  await clickNode(page, 1)
  await page.waitForTimeout(250)
  const recorded = await page.evaluate(readState)
  check('a recorded confirmation is shown as a citation, not asked again',
    recorded.gate?.manual.met === true && recorded.gate?.manual.withdraw === true
      && recorded.gate?.manual.note?.includes('李彦辉') === true
      && recorded.gate?.enterDisabled === false,
    String(recorded.gate?.manual.note))
  await page.click('[data-wui="gateEnter"]')
  await page.waitForTimeout(250)
  check('entering with the answer already on record writes nothing',
    confirmRequests.length === 0 && (await page.evaluate(readState)).tag.step === '1',
    `${confirmRequests.length} write(s)`)
  await page.close()
}

{
  const { page } = await inspect(0)
  clearRequests()
  gateAnswer = report({
    status: 'passed',
    items: [item('requirement-analysis'), item('feature-list'), item('html-demo')],
    confirmations: [confirmation({ confirmed: true, by: '李彦辉' })],
  })
  await clickNode(page, 1)
  await page.waitForTimeout(250)
  await page.click('[data-wui="gateWithdraw"]')
  await page.waitForTimeout(250)
  const withdrawn = await page.evaluate(readState)
  check('withdrawing a confirmation deletes the evidence and closes the gate again',
    confirmRequests.length === 1 && confirmRequests[0].confirmed === false
      && withdrawn.gate?.manual.met === false && withdrawn.gate?.enterDisabled === true
      && withdrawn.tag.step === '0',
    `writes ${JSON.stringify(confirmRequests)}, met ${withdrawn.gate?.manual.met}`)
  await page.close()
}

{
  const { page } = await inspect(0)
  gateAnswer = { ok: false, error: { code: 'not-logged-in', message: 'no Feishu user is signed in' } }
  await clickNode(page, 1)
  await page.waitForTimeout(250)
  const failed = await page.evaluate(readState)
  check('a check that could not run blocks the move, and says so in the host’s words',
    failed.tag.step === '0' && failed.gate?.enterDisabled === true
      && failed.gate.notes.some(note => note.includes('no Feishu user is signed in')) === true
      && failed.gate.retry === true && failed.gate.items.length === 0,
    `step ${failed.tag.step}, ${JSON.stringify(failed.gate?.notes)}`)
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
  // The TERMINAL node is the one row whose status word is not the running word:
  // a project sitting on 完成 has finished the delivery (see stage.ts).
  check('the terminal node says the delivery is handed over, not that it is running',
    data.rows[stage].label === zh['stage.done']
      && data.rows[stage].status === zh['stage.status.finished']
      && data.rows[stage].status !== zh['stage.status.current']
      && data.rows[stage].final === true
      && data.rows.slice(0, -1).every(row => row.final === false),
    `${data.rows[stage].label} / ${data.rows[stage].status}`)
  check('sitting on the terminal node closes the flow: nothing behind it moves',
    data.rows[stage].locked === false
      && data.rows.slice(0, stage).every(row => row.locked === true),
    data.rows.map(row => `${row.label}:${row.locked ? 'locked' : 'open'}`).join(', '))
  // Reaching the END is an ordinary one-step move from the stage before it: the
  // terminal node carries no gate of its own (see stage.ts). The scenario is
  // re-seeded one step earlier so the click is a real move rather than a no-op.
  {
    const approach = await open(stage - 1)
    await approach.click(`${WIDE}[data-wui="stageTag"]`)
    await approach.waitForTimeout(250)
    await clickNode(approach, stage)
    await approach.waitForTimeout(200)
    const arrived = await approach.evaluate(readState)
    check('the terminal node is entered by the same one step, ungated, and persisted',
      arrived.tag.step === String(stage) && arrived.tag.label === zh['stage.done']
        && arrived.tag.count === `${STAGE_COUNT}/${STAGE_COUNT}`
        && arrived.gate === null && JSON.parse(arrived.stored)['demo-wide'] === stage,
      `step ${arrived.tag.step}, ${arrived.tag.label}, ${arrived.tag.count}`)
    await approach.close()
  }
  await page.waitForTimeout(200)
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
  check('the rail keeps the ring honest about the reached share',
    rail.fill === `${Number(((stage + 1) / STAGE_COUNT * 100).toFixed(3))}%`, rail.fill)
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
  // The next stage from the clamped first one, whose gate this scenario answers:
  // a repaired record must be able to take the flow's FIRST step — which now means
  // the dialog's own two steps, the gate check and the human answer.
  gateAnswer = report({ status: 'passed', items: [item('requirement-analysis'), item('feature-list'), item('html-demo')] })
  await clickNode(page, 1)
  await page.waitForTimeout(250)
  await answerManual(page, 'yes')
  await page.click('[data-wui="gateEnter"]')
  await page.waitForTimeout(250)
  const repaired = await page.evaluate(() => window.localStorage.getItem('dsh-web-ui.fde-stage'))
  check('the next click writes a clean record over the unreadable one',
    JSON.parse(repaired)['demo-wide'] === 1, repaired)
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
