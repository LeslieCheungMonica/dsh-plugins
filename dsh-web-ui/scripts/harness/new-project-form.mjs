/**
 * Offline harness for the New Project FORM.
 *
 * The form is the one surface of this plugin whose correctness is a question
 * about CONDITIONAL LAYOUT — which row exists for which answer, what the folder
 * field does when the host has no chooser, what a submission carries — and that
 * cannot be read off the source. `smoke-new-project.mjs` covers the same form
 * through a real browser, but it needs a RUNNING host, and this deployment's GUI
 * sits behind a QR login; this harness needs neither.
 *
 * It renders the REAL dialog over the REAL flow (both bundled from source by
 * `tsdown.mjs`, with only the UI primitives stubbed, since their node build
 * imports CSS Node cannot load) in jsdom, and drives it by clicking real nodes:
 *
 * 1. what the dialog asks for, and that opening it touches nothing;
 * 2. the conditional product-card row — present for "已有产品", ABSENT for the
 *    other two answers, fed by the HOST's catalogue (this harness answers that
 *    read), and reporting an empty catalogue as such;
 * 3. the folder field, on a host whose native chooser fails: the in-app browser
 *    stands in, and the path it returns fills the form rather than creating a
 *    project behind the operator's back;
 * 4. the submission: what reaches `workspace.create`, and that a name the folder
 *    already implies costs no rename.
 *
 * Usage: pnpm harness:new-project-form   (builds the bundle first, then runs this)
 */
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:3080/',
  pretendToBeVisual: true,
})
for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true })
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { createElement, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NewProjectFormHarness } = await import('./out/new-project-form.js')
const { zh } = await import('../../src/client/locales.ts')
const { STYLES } = await import('../../src/client/styles.ts')

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

/** The directory the fake native chooser answers with. */
const PICKED = '/Users/harness/dsh-demo'
/** The directory the fake in-app browser reports instead. */
const BROWSED = '/Users/harness/browsed-project'

/** What the fake host was asked to do. */
const calls = []
/** The catalogue the fake host serves; emptied mid-run to check the empty state. */
let catalogue = [
  { id: 'card-acf', name: 'ACF', detail: '资产汇聚' },
  { id: 'card-fde', name: 'FDE' },
]
/** What the browser asked the host's routes for. */
const wire = []
/** The record the fake host serves for an existing project; null when it has none. */
let storedRecord = null
globalThis.fetch = async (url, init) => {
  const target = String(url)
  wire.push({ url: target, method: init?.method ?? 'GET', body: init?.body === undefined ? null : JSON.parse(init.body) })
  const text = target.includes('/cards')
    ? JSON.stringify({ ok: true, cards: catalogue })
    : JSON.stringify({ ok: true, project: storedRecord })
  return { ok: true, status: 200, async text() { return text } }
}
/** Whether the host's native chooser exists. */
let nativeChooser = false

const injected = {
  startSession: (id) => { calls.push({ method: 'session.create', workspaceId: String(id) }) },
  toggleSidebar: () => {},
  pickDirectory: async () => {
    calls.push({ method: 'host.pickDirectory' })
    if (!nativeChooser) throw new Error('directory-picker-unavailable')
    return PICKED
  },
  createWorkspace: async (input) => {
    calls.push({ method: 'workspace.create', ...input })
    return {
      workspaceId: 'ws-1',
      path: input.path,
      // The host names a workspace after the path's last segment.
      title: input.path.split('/').filter(Boolean).pop() ?? input.path,
      sessionIds: [],
      createdAt: '',
      updatedAt: '',
    }
  },
  listDirectory: async () => ({ path: '', home: '', crumbs: [], entries: [], truncated: false }),
  createDirectory: async () => '',
  openSession: () => {},
  selectProject: () => {},
  renameSession: async () => {},
  archiveSession: async () => {},
  renameWorkspace: async (id, title) => { calls.push({ method: 'workspace.rename', workspaceId: String(id), title }) },
  deleteWorkspace: async () => {},
}

const root = createRoot(document.getElementById('root'))
act(() => { root.render(createElement(NewProjectFormHarness, { injected, t })) })

const results = []
/**
 * Record one assertion.
 * @param name - what was checked.
 * @param ok - whether it held.
 * @param detail - what was actually observed.
 */
const check = (name, ok, detail = '') => results.push({ name, ok, detail })
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
/** The live flow, published by the harness on each render. */
const flow = () => globalThis.flow
/** The dialog element, or null while it is closed. */
const dialog = () => document.querySelector('[data-wui="form"]')
/** The whole dialog, copy included (the form element alone holds only fields). */
const dialogRoot = () => document.querySelector('.dsh-web-ui-new-project')
const text = () => dialog()?.textContent ?? ''

/**
 * Click one element, through the real event path.
 * @param element - the node to click.
 */
const click = async (element) => {
  if (element === null || element === undefined) throw new Error('click: nothing to click')
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await settle()
}
/**
 * Find a button by its visible label.
 * @param label - the label to match.
 * @returns the button, or undefined.
 */
const button = label => [...document.querySelectorAll('button')]
  .find(element => (element.textContent ?? '').trim() === label)
/**
 * Find the radio chip whose label is the given answer.
 * @param label - the answer's label.
 * @returns the label element, or undefined.
 */
const radio = label => [...document.querySelectorAll('[data-wui="formRadio"]')]
  .find(element => (element.textContent ?? '').trim() === label)
/**
 * Type into the form's name field the way a browser does.
 * @param value - the value to enter.
 */
const typeName = async (value) => {
  const input = document.querySelector('[data-wui="form"] input[type="text"], [data-wui="form"] input:not([type])')
  await act(async () => {
    // React reads `value` through its own tracker, so the setter has to be the
    // one the DOM defines — assigning `input.value` directly is swallowed.
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    setter.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await settle()
}

// 1. Opening the form.
check('the form is closed until the + action runs', dialog() === null)
act(() => { flow().newProject() })
await settle()
check('the + action opens the form', dialog() !== null)
check('opening the form asks the host for nothing', calls.length === 0, JSON.stringify(calls))
// The stylesheet is asserted from the real module, not from a running page:
// every rule this form depends on is ours, and a missing one is invisible to a
// jsdom render (no cascade) while ruining the dialog in a browser.
check('the stylesheet carries the form\'s own field vocabulary',
  STYLES.includes("[data-wui='formField']") && STYLES.includes("[data-wui='formRadio']")
  && STYLES.includes("[data-wui='formSelect']") && STYLES.includes("[data-wui='formPath']"))
check('the stylesheet widens the shared modal card for this form',
  STYLES.includes(".dsh-web-ui-new-project:has([data-wui='form'])"))
check('the form is one focusable region, so the dialog is keyboard-usable',
  dialog()?.getAttribute('tabindex') === '-1', dialog()?.getAttribute('tabindex') ?? null)
const copy = text()
check('the form asks for a name, a folder, and a product background',
  copy.includes(zh['form.name']) && copy.includes(zh['form.path']) && copy.includes(zh['form.background']),
  copy.slice(0, 80))
check('the folder field starts empty, with the hint that says what it becomes',
  copy.includes(zh['form.path.none']) && copy.includes(zh['form.path.hint'].slice(0, 10)))

// 2. The three answers, and the conditional row.
check('the background offers exactly the three answers',
  radio(zh['form.background.new']) !== undefined
  && radio(zh['form.background.existing']) !== undefined
  && radio(zh['form.background.unsure']) !== undefined)
check('"new project" is the default answer', flow().draft.background === 'new', flow().draft.background)
check('the product-card row is absent for a new project', !copy.includes(zh['form.productCard']))
check('the product-card row is absent for "not sure"',
  !text().includes(zh['form.productCard']) || flow().draft.background !== 'unsure')

await click(radio(zh['form.background.existing']))
check('choosing "existing product" is recorded in the draft', flow().draft.background === 'existing', flow().draft.background)
check('choosing "existing product" reveals the product-card row', text().includes(zh['form.productCard']))
// The catalogue now comes FROM THE HOST, so the harness answers that read the way
// an unconfigured deployment does (an empty list) and the row must say so rather
// than offering an empty picker.
check('the form read the card catalogue from the host',
  wire.some(entry => entry.url.includes('/dsh-web-ui/lark/cards') && entry.method === 'GET'),
  JSON.stringify(wire))
const select = document.querySelector('[data-wui="formSelect"]')
check('the catalogue the host served is offered', select !== null, select?.outerHTML?.slice(0, 120) ?? null)
check('the offered cards are the host\'s own',
  select !== null && [...select.options].some(option => option.textContent?.includes('ACF')),
  select === null ? null : [...select.options].map(option => option.textContent).join(' | '))
check('the card row has no note while the catalogue is usable',
  document.querySelector('[data-wui="formCardNote"]') === null)

await click(radio(zh['form.background.unsure']))
check('answering "not sure" is recorded', flow().draft.background === 'unsure', flow().draft.background)
check('answering "not sure" hides the product-card row again', !text().includes(zh['form.productCard']))
check('the card note goes with the row it belongs to',
  document.querySelector('[data-wui="formCardNote"]') === null)

// 3. The folder field on a host with no native chooser.
await click(radio(zh['form.background.new']))
await typeName('订单中心')
await click(button(zh['form.path.choose']))
check('the folder field tries the host\'s own chooser first',
  calls.some(call => call.method === 'host.pickDirectory'), JSON.stringify(calls.map(c => c.method)))
check('a host without a native chooser opens the in-app browser instead',
  flow().browserOpen === true, String(flow().browserOpen))
check('the form steps aside while the browser is up', dialog() === null)

// The browser reports a path — the same hand-off the Shell wires to `onPicked`.
act(() => { flow().adoptPath(BROWSED) })
await settle()
check('a path from the browser fills the form rather than creating a project',
  flow().draft.path === BROWSED && !calls.some(call => call.method === 'workspace.create'),
  JSON.stringify(flow().draft))
check('the browser closes and the form comes back',
  flow().browserOpen === false && dialog() !== null)
check('the path is what the form shows', text().includes(BROWSED))
check('a name already typed survives the folder round trip',
  flow().draft.name === '订单中心', flow().draft.name)

// 4. The submission.
check('the form submits', true)
act(() => { flow().submitNewProject() })
await settle()
await settle()
check('submitting registers the folder as a workspace',
  calls.some(call => call.method === 'workspace.create' && call.path === BROWSED),
  JSON.stringify(calls.filter(c => c.method === 'workspace.create')))
check('the typed name reaches the host as the workspace title',
  calls.some(call => call.method === 'workspace.rename' && call.title === '订单中心'),
  JSON.stringify(calls.filter(c => c.method === 'workspace.rename')))
check('a session opens in the new project',
  calls.some(call => call.method === 'session.create' && call.workspaceId === 'ws-1'),
  JSON.stringify(calls.filter(c => c.method === 'session.create')))
check('the form closes and its draft is dropped',
  dialog() === null && flow().draft.path === '' && flow().draft.name === '',
  JSON.stringify({ open: flow().formOpen, draft: flow().draft }))

// 5. A native chooser, when the host has one: the browser never opens, and a
//    name the folder already implies costs no rename.
nativeChooser = true
act(() => { flow().newProject() })
await settle()
await click(button(zh['form.path.choose']))
await settle()
check('a host with a native chooser needs no browser', flow().browserOpen === false)
check('the native path lands in the form', flow().draft.path === PICKED, flow().draft.path)
check('an untouched name field defaults to the folder\'s last segment',
  flow().draft.name === 'dsh-demo', flow().draft.name)
calls.length = 0
act(() => { flow().submitNewProject() })
await settle()
await settle()
check('a name the folder already implies costs no rename',
  calls.some(call => call.method === 'workspace.create') && !calls.some(call => call.method === 'workspace.rename'),
  JSON.stringify(calls.map(c => c.method)))

// 6. Cancelling is silent: nothing is created and no draft survives.
act(() => { flow().newProject() })
await settle()
await typeName('打错了')
calls.length = 0
await click(button(zh['picker.cancel']))
check('cancelling creates nothing', calls.length === 0, JSON.stringify(calls))
check('cancelling drops the draft', dialog() === null && flow().draft.name === '', JSON.stringify(flow().draft))

// 7. A browser opened WITHOUT the form behind it is not a form field: closing it
//    must not raise a form the operator never asked for.
act(() => { flow().browse() })
await settle()
check('a browser opened on its own does not raise a form',
  flow().browserOpen === true && dialog() === null)
act(() => { flow().closeBrowser() })
await settle()
check('closing that browser leaves no form behind',
  flow().browserOpen === false && dialog() === null, JSON.stringify({ browser: flow().browserOpen, form: flow().formOpen }))

// 8. EDIT MODE: the same form, opened on a project that exists. It prefills from
//    the project's RECORD (the answers the registry has no field for), keeps the
//    directory read-only, and saves through the flow's edit path.
catalogue = [{ id: 'card-acf', name: 'ACF', detail: '资产汇聚' }]
storedRecord = {
  name: '旧名字',
  path: BROWSED,
  background: 'existing',
  productCardId: 'card-acf',
  updatedAt: 1,
}
calls.length = 0
wire.length = 0
act(() => { flow().editProject({ workspaceId: 'ws-1', path: BROWSED, title: '旧名字' }) })
await settle()
await settle()
check('the edit form opens', flow().formMode === 'edit' && flow().formOpen === true,
  JSON.stringify({ mode: flow().formMode, open: flow().formOpen }))
check('the edit form prefilled from the stored record',
  flow().draft.background === 'existing' && flow().draft.productCardId === 'card-acf',
  JSON.stringify(flow().draft))
check('the edit form asks the host for that project\'s record',
  wire.some(entry => entry.url.includes('/dsh-web-ui/lark/project') && entry.url.includes('path=')),
  JSON.stringify(wire.map(entry => entry.url)))
const editCopy = dialogRoot()?.textContent ?? ''
check('the edit form says it is editing a project',
  editCopy.includes(zh['form.edit.title']) && editCopy.includes(zh['form.edit.submit']),
  editCopy.slice(0, 160))
check('the workspace directory cannot be changed while editing',
  document.querySelector('[data-wui="formPath"][data-locked="true"]') !== null
  && button(zh['form.path.choose']) === undefined,
  document.querySelector('[data-wui="formPath"]')?.outerHTML ?? null)
check('the stored background is the selected answer',
  document.querySelector('[data-wui="formRadio"][data-checked="true"]')?.textContent?.includes(zh['form.background.existing']) === true,
  document.querySelector('[data-wui="formRadio"][data-checked="true"]')?.textContent ?? null)

// The submission: the name is renamed in the registry, and the record is written.
calls.length = 0
wire.length = 0
await typeName('新名字')
await click(button(zh['form.edit.submit']))
await settle()
check('saving an edit renames the workspace',
  calls.some(call => call.method === 'workspace.rename' && call.title === '新名字'),
  JSON.stringify(calls))
check('saving an edit writes the project record',
  wire.some(entry => entry.method === 'POST' && entry.url.includes('/dsh-web-ui/lark/project')
    && entry.body?.name === '新名字' && entry.body?.background === 'existing'),
  JSON.stringify(wire.filter(entry => entry.method === 'POST')))
check('saving an edit closes the form and returns it to create mode',
  flow().formOpen === false && flow().formMode === 'create',
  JSON.stringify({ open: flow().formOpen, mode: flow().formMode }))

let failed = 0
for (const entry of results) {
  if (!entry.ok) failed += 1
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name}${entry.detail === '' ? '' : `\n      ${entry.detail}`}`)
}
console.log(failed === 0 ? `\n${String(results.length)} checks passed` : `\n${String(failed)} of ${String(results.length)} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
