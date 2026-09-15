/**
 * Wire-level smoke test for the host half.
 *
 * This drives the plugin's real route handlers against a fake webserver and a
 * stubbed Feishu API, so it can assert the whole chain — login page → signed
 * state → code exchange → identity → allowlist → session cookie → gated
 * document — without an application id, a secret, a phone, or a running GUI.
 *
 * What it deliberately does NOT cover: whether Feishu's own QR page renders
 * inside the iframe on a given network, and whether a real scan produces a
 * code. Those need a registered application and a human with a phone; every
 * other seam is exercised here.
 *
 * Run: node scripts/smoke.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { apply } from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROFILE = join(process.env['HOME'] ?? '', '.dsh', 'profiles', 'web')
/**
 * The anchor shape the REAL host gives a plugin: app-boot sets
 * `pathToFileURL(dirname(config)).href + '/'`, i.e. a FILE URL with a trailing
 * slash. Testing with a plain directory here would have hidden a resolution bug
 * that silently turned the server-side gate off in production — so the harness
 * uses the production shape, and one case below pins the plain-directory shape
 * too.
 */
const BASE_URL = pathToFileURL(PROFILE).href + '/'

let passed = 0
let failed = 0

/**
 * Run one assertion block.
 * @param {string} label - the case name.
 * @param {() => void | Promise<void>} body - the case.
 * @returns {Promise<void>} resolves when the case has run.
 */
async function test(label, body) {
  try {
    await body()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** A `node:http`-shaped response recorder. */
function createResponse() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      res.status = status
      res.headers = headers ?? {}
      res.headersSent = true
      return res
    },
    end(chunk) {
      if (typeof chunk === 'string') res.body += chunk
      return res
    },
  }
  return res
}

/**
 * Build a fake cordis context that captures what the plugin registers.
 * @param {object} options - `baseUrl` for dist resolution.
 * @returns {object} the fake ctx plus its ledger.
 */
function createContext(options = {}) {
  /** @type {Map<string, Function>} */
  const routes = new Map()
  /** @type {Array<(html: string) => string>} */
  const taps = []
  const logs = []
  const disposers = []
  const record = kind => (format, ...params) => logs.push(`${kind}: ${String(format)}${params.length === 0 ? '' : ` ${params.map(String).join(' ')}`}`)

  const ctx = {
    baseUrl: options.baseUrl,
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    get: () => undefined,
    logger: () => ({ info: record('info'), warn: record('warn'), error: record('error') }),
    webServer: {
      port: 3080,
      host: '127.0.0.1',
      register: ({ path, handler }) => {
        assert.ok(!routes.has(path), `duplicate route ${path}`)
        routes.set(path, handler)
        return () => routes.delete(path)
      },
      tapIndex: (transform) => {
        taps.push(transform)
        return () => {
          const at = taps.indexOf(transform)
          if (at >= 0) taps.splice(at, 1)
        }
      },
      applyIndexTaps: (html) => taps.reduce((acc, transform) => transform(acc), html),
    },
  }
  return { ctx, routes, logs, disposers }
}

/**
 * Invoke one captured route.
 * @param {object} harness - the fake context ledger.
 * @param {string} url - path + query.
 * @param {object} init - method, headers, cookie.
 * @returns {Promise<object>} the recorded response.
 */
async function call(harness, url, init = {}) {
  const path = url.split('?')[0]
  const handler = harness.routes.get(path)
  assert.ok(handler !== undefined, `no route registered for ${path}`)
  const res = createResponse()
  const req = {
    url,
    method: init.method ?? 'GET',
    headers: {
      host: init.host ?? '127.0.0.1:3080',
      ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
      ...(init.headers ?? {}),
    },
  }
  await handler(req, res)
  return res
}

/** Add one `Set-Cookie` header (which may be a list) to a Cookie request header. */
function cookieHeaderFrom(res) {
  const raw = res.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
  return list.map(value => value.split(';')[0]).join('; ')
}

/** The default config every armed case uses. */
const BASE_CONFIG = {
  appId: 'cli_test_app_id',
  appSecret: 'test-secret',
  brandName: 'ForgeX',
  brand: 'feishu',
}

/** Install a fetch stub that answers the two Feishu calls the host makes. */
function stubFeishu({ tokenBody, userBody, failures = 0 } = {}) {
  const calls = []
  let remainingFailures = failures
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('/oauth/v3/token') || String(url).includes('/authen/v2/')) {
      if (remainingFailures > 0) {
        remainingFailures -= 1
        return {
          status: 400,
          ok: false,
          text: async () => JSON.stringify({ error: 'invalid_grant', code: 20003, error_description: 'nope' }),
        }
      }
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify(tokenBody ?? { code: 0, access_token: 'u-test-token', expires_in: 7200 }),
      }
    }
    if (String(url).includes('/authen/v1/user_info')) {
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify(userBody ?? {
          code: 0,
          data: { open_id: 'ou_test_user', name: '测试用户', email: 'tester@asiainfo.com' },
        }),
      }
    }
    return { status: 200, ok: true, text: async () => JSON.stringify({ code: 0 }) }
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

/**
 * Extract the OAuth `state` a login response carried: from the page body
 * (embed mode, where the state rides the iframe's src) or from the authorize
 * redirect (redirect mode, where it rides the Location header).
 * @param {object} res - the recorded login response.
 * @returns {string} the decoded state.
 */
function stateFromLogin(res) {
  // The page escapes `&` as `&amp;` inside attribute values, so undo that first.
  const source = res.status === 302 ? String(res.headers.location ?? '') : res.body
  const match = /[?&]state=([^&"']+)/u.exec(source.replaceAll('&amp;', '&'))
  assert.ok(match !== null, `login response carried no state parameter (status ${res.status})`)
  return decodeURIComponent(match[1])
}

console.log('feishu-login host smoke')

await test('unconfigured (no appId) registers nothing and says so', () => {
  const harness = createContext()
  apply(harness.ctx, {})
  assert.equal(harness.routes.size, 0, 'no route may be registered without an appId')
  assert.ok(harness.logs.some(line => line.includes('no appId configured')), 'the warning must be logged')
})

await test('gate: false registers nothing', () => {
  const harness = createContext()
  apply(harness.ctx, { ...BASE_CONFIG, gate: false })
  assert.equal(harness.routes.size, 0)
  assert.ok(harness.logs.some(line => line.includes('gate disabled')))
})

await test('dist resolution: a FILE-URL baseUrl and a plain directory both work', () => {
  for (const baseUrl of [BASE_URL, PROFILE, PROFILE + '/']) {
    const harness = createContext({ baseUrl })
    apply(harness.ctx, BASE_CONFIG)
    assert.ok(harness.routes.has('/'), `the / gate must register for baseUrl ${baseUrl}`)
    assert.ok(!harness.logs.some(line => line.includes('cannot resolve')), `no resolution warning for ${baseUrl}`)
  }
})

await test('dist resolution: an unresolvable anchor degrades loudly, never silently', () => {
  const harness = createContext({ baseUrl: 'file:///nonexistent-anchor/' })
  apply(harness.ctx, BASE_CONFIG)
  assert.ok(!harness.routes.has('/'), 'the document gate must not register')
  assert.ok(harness.logs.some(line => line.includes('gate is OFF')), 'the degradation must be explained')
  assert.ok(harness.routes.has('/login'), 'the login page must still exist')
})

await test('armed: registers the five endpoints, the two document gates, and one index tap', () => {
  const harness = createContext({ baseUrl: BASE_URL })
  apply(harness.ctx, BASE_CONFIG)
  for (const path of ['/login', '/feishu-auth/callback', '/feishu-auth/session', '/feishu-auth/logout', '/feishu-auth/start', '/', '/index.html']) {
    assert.ok(harness.routes.has(path), `missing route ${path}`)
  }
  assert.ok(harness.logs.some(line => line.includes('armed')), 'the arming line must be logged')
})

await test('GET / without a session redirects to the login page with next', async () => {
  const harness = createContext({ baseUrl: BASE_URL })
  apply(harness.ctx, BASE_CONFIG)
  const res = await call(harness, '/')
  assert.equal(res.status, 302)
  assert.equal(res.headers.location, '/login?next=%2F')
})

await test('GET /login renders the Feishu QR iframe with app_id, redirect_uri and state', async () => {
  const harness = createContext({ baseUrl: BASE_URL })
  apply(harness.ctx, BASE_CONFIG)
  const res = await call(harness, '/login?next=%2Fsome%2Fpath')
  assert.equal(res.status, 200)
  // Default embed technique is the official QR SDK: it is handed the legacy
  // authorize URL (app id, redirect_uri and state all ride inside it).
  assert.match(res.body, /LarkSSOSDKWebQRCode/u, 'the official QR SDK script')
  assert.match(res.body, /client_id=cli_test_app_id/u)
  assert.match(res.body, new RegExp(`redirect_uri=${encodeURIComponent('http://127.0.0.1:3080/feishu-auth/callback')}`, 'u'))
  assert.match(res.body, /state=/u)
  assert.match(res.body, /ForgeX/u)
  assert.match(res.body, /回调地址/u)
})

await test('qrEmbed: page iframes the qrconnect login page, offset to frame the code', async () => {
  const harness = createContext({ baseUrl: BASE_URL })
  apply(harness.ctx, { ...BASE_CONFIG, qrEmbed: 'page' })
  const res = await call(harness, '/login')
  assert.equal(res.status, 200)
  assert.match(res.body, /connect\/qrconnect\/page\/sso/u)
  assert.match(res.body, /app_id=cli_test_app_id/u)
  // The offset class is what puts Feishu's code inside the visible window
  // instead of its language switcher; losing it re-breaks the QR silently.
  assert.match(res.body, /class="offset"/u, 'the iframe must carry the framing offset')
})

await test('GET /feishu-auth/session reports configured + unauthenticated', async () => {
  const harness = createContext({ baseUrl: BASE_URL })
  apply(harness.ctx, BASE_CONFIG)
  const res = await call(harness, '/feishu-auth/session')
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.configured, true)
  assert.equal(body.authenticated, false)
  assert.equal(body.loginUrl, '/login')
})

await test('callback: rejects a forged state', async () => {
  const harness = createContext({ baseUrl: BASE_URL })
  apply(harness.ctx, BASE_CONFIG)
  const res = await call(harness, '/feishu-auth/callback?code=x&state=forged.signature')
  assert.equal(res.status, 400)
  assert.match(res.body, /state 校验失败/u)
})

await test('callback: access_denied renders a cancellation page', async () => {
  const harness = createContext({ baseUrl: BASE_URL })
  apply(harness.ctx, BASE_CONFIG)
  const res = await call(harness, '/feishu-auth/callback?error=access_denied&state=whatever')
  assert.equal(res.status, 400)
  assert.match(res.body, /取消了授权/u)
})

await test('full chain: scan → token → identity → cookie → gated document', async () => {
  const harness = createContext({ baseUrl: BASE_URL })
  //  mode is the top-level flow, so the callback answers a 302.
  apply(harness.ctx, { ...BASE_CONFIG, mode: 'redirect' })
  const feishu = stubFeishu()
  try {
    const login = await call(harness, '/login')
    const state = stateFromLogin(login)

    const callback = await call(harness, `/feishu-auth/callback?code=THE_CODE&state=${encodeURIComponent(state)}`)
    assert.equal(callback.status, 302, `expected a redirect, got ${callback.status}: ${callback.body.slice(0, 200)}`)
    assert.equal(callback.headers.location, '/')
    const cookies = callback.headers['set-cookie']
    assert.ok(Array.isArray(cookies) && cookies.length === 2, 'two cookies must be set (credential + hint)')
    assert.ok(cookies.some(value => value.includes('dsh_feishu_session=') && value.includes('HttpOnly')))
    assert.ok(cookies.some(value => value.includes('dsh_feishu_hint=1') && !value.includes('HttpOnly')))

    // The code really travelled to Feishu's v3 token endpoint, with the secret.
    const tokenCall = feishu.calls.find(entry => entry.url.includes('/oauth/v3/token'))
    assert.ok(tokenCall !== undefined, 'the v3 token endpoint must be called')
    assert.match(String(tokenCall.init.body), /grant_type=authorization_code/u)
    assert.match(String(tokenCall.init.body), /client_secret=test-secret/u)
    assert.match(String(tokenCall.init.body), /code=THE_CODE/u)

    const cookie = cookieHeaderFrom(callback)
    const gated = await call(harness, '/', { cookie })
    assert.equal(gated.status, 200)
    assert.ok(gated.body.includes('__DSH_BOOT__') || gated.body.includes('<div id="root">'), 'the app document must be served')
    assert.ok(gated.body.includes('data-dsh-feishu-login="gate"'), 'the pre-boot gate must ride the document')

    const probe = await call(harness, '/feishu-auth/session', { cookie })
    const body = JSON.parse(probe.body)
    assert.equal(body.authenticated, true)
    assert.equal(body.user.openId, 'ou_test_user')
    assert.equal(body.user.name, '测试用户')

    const logout = await call(harness, '/feishu-auth/logout', { method: 'POST', cookie })
    assert.equal(logout.status, 200)
    const cleared = logout.headers['set-cookie']
    assert.ok(cleared.every(value => value.includes('Max-Age=0')), 'logout must expire both cookies')
  } finally {
    feishu.restore()
  }
})

await test('callback: the code exchange falls back v3 → v2', async () => {
  const harness = createContext({ baseUrl: BASE_URL })
  apply(harness.ctx, { ...BASE_CONFIG, mode: 'redirect' })
  const feishu = stubFeishu({ failures: 1 })
  try {
    const login = await call(harness, '/login')
    const state = stateFromLogin(login)
    const callback = await call(harness, `/feishu-auth/callback?code=C&state=${encodeURIComponent(state)}`)
    assert.equal(callback.status, 302, `expected a redirect, got ${callback.status}`)
    assert.ok(feishu.calls.some(entry => entry.url.includes('/oauth/v3/token')), 'v3 must be tried first')
    assert.ok(feishu.calls.some(entry => entry.url.includes('/authen/v2/oauth/token')), 'v2 must be tried second')
  } finally {
    feishu.restore()
  }
})

await test('allowlist: a domain rule admits the matching email', async () => {
  const harness = createContext({ baseUrl: BASE_URL })
  apply(harness.ctx, { ...BASE_CONFIG, mode: 'redirect', allow: ['email:@asiainfo.com'] })
  const feishu = stubFeishu()
  try {
    const login = await call(harness, '/login')
    const state = stateFromLogin(login)
    const callback = await call(harness, `/feishu-auth/callback?code=C&state=${encodeURIComponent(state)}`)
    assert.equal(callback.status, 302)
  } finally {
    feishu.restore()
  }
})

await test('allowlist: a domain rule refuses a foreign email, showing the identity', async () => {
  const harness = createContext({ baseUrl: BASE_URL })
  apply(harness.ctx, { ...BASE_CONFIG, mode: 'redirect', allow: ['email:@asiainfo.com'] })
  const feishu = stubFeishu({
    userBody: { code: 0, data: { open_id: 'ou_outsider', name: '外人', email: 'outsider@example.com' } },
  })
  try {
    const login = await call(harness, '/login')
    const state = stateFromLogin(login)
    const callback = await call(harness, `/feishu-auth/callback?code=C&state=${encodeURIComponent(state)}`)
    assert.equal(callback.status, 403)
    assert.match(callback.body, /无访问权限/u)
    assert.match(callback.body, /ou_outsider/u, 'the denied page must print the identity to allowlist')
    assert.ok(harness.logs.some(line => line.includes('refused by the allowlist')))
  } finally {
    feishu.restore()
  }
})

await test('allowlist: a rule naming a field Feishu withheld explains itself', async () => {
  const harness = createContext({ baseUrl: BASE_URL })
  apply(harness.ctx, { ...BASE_CONFIG, mode: 'redirect', allow: ['email:@asiainfo.com'] })
  // No email in user_info: the rule cannot match whatever the truth is, and the
  // page must say why instead of looking like a wrong allowlist.
  const feishu = stubFeishu({ userBody: { code: 0, data: { open_id: 'ou_noemail', name: '无邮箱' } } })
  try {
    const login = await call(harness, '/login')
    const state = stateFromLogin(login)
    const callback = await call(harness, '/feishu-auth/callback?code=C&state=' + encodeURIComponent(state))
    assert.equal(callback.status, 403)
    assert.match(callback.body, /contact:user.email:readonly/u, 'the missing scope must be named')
    assert.ok(harness.logs.some(line => line.includes('contact:user.email:readonly')))
  } finally {
    feishu.restore()
  }
})

await test('allowlist: allow: [none] refuses everybody', async () => {
  const harness = createContext({ baseUrl: BASE_URL })
  apply(harness.ctx, { ...BASE_CONFIG, mode: 'redirect', allow: ['none'] })
  const feishu = stubFeishu()
  try {
    const login = await call(harness, '/login')
    const state = stateFromLogin(login)
    const callback = await call(harness, `/feishu-auth/callback?code=C&state=${encodeURIComponent(state)}`)
    assert.equal(callback.status, 403)
  } finally {
    feishu.restore()
  }
})

await test('embedded flow: the callback answers a bridge page, not a redirect', async () => {
  const harness = createContext({ baseUrl: BASE_URL })
  apply(harness.ctx, BASE_CONFIG)
  const feishu = stubFeishu()
  try {
    const login = await call(harness, '/login?next=%2Fdeep%2Flink')
    const state = stateFromLogin(login)
    const callback = await call(harness, `/feishu-auth/callback?code=C&state=${encodeURIComponent(state)}`)
    assert.equal(callback.status, 200, 'the iframe must get a document, not a 302')
    assert.match(callback.body, /window\.top\.location\.replace/u)
    assert.match(callback.body, /"\/deep\/link"/u, 'the sanitized next must be carried through the state')
  } finally {
    feishu.restore()
  }
})

await test('redirect mode: /login bounces straight to the authorize page', async () => {
  const harness = createContext({ baseUrl: BASE_URL })
  apply(harness.ctx, { ...BASE_CONFIG, mode: 'redirect' })
  const res = await call(harness, '/login')
  assert.equal(res.status, 302)
  assert.match(res.headers.location, /^https:\/\/accounts\.feishu\.cn\/open-apis\/authen\/v1\/authorize\?/u)
  assert.match(res.headers.location, /client_id=cli_test_app_id/u)
})

await test('lark brand: every default endpoint moves to larksuite', async () => {
  const harness = createContext({ baseUrl: BASE_URL })
  apply(harness.ctx, { ...BASE_CONFIG, brand: 'lark', mode: 'redirect' })
  const res = await call(harness, '/login')
  assert.match(res.headers.location, /accounts\.larksuite\.com/u)
})

await test('index tap: the gate script is injected once, in <head>, and is idempotent', () => {
  const harness = createContext({ baseUrl: BASE_URL })
  apply(harness.ctx, BASE_CONFIG)
  const source = readFileSync(join(PROFILE, '..', '..', '..', 'vscodeProjects', 'deepseek-harness', 'apps', 'web', 'dist', 'index.html'), 'utf8')
  const once = harness.ctx.webServer.applyIndexTaps(source)
  const twice = harness.ctx.webServer.applyIndexTaps(once)
  assert.equal((once.match(/data-dsh-feishu-login="gate"/gu) ?? []).length, 1)
  assert.equal(once, twice, 'the transform must be idempotent')
  const headAt = once.indexOf('<head>')
  const scriptAt = once.indexOf('data-dsh-feishu-login="gate"')
  const moduleAt = once.indexOf('<script type="module"')
  assert.ok(scriptAt > headAt && scriptAt < moduleAt, 'the gate must run before the app bundle')
  assert.match(once, /__DSH_FEISHU_LOGIN__/u, 'the browser half needs its deployment facts')
})

await test('security: a next= of "//evil.example" never leaves the origin', async () => {
  const harness = createContext({ baseUrl: BASE_URL })
  apply(harness.ctx, BASE_CONFIG)
  const res = await call(harness, '/login?next=%2F%2Fevil.example')
  assert.equal(res.status, 200)
  assert.ok(!res.body.includes('evil.example'), 'the open-redirect candidate must be dropped')
})

await test('pre-boot script: runs before the app, bounces an unsigned visitor, honours the hint', () => {
  const harness = createContext({ baseUrl: BASE_URL })
  apply(harness.ctx, BASE_CONFIG)
  const document_ = '<!doctype html><html><head><script type="module" src="/assets/index.js"></script></head><body><div id="root"></div></body></html>'
  const gated = harness.ctx.webServer.applyIndexTaps(document_)
  const open = /<script data-dsh-feishu-login="gate">([\s\S]*?)<\/script>/u.exec(gated)
  assert.ok(open !== null, 'the tap must inject a gate script')
  const program = open[1]

  /** Run the program against a minimal document/window pair. */
  const run = (cookie, storage = {}) => {
    let navigated = null
    const window = {
      location: { pathname: '/session/abc', search: '?x=1', hash: '#top', replace: (url) => { navigated = url } },
      sessionStorage: {
        getItem: key => storage[key] ?? null,
        setItem: (key, value) => { storage[key] = value },
        removeItem: (key) => { delete storage[key] },
      },
    }
    const document = { cookie }
    // eslint-disable-next-line no-new-func -- the injected program is the unit under test
    new Function('window', 'document', program)(window, document)
    return { navigated, storage, global: window['__DSH_FEISHU_LOGIN__'] }
  }

  const unsigned = run('')
  assert.equal(unsigned.navigated, '/login?next=' + encodeURIComponent('/session/abc?x=1#top'))
  assert.deepEqual(unsigned.global, {
    prefix: '/feishu-auth', loginUrl: '/login', accountChip: true, hideSessionLog: true, brandName: 'ForgeX',
  }, 'the browser half must receive its deployment facts')

  const signed = run('other=1; dsh_feishu_hint=1; more=2')
  assert.equal(signed.navigated, null, 'a hint cookie must let the document through')

  // The loop guard: a second bounce within the window is suppressed, and the
  // guard is consumed so the next load gates again.
  const first = run('')
  const second = run('', first.storage)
  assert.equal(second.navigated, null, 'the loop guard must break a repeat bounce')
  const third = run('', second.storage)
  assert.ok(third.navigated !== null, 'the guard must be consumed, not permanent')
})

await test('a missing secret never blocks the document (fail open, loudly)', async () => {
  const harness = createContext({ baseUrl: BASE_URL })
  apply(harness.ctx, { ...BASE_CONFIG, appSecret: undefined, appSecretRef: 'DSH_FEISHU_LOGIN_TEST_UNSET' })
  const previous = process.env['DSH_FEISHU_LOGIN_TEST_UNSET']
  delete process.env['DSH_FEISHU_LOGIN_TEST_UNSET']
  try {
    const res = await call(harness, '/')
    assert.equal(res.status, 200, 'an unauthenticatable gate must not lock the operator out')
    assert.ok(harness.logs.some(line => line.includes('gate is OPEN')), 'the failure must be logged')
    const login = await call(harness, '/login')
    assert.equal(login.status, 503)
  } finally {
    if (previous !== undefined) process.env['DSH_FEISHU_LOGIN_TEST_UNSET'] = previous
  }
})

console.log(`\n${String(passed)} passed, ${String(failed)} failed`)
process.exit(failed === 0 ? 0 : 1)
