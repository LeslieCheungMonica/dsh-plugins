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
 * 5. **A Feishu refusal** renders the reason AND the fix for that reason: a
 *    login without `space:document:retrieve` names the scope to ask for, because
 *    a folder's contents cannot be listed without it.
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

// 5. A Feishu refusal: the reason AND its fix, because a login made for the old
//    panel cannot list a Drive folder at all.
routes = {
  '/dsh-web-ui/lark/state': resolvedHost()['/dsh-web-ui/lark/state'],
  '/dsh-web-ui/lark/folder': {
    ok: false,
    error: {
      code: 'scope-missing',
      message: 'unauthorized: user authorization does not cover the required scope(s): space:document:retrieve',
    },
  },
}
reset()
await remount()
check('a refusal is rendered with the scope to ask for',
  body().includes('space:document:retrieve')
  && body().includes('lark-cli auth login --scope "space:document:retrieve"'),
  body())
check('a refused resolution lists nothing',
  to('/dsh-web-ui/lark/files').length === 0,
  JSON.stringify(requests.map(entry => entry.url)))

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
