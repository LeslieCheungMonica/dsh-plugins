/**
 * Smoke test for `my-sider` — both halves, end to end, with no GUI and no login.
 *
 * It exists because the two things this plugin does cannot be read off the
 * source: a command panel is only right if a command's bytes actually arrive,
 * offset by offset, and a relayed page is only right if the headers it must drop
 * were actually dropped. So the test drives the REAL pieces:
 *
 *   route handler → service → fake subprocess seam → back over a real socket
 *   route handler → real upstream HTTP server → back over a real socket
 *   built lib/client.js → real DOM → real clicks → those same routes
 *
 * Three phases:
 *
 * 1. **Host routes**, over a real HTTP server: envelopes, method guards, the
 *    malformed-request arm, the sandbox wrapping, the polling offsets, and every
 *    refusal that matters — plus the relay against an upstream that does its best
 *    to prevent framing.
 * 2. **The browser half**, loading the BUILT `lib/client.js` through the shell's
 *    own registration protocol and applying it against a stub client context, then
 *    rendering into a real DOM and clicking real nodes.
 * 3. **The two halves together**: the panel's own fetches are re-anchored at the
 *    route server above, so a click in the DOM exercises the real host code.
 *
 * Usage:
 *   node scripts/smoke.mjs
 *
 * Requirements: `jsdom` and `react-dom` resolvable from this package (dev-only —
 * see the README, "Verifying"). The host seams (subprocess, sandbox, sandbox
 * policy) are faked here on purpose: the real ones need a booted DSH host, and
 * what this test proves is the plugin's own logic, not theirs.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'

const require = createRequire(import.meta.url)
const HOST_BUNDLE = new URL('../lib/index.js', import.meta.url)
const CLIENT_BUNDLE = new URL('../lib/client.js', import.meta.url)

let failures = 0

/**
 * Record one assertion.
 * @param {string} label - what was checked.
 * @param {boolean} ok - whether it held.
 * @param {unknown} detail - a value to print when it did not.
 */
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${label}`)
    return
  }
  failures += 1
  console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${String(detail)}`}`)
}

/**
 * A stub that renders a real element of the given tag. It closes over `React`,
 * which is imported below once the DOM globals exist — the helper is only ever
 * called from the client phase, after that.
 * @param {string} tag - the element to render.
 * @param {string} name - a marker attribute value.
 * @returns {Function} the component.
 */
const asTag = (tag, name) => function Stub(props) {
  const { children, ...rest } = props ?? {}
  return React.createElement(tag, { 'data-stub': name, ...rest }, children)
}

// ── the host seams, faked ────────────────────────────────────────────────────

/** Every spawn request the fake process seam received. */
const spawns = []

/**
 * A process seam that answers deterministically: two chunks, then a clean exit.
 * `spawn` must be synchronous and hand back live streams, like the real one.
 * @param {number} holdMs - how long the stderr chunk waits before arriving.
 * @returns {object} the seam.
 */
function fakeSubprocess(holdMs = 12) {
  return {
    async resolveExecutable(command) { return command },
    spawn(spec) {
      spawns.push(spec)
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let settle
      const done = new Promise((resolve) => { settle = resolve })
      setTimeout(() => { stdout.write('hello from the fake seam\n') }, 2)
      setTimeout(() => { stderr.write('a warning on stderr\n') }, holdMs)
      setTimeout(() => {
        stdout.end()
        stderr.end()
        settle({ exitCode: 0, signal: null })
      }, holdMs + 20)
      return {
        stdout,
        stderr,
        done,
        terminate() {
          stdout.end()
          stderr.end()
          settle({ exitCode: null, signal: 'SIGTERM' })
        },
      }
    },
  }
}

/** A confinement seam that marks the argv instead of wrapping it for real. */
const sandbox = {
  confine(argv, policy) {
    return {
      argv: ['<confined>', policy.mode, policy.workspaceRoot, ...argv],
      enforcement: 'full',
      denialSignatures: [],
      runnerFailureRules: [],
    }
  },
}

/**
 * A policy seam that reports the requested mode, or the deployment default.
 * @param {string} fallback - the mode a sessionless resolve yields.
 * @returns {object} the seam.
 */
const policyOf = fallback => ({
  resolve(request) {
    return { mode: request?.mode ?? fallback, workspaceRoot: process.cwd() }
  },
})

/**
 * Build a context stub and run this plugin's host half against it.
 * @param {object} options - the row config and the deployment's default mode.
 * @returns {Promise<{ routes: Map<string, Function> }>} the registered routes.
 */
async function mountHost(options) {
  const routes = new Map()
  const seams = {
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    },
    subprocess: fakeSubprocess(),
    sandbox,
    sandboxPolicy: policyOf(options.defaultMode ?? 'workspace-write'),
  }

  const base = {
    logger: () => ({ info() {}, error() {} }),
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }

  /**
   * A child context exposing exactly the named services, like cordis `inject`.
   * @param {readonly string[]} services - the names to expose.
   * @param {Function} body - the callback cordis would run.
   */
  const inject = (services, body) => {
    const child = { ...base, ...parent }
    for (const service of services) child[service] = seams[service] ?? parent[service]
    body(child)
  }
  const parent = { ...base, inject }

  const plugin = await import(HOST_BUNDLE.href)
  plugin.apply(parent, options.config)
  return { routes }
}

/**
 * Serve one set of registered routes over a real socket.
 * @param {Map<string, Function>} routes - the route table.
 * @returns {Promise<{ origin: string, close: () => Promise<void> }>} the server.
 */
async function serve(routes) {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const handler = routes.get(path)
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>not found</title>')
      return
    }
    void handler(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const origin = `http://127.0.0.1:${address.port}`
  return {
    origin,
    close: () => new Promise((resolve) => { server.close(() => { resolve() }) }),
  }
}

/**
 * The upstream site the relay is tested against: it forbids framing, sets a
 * cookie, and serves one relative asset and one non-HTML body.
 * @returns {Promise<{ origin: string, close: () => Promise<void> }>} the server.
 */
async function serveUpstream() {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/page/') {
      const body = '<!doctype html><html><head><title>upstream</title></head>'
        + '<body><img src="pic.png"><a href="/next">next</a></body></html>'
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'x-frame-options': 'DENY',
        'content-security-policy': "frame-ancestors 'none'",
        'set-cookie': 'session=secret; Path=/',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
      return
    }
    if (path === '/pic.png') {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.length })
      res.end(bytes)
      return
    }
    if (path === '/open') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>open</title>ok')
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('nope')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin,
    close: () => new Promise((resolve) => { server.close(() => { resolve() }) }),
  }
}

/**
 * Read a JSON route.
 * @param {string} url - the absolute URL.
 * @param {RequestInit} [init] - the request init.
 * @returns {Promise<{ status: number, body: any }>} the answer.
 */
async function json(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

/**
 * POST a JSON body.
 * @param {string} url - the absolute URL.
 * @param {unknown} value - the body.
 * @returns {Promise<{ status: number, body: any }>} the answer.
 */
const postJson = (url, value) => json(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
})

/**
 * Wait until a poll reports the run settled.
 * @param {string} origin - the route server.
 * @param {string} id - the run id.
 * @returns {Promise<{ output: string, run: any }>} everything read.
 */
async function drain(origin, id) {
  let from = 0
  let output = ''
  let run
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const answer = await json(`${origin}/my-sider/shell/poll?id=${id}&from=${from}`)
    if (!answer.body.ok) throw new Error(`poll failed: ${JSON.stringify(answer.body)}`)
    output += answer.body.data.output
    from = answer.body.data.next
    run = answer.body.data.run
    if (!run.running) return { output, run }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('the run never settled')
}

// ── phase 1: the host routes ─────────────────────────────────────────────────

console.log('# phase 1 — host routes over a real socket\n')

const upstream = await serveUpstream()
const host = await mountHost({ config: undefined })
const server = await serve(host.routes)

check('the command panel registers its five routes', ['context', 'run', 'poll', 'kill', 'list']
  .every(name => host.routes.has(`/my-sider/shell/${name}`)))
check('the relay registers its two routes', host.routes.has('/my-sider/url/fetch') && host.routes.has('/my-sider/url/probe'))

{
  const context = await json(`${server.origin}/my-sider/shell/context`)
  check('context reports the host directory', context.body.ok && context.body.data.dir === process.cwd(), JSON.stringify(context.body))
  check('context reports the panel enabled by default', context.body.data.enabled === true)
}

{
  const started = await postJson(`${server.origin}/my-sider/shell/run`, { dir: process.cwd(), command: 'echo hi' })
  check('run starts a command', started.body.ok === true, JSON.stringify(started.body))
  const argv = spawns.at(-1)?.argv ?? []
  check('the command is evaluated by a login shell', argv.at(-2) === '-lc' && argv.at(-1) === 'echo hi', argv.join(' '))
  check('the sandbox wrapped the argv before the spawn', argv[0] === '<confined>', argv[0])
  check('the run reports the resolved sandbox mode', started.body.data.sandboxMode === 'workspace-write', started.body.data.sandboxMode)
  const runId = started.body.data.id

  const drained = await drain(server.origin, runId)
  check('stdout and stderr both arrive, in arrival order',
    drained.output.includes('hello from the fake seam') && drained.output.includes('a warning on stderr'),
    JSON.stringify(drained.output))
  check('the settled run reports exit code 0', drained.run.exitCode === 0 && drained.run.running === false)

  const again = await json(`${server.origin}/my-sider/shell/poll?id=${runId}&from=${drained.run.bytes}`)
  check('a poll past the end answers with no new bytes', again.body.data.output === '' && again.body.data.next === drained.run.bytes)

  const list = await json(`${server.origin}/my-sider/shell/list`)
  check('list holds the run, newest first', list.body.data[0].id === runId)

  const killed = await postJson(`${server.origin}/my-sider/shell/kill`, { id: runId })
  check('kill is idempotent on a settled run', killed.body.ok === true && killed.body.data.running === false)
}

{
  const guarded = await json(`${server.origin}/my-sider/shell/run`)
  check('a wrong method is refused with 405', guarded.status === 405)
  const badBody = await json(`${server.origin}/my-sider/shell/run`, { method: 'POST', body: 'not json' })
  check('a non-JSON body is refused with 400', badBody.status === 400 && badBody.body.error.code === 'bad-request')
  const missing = await postJson(`${server.origin}/my-sider/shell/run`, { dir: process.cwd() })
  check('a missing field is refused with 400', missing.status === 400)
  const relative = await postJson(`${server.origin}/my-sider/shell/run`, { dir: 'somewhere', command: 'ls' })
  check('a relative directory is refused', relative.body.error.code === 'bad-request', JSON.stringify(relative.body))
  const nowhere = await postJson(`${server.origin}/my-sider/shell/run`, { dir: '/definitely/not/here', command: 'ls' })
  check('a missing directory is refused by name', nowhere.body.error.code === 'no-directory', JSON.stringify(nowhere.body))
  const unknown = await json(`${server.origin}/my-sider/shell/poll?id=nope&from=0`)
  check('an unknown run is answered, not crashed', unknown.body.error.code === 'unknown-run')
}

{
  const relayed = await fetch(`${server.origin}/my-sider/url/fetch?url=${encodeURIComponent(`${upstream.origin}/page/`)}`)
  const body = await relayed.text()
  check('the relay passes the upstream status through', relayed.status === 200)
  check('the framing ban is lifted', relayed.headers.get('x-frame-options') === null && relayed.headers.get('content-security-policy') === null)
  check('no cookie state crosses the relay', relayed.headers.get('set-cookie') === null)
  check('a <base> element makes relative urls resolve upstream', body.includes(`<base href="${upstream.origin}/page/">`), body.slice(0, 200))
  check('the relayed document keeps its markup', body.includes('<img src="pic.png">'))

  const asset = await fetch(`${server.origin}/my-sider/url/fetch?url=${encodeURIComponent(`${upstream.origin}/pic.png`)}`)
  const bytes = Buffer.from(await asset.arrayBuffer())
  check('a non-HTML body passes through byte-for-byte', bytes.length === 11 && bytes[0] === 0x89, bytes.toString('hex'))
  check('a non-HTML body keeps its content type', asset.headers.get('content-type') === 'image/png')

  const missingUpstream = await fetch(`${server.origin}/my-sider/url/fetch?url=${encodeURIComponent(`${upstream.origin}/nope`)}`)
  check('an upstream 404 is reported as a 404', missingUpstream.status === 404, missingUpstream.status)

  const refused = await fetch(`${server.origin}/my-sider/url/fetch?url=file:///etc/passwd`)
  const refusedBody = await refused.text()
  check('a non-http scheme is refused with an explanation', refused.status === 502 && refusedBody.includes('not supported'), refusedBody.slice(0, 120))

  const unreachable = await fetch(`${server.origin}/my-sider/url/fetch?url=${encodeURIComponent('http://127.0.0.1:1/')}`)
  check('an unreachable site yields a readable error page', unreachable.status === 502 && (await unreachable.text()).includes('Could not load this page'))

  const probed = await json(`${server.origin}/my-sider/url/probe?url=${encodeURIComponent(`${upstream.origin}/page/`)}`)
  check('the probe detects a framing ban', probed.body.data.frameBlocked === true, JSON.stringify(probed.body.data))
  const probedOpen = await json(`${server.origin}/my-sider/url/probe?url=${encodeURIComponent(`${upstream.origin}/open`)}`)
  check('the probe clears a framable page', probedOpen.body.data.frameBlocked === false)
  const probedDead = await json(`${server.origin}/my-sider/url/probe?url=${encodeURIComponent('http://127.0.0.1:1/')}`)
  check('the probe reports an unreachable site as an answer', probedDead.body.ok === true && probedDead.body.data.unreachable === true)
}

{
  const pinned = await mountHost({ config: { shell: { mode: 'danger-full-access' } }, defaultMode: 'read-only' })
  const pinnedServer = await serve(pinned.routes)
  await postJson(`${pinnedServer.origin}/my-sider/shell/run`, { dir: process.cwd(), command: 'true' })
  const argv = spawns.at(-1)?.argv ?? []
  check('a pinned mode overrides the deployment policy', argv[0] !== '<confined>' && argv[0] === '/bin/bash', argv[0])
  await pinnedServer.close()
}

{
  const allowed = await mountHost({ config: { relay: { allowHosts: ['example.com'] } } })
  const allowedServer = await serve(allowed.routes)
  const blocked = await fetch(`${allowedServer.origin}/my-sider/url/fetch?url=${encodeURIComponent(`${upstream.origin}/page/`)}`)
  check('the allowlist refuses a host that is not on it', (await blocked.text()).includes('not on that list'))
  await allowedServer.close()
}

{
  const off = await mountHost({ config: { shell: { enabled: false }, relay: { enabled: false } } })
  const offServer = await serve(off.routes)
  const context = await json(`${offServer.origin}/my-sider/shell/context`)
  check('a switched-off command panel says so through context', context.body.data.enabled === false)
  const run = await postJson(`${offServer.origin}/my-sider/shell/run`, { dir: process.cwd(), command: 'echo hi' })
  check('a switched-off command panel refuses to run anything', run.body.error.code === 'disabled')
  const disabledSpawns = spawns.length
  await postJson(`${offServer.origin}/my-sider/shell/run`, { dir: process.cwd(), command: 'echo hi' })
  check('a switched-off command panel spawns nothing', spawns.length === disabledSpawns)
  const relayed = await fetch(`${offServer.origin}/my-sider/url/fetch?url=${encodeURIComponent(`${upstream.origin}/open`)}`)
  check('a switched-off relay explains itself inside the frame', (await relayed.text()).includes('relay is switched off'))
  const probed = await json(`${offServer.origin}/my-sider/url/probe?url=${encodeURIComponent(`${upstream.origin}/open`)}`)
  check('a switched-off relay answers probe with `disabled`', probed.body.error.code === 'disabled')
  await offServer.close()
}

{
  const strict = await mountHost({ config: { shell: { timeoutMs: 0 } } }).catch(error => error)
  check('a bad config value fails at boot with the field named',
    strict instanceof Error && String(strict.message).includes('config.shell.timeoutMs'), String(strict))
}

// ── phase 2 and 3: the browser half, against phase 1's routes ────────────────

console.log('\n# phase 2 — the client bundle in a real DOM\n')

const entry = readFileSync(CLIENT_BUNDLE, 'utf8')
if (entry === '') {
  console.error('smoke: lib/client.js is empty — run `npm run build` first.')
  process.exit(2)
}

let JSDOM
try {
  ({ JSDOM } = require('jsdom'))
} catch {
  console.error('smoke: jsdom is not resolvable from this package — see README, "Verifying".')
  process.exit(2)
}

// The DOM globals must exist BEFORE react-dom is imported: it decides whether it
// has a document at module load.
const dom = new JSDOM(
  '<!doctype html><html><head></head><body><div id="host"></div></body></html>',
  { url: server.origin },
)
const { window } = dom
globalThis.window = window
globalThis.document = window.document
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true })
globalThis.HTMLElement = window.HTMLElement
globalThis.Node = window.Node
globalThis.Event = window.Event
globalThis.MouseEvent = window.MouseEvent
globalThis.MutationObserver = window.MutationObserver
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = (await import('react')).default
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')

/** Icon stub: the drawn glyph is not what this test is about. */
const icon = name => asTag('span', name)
const primitivesStub = new Proxy(
  { Tooltip: ({ children }) => React.createElement(React.Fragment, null, children) },
  {
    get: (target, key) => {
      if (key in target) return target[key]
      return typeof key === 'string' && key.startsWith('Icon') ? icon(key) : undefined
    },
  },
)

const shared = {
  'react': React,
  'react/jsx-runtime': require('react/jsx-runtime'),
  'react-dom': require('react-dom'),
  'react-dom/client': require('react-dom/client'),
  '@deepseek-ai/dsh-client-ui-primitives': primitivesStub,
}

window.__ModuleLoader__ = { load(registration) { window.__registration = registration } }
// eslint-disable-next-line no-new-func
new Function('window', 'document', entry)(window, window.document)
const registration = window.__registration
check('the bundle registers under the Loader row name', registration?.id === 'my-sider', registration?.id)
const clientPlugin = registration.factory((specifier) => {
  if (specifier in shared) return shared[specifier]
  throw new Error(`the client bundle requested a non-shared module: ${specifier}`)
})
check('the bundle asks only for shared modules', typeof clientPlugin.apply === 'function' && Array.isArray(clientPlugin.inject))

/** Every locale dictionary the plugin registered. */
const dictionaries = {}

/**
 * A client context that models slot DECLARATIONS, which is the whole point here:
 * the real registry runs `slots.inject`'s factory only once the key it names has
 * been declared, and this plugin now chooses its home by exactly that signal.
 *
 * @param {Set<string>} declared - the slot keys this fake composition declares.
 * @returns {{ctx: object, entries: Array<object>, waited: string[], provided: object}}
 * the context, the entries it collected, every key the plugin waited on, and
 * every service it provided (by name).
 */
const makeClientCtx = (declared) => {
  const entries = []
  const waited = []
  const provided = {}
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    // `ctx.reflect.provide` is how a client plugin publishes a service. The fake
    // records it instead of registering it, which is enough for the two things
    // asserted below: that the capability is published at all, and that the
    // channel handed to the launcher is the one behind it.
    reflect: {
      provide(name, value) {
        provided[name] = value
        return () => Promise.resolve()
      },
    },
    locale: {
      register(namespace, dictionary) {
        dictionaries[namespace] = dictionary
        return () => {}
      },
    },
    slots: {
      inject(name, factory) {
        waited.push(name)
        if (!declared.has(name)) return () => {}
        const dispose = factory()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(options, component) {
        entries.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, entries, waited, provided }
}

// ── 1. the home this deployment has: dsh-web-ui's shared action row ────────
const strip = makeClientCtx(new Set(['shell.action']))
clientPlugin.apply(strip.ctx)
/** The entries the primary composition produced (the rest of this file drives them). */
const entries = strip.entries
check('the launcher registers one entry, in the shared action row',
  entries.length === 1 && entries[0].options.name === 'shell.action', JSON.stringify(entries.map(entry => entry.options)))
check('and it is told it is rendering inside that row',
  entries[0].options.inject().inRow === true, JSON.stringify(entries[0].options.inject()))
check('no pinned bar is registered beside the row',
  !strip.waited.includes('shell.overlay'), strip.waited.join(' | '))
check('the entry is a fresh id, so peers are not shadowed', entries[0].options.id === 'my-sider-panels', entries[0].options.id)
check('both dictionaries are registered under one namespace',
  dictionaries['mysider'] !== undefined && Object.keys(dictionaries['mysider'].zh).length === Object.keys(dictionaries['mysider'].en).length)
check('the stylesheet is injected and attributed to this plugin',
  window.document.querySelector('style[data-plugin="my-sider"]')?.dataset['pluginCss'] === 'my-sider/panels')

// ── 1b. the fallback: a deployment with no shared row ──────────────────────
// The pending timer is run on the spot rather than waited out: the code path is
// the same one, and a two-second sleep in a smoke test buys nothing.
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn) => { fn(); return 0 }
// `shell.overlay` IS declared here — ui-layout's AppFrame always declares it. What
// is missing is `shell.action`, i.e. a deployment without `dsh-web-ui`.
const alone = makeClientCtx(new Set(['shell.overlay']))
try {
  clientPlugin.apply(alone.ctx)
} finally {
  globalThis.setTimeout = realSetTimeout
}
check('with no shared row the launcher pins its own bar in the overlay layer',
  alone.entries.length === 1 && alone.entries[0].options.name === 'shell.overlay',
  JSON.stringify(alone.entries.map(entry => entry.options)))
check('and it is told it is NOT in a row',
  alone.entries[0].options.inject().inRow === false, JSON.stringify(alone.entries[0].options.inject()))
check('the two homes never both hold the launcher',
  alone.waited.includes('shell.action') && entries[0].options.name !== alone.entries[0].options.name,
  alone.waited.join(' | '))
check('the launcher is told where its open requests arrive',
  typeof entries[0].options.inject().requests?.subscribe === 'function',
  JSON.stringify(Object.keys(entries[0].options.inject())))

// ── 1c. the capability another plugin reaches for ──────────────────────────
// `ctx.webSidebar.open` is what `dsh-web-ui`'s document panel calls when a reader
// clicks a Feishu link. It must both reach the mounted launcher and ANSWER, since
// its answer is what decides between the sidebar and a plain tab.
const sidebarFace = strip.provided['webSidebar']
check('the plugin publishes the web-sidebar capability',
  typeof sidebarFace?.open === 'function', JSON.stringify(Object.keys(strip.provided)))
check('with no launcher mounted the request is refused, so the caller can fall back',
  sidebarFace.open('https://feishu.cn/docx/doxcn1') === false)
check('an empty address is refused too', sidebarFace.open('') === false)

/**
 * Build the translator the renderer would synthesize.
 * @param {Record<string, string>} dictionary - the Chinese dictionary.
 * @returns {Function} `t`.
 */
function makeT(dictionary) {
  return (key, params) => {
    const template = dictionary[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (_match, name) => String(params[name] ?? `{${name}}`))
  }
}

/** The session/workspace kit the frame hands an overlay entry. */
const seatProps = {
  useSessions: selector => selector({ current: 'sess-1' }),
  useWorkspaces: selector => selector({ items: [{ path: process.cwd(), sessionIds: ['sess-1'] }] }),
  t: makeT(dictionaries['mysider'].zh),
  // Exactly what this plugin's own registration injects: where it renders, and
  // the channel another plugin's document link arrives on.
  ...entries[0].options.inject(),
}

// The plugin's own fetches are RELATIVE, so the stub re-anchors them at the route
// server phase 1 built — which is what makes this phase end to end.
const nodeFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' && input.startsWith('/') ? `${server.origin}${input}` : input
  const response = await nodeFetch(url, init)
  if (process.env.TRACE_SHELL === '1' && typeof url === 'string' && url.includes('/my-sider/shell/')) {
    console.log(`    [trace] ${init?.method ?? 'GET'} ${url.replace(server.origin, '')} -> ${response.status} ${(await response.clone().text()).slice(0, 160)}`)
  }
  return response
}

const container = window.document.getElementById('host')
const root = createRoot(container)

/**
 * Let React and the panel's own promises settle.
 * @param {number} [ms] - how long to wait.
 */
const settle = async (ms = 80) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }

/**
 * Let a chain of network round-trips and timers settle.
 *
 * In SMALL act windows, deliberately: a single long window holds React's own
 * effect flush until it closes, so a panel whose state arrives mid-window (a
 * command's output, a probe's answer) would be asserted before React ever ran the
 * effect that renders it. Several short windows give React the boundaries it
 * needs, which is what a browser does frame by frame.
 * @param {number} [ms] - the total time to cover.
 * @param {number} [step] - the size of one window.
 */
const settleFor = async (ms = 800, step = 50) => {
  for (let waited = 0; waited < ms; waited += step) await settle(step)
}

/**
 * Click a node the way an operator would.
 * @param {Element} element - the node.
 */
const click = async (element) => {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
}

/**
 * Type into an input the way React's synthetic change path expects.
 * @param {HTMLInputElement} input - the field.
 * @param {string} value - the new value.
 */
const type = async (input, value) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

/** Find the launcher button whose label is the given copy. */
const barButton = label => [...window.document.querySelectorAll('[data-ms="barButton"]')]
  .find(button => button.getAttribute('aria-label')?.includes(label))

/**
 * The height the open command panel takes OUT of the page, as the launcher
 * publishes it. The stylesheet turns this one property into padding on the app's
 * mount node — the split — so it is the whole mechanism in one readable value.
 * @returns the raw custom-property value (empty when no panel is open).
 */
const shellReserve = () => window.document.documentElement.style.getPropertyValue('--ms-shell-h')

/** The open command panel's own rendered height, as its inline style carries it. */
const shellPanelHeight = () => window.document.querySelector('[data-ms="shellPanel"]')?.style.height

const Launcher = entries[0].component
await act(async () => { root.render(React.createElement(Launcher, seatProps)) })
await settle()

{
  const buttons = [...window.document.querySelectorAll('[data-ms="barButton"]')]
  check('the launcher renders both controls', buttons.length === 2, String(buttons.length))
  check('the sidebar control is labelled in the operator\'s language',
    barButton('侧边栏') !== undefined && barButton('下侧边栏') !== undefined)
  check('neither panel is open before a click',
    window.document.querySelector('[data-ms="webPanel"]') === null
    && window.document.querySelector('[data-ms="shellPanel"]') === null)
}

{
  await click(barButton('侧边栏'))
  const panel = window.document.querySelector('[data-ms="webPanel"]')
  check('clicking the sidebar control opens the sidebar', panel !== null)
  check('the sidebar opens with one blank tab', panel.querySelectorAll('[data-ms="webTab"]').length === 1)
  check('the empty state names the next step', panel.textContent.includes('还没有标签页'))
  check('the sidebar stops above the closed command panel', panel.style.bottom === '0px', panel.style.bottom)
  check('the sidebar docked right, leaving the frame its width', panel.style.width.endsWith('px'))

  // The address normalizer is the panel's own contract with the operator: bare
  // hosts are what people type.
  const address = panel.querySelector('[data-ms="webAddress"]')
  await type(address, `${upstream.origin.replace('http://', '')}/page/`)

  // The same input-method guard the command prompt needs, asserted here too: an
  // address is typed with the same keyboards, and an Enter that belongs to a
  // composition must not load a half-typed one.
  const composingAddress = new window.KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true, isComposing: true,
  })
  await act(async () => { address.dispatchEvent(composingAddress) })
  check('an IME\'s Enter does not load a half-typed address either',
    composingAddress.defaultPrevented === false
    && window.document.querySelector('[data-ms="webFrame"]') === null,
    String(composingAddress.defaultPrevented))

  await act(async () => {
    address.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await settleFor(400)

  const frame = window.document.querySelector('[data-ms="webFrame"]')
  check('a typed address loads in a frame', frame !== null, String(frame?.getAttribute('src')))
  check('a scheme-less host is normalized to http/https',
    frame.getAttribute('src') === `${upstream.origin}/page/`, frame.getAttribute('src'))
  check('the framing ban is detected and explained',
    window.document.querySelector('[data-ms="webPanel"]').textContent.includes('禁止被嵌入'))

  const switchButton = [...window.document.querySelectorAll('[data-ms="notice"] button')][0]
  await click(switchButton)
  await settle(120)
  const relayedFrame = window.document.querySelector('[data-ms="webFrame"]')
  check('switching to the relay points the frame at the host route',
    relayedFrame.getAttribute('src')?.startsWith('/my-sider/url/fetch?url=') === true,
    relayedFrame.getAttribute('src'))
  check('a relayed frame runs on an opaque origin', !relayedFrame.getAttribute('sandbox').includes('allow-same-origin'))

  // The relayed frame is really relayed: the same route, read directly.
  const relayedBody = await (await fetch(relayedFrame.getAttribute('src'))).text()
  check('the relayed body is the upstream page, framing ban lifted',
    relayedBody.includes('<img src="pic.png">') && !relayedBody.includes('X-Frame-Options'))

  await click(barButton('侧边栏'))
  check('clicking the control again closes the sidebar', window.document.querySelector('[data-ms="webPanel"]') === null)
}

{
  await click(barButton('下侧边栏'))
  const panel = window.document.querySelector('[data-ms="shellPanel"]')
  check('clicking the bottom control opens the command panel', panel !== null)

  // The panel says where commands will run as REAL text. A grey placeholder is not
  // an answer to "where am I": the operator has to be able to read the directory
  // without typing anything first, and typing into the field is an override.
  const dirField = panel.querySelector('[data-ms="shellDir"]')
  check('the command panel shows the session\'s directory as its value',
    dirField.value === process.cwd(), `value ${JSON.stringify(dirField.value)}`)

  // …and the command line says the same thing in shell form, so the input row
  // reads as this directory's prompt rather than as a bare `$`.
  const prompt = panel.querySelector('[data-ms="shellPrompt"]')
  check('the command prompt names the working directory',
    prompt.textContent.startsWith('…') && prompt.textContent.endsWith('$')
    && prompt.getAttribute('title') === process.cwd(),
    `${JSON.stringify(prompt.textContent)} / ${String(prompt.getAttribute('title'))}`)

  // "Opened by a click" must not mean "click again before typing": the panel takes
  // the caret itself as it mounts.
  const input = panel.querySelector('[data-ms="shellInput"]')
  check('the panel focuses its command line as it opens',
    window.document.activeElement === input, window.document.activeElement?.tagName)

  // Editing the directory field overrides the default, and the reset control
  // exists only while an override is in force.
  await type(dirField, '/tmp')
  const overridden = window.document.querySelector('[data-ms="shellDir"]')
  check('editing the directory field overrides where commands run',
    overridden.value === '/tmp' && window.localStorage.getItem('my-sider.shell.dir') === '/tmp',
    `${overridden.value} / ${String(window.localStorage.getItem('my-sider.shell.dir'))}`)
  const reset = [...window.document.querySelectorAll('[data-ms="iconButton"]')]
    .find(button => button.getAttribute('aria-label') === '恢复默认目录')
  check('a reset control appears with the override', reset !== undefined)
  await click(reset)
  await settle(40)
  const restored = window.document.querySelector('[data-ms="shellDir"]')
  check('resetting returns the field to the session\'s directory',
    restored.value === process.cwd() && window.localStorage.getItem('my-sider.shell.dir') === null,
    `${restored.value} / ${String(window.localStorage.getItem('my-sider.shell.dir'))}`)

  // The split, asserted where it is decided: opening the panel takes its height
  // OUT of the page instead of floating over it, and the reserve and the panel's
  // own height must be one number — two sources would disagree about where the
  // page ends.
  check('opening the panel reserves its height instead of covering the page',
    shellReserve() === shellPanelHeight() && Number.parseFloat(shellReserve()) > 0,
    `reserve ${JSON.stringify(shellReserve())} panel ${JSON.stringify(shellPanelHeight())}`)

  // …and the plugin's own stylesheet is what spends the reserve, on the mount node
  // the frame's percentage height descends from.
  const skin = [...window.document.querySelectorAll('style[data-plugin-css]')]
    .find(tag => tag.dataset.pluginCss === 'my-sider/panels')
  check('the reserve is spent as padding on the app\'s mount node',
    skin?.textContent.includes('padding-bottom: var(--ms-shell-h') === true,
    String(skin?.textContent.length))

  // A viewport shorter than the panel must not collapse the frame: the reserve is
  // clamped to leave the app a usable strip, and the panel follows it down.
  const viewport = window.innerHeight
  Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true })
  await act(async () => { window.dispatchEvent(new window.Event('resize')) })
  await settle(40)
  check('a short viewport clamps what the panel takes from the page',
    Number.parseFloat(shellReserve()) === 160, shellReserve())
  Object.defineProperty(window, 'innerHeight', { value: viewport, configurable: true })
  await act(async () => { window.dispatchEvent(new window.Event('resize')) })
  await settle(40)
  check('a restored viewport restores the panel\'s height',
    Number.parseFloat(shellReserve()) === Math.min(300, viewport - 240), shellReserve())

  await type(input, 'echo from the panel')

  // An IME's Enter belongs to the IME. Chinese input methods commit a composition on
  // Enter, and that committed text arrives through `change`; a handler that takes the
  // keydown as "run" both CANCELS the commit (preventDefault) — so the operator
  // presses Enter again and again and nothing at all happens — and, when a commit
  // does land first, runs whatever half-composed string was in the field (the host
  // really did receive `p w d`, `l s` and `k s`). So: not prevented, and no run.
  const composing = new window.KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true, isComposing: true,
  })
  await act(async () => { input.dispatchEvent(composing) })
  await settle(60)
  check('an IME\'s Enter is left to the IME, not read as "run"',
    composing.defaultPrevented === false, String(composing.defaultPrevented))
  check('…so the composition is not submitted while it is still open',
    window.document.querySelectorAll('[data-ms="shellEntry"]').length === 1
    && window.document.querySelector('[data-ms="shellInput"]').value === 'echo from the panel',
    `${String(window.document.querySelectorAll('[data-ms="shellEntry"]').length)} entr(ies)`)

  // Some engines report a composition keydown only through the legacy keyCode, with no
  // isComposing flag at all.
  const legacyComposition = new window.KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true,
  })
  Object.defineProperty(legacyComposition, 'keyCode', { value: 229 })
  await act(async () => { input.dispatchEvent(legacyComposition) })
  await settle(60)
  check('a composition keydown reported only as keyCode 229 is left alone too',
    legacyComposition.defaultPrevented === false, String(legacyComposition.defaultPrevented))

  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  // Still inside the run, and deliberately so: the fake seam's process lives ~32ms
  // but the panel learns that on its next poll (400ms), so this window is where the
  // serialization contract is observable.
  await settle(120)
  const promptInput = () => window.document.querySelector('[data-ms="shellPanel"] [data-ms="shellInput"]')
  check('the prompt shuts while a command runs, and says why',
    promptInput().disabled === true && promptInput().getAttribute('placeholder') === '命令正在执行…',
    `${String(promptInput().disabled)} / ${String(promptInput().getAttribute('placeholder'))}`)

  // Long enough for the next poll cycle (the panel polls a running command every
  // 400 ms) plus the fake seam's own ~30 ms lifetime.
  await settleFor(900)

  const refreshed = window.document.querySelector('[data-ms="shellPanel"]')
  // The terminal shape, asserted negatively: a separate row, a Run button or run
  // tabs would each be a second place to look, which is what this panel stopped
  // having. Their selectors must match nothing at all.
  const stale = ['shellInputRow', 'shellRunButton', 'shellRun', 'shellRuns']
    .filter(name => refreshed.querySelectorAll(`[data-ms="${name}"]`).length > 0)
  check('the panel is a transcript and a prompt, with no row, Run button or run tabs',
    stale.length === 0, stale.join(', '))
  check('the prompt line is the transcript\'s own last line',
    refreshed.querySelector('[data-ms="shellPane"]')?.lastElementChild?.getAttribute('data-ms')
      === 'shellPromptLine')
  check('the prompt comes back once the command settles', promptInput().disabled === false)

  const entries = [...refreshed.querySelectorAll('[data-ms="shellEntry"]')]
  const echoOf = entry => entry.querySelector('[data-ms="shellEchoText"]')?.textContent
  check('every run the host still holds is in the transcript',
    entries.length === 2, `${String(entries.length)} entr(ies)`)
  check('the transcript reads oldest first, so the newest command is at its foot',
    echoOf(entries[0]) === 'echo hi' && echoOf(entries.at(-1)) === 'echo from the panel',
    entries.map(echoOf).join(' | '))
  check('a run from before the panel opened is rendered whole, echo and output together',
    entries[0].querySelector('[data-ms="shellEcho"]')?.textContent === '$ echo hi'
    && entries[0].querySelector('[data-ms="shellOut"]')?.textContent.includes('hello from the fake seam'),
    entries[0].textContent)

  const newestEntry = entries.at(-1)
  check('the entry echoes the command as a shell prompt',
    newestEntry.querySelector('[data-ms="shellEcho"]')?.textContent.includes('$ echo from the panel'))
  check('the command\'s output is rendered under its own echo',
    newestEntry.querySelector('[data-ms="shellOut"]')?.textContent.includes('hello from the fake seam'),
    newestEntry.querySelector('[data-ms="shellOut"]')?.textContent)
  check('stderr is merged into the same output',
    newestEntry.querySelector('[data-ms="shellOut"]')?.textContent.includes('a warning on stderr'),
    newestEntry.querySelector('[data-ms="shellOut"]')?.textContent)
  check('the settled entry carries its own status line',
    newestEntry.querySelector('[data-ms="shellStatus"]')?.textContent.includes('成功'),
    newestEntry.querySelector('[data-ms="shellStatus"]')?.textContent)
  check('the panel reports the sandbox mode the run used', refreshed.textContent.includes('workspace-write'))

  // An empty line is a COMPLETED line in a terminal: the shell has nothing to run and
  // reprints its prompt, which is the only acknowledgement such an Enter can give.
  // It is not a run (so not an entry), it sits where it was pressed, and 清屏 takes it
  // off the screen like anything else that is visible.
  const pressEnter = async () => {
    await act(async () => {
      window.document.querySelector('[data-ms="shellInput"]')
        .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await settle(40)
  }
  await pressEnter()
  const afterBlank = window.document.querySelector('[data-ms="shellPanel"]')
  const blanks = [...afterBlank.querySelectorAll('[data-ms="shellBlank"]')]
  check('an Enter on an empty prompt leaves the prompt line it was pressed on',
    blanks.length === 1 && blanks[0].textContent.trim() === '$', JSON.stringify(blanks[0]?.textContent))
  check('…and starts no run for it',
    afterBlank.querySelectorAll('[data-ms="shellEntry"]').length === 2,
    String(afterBlank.querySelectorAll('[data-ms="shellEntry"]').length))
  const paneChildren = [...afterBlank.querySelector('[data-ms="shellPane"]').children]
  const names = paneChildren.map(child => child.getAttribute('data-ms'))
  check('…in the place it was pressed, after the command before it and above the prompt',
    names.lastIndexOf('shellBlank') > names.lastIndexOf('shellEntry')
    && names.at(-1) === 'shellPromptLine', names.join(' | '))

  // Whitespace is not a command either, and must not become one.
  await type(afterBlank.querySelector('[data-ms="shellInput"]'), '   ')
  await pressEnter()
  const afterSpaces = window.document.querySelector('[data-ms="shellPanel"]')
  check('a whitespace-only line is another empty line, not a command that would fail',
    afterSpaces.querySelectorAll('[data-ms="shellBlank"]').length === 2
    && afterSpaces.querySelectorAll('[data-ms="shellEntry"]').length === 2
    && afterSpaces.querySelector('[data-ms="shellInput"]').value === '',
    afterSpaces.querySelectorAll('[data-ms="shellBlank"]').length)
  // The prompt takes the caret back after a line is taken, the way a terminal does.
  check('the caret comes back to the new prompt line',
    window.document.activeElement === afterSpaces.querySelector('[data-ms="shellInput"]'),
    window.document.activeElement?.getAttribute('data-ms'))

  // `clear` is the shell's own verb: the finished commands leave the screen, and the
  // prompt stays where the next command goes.
  const clearButton = [...afterSpaces.querySelectorAll('[data-ms="panelButton"]')]
    .find(button => button.textContent.includes('清屏'))
  await click(clearButton)
  await settle(40)
  const cleared = window.document.querySelector('[data-ms="shellPanel"]')
  check('clearing takes the finished commands off the transcript',
    cleared.querySelectorAll('[data-ms="shellEntry"]').length === 0,
    String(cleared.querySelectorAll('[data-ms="shellEntry"]').length))
  check('clearing takes the empty prompt lines with them',
    cleared.querySelectorAll('[data-ms="shellBlank"]').length === 0,
    String(cleared.querySelectorAll('[data-ms="shellBlank"]').length))
  check('clearing leaves the prompt in place, and nothing left for it to clear',
    cleared.querySelector('[data-ms="shellPromptLine"]') !== null
    && [...cleared.querySelectorAll('[data-ms="panelButton"]')]
      .find(button => button.textContent.includes('清屏'))?.disabled === true)

  await click(barButton('侧边栏'))
  await settle(60)
  const both = window.document.querySelector('[data-ms="webPanel"]')
  check('with both open the sidebar stops where the command panel begins',
    Number.parseFloat(both.style.bottom) > 0, both.style.bottom)
  await click(barButton('侧边栏'))
}

{
  await click(barButton('下侧边栏'))
  check('the bottom panel closes again', window.document.querySelector('[data-ms="shellPanel"]') === null)
  check('the page gets its space back when the panel closes', shellReserve() === '', JSON.stringify(shellReserve()))
}

await act(async () => { root.unmount() })

// ── teardown and verdict ─────────────────────────────────────────────────────

await server.close()
await upstream.close()

console.log()
if (failures > 0) {
  console.log(`smoke: ${String(failures)} assertion(s) failed`)
  process.exit(1)
}
console.log('smoke: every assertion held')
