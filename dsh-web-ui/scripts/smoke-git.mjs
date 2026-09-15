/**
 * Smoke test for the git drawer — the whole chain, with no GUI and no login.
 *
 * It exists because this surface is the one part of the plugin whose correctness
 * cannot be read off the source: a branch list is only right if porcelain v2 was
 * parsed right, a diff is only right if the format escapes matched the command
 * that wrote them, and a mutation is only right if its argv reached a real `git`
 * process. So the test drives the REAL pieces end to end —
 *
 *   component → fetch → route handler → git service → `git` binary → back
 *
 * — against a scratch repository this script creates itself.
 *
 * Two phases, because there are two boundaries worth isolating:
 *
 * 1. **Host.** Every route over a real socket: statuses, envelopes, method
 *    guards, the malformed-request arm, the body cap, and the refusals that
 *    matter (an option-injection `ref`, a path escaping the work tree, a
 *    branch name git rejects).
 * 2. **Browser.** The BUILT `lib/client.js`, loaded through the shell's own
 *    registration protocol and applied against a stub client context, then
 *    rendered into a real DOM. Clicks are dispatched at real nodes, and the
 *    assertions read what the operator would see.
 *
 * The shipped UI primitives are the one stub, because their node builds import
 * CSS modules Node cannot load; the shell answers them from a browser module
 * table instead. The stub renders real buttons, a real checkbox, and a real
 * menu, so every click below lands on this plugin's own control.
 *
 * Usage:
 *   node scripts/smoke-git.mjs            # build first: npm run build
 *   KEEP=1 node scripts/smoke-git.mjs     # leave the scratch repository behind
 *
 * Requirements: `git` on PATH, plus `jsdom` symlinked into node_modules
 * (dev-only, like playwright — see README, "Verifying").
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const BUNDLE = new URL('../lib/client.js', import.meta.url)

if (!existsSync(BUNDLE)) {
  console.error('smoke-git: lib/client.js is missing — run `npm run build` first.')
  process.exit(2)
}
let JSDOM
try {
  ({ JSDOM } = require('jsdom'))
} catch {
  console.error('smoke-git: jsdom is not resolvable from this package — see README, "Verifying".')
  process.exit(2)
}

/** One recorded assertion. */
const results = []
let failed = 0
/**
 * Record and print one assertion.
 * @param name - what was checked.
 * @param ok - whether it held.
 * @param detail - the value that was actually observed.
 */
const check = (name, ok, detail = '') => {
  results.push(name)
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`)
}

// ── the scratch repository ───────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'dsh-web-ui-git-'))
/**
 * Run one git command in the scratch repository.
 * @param args - the argv.
 */
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
git('init', '-q', '-b', 'main', '.')
git('config', 'user.email', 'smoke@dsh.test')
git('config', 'user.name', 'Smoke Test')
writeFileSync(join(root, 'tracked.txt'), 'one\n')
git('add', '.')
git('commit', '-qm', 'base commit')
writeFileSync(join(root, 'tracked.txt'), 'one\ntwo\n')
writeFileSync(join(root, 'untracked.txt'), 'fresh\n')

// ── the real routes, on a real socket ────────────────────────────────────────
const { registerGitRoutes } = await import('../src/host/git-routes.ts')
const routes = new Map()
registerGitRoutes({
  effect: fn => fn(),
  logger: () => ({ info() {}, warn() {}, error(message) { console.error('host:', message) } }),
  webServer: {
    register: (route) => {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
})
const server = createServer(async (req, res) => {
  const handler = routes.get(new URL(req.url, 'http://x').pathname)
  if (handler === undefined) { res.writeHead(404); res.end(); return }
  await handler(req, res)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

/**
 * GET one route.
 * @param path - the path plus query.
 * @returns the status and the parsed body.
 */
const get = async (path) => {
  const response = await fetch(`${origin}${path}`)
  return { status: response.status, body: await response.json() }
}
/**
 * POST one action.
 * @param body - the request body.
 * @returns the status and the parsed body.
 */
const post = async (body) => {
  const response = await fetch(`${origin}/dsh-web-ui/git/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}
/** The `dir` query fragment for the scratch repository. */
const DIR = `dir=${encodeURIComponent(root)}`

console.log(`# scratch repository: ${root}\n# phase 1 — host routes\n`)

let answer = await get(`/dsh-web-ui/git/overview?${DIR}`)
check('overview reads the repository identity', answer.status === 200 && answer.body.ok && answer.body.data.repo.name.startsWith('dsh-web-ui-git-'), answer.body.data?.repo?.name)
check('overview reads HEAD and its tracking state',
  answer.body.data?.head?.branch === 'main' && answer.body.data?.head?.subject === 'base commit',
  `${answer.body.data?.head?.branch} ${answer.body.data?.head?.subject}`)
check('overview counts the dirty tree',
  answer.body.data?.counts?.modified === 1 && answer.body.data?.counts?.untracked === 1,
  JSON.stringify(answer.body.data?.counts))

answer = await get(`/dsh-web-ui/git/branches?${DIR}`)
check('branches lists the local branch as current',
  answer.body.ok && answer.body.data.local.length === 1 && answer.body.data.local[0].current,
  answer.body.data?.local?.map(b => b.name).join(','))

answer = await get(`/dsh-web-ui/git/log?${DIR}&limit=5`)
check('log parses subject, author, and refs',
  answer.body.ok && answer.body.data.length === 1 && answer.body.data[0].subject === 'base commit'
  && answer.body.data[0].author === 'Smoke Test' && answer.body.data[0].refs.includes('HEAD -> main'),
  JSON.stringify(answer.body.data?.[0]?.refs))

answer = await get(`/dsh-web-ui/git/changes?${DIR}`)
check('changes buckets staged, modified, and untracked',
  answer.body.ok && answer.body.data.files.length === 2
  && answer.body.data.files.some(f => f.path === 'tracked.txt' && f.unstaged)
  && answer.body.data.files.some(f => f.path === 'untracked.txt' && f.untracked),
  answer.body.data?.files?.map(f => `${f.path}:${f.index}${f.worktree}`).join(','))

answer = await get(`/dsh-web-ui/git/diff?${DIR}&file=tracked.txt`)
check('diff returns a patch for a tracked path', answer.body.ok && answer.body.data.patch.includes('diff --git'), `${answer.body.data?.patch?.length} bytes`)
answer = await get(`/dsh-web-ui/git/diff?${DIR}&file=untracked.txt`)
check('diff says why an untracked path has none', answer.body.ok === false && answer.body.error.code === 'git-failed', answer.body.error?.message?.slice(0, 48))

answer = await get('/dsh-web-ui/git/overview')
check('a missing dir is a 400', answer.status === 400 && answer.body.error.code === 'bad-request')
answer = await get(`/dsh-web-ui/git/overview?dir=${encodeURIComponent(tmpdir())}`)
check('a non-repository is content, not a transport error',
  answer.status === 200 && answer.body.ok === false && answer.body.error.code === 'not-a-repo', answer.body.error?.message?.slice(0, 48))
answer = await get(`/dsh-web-ui/git/overview?dir=/no/such/place`)
check('a missing directory is named as such', answer.body.error?.code === 'no-directory')
answer = await get(`/dsh-web-ui/git/commit?${DIR}&sha=zzz`)
check('a non-hex commit id is refused', answer.body.error?.code === 'bad-request')

let raw = await fetch(`${origin}/dsh-web-ui/git/overview?${DIR}`, { method: 'POST' })
check('a read route answers 405 to a write method', raw.status === 405 && raw.headers.get('allow') === 'GET')
raw = await fetch(`${origin}/dsh-web-ui/git/action`, { method: 'GET' })
check('the action route answers 405 to a read method', raw.status === 405 && raw.headers.get('allow') === 'POST')
raw = await fetch(`${origin}/dsh-web-ui/git/action`, { method: 'POST', body: 'nope' })
check('a non-JSON body is a 400', raw.status === 400)
raw = await fetch(`${origin}/dsh-web-ui/git/action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ dir: root, action: 'commit', args: { message: 'x'.repeat(70_000) } }),
})
check('an oversized body is refused unread', raw.status === 400 && (await raw.json()).error.message.includes('exceeds'))

answer = await post({ dir: root, action: 'checkout', args: { ref: '--upload-pack=touch /tmp/pwned' } })
check('an option-shaped ref never reaches argv', answer.body.ok === false && answer.body.error.code === 'bad-request', answer.body.error?.message)
answer = await post({ dir: root, action: 'create-branch', args: { name: 'bad..name' } })
check('a branch name git rejects is refused by git', answer.body.error?.code === 'bad-request', answer.body.error?.message)
answer = await post({ dir: root, action: 'stage', args: { files: ['../../etc/hosts'] } })
check('a path escaping the work tree is refused', answer.body.error?.code === 'bad-request', answer.body.error?.message)
answer = await post({ dir: root, action: 'not-an-action' })
check('an unknown action is a 400 naming the set', answer.status === 400 && answer.body.error.message.includes('checkout'))

answer = await post({ dir: root, action: 'create-branch', args: { name: 'smoke-branch', checkout: true } })
check('create-branch makes and switches to a branch', answer.body.ok && answer.body.data.ok && answer.body.data.command === 'git checkout -b smoke-branch', answer.body.data?.command)
answer = await get(`/dsh-web-ui/git/overview?${DIR}`)
check('the new branch is HEAD', answer.body.data?.head?.branch === 'smoke-branch')
answer = await post({ dir: root, action: 'checkout', args: { ref: 'main' } })
check('checkout moves HEAD back', answer.body.ok && answer.body.data.ok, answer.body.data?.command)
answer = await post({ dir: root, action: 'delete-branch', args: { name: 'smoke-branch', force: true } })
check('delete-branch removes it', answer.body.data?.command === 'git branch -D smoke-branch', answer.body.data?.command)

answer = await post({ dir: root, action: 'stash-save', args: { message: 'wip' } })
check('stash-save takes the working tree', answer.body.ok && answer.body.data.ok, answer.body.data?.output?.split('\n')[0])
answer = await get(`/dsh-web-ui/git/changes?${DIR}`)
check('the stash is listed with its branch and message',
  answer.body.data.stashes.length === 1 && answer.body.data.stashes[0].branch === 'main' && answer.body.data.stashes[0].message === 'wip',
  JSON.stringify(answer.body.data?.stashes?.[0]))
answer = await post({ dir: root, action: 'stash-pop', args: { index: 0 } })
check('stash-pop restores it and empties the stack', answer.body.data.ok)
answer = await get(`/dsh-web-ui/git/changes?${DIR}`)
check('the restored tree is dirty again', answer.body.data.stashes.length === 0 && answer.body.data.files.length === 2)

answer = await post({ dir: root, action: 'tag-create', args: { name: 'v9.9.9', annotation: 'smoke' } })
check('tag-create makes an annotated tag', answer.body.data?.command === 'git tag -a -m smoke v9.9.9', answer.body.data?.command)
answer = await post({ dir: root, action: 'tag-delete', args: { name: 'v9.9.9' } })
check('tag-delete removes it', answer.body.data?.command === 'git tag -d v9.9.9')

answer = await get(`/dsh-web-ui/git/records?${DIR}`)
const journalled = answer.body.data.records.map(record => record.command)
check('the journal holds every action this run performed',
  answer.body.data.total === 7 && journalled.every(command => command.startsWith('git ')),
  `${answer.body.data?.total} records, newest ${journalled[0]}`)
check('the journal records the command line, not just the action name',
  journalled.includes('git stash pop stash@{0}') && journalled.includes('git tag -a -m smoke v9.9.9'), journalled.join(' | '))
check('a REFUSED action is not journalled — nothing ran',
  !journalled.some(command => command.includes('upload-pack') || command.includes('bad..name')), `${answer.body.data.total} records`)

// ── phase 2: the browser half in a real DOM ──────────────────────────────────
console.log('\n# phase 2 — the drawer in a DOM\n')

// The DOM globals must exist BEFORE react-dom is imported: it decides whether it
// has a document at module load, and an import-first harness silently loses the
// synthetic `change` path even though clicks still arrive.
const dom = new JSDOM(
  '<!doctype html><html><head></head><body><div id="host"></div></body></html>',
  { url: origin },
)
const { window } = dom
globalThis.window = window
globalThis.document = window.document
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true })
globalThis.HTMLElement = window.HTMLElement
globalThis.Node = window.Node
globalThis.Event = window.Event
globalThis.MouseEvent = window.MouseEvent
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = (await import('react')).default
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const h = React.createElement
const nodeFetch = globalThis.fetch
// The client bundle builds RELATIVE urls, so the stub re-anchors them at the
// route server this test owns.
globalThis.fetch = (input, init) => nodeFetch(
  typeof input === 'string' && input.startsWith('/') ? `${origin}${input}` : input,
  init,
)

/** A stub that renders a real element of the given tag. */
const asTag = (tag, name) => function Stub(props) {
  const { children, ...rest } = props ?? {}
  return h(tag, { 'data-stub': name, ...rest }, children)
}
/** A menu stub that renders its entries as real, clickable buttons. */
const Menu = ({ anchor, items, open, onSelect, onClose }) => h('div', { 'data-stub': 'Menu' },
  anchor,
  open
    ? h('ul', { 'data-menu': 'open' }, (items ?? [])
      .filter(item => item.type === undefined || item.type === 'item')
      .map(item => h('li', { key: item.id }, h('button', {
        type: 'button',
        'data-menu-id': item.id,
        onClick: () => { onSelect(item.id); onClose?.() },
      }, item.label))))
    : null)
/** A modal stub that honours `open`, so a closed dialog renders nothing. */
const Modal = ({ open, children, footer }) => (open ? h('div', { 'data-stub': 'Modal' }, children, footer) : null)
/** An icon stub: the drawn glyph is not what this test is about. */
const icon = name => asTag('span', name)

const shared = {
  'react': React,
  'react/jsx-runtime': require('react/jsx-runtime'),
  'react-dom': require('react-dom'),
  'react-dom/client': require('react-dom/client'),
  '@deepseek-ai/dsh-client-ui-primitives': {
    Tooltip: ({ children }) => h(React.Fragment, null, children),
    Menu,
    Modal,
    Button: asTag('button', 'Button'),
    Input: props => h('input', { 'data-stub': 'Input', ...props }),
    IconBranchOutline16: icon('IconBranchOutline16'),
    IconCheckOutline14: icon('IconCheckOutline14'),
    IconChevronDownOutline14: icon('IconChevronDownOutline14'),
    IconChevronRightOutline14: icon('IconChevronRightOutline14'),
    IconCloseOutline16: icon('IconCloseOutline16'),
    IconEllipsisOutline16: icon('IconEllipsisOutline16'),
    IconLoadingOutline16: icon('IconLoadingOutline16'),
    IconPlusOutline16: icon('IconPlusOutline16'),
    IconRefreshOutline16: icon('IconRefreshOutline16'),
    IconWarningOutline16: icon('IconWarningOutline16'),
  },
  '@deepseek-ai/dsh-client-runtime/client': { defineStore: config => ({ __storeConfig: config }) },
}

// Load the built bundle exactly as the browser does: evaluate the classic
// script, take the registration, materialize the factory against the module
// table. Anything the bundle asks for beyond that table is a packaging bug, and
// this throws loudly on it.
window.__ModuleLoader__ = { load(registration) { window.__registration = registration } }
// eslint-disable-next-line no-new-func
new Function('window', 'document', readFileSync(BUNDLE, 'utf8'))(window, window.document)
const registration = window.__registration
check('the bundle registers under the Loader row name', registration?.id === 'dsh-web-ui', registration?.id)
const plugin = registration.factory((specifier) => {
  if (specifier in shared) return shared[specifier]
  throw new Error(`the client bundle requested a non-shared module: ${specifier}`)
})
check('the bundle only asks for shared modules', typeof plugin.apply === 'function' && Array.isArray(plugin.inject))

/** Every registration the applied plugin made. */
const registrations = []
plugin.apply({
  effect: fn => fn(),
  on: () => {},
  logger: () => ({ info() {}, warn() {}, error() {} }),
  locale: { register: () => () => {} },
  slots: {
    inject: (name, factory) => { registrations.push({ name, dispose: factory() }) },
    register: (options, component) => { registrations.push({ name: options.name, options, component }); return () => {} },
  },
  workspaces: new Proxy({}, { get: () => () => {} }),
  sessions: { open() {}, binding: () => undefined },
  layout: { toggleSidebar() {} },
})
const action = registrations.find(entry => entry.options?.id === 'dsh-web-ui-git')
check('the git action registers into the header utility seat',
  action !== undefined && action.name === 'conversation.session.header.utilities', action?.name)
check('the sidebar takeover still registers alongside it',
  registrations.some(entry => entry.name === 'sidebar'), registrations.map(entry => entry.name).join(' | '))

/** The dictionary the assertions read through. */
const dictionary = {
  'git.title': 'Git', 'git.open': 'Git operations', 'git.empty.project': 'No project',
  'git.refresh': 'Refresh', 'git.loading': 'Loading…', 'git.retry': 'Retry', 'git.close': 'Close',
  'git.tab.branches': 'Branches', 'git.tab.changes': 'Changes', 'git.tab.history': 'History', 'git.tab.records': 'Journal',
  'git.current': 'Current branch', 'git.detached': 'detached HEAD', 'git.unborn': 'no commit yet',
  'git.upstream.none': 'no upstream', 'git.upstream.gone': 'upstream gone', 'git.ahead': '{n} ahead', 'git.behind': '{n} behind',
  'git.local.count': 'Local ({n})', 'git.remote.count': 'Remote ({n})', 'git.local.empty': 'none', 'git.remote.empty': 'none',
  'git.remote.none': 'no remote', 'git.branch.new': 'New branch', 'git.branch.new.title': 'New branch',
  'git.branch.new.name': 'Branch name', 'git.branch.new.start': 'Start point', 'git.branch.rename.title': 'Rename branch',
  'git.branch.rename.name': 'New name', 'git.branch.checkout': 'Switch', 'git.branch.checkoutRemote': 'Check out',
  'git.branch.merge': 'Merge', 'git.branch.rebase': 'Rebase', 'git.branch.delete': 'Delete', 'git.branch.push': 'Push',
  'git.branch.tag': 'Tag here', 'git.branch.copy': 'Copy name', 'git.branch.delete.title': 'Delete branch',
  'git.branch.delete.message': 'Delete {name}?', 'git.branch.delete.force': 'Force delete',
  'git.branch.actions': 'Actions for {name}', 'git.branch.rows.aria': 'branches', 'git.branch.copied': 'Copied {name}',
  'git.quick.fetch': 'Fetch', 'git.quick.pull': 'Pull', 'git.quick.push': 'Push', 'git.quick.more': 'More',
  'git.tag.title': 'New tag', 'git.tag.name': 'Tag name', 'git.tag.annotation': 'Tag message',
  'git.staged.count': 'Staged ({n})', 'git.unstaged.count': 'Changes ({n})', 'git.untracked.count': 'Untracked ({n})',
  'git.conflicted.count': 'Conflicts ({n})', 'git.stash.count': 'Stashes ({n})', 'git.changes.clean': 'clean',
  'git.side.staged': 'staged', 'git.side.unstaged': 'unstaged', 'git.side.untracked': 'untracked', 'git.side.conflict': 'conflict',
  'git.changes.stage': 'Stage', 'git.changes.unstage': 'Unstage', 'git.changes.discard': 'Discard',
  'git.changes.remove': 'Delete', 'git.changes.diff': 'Diff', 'git.changes.diff.empty': '(none)',
  'git.changes.discard.title': 'Discard', 'git.changes.discard.message': 'Discard {path}?',
  'git.changes.remove.title': 'Delete file', 'git.changes.remove.message': 'Delete {path}?',
  'git.changes.commit.placeholder': 'Commit message', 'git.changes.commit.all': 'All (-a)',
  'git.changes.commit.action': 'Commit', 'git.changes.amend': 'Amend', 'git.changes.stash.save': 'Stash',
  'git.changes.stash.placeholder': 'Stash message', 'git.changes.stash.apply': 'Apply', 'git.changes.stash.pop': 'Pop',
  'git.changes.stash.drop': 'Drop', 'git.changes.stash.drop.title': 'Drop stash', 'git.changes.stash.drop.message': 'Drop {ref}?',
  'git.changes.stash.empty': 'no stash', 'git.conflict.hint': '{op} in progress', 'git.conflict.abort': 'Abort {op}',
  'git.op.merge': 'merge', 'git.op.rebase': 'rebase', 'git.op.cherry-pick': 'cherry-pick', 'git.op.revert': 'revert',
  'git.op.bisect': 'bisect', 'git.op.abort.title': 'Abort', 'git.op.abort.message': 'Abort {op}?',
  'git.history.limit': 'Last {n}', 'git.history.empty': 'no commit', 'git.history.merge': 'merge',
  'git.history.truncated': 'truncated', 'git.history.files': '{n} files', 'git.history.refresh': 'Refresh',
  'git.records.empty': 'no record', 'git.records.ok': 'ok', 'git.records.failed': 'failed', 'git.records.count': '{n} records',
  'git.records.output': 'Output', 'git.records.none': '(no output)', 'git.actions.running': 'Running…',
  'git.actions.done': 'Done: {command}', 'git.actions.failed': 'Failed: {command}', 'git.dismiss': 'Dismiss',
  'git.copy': 'Copy', 'git.cancel': 'Cancel', 'git.confirm': 'OK', 'git.more': 'More', 'git.file.actions': 'Actions {path}',
  'git.commit.actions': 'Actions {sha}', 'git.copySha': 'Copy', 'git.notRepo': '{path} is not a repo',
  'git.notRepo.hint': 'pick a repo', 'git.notRepo.pick': 'Switch', 'git.gitMissing.hint': 'install git',
  'time.now': 'just now', 'time.minutes': '{n} min', 'time.hours': '{n} h', 'time.days': '{n} d',
  'time.months': '{n} mo', 'time.years': '{n} y',
}
const t = (key, params) => {
  let text = dictionary[key] ?? key
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}

const workspaces = [{ workspaceId: 'w1', path: root, title: 'scratch', sessionIds: ['s1'], createdAt: '', updatedAt: '' }]
const container = window.document.getElementById('host')
const root_ = createRoot(container)
const settle = async (ms = 60) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
/**
 * Poll until a condition holds, flushing React between attempts.
 * @param predicate - the condition to reach.
 * @param label - what is being waited for, printed on timeout.
 * @returns whether it held within the budget.
 */
const waitFor = async (predicate, label) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return true
    await settle(50)
  }
  console.log(`      (timed out waiting for ${label})`)
  return false
}
// The drawer is mounted through a portal onto document.body, so lookups search
// the whole document — which is where the operator's eyes are anyway.
const q = selector => window.document.querySelector(selector)
const qa = selector => [...window.document.querySelectorAll(selector)]
const click = async (element) => {
  await act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
}
/**
 * Type into a controlled field the way a user does.
 * @param element - the input or textarea.
 * @param value - the text to enter.
 */
const type = async (element, value) => {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value')
    descriptor.set.call(element, value)
    element.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
/** The tab whose label starts with the given word. */
const tab = word => qa('[data-wui="gitTab"]').find(element => element.textContent.startsWith(word))
/** The section disclosure whose label starts with the given text. */
const section = text => qa('[data-wui="gitDisclosure"]').find(element => element.textContent.startsWith(text))
/** One action button inside the changes tab, by its label. */
const tiny = label => qa('[data-wui="gitTinyAction"]').find(element => element.textContent === label)

await act(async () => {
  root_.render(h(action.component, {
    sessionId: 's1',
    useWorkspaces: selector => selector({ items: workspaces, recentWorkspaceId: 'w1' }),
    useSessions: selector => selector({}),
    t,
  }))
})
await settle()

check('the header control renders', q('[data-wui="gitHeaderButton"]') !== null)
const noProject = window.document.createElement('div')
void noProject
await act(async () => {
  root_.render(h(action.component, {
    sessionId: 's1',
    useWorkspaces: selector => selector({ items: [], recentWorkspaceId: undefined }),
    useSessions: selector => selector({}),
    t,
  }))
})
await settle()
check('a session with no project disables the control', q('[data-wui="gitHeaderButton"]')?.disabled === true)
await act(async () => {
  root_.render(h(action.component, {
    sessionId: 's1',
    useWorkspaces: selector => selector({ items: workspaces, recentWorkspaceId: 'w1' }),
    useSessions: selector => selector({}),
    t,
  }))
})
await settle()

await click(q('[data-wui="gitHeaderButton"]'))
check('the drawer opens', q('[data-wui="gitDrawer"]') !== null)
await waitFor(() => q('[data-wui="gitBranchChip"]')?.textContent === 'main', 'the overview read')
check('the drawer names the repository', q('[data-wui="gitRepoName"]')?.textContent === root.split('/').pop(), q('[data-wui="gitRepoName"]')?.textContent)
check('the drawer names the current branch', q('[data-wui="gitBranchChip"]')?.textContent === 'main')
check('the drawer offers four tabs', qa('[data-wui="gitTab"]').map(element => element.textContent.replace(/\d+$/, '')).join(',') === 'Branches,Changes,History,Journal',
  qa('[data-wui="gitTab"]').map(element => element.textContent).join(','))

await waitFor(() => [...qa('[data-wui="gitRowName"]')].some(element => element.textContent === 'main'), 'the branch roster')
check('the branches tab lists the local branch', [...qa('[data-wui="gitRowName"]')].some(element => element.textContent === 'main'))

await click(tab('Changes'))
check('the changes tab has a commit box', q('[data-wui="gitCommitInput"]') !== null)
await waitFor(() => section('Changes (1)') !== undefined, 'the change buckets')
check('the changes tab buckets the dirty tree',
  section('Changes (1)') !== undefined && section('Untracked (1)') !== undefined,
  qa('[data-wui="gitDisclosure"]').map(element => element.textContent).join(' | '))

const stageButton = tiny('Stage')
check('a Stage control exists', stageButton !== undefined)
const stagedPath = stageButton?.closest('[data-wui="gitRow"]')?.querySelector('[data-wui="gitRowName"]')?.textContent
await click(stageButton)
await waitFor(() => section('Staged (1)') !== undefined, 'the staged bucket')
check('staging moves the path into the staged bucket', section('Staged (1)') !== undefined, `staged ${stagedPath}`)
check('the footer reports the exact command', q('[data-wui="gitFooterText"]')?.textContent?.startsWith('Done: git add --'), q('[data-wui="gitFooterText"]')?.textContent)

await click(tiny('Unstage'))
await waitFor(() => section('Staged (') === undefined, 'the unstage')
check('unstaging empties the staged bucket', section('Staged (') === undefined)

await click(tiny('Stage'))
await waitFor(() => section('Staged (1)') !== undefined, 'the staged bucket')
const commitBox = q('[data-wui="gitCommitInput"]')
await type(commitBox, 'commit from the drawer')
check('the commit action enables once a message is present', q('[data-wui="gitPrimaryButton"]').disabled === false)
await click(q('[data-wui="gitPrimaryButton"]'))
await waitFor(() => q('[data-wui="gitCommitInput"]').value === '', 'the commit')
check('committing runs git and clears the box', q('[data-wui="gitFooterText"]')?.textContent?.includes('git commit -m'), q('[data-wui="gitFooterText"]')?.textContent)

await click(tab('History'))
const historyPane = qa('[data-wui="gitTabPane"]')[2]
await waitFor(() => [...historyPane.querySelectorAll('[data-wui="gitRowName"]')].some(element => element.textContent.includes('commit from the drawer')), 'the new commit in history')
check('history lists the commit that was just made', historyPane.textContent.includes('commit from the drawer'))
const commitRow = [...historyPane.querySelectorAll('[data-wui="gitRowMain"]')].find(element => element.textContent.includes('commit from the drawer'))
await click(commitRow)
await waitFor(() => historyPane.querySelector('[data-wui="gitPatchText"]') !== null, 'the commit patch')
check('opening a commit loads its patch', historyPane.querySelector('[data-wui="gitPatchText"]')?.textContent.includes('diff --git') === true)
check('opening a commit loads its file stats', historyPane.querySelector('[data-wui="gitCommitFiles"]') !== null)

await click(tab('Journal'))
await waitFor(() => qa('[data-wui="gitRowName"]').some(element => element.textContent.includes('git commit')), 'the journal')
const commands = qa('[data-wui="gitRowName"]').map(element => element.textContent).join(' | ')
check('the journal lists what the panel actually ran',
  commands.includes('git commit -m "commit from the drawer"') && commands.includes('git restore --staged -- tracked.txt'), commands.slice(0, 96))
const journalRow = qa('[data-wui="gitRowMain"]').find(element => element.textContent.includes('git commit'))
await click(journalRow)
check('a journal row expands the git output it captured', q('[data-wui="gitPatchText"]') !== null)

await click(tab('Branches'))
await waitFor(() => q('[data-wui="gitRowAction"]') !== null, 'a branch row menu')
await click(q('[data-wui="gitRowAction"]'))
const verbs = qa('[data-menu-id]').map(element => element.textContent)
check('the current branch offers only verbs that apply to it',
  !verbs.includes('Switch') && !verbs.includes('Delete') && verbs.includes('Rename branch') && verbs.includes('Push'), verbs.join(','))

const newBranch = tiny('New branch')
check('the branches header offers New branch', newBranch !== undefined)
await click(newBranch)
const promptFields = qa('[data-stub="Input"]')
check('the prompt asks for a name and a start point', promptFields.length === 2, `${promptFields.length} fields`)
await type(promptFields[0], 'ui-made-branch')
await click(qa('[data-stub="Button"]').find(element => element.textContent === 'OK'))
await waitFor(() => q('[data-wui="gitBranchChip"]')?.textContent === 'ui-made-branch', 'the new branch')
check('confirming the prompt creates and checks out the branch', q('[data-wui="gitBranchChip"]')?.textContent === 'ui-made-branch')
check('the prompt closes once confirmed', qa('[data-stub="Input"]').length === 0)
check('the new branch is in the roster', [...qa('[data-wui="gitRowName"]')].some(element => element.textContent === 'ui-made-branch'))

// A repository the drawer cannot read must say so by name, not render an empty
// list that looks like a clean tree. This gets a FRESH root: re-rendering the
// mounted one would leave the trigger toggling its already-open drawer shut.
root_.unmount()
const outsider = createRoot(container)
await act(async () => {
  outsider.render(h(action.component, {
    sessionId: 's1',
    useWorkspaces: selector => selector({ items: [{ ...workspaces[0], path: tmpdir() }], recentWorkspaceId: 'w1' }),
    useSessions: selector => selector({}),
    t,
  }))
})
await settle()
await click(q('[data-wui="gitHeaderButton"]'))
await waitFor(() => q('[data-wui="gitEmptyTitle"]') !== null, 'the not-a-repository answer')
check('a non-repository is reported by name',
  q('[data-wui="gitEmptyTitle"]')?.textContent.includes('is not a repo') === true,
  q('[data-wui="gitEmptyTitle"]')?.textContent)
check('the not-a-repository answer is reachable to a fix, not a dead end',
  q('[data-wui="gitEmpty"] [data-wui="gitQuickButton"]') !== null)
await act(async () => { outsider.unmount() })
server.close()
if (process.env.KEEP !== '1') rmSync(root, { recursive: true, force: true })
console.log(failed === 0
  ? `\n${String(results.length)} checks passed`
  : `\n${String(failed)} of ${String(results.length)} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
