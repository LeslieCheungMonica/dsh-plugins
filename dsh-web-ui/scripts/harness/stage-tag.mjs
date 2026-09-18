/**
 * Offline harness for the FDE stage TAG.
 *
 * The tag is where the delivery flow is read and MOVED, and the node it shows is
 * no longer one browser's private note: it is a fact this plugin persists on the
 * host, on the project's own record (`~/.dsh/storages/web_ui_projects.json`, see
 * `src/host/projects.ts`). That changes what the tag has to get right, and none
 * of it can be read off the source — it is a question about what the page does
 * with an answer from the host, including the answers that say "no".
 *
 * `project-record.mjs` proves the far end of this same wire (the rule the host
 * enforces), so the fake host here does NOT re-implement the flow: it serves
 * scripted answers, and what is checked is the tag's own behaviour. It renders
 * the REAL tag over the REAL client module in jsdom and drives it by clicking
 * real nodes:
 *
 * 1. the node shown is the HOST's, and the read names the project's own path;
 * 2. the browser's old `localStorage` note is not consulted once the host has one;
 * 3. a move is a POST carrying the project and the NODE ID, and the tag shows what
 *    the host answered rather than what was clicked;
 * 4. a gated node opens the gate dialog and writes NOTHING (a gate is a decision,
 *    not a move);
 * 5. a REFUSED move puts the tag back where the host says the project is and says
 *    why — a page that kept the clicked node would be showing a delivery position
 *    the host has already rejected;
 * 6. a node that cannot be read is a STATE, not the first node: the flow renders
 *    read-only and offers a retry;
 * 7. with no project selected the host is asked NOTHING and nothing can move;
 * 8. the migration: a node that only ever existed in this browser is registered
 *    ONCE, as the host's first registration, and never sent again.
 *
 * Usage: pnpm harness:stage-tag   (builds the bundle first, then runs this)
 */
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:3080/',
  pretendToBeVisual: true,
})
// The tag reads the DOM the way a component does, including `instanceof` checks
// against the element classes (`HTMLButtonElement` decides whether a lost focus
// has to be handed on — see StageTag.tsx), so the constructor globals travel with
// the window ones.
for (const key of [
  'window', 'document', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'Element', 'Node',
  'Event', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame',
]) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true })
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { createElement, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { StageTag, NO_PROJECT_SCOPE } = await import('./out/stage-tag.js')
const { zh } = await import('../../src/client/locales.ts')

/**
 * The translate seat, filled the way the framework fills it.
 * @param key - a dictionary key.
 * @param params - interpolation values.
 * @returns the sentence the operator would read.
 */
const fill = (template, params) => template.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? ''))
const t = (key, params = {}) => {
  const template = zh[key]
  if (template === undefined) throw new Error(`missing locale key ${key}`)
  return fill(template, params)
}

/** The browser's key from before the host kept the node. */
const LEGACY_KEY = 'dsh-web-ui.fde-stage'
/** The selected project. */
const SCOPE_KEY = 'ws-1'
const SCOPE_PATH = '/work/alpha'
const SCOPE_NAME = '订单中心'

/** Every request the page made, in order. */
const wire = []
/** The record the fake host holds; `null` = a project it has no record for. */
let record = null
/**
 * The refusal the fake host answers a move with, or null to accept it.
 *
 * Scripted rather than computed: the RULE is the host's and is proven in
 * `project-record.mjs`. What this harness needs is the page's reaction to being
 * told no.
 */
let refusal = null
/** Whether the host is answering at all. */
let hostDown = false
/**
 * A node the fake host answers a move with INSTEAD of the one it was asked for.
 *
 * The host is the authority for where a project stands, so this is how a page that
 * kept the node it clicked gets caught: the answer can legitimately differ — a
 * second tab moved the project, the document was edited by hand — and the tag must
 * show what the host ANSWERED.
 */
let hostDecides = null

/** Build one scripted answer. */
const json = (status, body) => ({
  ok: status < 400,
  status,
  async text() { return JSON.stringify(body) },
})

globalThis.fetch = async (url, init) => {
  if (hostDown) throw new Error('host unreachable')
  const target = String(url)
  const method = init?.method ?? 'GET'
  const body = init?.body === undefined ? null : JSON.parse(init.body)
  wire.push({ url: target, method, body })
  // The gate's own read, so a gated click settles instead of hanging. Its content
  // is the gate harness's business, not this one's.
  if (target.includes('/stage-gate/')) {
    return json(200, { ok: false, error: { code: 'not-logged-in', message: 'gate: no login' } })
  }
  if (target.includes('/project/stage')) {
    if (refusal !== null) return json(409, { ok: false, error: refusal, project: record })
    record = { ...record, stage: hostDecides ?? body.stage, name: body.name }
    return json(200, { ok: true, project: record })
  }
  if (target.includes('/project')) return json(200, { ok: true, project: record })
  return json(200, { ok: true })
}

const results = []
/**
 * Record one assertion.
 * @param name - what was checked.
 * @param ok - whether it held.
 * @param detail - what was actually observed.
 */
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

/**
 * Let every pending read settle.
 *
 * The tag's flow is a CHAIN — fetch, a JSON body, a state update, and after a
 * move perhaps a second read — so one round of microtasks is not enough for the
 * assertions below to see the end of it.
 */
const settle = async () => {
  for (let round = 0; round < 8; round += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  }
}

/** The trigger, which is the tag's collapsed face. */
const trigger = () => document.querySelector('[data-wui="stageTag"]')
/** The open panel, portaled to the page body. */
const panel = () => document.querySelector('[data-wui="stagePanel"]')
/** One node button of the flow, by its position. */
const node = (index) => document.querySelectorAll('[data-wui="stageNodeButton"]')[index]
/** The tag's visible words. */
const triggerText = () => (trigger()?.textContent ?? '').trim()
/** The copy the panel carries about its own state. */
const stateText = () => [
  document.querySelector('[data-wui="stagePanelState"]')?.textContent ?? '',
  document.querySelector('[data-wui="stageNotice"]')?.textContent ?? '',
].join(' ').trim()

/**
 * Click one element through the real event path.
 * @param element - the node to click.
 */
const click = async (element) => {
  if (element === null || element === undefined) throw new Error('click: nothing to click')
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await settle()
}

/** Mount the tag for one project, and open its panel. */
async function open(props) {
  const root = createRoot(document.getElementById('root'))
  await act(async () => {
    root.render(createElement(StageTag, {
      scopeKey: SCOPE_KEY,
      scopePath: SCOPE_PATH,
      scopeLabel: SCOPE_NAME,
      rail: false,
      t,
      ...props,
    }))
  })
  await settle()
  await click(trigger())
  return async () => { await act(async () => { root.unmount() }) }
}

/** A host record at one node. */
const at = (stage) => ({
  name: SCOPE_NAME, path: SCOPE_PATH, stage,
  background: 'existing', productCardId: 'card-acf', larkFolderToken: '', larkFolderUrl: '', updatedAt: 1,
})

/**
 * The requests the page made, excluding the gate's own check.
 * @returns the wire entries that are about the project record.
 */
const recordWire = () => wire.filter(entry => !entry.url.includes('/stage-gate/'))

/**
 * Drive every phase.
 *
 * The phases run in sequence against ONE page, because that is how the tag is
 * used: a project is selected, the flow is opened, and a node is clicked. A
 * phase that throws is therefore caught by the caller and REPORTED — a harness
 * that aborted on the first surprise would hide the results it already had,
 * which is exactly when they are worth reading.
 */
async function main() {
  // 0. A tag that has not read yet claims NO node.
  //
  // The read is a round trip, so there is a moment with no answer — and the moment
  // is what an operator sees on every project switch. Filling it with the first
  // node (or with the previous project's) would show a delivery position nobody
  // established, and a click during it would move a project from a position the
  // page never read.
  {
    const root = createRoot(document.getElementById('root'))
    act(() => {
      root.render(createElement(StageTag, {
        scopeKey: SCOPE_KEY, scopePath: SCOPE_PATH, scopeLabel: SCOPE_NAME, rail: false, t,
      }))
    })
    check('a tag that has not read yet claims no node',
      trigger()?.getAttribute('data-step') === null
      && trigger()?.getAttribute('data-pending') === 'true',
      `${String(trigger()?.getAttribute('data-step'))} / ${String(trigger()?.getAttribute('data-pending'))}`)
    // Opened WITHOUT letting the read settle, which is the only way to observe the
    // state: the dispatch is synchronous, so nothing has resolved yet.
    act(() => {
      trigger()?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    check('a node that has not been read cannot be moved',
      [...document.querySelectorAll('[data-wui="stageNodeButton"]')].every(button => button.disabled)
      && document.querySelectorAll('[data-wui="stageNodeButton"]').length === 7,
      String([...document.querySelectorAll('[data-wui="stageNodeButton"]')].filter(b => !b.disabled).length))
    check('a node that has not been read says so',
      stateText().includes(t('stage.read.pending')), stateText())
    await act(async () => { root.unmount() })
    document.body.innerHTML = '<div id="root"></div>'
  }

  // 1. The node shown is the HOST's.
  //
  // The browser's own old note says 上线验收 (node 5) while the host holds
  // 测试环境验收 (node 3). Only one of them may be shown, and it is the host's:
  // that is the whole point of persisting it there.
  const legacy = JSON.stringify({ [SCOPE_KEY]: 5 })
  dom.window.localStorage.setItem(LEGACY_KEY, legacy)
  record = at('test')
  let unmount = await open({})
  check('the node shown is the one the HOST holds, not the one this browser remembered',
    trigger()?.getAttribute('data-step') === '3'
    && triggerText().includes(t('stage.test')),
    `${String(trigger()?.getAttribute('data-step'))} / ${triggerText()}`)
  check('the read names the project it is about, by PATH',
    recordWire()[0]?.url === `/dsh-web-ui/lark/project?path=${encodeURIComponent(SCOPE_PATH)}`
    && recordWire()[0]?.method === 'GET',
    JSON.stringify(recordWire()[0]))
  check('a host that has a node is not asked about this browser\'s old one',
    recordWire().every(entry => entry.method === 'GET'),
    JSON.stringify(recordWire()))
  await unmount()

  // 2. An ungated move: a POST carrying the project and the NODE ID, answered by the
  //    host. 上线验收 → 完成 is the flow's one transition with no gate, so this is
  //    the move the tag performs itself.
  wire.length = 0
  record = at('acceptance')
  unmount = await open({})
  await click(node(6))
  const move = recordWire().find(entry => entry.method === 'POST')
  check('a move is a POST of the project and the NODE, not a position',
    move?.url === '/dsh-web-ui/lark/project/stage'
    && move?.body?.path === SCOPE_PATH
    && move?.body?.name === SCOPE_NAME
    && move?.body?.stage === 'done',
    JSON.stringify(move))
  check('the tag shows the node the host ANSWERED',
    trigger()?.getAttribute('data-step') === '6' && triggerText().includes(t('stage.done')),
    `${String(trigger()?.getAttribute('data-step'))} / ${triggerText()}`)
  await unmount()

  // 2b. …and the ANSWER is what counts, not the click: a host that answers a
  //     different node is reporting where the project really is (another tab
  //     moved it), and a page that showed the node it asked for would be showing
  //     a delivery position the record does not hold.
  wire.length = 0
  record = at('acceptance')
  unmount = await open({})
  hostDecides = 'deploy'
  await click(node(6))
  hostDecides = null
  check('the host\'s answer wins over the node that was clicked',
    trigger()?.getAttribute('data-step') === '4' && triggerText().includes(t('stage.deploy')),
    `${String(trigger()?.getAttribute('data-step'))} / ${triggerText()}`)
  await unmount()

  // 3. A gated node is a DECISION: the gate dialog opens and nothing is written.
  wire.length = 0
  record = at('test')
  unmount = await open({})
  await click(node(4))
  check('a gated node opens the gate dialog',
    document.querySelector('[data-wui="gateDialog"]') !== null)
  check('a gated node writes no move',
    recordWire().every(entry => entry.method === 'GET'),
    JSON.stringify(recordWire().filter(entry => entry.method !== 'GET')))
  await unmount()
  document.body.innerHTML = '<div id="root"></div>'

  // 4. A REFUSED move: the host says no and the page has to believe it.
  //
  // The scenario is the one that makes a refusal possible in the first place: the
  // project moved UNDER this page — another operator, another tab — so the node the
  // page holds is stale and the move it asks for is no longer the next one. A page
  // that kept what it had would go on showing a position the record does not have.
  wire.length = 0
  record = at('acceptance')
  const REFUSED_WITH = 'the FDE flow moves one node at a time'
  refusal = { code: 'not-next', message: REFUSED_WITH }
  unmount = await open({})
  record = at('test')
  await click(node(6))
  refusal = null
  check('a refused move puts the tag where the HOST says the project is, not where the page thought',
    trigger()?.getAttribute('data-step') === '3' && triggerText().includes(t('stage.test')),
    `${String(trigger()?.getAttribute('data-step'))} / ${triggerText()}`)
  check('a refused move asks the host where the project really is',
    recordWire().filter(entry => entry.method === 'GET').length >= 2,
    JSON.stringify(recordWire()))
  check('a refused move is explained, in the operator\'s words, quoting the host',
    stateText().includes(t('stage.move.refused', { message: REFUSED_WITH })), stateText())
  await unmount()

  // 5. A node that cannot be read is a STATE, not the first node.
  wire.length = 0
  hostDown = true
  unmount = await open({})
  check('an unreadable node is not rendered as the first node',
    trigger()?.getAttribute('data-step') === null
    && trigger()?.getAttribute('data-pending') === 'true',
    `${String(trigger()?.getAttribute('data-step'))} / ${String(trigger()?.getAttribute('data-pending'))}`)
  check('an unreadable node says so, and names the failure',
    stateText().includes(t('stage.read.failed', { message: 'host unreachable' })), stateText())
  check('an unreadable node offers no move at all',
    [...document.querySelectorAll('[data-wui="stageNodeButton"]')].every(button => button.disabled),
    String([...document.querySelectorAll('[data-wui="stageNodeButton"]')].filter(b => !b.disabled).length))
  hostDown = false
  record = at('deploy')
  await click(document.querySelector('[data-wui="stageRetry"]'))
  check('retrying reads the node the host holds',
    trigger()?.getAttribute('data-step') === '4' && triggerText().includes(t('stage.deploy')),
    `${String(trigger()?.getAttribute('data-step'))} / ${triggerText()}`)
  await unmount()

  // 6. With no project selected, the host is asked NOTHING.
  wire.length = 0
  record = null
  unmount = await open({ scopeKey: NO_PROJECT_SCOPE, scopePath: undefined, scopeLabel: undefined })
  check('no project means no question to the host at all',
    recordWire().length === 0, JSON.stringify(recordWire()))
  check('no project cannot move a node: every row is inert',
    [...document.querySelectorAll('[data-wui="stageNodeButton"]')].every(button => button.disabled),
    String([...document.querySelectorAll('[data-wui="stageNodeButton"]')].filter(b => !b.disabled).length))
  check('no project says which fact is missing',
    stateText().includes(t('stage.read.noProject')), stateText())
  await unmount()

  // 7. The migration: a node that only ever existed in this browser arrives at the
  //    host as its FIRST registration — and only while the host has none.
  wire.length = 0
  dom.window.localStorage.setItem(LEGACY_KEY, JSON.stringify({ [SCOPE_KEY]: 4 }))
  record = at(null)
  unmount = await open({})
  const registered = recordWire().find(entry => entry.method === 'POST')
  check('a node this browser already had is registered with the host, as a first registration',
    registered?.body?.stage === 'deploy' && registered?.body?.path === SCOPE_PATH,
    JSON.stringify(registered))
  check('the tag then shows that node',
    trigger()?.getAttribute('data-step') === '4' && triggerText().includes(t('stage.deploy')),
    `${String(trigger()?.getAttribute('data-step'))} / ${triggerText()}`)
  await unmount()

  // …and never twice: the host has the node now, so the old key is dead weight.
  wire.length = 0
  unmount = await open({})
  check('a node the host already has is never registered again',
    recordWire().every(entry => entry.method === 'GET'), JSON.stringify(recordWire()))
  await unmount()

}

try {
  await main()
} catch (error) {
  check('every phase ran to the end', false, error instanceof Error ? error.message : String(error))
}

let failed = 0
for (const entry of results) {
  if (!entry.ok) failed += 1
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name}${entry.detail === '' ? '' : `\n      ${entry.detail}`}`)
}
console.log(failed === 0 ? `\n${String(results.length)} checks passed` : `\n${String(failed)} of ${String(results.length)} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
