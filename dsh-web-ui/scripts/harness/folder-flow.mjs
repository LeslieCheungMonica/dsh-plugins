/**
 * Offline harness for the New Project flow's Feishu folder side effect.
 *
 * `smoke-new-project.mjs` covers the same flow through a real browser, but it
 * needs a RUNNING host, and this deployment's GUI sits behind a QR login. This
 * harness needs neither: it renders the REAL flow — bundled from
 * `src/client/projectFlow.ts`, the same module the shipped client bundle
 * contains — in jsdom, with the runtime's project services stubbed and `fetch`
 * answering the way the host's route answers.
 *
 * What it pins down, in the order the operator experiences it:
 *
 * 1. the exact request the browser sends (method, path, body);
 * 2. that the folder call does not gate the session — the project opens first;
 * 3. every sentence the strip can show, for created / missing-scope / refused /
 *    unreachable, taken from the real dictionary — and that there is no
 *    "already existed, skipped" outcome left, because the host creates
 *    unconditionally (this deployment's decision).
 *
 * Usage: pnpm harness:folder-flow   (builds the bundle first, then runs this)
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
const { useProjectFlow } = await import('./out/project-flow.js')
const { zh } = await import('../../src/client/locales.ts')

/** The real dictionary, filled the way the framework fills it. */
const fill = (template, params) => template.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? ''))
const t = (key, params = {}) => {
  const template = zh[key]
  if (template === undefined) throw new Error(`missing locale key ${key}`)
  return fill(template, params)
}

/** One adopted project, and what the browser did about it. */
const requests = []
const events = []
let folderReply = null
globalThis.fetch = async (url, init) => {
  requests.push({
    url: String(url),
    method: init?.method ?? 'GET',
    body: init?.body === undefined ? null : JSON.parse(init.body),
  })
  return { ok: true, status: 200, async text() { return JSON.stringify(folderReply) } }
}

const PROJECT = '/Users/liyanhui/vscodeProjects/dsh-plugins/dsh-web-ui'
const NAME = 'dsh-web-ui'
let flow = null
/** What the host's `workspace.rename` was asked for, when it was asked at all. */
const renames = []

/** The component under test: the real hook, fed the runtime's own faces. */
function Harness() {
  flow = useProjectFlow({
    startSession: (id) => { events.push(`startSession:${String(id)}`) },
    toggleSidebar: () => {},
    pickDirectory: async () => PROJECT,
    createWorkspace: async ({ path }) => {
      events.push('createWorkspace')
      // The host names a workspace after the path's last segment; `applyName`
      // bumps that when the form asked for a different one.
      return {
        workspaceId: 'ws-1', path, title: applyName ? NAME : path.split('/').pop(),
        sessionIds: [], createdAt: '', updatedAt: '',
      }
    },
    listDirectory: async () => ({ path: '', home: '', crumbs: [], entries: [], truncated: false }),
    createDirectory: async () => '',
    openSession: () => {},
    selectProject: () => {},
    renameSession: async () => {},
    archiveSession: async () => {},
    renameWorkspace: async (_id, title) => { renames.push(title) },
    deleteWorkspace: async () => {},
  }, t)
  return null
}

/** Whether the form's submitted name differs from the folder's own last segment. */
let applyName = false

const root = createRoot(document.getElementById('root'))
act(() => { root.render(createElement(Harness)) })

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }

/**
 * Drive one whole form submission and report what the flow did with the host's
 * answer: "+" → form → name → folder → product background → create.
 *
 * The form is part of the flow now, so the harness walks it rather than calling
 * the adoption directly — that is what makes these checks cover the operator's
 * path and not just the Feishu half of it.
 * @param reply - the folder route's answer.
 * @returns the wire requests, the event order, and the notice.
 */
const runFlow = async (reply, { name = NAME, background = 'new' } = {}) => {
  folderReply = reply
  requests.length = 0
  events.length = 0
  renames.length = 0
  applyName = name !== NAME
  // Both surfaces are React state, so a run has to start from a clean one: a
  // banner left standing by the previous case would answer for this one.
  act(() => { flow.dismissSystemNotice() })
  act(() => { flow.dismissFolderNotice() })
  act(() => { flow.newProject() })
  await settle()
  act(() => { flow.updateDraft({ name }) })
  act(() => { flow.pickWorkspaceFolder() })
  await settle()
  act(() => { flow.updateDraft({ background }) })
  act(() => { flow.submitNewProject() })
  await settle()
  await settle()
  return {
    requests: [...requests],
    events: [...events],
    notice: flow.folderNotice,
    toast: flow.systemNotice,
    renames: [...renames],
  }
}

// 0. The form itself: the "+" action opens it, and it does not touch the host
//    until the operator confirms it.
act(() => { flow.newProject() })
await settle()
check('the + action opens the New Project form', flow.formOpen === true, JSON.stringify({ open: flow.formOpen }))
check('opening the form creates nothing', events.length === 0 && flow.draft.path === '', JSON.stringify({ events, draft: flow.draft }))

// The folder field: the native chooser answers a path, and the name field takes
// the folder's last segment as the default the host itself would have used.
act(() => { flow.pickWorkspaceFolder() })
await settle()
check('choosing a folder fills the draft with the host\'s path', flow.draft.path === PROJECT, JSON.stringify(flow.draft))
check('an empty name field defaults to the folder\'s last segment', flow.draft.name === NAME, JSON.stringify(flow.draft))
check('the default answer is "new project"', flow.draft.background === 'new', JSON.stringify(flow.draft))

// A typed name wins over that default.
act(() => { flow.updateDraft({ name: '订单中心' }) })
act(() => { flow.pickWorkspaceFolder() })
await settle()
check('a typed name is not overwritten by a later folder choice', flow.draft.name === '订单中心', JSON.stringify(flow.draft))

// Closing the form is a cancel: nothing is created and the draft is dropped.
act(() => { flow.closeForm() })
check('closing the form creates nothing', flow.formOpen === false && flow.draft.path === '', JSON.stringify({ open: flow.formOpen, draft: flow.draft }))

// 1. A created folder, and the project that does not wait for it. The name the
//    host receives is the PROJECT's name, not the directory's.
let run = await runFlow({ ok: true, name: NAME, folderToken: 'fld1', url: 'https://x/fld1' })
const folders = (requests) => requests.filter(entry => entry.url === '/dsh-web-ui/lark/folder')
const records = (requests) => requests.filter(entry => entry.url === '/dsh-web-ui/lark/project')
check('the flow POSTs the project path AND the project name to the folder route',
  folders(run.requests).length === 1
  && folders(run.requests)[0].method === 'POST'
  && folders(run.requests)[0].body.path === PROJECT
  && folders(run.requests)[0].body.name === NAME,
  JSON.stringify(run.requests))
check('the create also records the project\'s own answers',
  records(run.requests).length === 1
  && records(run.requests)[0].method === 'POST'
  && records(run.requests)[0].body.background === 'new',
  JSON.stringify(records(run.requests)))
check('the session opens without waiting for the folder call',
  run.events[0] === 'createWorkspace' && run.events[1] === 'startSession:ws-1',
  JSON.stringify(run.events))
check('a created folder is announced through the SYSTEM banner',
  run.toast?.text === fill(zh['feishu.folder.created'], { name: NAME })
  && typeof run.toast.seq === 'number',
  JSON.stringify(run.toast))
check('nothing is left in the sidebar strip for a success',
  run.notice === null, JSON.stringify(run.notice))
check('a name the folder already implies costs no rename round trip',
  run.renames.length === 0, JSON.stringify(run.renames))

// 1b. A name that is NOT the folder's last segment: it becomes the workspace
//     title AND the Feishu folder's name — one name, in both places. This is the
//     case the whole change exists for: project "陕西代码模型" inside a directory
//     called `dsh-web-ui`.
run = await runFlow({ ok: true, name: '陕西代码模型', folderToken: 'fld1b', url: 'u' }, { name: '陕西代码模型' })
check('a typed project name reaches workspace.rename',
  run.renames.length === 1 && run.renames[0] === '陕西代码模型', JSON.stringify(run.renames))
check('the Feishu folder is named after the PROJECT, not the directory',
  folders(run.requests).length === 1
  && folders(run.requests)[0].body.name === '陕西代码模型'
  && folders(run.requests)[0].body.path === PROJECT,
  JSON.stringify(run.requests))
check("the banner names the project's folder",
  run.toast?.text === fill(zh['feishu.folder.created'], { name: '陕西代码模型' })
  && run.notice === null,
  JSON.stringify({ toast: run.toast, strip: run.notice }))
check('the session still opens after the rename',
  run.events[0] === 'createWorkspace' && run.events[1] === 'startSession:ws-1', JSON.stringify(run.events))

// 2. The same project runs again: a second create, and the same "created"
//    sentence. There is no dedup outcome any more — the host does not check.
folderReply = { ok: true, name: NAME, folderToken: 'fld2', url: 'https://x/fld2' }
run = await runFlow(folderReply)
check('a repeat project re-announces the creation, not a skip',
  run.toast?.text === fill(zh['feishu.folder.created'], { name: NAME })
  && run.toast.seq > 1
  && run.notice === null,
  JSON.stringify({ toast: run.toast, strip: run.notice }))
check('the repeat still sends exactly one folder request, named the same way',
  folders(run.requests).length === 1
  && folders(run.requests)[0].method === 'POST'
  && folders(run.requests)[0].body.name === NAME,
  JSON.stringify(run.requests))
check('no dedup copy is reachable from the dictionary',
  zh['feishu.folder.exists'] === undefined && zh['feishu.folder.duplicate'] === undefined,
  JSON.stringify(Object.keys(zh).filter(key => key.startsWith('feishu.folder'))))

// 4. A missing scope: the strip names the scope to request.
run = await runFlow({ ok: false, error: { code: 'scope-missing', message: 'unauthorized: user authorization does not cover the required scope(s): space:document:retrieve (hint…)' } })
check('a missing scope keeps its fix in the column strip',
  run.notice?.tone === 'warn'
  && run.notice.text.includes('space:document:retrieve')
  && run.notice.text.includes(zh['feishu.folder.failed']),
  JSON.stringify(run.notice))
check('a failure is NOT announced as a system banner',
  run.toast === null, JSON.stringify(run.toast))

// 5. A refused folder: the fix is a permission, not a retry.
run = await runFlow({ ok: false, error: { code: 'forbidden', message: 'permission denied' } })
check('a refused folder is reported as a permission problem',
  run.notice?.tone === 'warn' && run.notice.text.includes(zh['feishu.hint.forbidden']),
  JSON.stringify(run.notice))

// 6. A transport failure: the adapter's own words, no invented hint.
run = await runFlow({ ok: false, error: { code: 'unreachable', message: 'Failed to fetch' } })
check('an unreachable host is reported without inventing a hint',
  run.notice?.tone === 'warn' && run.notice.text.startsWith(zh['feishu.folder.failed']),
  JSON.stringify(run.notice))

// 7. The strip is dismissible.
act(() => { flow.dismissFolderNotice() })
check('the banner can be dismissed',
  flow.systemNotice === null, JSON.stringify(flow.systemNotice))
check('the failure strip can be dismissed',
  flow.folderNotice === null, JSON.stringify(flow.folderNotice))

let failed = 0
for (const entry of results) {
  if (!entry.ok) failed += 1
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name}${entry.detail === '' ? '' : `\n      ${entry.detail}`}`)
}
console.log(failed === 0 ? `\n${String(results.length)} checks passed` : `\n${String(failed)} of ${String(results.length)} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
