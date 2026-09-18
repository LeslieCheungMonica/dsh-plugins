/**
 * Offline harness for the Feishu folder panel.
 *
 * The panel is what the operator actually looks at, and its hard part is not
 * rendering rows: it is the four answers the host can give about a project's
 * folder — *here it is*, *there is none*, *there are several*, and *Feishu
 * refused* — each of which owes the operator a different affordance. So this
 * harness renders the REAL panel (`src/client/LarkDocsPanel.tsx`, bundled by
 * `tsdown.mjs`) in jsdom, with `fetch` answering the way the host's routes
 * answer, and drives it the way an operator would.
 *
 * What it pins down, in the order the operator experiences it:
 *
 * 1. **No project, no requests.** A panel with nothing selected must not read a
 *    folder that belongs to no one.
 * 2. **A resolved folder** is browsed: one listing call for the folder, the
 *    project's name on the strip as a link to it, directories expanding into a
 *    further call (lazily, and only once), documents opening in Feishu, and
 *    "load more" asking for the page the host offered.
 * 3. **No folder** offers the two ways out — create one, or paste a link to one
 *    that already exists — and the create round trip is the real one: POST the
 *    folder, then re-read the resolution.
 * 4. **Several folders** offers each of them, and choosing one POSTs the attach
 *    that records it.
 * 5. **A Feishu refusal** renders the reason AND the fix for that reason, and the
 *    fix is a flow rather than a sentence: a login missing
 *    `space:document:retrieve` offers a login button, which opens a dialog with
 *    the QR the host rendered and the page it pictures; when the host reports the
 *    login landed, the dialog closes and the read that failed is re-read with the
 *    caches dropped. Giving up CANCELS it (the host's child holds a one-shot
 *    device code), and a refusal a login cannot fix — a folder this account may
 *    not read — offers no login at all.
 *
 * Usage: pnpm harness:lark-panel   (builds the bundle first, then runs this)
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
const { LarkDocsPanel, folderTokenFromInput } = await import('./out/lark-panel.js')
const { zh } = await import('../../src/client/locales.ts')

/** The real dictionary, filled the way the framework fills it. */
const fill = (template, params) => template.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? ''))
const t = (key, params = {}) => {
  const template = zh[key]
  if (template === undefined) throw new Error(`missing locale key ${key}`)
  return fill(template, params)
}

const PROJECT = { path: '/Users/liyanhui/vscodeProjects/prd-demo-designer', title: '陕西内生安全2期' }
const FOLDER = 'fldroot'
const SUBFOLDER = 'fldsub'

/** Every request the panel made, in order. */
const requests = []
/** Every link the panel opened. */
const opened = []

/** What the fake host answers, per route; rewritten per case. */
let routes = {}

globalThis.fetch = async (url, init) => {
  const target = String(url)
  requests.push({
    url: target,
    method: init?.method ?? 'GET',
    body: init?.body === undefined ? null : JSON.parse(init.body),
  })
  const path = target.split('?')[0]
  const answer = routes[path]
  if (answer === undefined) throw new Error(`the harness has no answer for ${path}`)
  // A route may be a function of the URL: `/files` answers per `folder`, which
  // is what makes a subdirectory a DIFFERENT listing rather than the root's
  // again (the mistake that would make a tree look infinite).
  return { ok: true, status: 200, async text() { return JSON.stringify(typeof answer === 'function' ? answer(target) : answer) } }
}
dom.window.open = (url) => { opened.push(url); return null }

/**
 * The web-sidebar capability the panel is handed (`dsh-web-ui`'s
 * `openInSidebar`). `sidebarTakes` decides its answer, which is the whole point
 * of the seam: the panel must open a tab when NO sidebar mounted, and must not
 * when one did.
 */
const sidebarCalls = []
let sidebarTakes = true
const openInSidebar = (url) => { sidebarCalls.push(url); return sidebarTakes }

const root = createRoot(document.getElementById('root'))

/** Let the panel's promises settle (a request, a state update, a re-render). */
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise(resolve => { setTimeout(resolve, 0) })
}

/**
 * Render the panel and wait for its first round of reads.
 * @param project - the project to scope it to, or undefined for none.
 */
async function render(project, openInSidebar) {
  await act(async () => {
    root.render(createElement(LarkDocsPanel, { t, project, openInSidebar }))
    await settle()
  })
}

/**
 * Re-render the panel over a new set of route answers.
 *
 * The panel re-reads when its PROJECT changes and on an explicit refresh, never
 * because a test rewrote the host's answers — so a case that wants new answers
 * starts from a fresh mount, which is also what a page reload does.
 * @param project - the project to scope it to.
 * @param openInSidebar - the web-sidebar capability, when the case supplies one.
 */
async function remount(project = PROJECT, openInSidebar) {
  await act(async () => {
    root.render(createElement(LarkDocsPanel, { t, project: undefined, openInSidebar }))
    await settle()
  })
  await render(project, openInSidebar)
}

/** Text of every element matching a selector. */
const texts = (selector) => [...document.querySelectorAll(selector)].map(node => node.textContent)

/** All the panel's visible text. */
const body = () => document.body.textContent

/**
 * Click the first element matching a selector.
 * @param selector - what to click.
 */
async function click(selector) {
  const node = document.querySelector(selector)
  if (node === null) throw new Error(`nothing matched ${selector}`)
  await act(async () => {
    node.click()
    await settle()
  })
}

/**
 * Click the element of a kind whose text contains a phrase.
 * @param selector - the elements to search.
 * @param phrase - the text to look for.
 */
async function clickText(selector, phrase) {
  const node = [...document.querySelectorAll(selector)].find(candidate => (candidate.textContent ?? '').includes(phrase))
  if (node === undefined) throw new Error(`no ${selector} saying ${phrase}`)
  await act(async () => {
    node.click()
    await settle()
  })
}

/**
 * Type into the panel's paste field, the way React sees a keystroke.
 * @param value - the text to enter.
 */
async function type(value) {
  const input = document.querySelector('[data-wui="larkInput"]')
  if (input === null) throw new Error('the paste field is not open')
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await settle()
  })
}

/**
 * Let real time pass under `act`, so a polled timer's state update lands.
 *
 * The login dialog polls the host while its QR is up, and `settle()` only flushes
 * microtasks: a case that wants the second poll has to wait for it.
 * @param ms - how long to wait.
 */
async function pass(ms) {
  await act(async () => {
    await new Promise(resolve => { setTimeout(resolve, ms) })
    await settle()
  })
}

/** The requests made to one path, in order. */
const to = (path) => requests.filter(entry => entry.url.split('?')[0] === path)
/** The query parameters of one request. */
const paramsOf = (entry) => new URLSearchParams(entry.url.split('?')[1] ?? '')

/** The standard answers: an identity and one resolved folder. */
function resolvedHost({ files = {}, folder = FOLDER } = {}) {
  return {
    '/dsh-web-ui/lark/state': {
      ok: true,
      loggedIn: true,
      user: { name: '李彦辉', enName: '', openId: 'ou_x', avatarUrl: '' },
    },
    '/dsh-web-ui/lark/folder': {
      ok: true,
      source: 'record',
      name: PROJECT.title,
      folder: { name: PROJECT.title, folderToken: folder, url: `https://feishu.cn/drive/folder/${folder}` },
      candidates: [],
    },
    // Keyed by the `folder` the panel asked about, so each directory is its own
    // listing.
    '/dsh-web-ui/lark/files': (url) => files[new URLSearchParams(url.split('?')[1] ?? '').get('folder')]
      ?? { ok: true, nodes: [], hasMore: false, pageToken: null },
  }
}

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })
const reset = () => { requests.length = 0; opened.length = 0 }

// 1. Nothing selected: the panel says which project it is about, and reads
//    nothing — a folder belongs to a project, and there is none.
routes = {}
reset()
await render(undefined)
check('with no project the panel asks for nothing',
  requests.length === 0, JSON.stringify(requests))
check('with no project the panel says so',
  body().includes(zh['lark.noProject']), body())

// 2. A resolved folder: the strip names it and links it, one listing is read,
//    and each level is read lazily.
routes = resolvedHost({
  files: {
    [FOLDER]: {
      ok: true,
      nodes: [
        { token: 'doxcn1', expandToken: '', type: 'docx', name: '总体方案', url: 'https://feishu.cn/docx/doxcn1' },
        { token: SUBFOLDER, expandToken: SUBFOLDER, type: 'folder', name: '交付物', url: `https://feishu.cn/drive/folder/${SUBFOLDER}` },
        { token: 'file1', expandToken: '', type: 'file', name: '归档.zip', url: 'https://feishu.cn/file/file1' },
      ],
      hasMore: true,
      pageToken: 'page2',
    },
    [SUBFOLDER]: {
      ok: true,
      nodes: [{ token: 'sht1', expandToken: '', type: 'sheet', name: '排期', url: 'https://feishu.cn/sheets/sht1' }],
      hasMore: false,
      pageToken: null,
    },
  },
})
reset()
await remount()
check('the panel reads the project\'s folder, then lists it once',
  to('/dsh-web-ui/lark/folder').length === 1
  && to('/dsh-web-ui/lark/files').length === 1
  && paramsOf(to('/dsh-web-ui/lark/files')[0]).get('folder') === FOLDER,
  JSON.stringify(requests.map(entry => entry.url)))
check('the resolution is asked for with the project\'s path and name',
  paramsOf(to('/dsh-web-ui/lark/folder')[0]).get('path') === PROJECT.path
  && paramsOf(to('/dsh-web-ui/lark/folder')[0]).get('name') === PROJECT.title,
  to('/dsh-web-ui/lark/folder')[0]?.url ?? '')
check('the folder\'s name is on the strip, as a link to it',
  texts('[data-wui="larkFolderLink"]').join('').includes(PROJECT.title),
  texts('[data-wui="larkFolderLink"]').join(' | '))
check('the listing is rendered with its type chips',
  texts('[data-wui="larkNodeTitle"]').join('|') === '总体方案|交付物|归档.zip'
  && texts('[data-wui="larkBadge"]').join('|') === 'DOC|DIR|FILE',
  `${texts('[data-wui="larkNodeTitle"]').join('|')} / ${texts('[data-wui="larkBadge"]').join('|')}`)
check('a subfolder is marked as expandable and a document is not',
  document.querySelectorAll('[data-wui="larkRowMain"][aria-expanded]').length === 1,
  String(document.querySelectorAll('[data-wui="larkRowMain"][aria-expanded]').length))

await click('[data-wui="larkFolderLink"]')
check('the folder link opens that folder in Feishu',
  opened[0] === `https://feishu.cn/drive/folder/${FOLDER}`, JSON.stringify(opened))

// A document row opens in Feishu; a directory row EXPANDS instead, and its level
// is read once — expanding again must not re-read it.
await clickText('[data-wui="larkRowMain"]', '总体方案')
check('a document row opens in Feishu',
  opened[1] === 'https://feishu.cn/docx/doxcn1', JSON.stringify(opened))
await clickText('[data-wui="larkRowMain"]', '交付物')
check('expanding a subfolder reads that subfolder once',
  to('/dsh-web-ui/lark/files').length === 2
  && paramsOf(to('/dsh-web-ui/lark/files')[1]).get('folder') === SUBFOLDER,
  JSON.stringify(to('/dsh-web-ui/lark/files').map(entry => entry.url)))
check('the expanded level renders its own rows',
  texts('[data-wui="larkNodeTitle"]').includes('排期'),
  texts('[data-wui="larkNodeTitle"]').join('|'))
await clickText('[data-wui="larkRowMain"]', '交付物')
await clickText('[data-wui="larkRowMain"]', '交付物')
check('collapsing and re-expanding does not read the level again',
  to('/dsh-web-ui/lark/files').length === 2,
  String(to('/dsh-web-ui/lark/files').length))

// "Load more" asks for the page the host offered, and appends rather than
// replaces — the rows already on screen must stay.
await clickText('[data-wui="larkNoteAction"]', zh['lark.loadMore'])
check('load more asks for the page token the host offered',
  to('/dsh-web-ui/lark/files').length === 3
  && paramsOf(to('/dsh-web-ui/lark/files')[2]).get('pageToken') === 'page2',
  JSON.stringify(to('/dsh-web-ui/lark/files').map(entry => entry.url)))

// 2c. A listing that points back up its own branch. Feishu permits a shortcut
//     into a folder that holds it, so the tree is remote data and remote data
//     must not decide this component's stack depth: the looping row renders as
//     one that OPENS instead of one that expands.
routes = resolvedHost({
  files: {
    [FOLDER]: {
      ok: true,
      nodes: [{ token: 'loop', expandToken: 'fldloop', type: 'shortcut', name: '回到上级', url: `https://feishu.cn/drive/folder/${FOLDER}` }],
      hasMore: false,
      pageToken: null,
    },
    fldloop: {
      ok: true,
      nodes: [{ token: 'home', expandToken: FOLDER, type: 'shortcut', name: '根目录', url: `https://feishu.cn/drive/folder/${FOLDER}` }],
      hasMore: false,
      pageToken: null,
    },
  },
})
reset()
await remount()
await clickText('[data-wui="larkRowMain"]', '回到上级')
check('a listing is expanded once per branch',
  to('/dsh-web-ui/lark/files').length === 2,
  JSON.stringify(to('/dsh-web-ui/lark/files').map(entry => entry.url)))
check('a row pointing back up the branch expands nothing and renders no chevron',
  texts('[data-wui="larkNodeTitle"]').includes('根目录')
  && document.querySelectorAll('[data-wui="larkRowMain"][aria-expanded]').length === 1,
  `${texts('[data-wui="larkNodeTitle"]').join('|')} / ${String(document.querySelectorAll('[data-wui="larkRowMain"][aria-expanded]').length)}`)
await clickText('[data-wui="larkRowMain"]', '根目录')
check('clicking it opens Feishu instead',
  opened[opened.length - 1] === `https://feishu.cn/drive/folder/${FOLDER}`,
  JSON.stringify(opened))

// 3. No folder yet: both ways out are offered, and creating is the real round
//    trip — POST the folder, then re-read the resolution that now knows it.
routes = {
  ...resolvedHost(),
  '/dsh-web-ui/lark/folder': {
    ok: true,
    source: 'missing',
    name: PROJECT.title,
    folder: null,
    candidates: [],
  },
}
reset()
await remount()
check('an absent folder is stated, with the create action offered',
  body().includes(zh['lark.folder.missing'])
  && document.querySelector('[data-wui="larkNoteAction"][data-primary="true"]') !== null,
  body())
check('nothing is listed when there is no folder to list',
  to('/dsh-web-ui/lark/files').length === 0,
  JSON.stringify(requests.map(entry => entry.url)))

routes['/dsh-web-ui/lark/folder'] = resolvedHost()['/dsh-web-ui/lark/folder']
routes['/dsh-web-ui/lark/files'] = { ok: true, nodes: [], hasMore: false, pageToken: null }
await click('[data-wui="larkNoteAction"][data-primary="true"]')
const createRequest = to('/dsh-web-ui/lark/folder').find(entry => entry.method === 'POST')
check('creating posts the project, not a path a page chose',
  createRequest?.body?.path === PROJECT.path && createRequest?.body?.name === PROJECT.title,
  JSON.stringify(createRequest?.body ?? null))
check('creating re-reads the resolution, so the new folder appears',
  to('/dsh-web-ui/lark/folder').filter(entry => entry.method === 'GET').length === 2,
  JSON.stringify(to('/dsh-web-ui/lark/folder').map(entry => `${entry.method} ${entry.url}`)))

// 3b. The other way out: a folder that already exists, pasted as the link the
//     operator has open in Feishu.
routes = {
  ...routes,
  '/dsh-web-ui/lark/folder': { ok: true, source: 'missing', name: PROJECT.title, folder: null, candidates: [] },
  '/dsh-web-ui/lark/folder/attach': { ok: true, name: PROJECT.title, folderToken: 'fldpasted', url: 'https://feishu.cn/drive/folder/fldpasted' },
}
reset()
await remount()
await clickText('[data-wui="larkNoteAction"]', zh['lark.folder.paste'])
await type('https://asiainfo.feishu.cn/drive/folder/fldpasted')
await clickText('[data-wui="larkNoteAction"]', zh['lark.folder.pasteApply'])
const attachRequest = to('/dsh-web-ui/lark/folder/attach')[0]
check('a pasted Feishu folder URL is read as its token and recorded',
  attachRequest?.body?.folderToken === 'fldpasted' && attachRequest?.body?.path === PROJECT.path,
  JSON.stringify(attachRequest?.body ?? null))
check('text that is not a folder reference is refused before any request',
  folderTokenFromInput('看看这个：https://example.com/x') === ''
  && folderTokenFromInput('https://x.feishu.cn/drive/folder/abc123?from=home') === 'abc123',
  `${folderTokenFromInput('看看这个：https://example.com/x')} / ${folderTokenFromInput('https://x.feishu.cn/drive/folder/abc123?from=home')}`)

// 4. Several same-named folders: each is offered, and choosing one records it.
routes = {
  ...resolvedHost(),
  '/dsh-web-ui/lark/folder': {
    ok: true,
    source: 'ambiguous',
    name: PROJECT.title,
    folder: null,
    candidates: [
      { name: PROJECT.title, folderToken: 'flda', url: 'https://feishu.cn/drive/folder/flda' },
      { name: PROJECT.title, folderToken: 'fldb', url: 'https://feishu.cn/drive/folder/fldb' },
    ],
  },
  '/dsh-web-ui/lark/folder/attach': { ok: true, name: PROJECT.title, folderToken: 'fldb', url: 'https://feishu.cn/drive/folder/fldb' },
}
reset()
await remount()
check('several folders are all offered, with the reason stated',
  body().includes(fill(zh['lark.folder.ambiguous'], { n: 2 }))
  && document.querySelectorAll('[data-wui="larkCandidate"]').length === 2,
  String(document.querySelectorAll('[data-wui="larkCandidate"]').length))
check('several folders list nothing until one is chosen',
  to('/dsh-web-ui/lark/files').length === 0,
  JSON.stringify(requests.map(entry => entry.url)))
await click('[data-wui="larkCandidate"] [data-wui="larkNoteAction"]')
const chosen = to('/dsh-web-ui/lark/folder/attach')[0]
check('choosing one of them records that one',
  chosen?.body?.folderToken === 'flda' && chosen?.body?.name === PROJECT.title,
  JSON.stringify(chosen?.body ?? null))

// 5. A Feishu refusal: the reason AND its fix. Retrying an authorization that was
//    never granted changes nothing, so the fix is a login the panel carries out
//    in place — QR, authorize, done — and the read that failed is re-read.
const VERIFY = 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=STUB&user_code=ABCD-1234'
const FILE_LISTING = {
  [FOLDER]: {
    ok: true,
    nodes: [{ token: 'doxcn1', expandToken: '', type: 'docx', name: '总体方案', url: 'https://feishu.cn/docx/doxcn1' }],
    hasMore: false,
    pageToken: null,
  },
}
/** The host that refuses the folder read for a missing scope, and can log in. */
const refusedHost = () => ({
  '/dsh-web-ui/lark/state': resolvedHost()['/dsh-web-ui/lark/state'],
  '/dsh-web-ui/lark/folder': {
    ok: false,
    error: {
      code: 'scope-missing',
      message: 'unauthorized: user authorization does not cover the required scope(s): space:document:retrieve',
      missingScopes: ['space:document:retrieve'],
    },
  },
  '/dsh-web-ui/lark/auth/login': {
    ok: true,
    verificationUrl: VERIFY,
    qrUrl: '/dsh-web-ui/lark/auth/qr.png?t=stub',
    expiresIn: 600,
    scopes: ['space:document:retrieve'],
  },
  '/dsh-web-ui/lark/auth/status': {
    ok: true, phase: 'pending', expired: false, verificationUrl: VERIFY,
    scopes: ['space:document:retrieve'], expiresIn: 540, message: '',
  },
  '/dsh-web-ui/lark/auth/cancel': { ok: true, phase: 'idle' },
})

/** The panel's own login action, as the failure surfaces render it. */
const LOGIN_ACTION = '[data-wui="larkError"] [data-wui="larkNoteAction"][data-primary="true"]'

routes = refusedHost()
reset()
await remount()
check('a refusal is rendered with the scope to ask for',
  body().includes('space:document:retrieve')
  && body().includes('lark-cli auth login --scope "space:document:retrieve"'),
  body())
check('a refused resolution lists nothing',
  to('/dsh-web-ui/lark/files').length === 0,
  JSON.stringify(requests.map(entry => entry.url)))
check('and the failure offers the login that fixes it',
  document.querySelector(LOGIN_ACTION) !== null && body().includes(zh['lark.login.action']),
  body())

await click(LOGIN_ACTION)
const started = to('/dsh-web-ui/lark/auth/login')[0]
check('starting it asks for exactly the scope that failed',
  started?.method === 'POST' && JSON.stringify(started?.body) === JSON.stringify({ scopes: ['space:document:retrieve'] }),
  JSON.stringify(started?.body ?? null))
const qr = document.querySelector('[data-wui="larkLoginQr"]')
check('the dialog renders the QR image the host made',
  qr !== null && qr.getAttribute('src') === '/dsh-web-ui/lark/auth/qr.png?t=stub',
  qr === null ? 'no QR image' : String(qr.getAttribute('src')))
const authLink = document.querySelector('[data-wui="larkLoginLink"] a')
check('and the page it is a picture of, for an operator who would rather not scan',
  authLink !== null && authLink.getAttribute('href') === VERIFY,
  authLink === null ? 'no link' : String(authLink.getAttribute('href')))
check('the scopes being requested are named in the dialog',
  document.querySelector('[data-wui="larkLoginScopes"]') !== null,
  body())

await pass(1700)
check('while the host is still waiting, the QR stays up',
  document.querySelector('[data-wui="larkLoginQr"]') !== null
  && to('/dsh-web-ui/lark/auth/status').length >= 1,
  `polls: ${String(to('/dsh-web-ui/lark/auth/status').length)}`)

// The operator scans: the host's child exits and the folder it could not read is
// readable. The dialog has to notice, close, and re-read — with the caches dropped,
// or it would serve back the refusal it had already cached.
const foldersBefore = to('/dsh-web-ui/lark/folder').length
routes = { ...resolvedHost({ files: FILE_LISTING }) }
routes['/dsh-web-ui/lark/auth/status'] = {
  ok: true, phase: 'done', expired: false, verificationUrl: '',
  scopes: ['space:document:retrieve'], expiresIn: 0, message: '',
}
await pass(1700)
const reloaded = to('/dsh-web-ui/lark/folder').slice(foldersBefore)
check('a completed login closes the dialog and re-reads what failed',
  document.querySelector('[data-wui="larkLoginQr"]') === null
  && reloaded.length >= 1
  && paramsOf(reloaded[0]).get('refresh') === '1',
  JSON.stringify(reloaded.map(entry => entry.url)))
check('and the read it was blocking renders its listing',
  body().includes('总体方案'),
  body())

// Giving up: the host's child holds a device code for ten minutes and the CLI's
// codes are one-shot, so leaving the dialog has to kill it.
routes = refusedHost()
reset()
await remount()
await click(LOGIN_ACTION)
await clickText('[data-stub="Button"]', zh['lark.login.cancel'])
check('leaving the dialog cancels the login in the host',
  to('/dsh-web-ui/lark/auth/cancel').length === 1
  && to('/dsh-web-ui/lark/auth/cancel')[0]?.method === 'POST',
  JSON.stringify(requests.map(entry => `${entry.method} ${entry.url}`)))
check('and the dialog is gone', document.querySelector('[data-wui="larkLoginQr"]') === null)

// A refusal a login cannot fix: this account simply cannot read that folder, and
// offering a login would send the operator round a loop.
routes = {
  '/dsh-web-ui/lark/state': resolvedHost()['/dsh-web-ui/lark/state'],
  '/dsh-web-ui/lark/folder': {
    ok: false,
    error: { code: 'forbidden', message: 'no permission to read this folder' },
  },
}
reset()
await remount()
check('a permission refusal offers no login, because a login is not its fix',
  document.querySelector(LOGIN_ACTION) === null && body().includes('no permission to read this folder'),
  body())

// 8. The web-sidebar capability: a Feishu link goes INTO the GUI when a sidebar
//    is mounted, and falls back to a tab when none is. The panel must not decide
//    that for itself — it asks, and acts on the answer.
routes = resolvedHost({
  files: {
    [FOLDER]: {
      ok: true,
      nodes: [
        { token: 'doxcn1', expandToken: '', type: 'docx', name: '总体方案', url: 'https://feishu.cn/docx/doxcn1' },
      ],
      hasMore: false,
      pageToken: null,
    },
  },
})
reset()
sidebarCalls.length = 0
sidebarTakes = true
await remount(PROJECT, openInSidebar)
await clickText('[data-wui="larkRowMain"]', '总体方案')
check('with a sidebar mounted, a document row goes to the sidebar',
  sidebarCalls.length === 1 && sidebarCalls[0] === 'https://feishu.cn/docx/doxcn1',
  JSON.stringify(sidebarCalls))
check('and no tab is opened beside it', opened.length === 0, JSON.stringify(opened))
await click('[data-wui="larkFolderLink"]')
check('the folder link takes the same route',
  sidebarCalls.length === 2 && sidebarCalls[1] === `https://feishu.cn/drive/folder/${FOLDER}`,
  JSON.stringify(sidebarCalls))

// The same panel, a deployment with no `my-sider`: the capability answers false
// and the link must open a tab — a click that does nothing reads as a dead link.
reset()
sidebarCalls.length = 0
sidebarTakes = false
await remount(PROJECT, openInSidebar)
await clickText('[data-wui="larkRowMain"]', '总体方案')
check('with no sidebar mounted, the link still opens a tab',
  opened.length === 1 && opened[0] === 'https://feishu.cn/docx/doxcn1', JSON.stringify(opened))
check('and the capability was asked first',
  sidebarCalls.length === 1 && sidebarCalls[0] === 'https://feishu.cn/docx/doxcn1',
  JSON.stringify(sidebarCalls))

let failed = 0
for (const entry of results) {
  if (!entry.ok) failed += 1
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name}${entry.detail === '' ? '' : `\n      ${entry.detail}`}`)
}
console.log(failed === 0 ? `\n${String(results.length)} checks passed` : `\n${String(failed)} of ${String(results.length)} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
