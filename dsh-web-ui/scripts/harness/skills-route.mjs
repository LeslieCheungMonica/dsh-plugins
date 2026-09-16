/**
 * Offline harness for the skill marketplace's host half.
 *
 * Three things here are cheap to get wrong and expensive to notice:
 *
 * 1. **The identity.** The marketplace is per-reader, and the token is derived
 *    from an email address that this plugin may not take from the browser. The
 *    harness asserts the whole chain: the caller's Cookie is forwarded to the
 *    login plugin's session route, the address the LOGIN PLUGIN names is the one
 *    used, and a browser that names nothing gets a list anyway — because nothing
 *    it sends is trusted.
 * 2. **The two SkillHub calls, and their order.** `/auth/whoami` runs FIRST, so
 *    "your account was never provisioned" stays distinguishable from "nothing
 *    matched". A refusal there must not be followed by a search.
 * 3. **The parameters.** Exactly `packageType=SKILL` and `label=FDE`. Anything
 *    else — a `limit`, an `assetOwnership`, a caller-supplied filter — changes
 *    what the list MEANS, and a deployment that quietly started asking a
 *    different question would be indistinguishable from one whose data moved.
 *
 * A local HTTP server plays both roles: the login plugin's session route and
 * SkillHub. Every request it receives is recorded, so the ORDER and the exact
 * query are asserted rather than inferred from the answer.
 *
 * Usage: pnpm harness:skills-route   (builds the bundle first, then runs this)
 */
import { createServer } from 'node:http'

const {
  readSkillOptions, registerSkillRoutes, searchMarket,
  SKILLS_MARKET_PATH, skillHandle, skillToken,
} = await import('./out/skills-route.js')

/** One assertion, counted so the run reports a total. */
let checks = 0
const failures = []
const ok = (label, condition, detail = '') => {
  checks += 1
  if (!condition) failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
}
const eq = (label, actual, expected) => {
  ok(label, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}
const json = value => JSON.stringify(value)

// ── the two pure helpers, asserted without any HTTP ──────────────────────
{
  eq('the token is the local part plus -skillhub', skillToken('li.yh9@asiainfo-sec.com'), 'li.yh9-skillhub')
  eq('the handle drops the domain', skillHandle('li.yh9@asiainfo-sec.com'), 'li.yh9')
  eq('a bare handle still works', skillToken('li.yh9'), 'li.yh9-skillhub')
  eq('an address with no local part derives nothing', skillToken('@asiainfo-sec.com'), undefined)
  eq('an empty address derives nothing', skillToken('   '), undefined)
  // The local part is case-sensitive by RFC 5321, so folding it would silently
  // produce a DIFFERENT token rather than a normalized one.
  eq('case is preserved', skillToken('Li.YH9@asiainfo-sec.com'), 'Li.YH9-skillhub')
  eq('surrounding space is not part of the handle', skillToken(' li.yh9 @asiainfo-sec.com'), 'li.yh9-skillhub')
}

// ── the configuration reader ─────────────────────────────────────────────
{
  const defaults = readSkillOptions(undefined)
  eq('the default provider is the documented host', defaults.baseUrl, 'http://acp.asiainfo-sec.com')
  eq('the default login prefix is the login plugin\'s own', defaults.feishuPrefix, '/feishu-auth')
  ok('a default deadline exists', defaults.timeoutMs > 0)
  const configured = readSkillOptions({ baseUrl: 'http://localhost:9/', feishuPrefix: 'login/', timeoutMs: 1234 })
  eq('a trailing slash is normalized off the base URL', configured.baseUrl, 'http://localhost:9')
  eq('and off the prefix', configured.feishuPrefix, '/login')
  eq('and a missing leading slash is added', readSkillOptions({ feishuPrefix: 'x' }).feishuPrefix, '/x')
  eq('the deadline is taken from the row', configured.timeoutMs, 1234)
  const threw = (value) => { try { readSkillOptions(value); return null } catch (error) { return error.message } }
  ok('a non-object is refused with the field named', (threw('nope') ?? '').includes('config.skills must be an object'))
  ok('an empty base URL is refused', (threw({ baseUrl: '' }) ?? '').includes('config.skills.baseUrl'))
  ok('a zero deadline is refused', (threw({ timeoutMs: 0 }) ?? '').includes('config.skills.timeoutMs'))
}

// ── the fake world: the login plugin's session route AND SkillHub ────────
/** Every request the fake server received, in order. */
const seen = []
/** What `/<prefix>/session` answers. */
let sessionAnswer = { status: 200, body: { configured: true, authenticated: true, user: { email: 'li.yh9@asiainfo-sec.com' } } }
/** What `/api/cli/v1/auth/whoami` answers. */
let whoamiAnswer = {
  status: 200,
  body: { code: 0, msg: 'Fetched successfully', data: { handle: 'li.yh9', displayName: '李彦辉', email: 'li.yh9@asiainfo-sec.com' } },
}
/** What `/api/cli/v1/skills/search` answers. */
let searchAnswer = {
  status: 200,
  body: {
    code: 0,
    msg: 'Fetched successfully',
    data: {
      items: [
        { namespace: 'fde', slug: 'order-rework', displayName: '订单中心重构', summary: '把订单中心拆成两个服务。', latestVersion: '1.2.0', assetOwnership: 'PUBLIC' },
        { namespace: 'fde', slug: 'my-draft', displayName: '我的草稿技能', summary: '', latestVersion: '0.1.0', assetOwnership: 'PRIVATE' },
      ],
      total: 7,
      limit: 2,
    },
  },
}
/** Paths that answer a body which is not JSON at all. Per-path, because the
 * session probe is the first hop: making EVERYTHING html would test the probe's
 * unreadable arm instead of the search's. */
let htmlPaths = new Set()

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  seen.push({
    path: url.pathname,
    params: [...url.searchParams.entries()],
    authorization: req.headers.authorization ?? null,
    cookie: req.headers.cookie ?? null,
  })
  if (htmlPaths.has(url.pathname)) {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><html></html>')
    return
  }
  const pick = url.pathname === '/feishu-auth/session'
    ? sessionAnswer
    : url.pathname === '/api/cli/v1/auth/whoami'
      ? whoamiAnswer
      : url.pathname === '/api/cli/v1/skills/search'
        ? searchAnswer
        : { status: 404, body: { code: 404, msg: 'no such route' } }
  res.writeHead(pick.status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(pick.body))
})
await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
const PORT = server.address().port

/** A context with only what this module reads: the listening port. */
const ctx = { webServer: { port: PORT } }
const options = { baseUrl: `http://127.0.0.1:${PORT}`, feishuPrefix: '/feishu-auth', timeoutMs: 4000 }

/** Read the marketplace as a caller carrying `cookie`. */
const read = async (cookie) => {
  seen.length = 0
  return searchMarket(ctx, options, cookie)
}
const paths = () => seen.map(entry => entry.path)
/** Ask the marketplace for one term, with the request log reset first. */
const ask = async (term) => {
  seen.length = 0
  return searchMarket(ctx, options, 'feishu_session=abc123', term)
}
const queryOf = (index) => seen[index]?.params ?? []

// ── the happy path: the chain, in order ──────────────────────────────────
{
  const answer = await read('feishu_session=abc123')
  eq('the read succeeds', answer.ok, true)
  eq('exactly two hops reach the outside world — the session probe and whoami and the search',
    paths().join(' '), '/feishu-auth/session /api/cli/v1/auth/whoami /api/cli/v1/skills/search')
  eq('the caller\'s cookie is what the session route is asked with',
    seen[0].cookie, 'feishu_session=abc123')
  eq('the session probe carries no Authorization header', seen[0].authorization, null)
  eq('the token is derived from the VERIFIED address',
    seen[1].authorization, 'Bearer li.yh9-skillhub')
  eq('the token check runs BEFORE the search', paths()[1], '/api/cli/v1/auth/whoami')
  eq('and the search carries the same token', seen[2].authorization, 'Bearer li.yh9-skillhub')

  // The question itself: exactly two parameters, in the documented spelling.
  eq('the search asks exactly two questions', json(queryOf(2)), json([['packageType', 'SKILL'], ['label', 'FDE']]))
  eq('asset type is SKILL', queryOf(2)[0][1], 'SKILL')
  eq('label is FDE', queryOf(2)[1][1], 'FDE')
  ok('no other parameter travels (no limit, no assetOwnership, no q)',
    queryOf(2).every(([key]) => key === 'packageType' || key === 'label'), json(queryOf(2)))

  const snapshot = answer.data
  eq('the server\'s total travels, not the returned slice', snapshot.total, 7)
  eq('both items are mapped, in the server\'s order', json(snapshot.items.map(item => item.displayName)),
    json(['订单中心重构', '我的草稿技能']))
  eq('the card title is the display name', snapshot.items[0].displayName, '订单中心重构')
  eq('the card body is the summary', snapshot.items[0].summary, '把订单中心拆成两个服务。')
  eq('the version travels for the install step', snapshot.items[0].latestVersion, '1.2.0')
  eq('the namespace and slug travel as the skill\'s identity',
    `${snapshot.items[0].namespace}/${snapshot.items[0].slug}`, 'fde/order-rework')
  eq('a PRIVATE asset is labelled as one', snapshot.items[1].assetOwnership, 'PRIVATE')
  eq('a PUBLIC asset is labelled as one', snapshot.items[0].assetOwnership, 'PUBLIC')
  eq('the identity the list was read as comes from whoami', snapshot.verifiedEmail, 'li.yh9@asiainfo-sec.com')
  eq('and an empty summary is allowed to be empty', snapshot.items[1].summary, '')
}

// ── the list degrades field by field, never as a whole ───────────────────
{
  searchAnswer = {
    status: 200,
    body: {
      code: 0,
      data: {
        items: [
          { slug: 'no-name', namespace: 'fde' },
          { namespace: 'fde', slug: 'weird', displayName: '有名字', assetOwnership: 'SOMETHING_ELSE' },
          'not an object',
        ],
      },
    },
  }
  const answer = await read('feishu_session=abc123')
  eq('a missing display name falls back to the slug', answer.data.items[0].displayName, 'no-name')
  eq('missing strings become empty, not undefined', answer.data.items[0].summary, '')
  // An ownership this plugin does not know is the QUIETER label, so an unknown
  // value can never make a shared skill look like somebody's private one.
  eq('an unknown ownership reads as PUBLIC', answer.data.items[1].assetOwnership, 'PUBLIC')
  eq('a non-object element still yields a card', answer.data.items[2].displayName, '')
  eq('and with no total, the count is what was returned', answer.data.total, 3)
  searchAnswer = {
    status: 200,
    body: { code: 0, data: { items: [{ namespace: 'fde', slug: 'x', displayName: 'X', summary: 's', latestVersion: '1', assetOwnership: 'PUBLIC' }], total: 1 } },
  }
}

// ── the search term: the one thing the browser may add ───────────────────
// It NARROWS within a frame the browser does not control. Nothing here may drop or
// rename the two parameters that define what this deployment catalogues, and a term
// must travel as the reader typed it — SkillHub's matching is the service's business.
{
  await read('feishu_session=abc123')
  eq('no term means no q parameter at all', json(queryOf(2)), json([['packageType', 'SKILL'], ['label', 'FDE']]))

  const withTerm = await ask('命名空间')
  eq('a term is accepted', withTerm.ok, true)
  eq('and rides WITH the fixed frame, not instead of it',
    json(queryOf(2)), json([['packageType', 'SKILL'], ['label', 'FDE'], ['q', '命名空间']]))
  eq('the frame is still exactly the two documented values',
    json(queryOf(2).slice(0, 2)), json([['packageType', 'SKILL'], ['label', 'FDE']]))

  await ask('  用例  ')
  eq('surrounding space is not part of the term', queryOf(2).find(([key]) => key === 'q')[1], '用例')

  await ask('   ')
  eq('a blank term is no term', json(queryOf(2)), json([['packageType', 'SKILL'], ['label', 'FDE']]))

  // A term is data, so characters that would reshape a URL must survive the trip —
  // asserted on what the SERVER received, which the fake host recorded decoded.
  await ask('a&b=c/d?e#f')
  eq('a term holding URL syntax arrives intact', queryOf(2).find(([key]) => key === 'q')[1], 'a&b=c/d?e#f')

  await ask('100% 覆盖率')
  eq('percent and space survive the round trip', queryOf(2).find(([key]) => key === 'q')[1], '100% 覆盖率')

  const tooLong = await ask('x'.repeat(101))
  eq('a term past the cap is refused', tooLong.ok, false)
  eq('as a bad request', tooLong.error.code, 'bad-request')
  eq('without asking SkillHub anything', seen.length, 0)
  await ask('x'.repeat(100))
  eq('while a term exactly at the cap is fine', queryOf(2).find(([key]) => key === 'q')[1].length, 100)
}

// ── the identity chain's four refusals ───────────────────────────────────
{
  const noCookie = await read(undefined)
  eq('no cookie is no session', noCookie.error.code, 'no-session')
  eq('and nothing is asked of the outside world', seen.length, 0)

  const emptyCookie = await read('')
  eq('an empty cookie is no session too', emptyCookie.error.code, 'no-session')

  sessionAnswer = { status: 200, body: { configured: true, authenticated: false, loginUrl: '/login' } }
  const signedOut = await read('feishu_session=abc123')
  eq('an unauthenticated session is refused', signedOut.error.code, 'no-session')
  eq('before any SkillHub hop', paths().join(' '), '/feishu-auth/session')

  sessionAnswer = { status: 200, body: { configured: true, authenticated: true, user: { name: '李彦辉' } } }
  const noEmail = await read('feishu_session=abc123')
  eq('a session without an email cannot derive a token', noEmail.error.code, 'no-email')
  eq('and does not call SkillHub either', paths().join(' '), '/feishu-auth/session')

  sessionAnswer = { status: 200, body: { configured: true, authenticated: true, user: { email: '   ' } } }
  eq('a blank address is treated as absent', (await read('feishu_session=abc123')).error.code, 'no-email')

  sessionAnswer = { status: 200, body: { configured: true, authenticated: true, user: { email: 'li.yh9@asiainfo-sec.com' } } }
}

// ── the token check's refusals ───────────────────────────────────────────
{
  whoamiAnswer = { status: 401, body: { code: 401, msg: 'invalid token' } }
  const answer = await read('feishu_session=abc123')
  eq('a refused token is unauthorized', answer.error.code, 'unauthorized')
  ok('and the sentence names the token the reader has to provision',
    answer.error.message.includes('li.yh9-skillhub'), answer.error.message)
  eq('a refused token does NOT go on to search', paths().length, 2)

  whoamiAnswer = { status: 200, body: { code: 1001, msg: 'token not found' } }
  const envelopeRefusal = await read('feishu_session=abc123')
  eq('a non-zero envelope code on the token check is unauthorized too',
    envelopeRefusal.error.code, 'unauthorized')
  ok('with the service\'s own words', envelopeRefusal.error.message.includes('token not found'),
    envelopeRefusal.error.message)
  eq('and still no search', paths().length, 2)

  whoamiAnswer = { status: 200, body: { code: 0, msg: 'ok', data: { handle: 'li.yh9' } } }
  const noEmailInWhoami = await read('feishu_session=abc123')
  eq('a whoami without an email does not sink the read', noEmailInWhoami.ok, true)
  eq('the verified session address labels the list instead',
    noEmailInWhoami.data.verifiedEmail, 'li.yh9@asiainfo-sec.com')

  whoamiAnswer = {
    status: 200,
    body: { code: 0, msg: 'Fetched successfully', data: { handle: 'li.yh9', displayName: '李彦辉', email: 'li.yh9@asiainfo-sec.com' } },
  }
}

// ── the search's refusals ────────────────────────────────────────────────
{
  searchAnswer = { status: 401, body: { code: 401, msg: 'token expired' } }
  const refused = await read('feishu_session=abc123')
  eq('a search refusal is unauthorized', refused.error.code, 'unauthorized')
  eq('and the token check DID run first', paths()[1], '/api/cli/v1/auth/whoami')

  searchAnswer = { status: 500, body: { code: 500, msg: 'boom' } }
  eq('a server error is an http error', (await read('feishu_session=abc123')).error.code, 'http-error')

  searchAnswer = { status: 200, body: { code: 42, msg: 'bad label' } }
  const coded = await read('feishu_session=abc123')
  eq('a non-zero envelope code on the search is an http error', coded.error.code, 'http-error')
  ok('reporting the service\'s message', coded.error.message.includes('bad label'), coded.error.message)

  searchAnswer = { status: 200, body: { code: 0, msg: 'ok' } }
  eq('a success without data is unreadable', (await read('feishu_session=abc123')).error.code, 'unreadable')

  searchAnswer = { status: 200, body: { msg: 'no code field' } }
  eq('a body without a code is unreadable', (await read('feishu_session=abc123')).error.code, 'unreadable')

  htmlPaths = new Set(['/api/cli/v1/skills/search'])
  eq('a search body that is not JSON is unreadable', (await read('feishu_session=abc123')).error.code, 'unreadable')
  htmlPaths = new Set(['/feishu-auth/session'])
  // The session probe is this plugin's own family, and it being served a page
  // means that half is not mounted; the reader's action is the same as any other
  // missing session, so it is reported as one.
  eq('a session probe that is not JSON is reported as no session',
    (await read('feishu_session=abc123')).error.code, 'no-session')
  htmlPaths = new Set()

  searchAnswer = { status: 200, body: { code: 0, data: { items: [], total: 0 } } }
}

// ── unreachable is its own code, and it is the one off-VPN readers hit ───
{
  // A port that is genuinely closed: bound once and released, so the connection
  // is REFUSED rather than refused-by-policy (`fetch` rejects port 1 as a "bad
  // port" before it ever dials, which is a different arm).
  const probe = createServer(() => {})
  await new Promise(resolve => { probe.listen(0, '127.0.0.1', resolve) })
  const closedPort = probe.address().port
  await new Promise(resolve => { probe.close(resolve) })
  const answer = await searchMarket(
    ctx,
    { baseUrl: `http://127.0.0.1:${closedPort}`, feishuPrefix: '/feishu-auth', timeoutMs: 2000 },
    'feishu_session=abc123',
  )
  eq('a refused socket is unreachable', answer.error.code, 'unreachable')
  // The session probe is the FIRST hop, so a bad base URL is only reached when
  // the session is good — which is the order the reader sees in practice.
  //
  // The CAUSE has to survive: `fetch` reports a refused socket, a DNS failure and
  // a TLS problem all as `TypeError: fetch failed` and hides the reason in
  // `cause`, and off the company network that difference is the entire diagnosis.
  ok('the sentence names the transport cause, not just "fetch failed"',
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|connect/i.test(answer.error.message), answer.error.message)
  ok('and keeps it attached to what failed',
    answer.error.message.includes('SkillHub is unreachable'), answer.error.message)
}

// ── the route itself: one exact path, GET only, failures as content ──────
{
  // The refusals above left an empty catalogue behind; the route has to be
  // exercised against a real answer, since what it FORWARDS is the thing it owns.
  searchAnswer = {
    status: 200,
    body: {
      code: 0,
      msg: 'Fetched successfully',
      data: {
        items: [
          { namespace: 'fde', slug: 'order-rework', displayName: '订单中心重构', summary: '把订单中心拆成两个服务。', latestVersion: '1.2.0', assetOwnership: 'PUBLIC' },
          { namespace: 'fde', slug: 'my-draft', displayName: '我的草稿技能', summary: '', latestVersion: '0.1.0', assetOwnership: 'PRIVATE' },
        ],
        total: 7,
        limit: 2,
      },
    },
  }
  const registered = []
  const routeCtx = {
    webServer: {
      port: PORT,
      register: (route) => { registered.push(route); return () => {} },
    },
    logger: () => ({ info() {}, warn() {}, error() {} }),
    effect: (body) => { body() },
  }
  registerSkillRoutes(routeCtx, options)
  // The family is three routes now (market, installed, install); what THIS harness
  // is about is the market one, and the install harness asserts the other two.
  const marketRoute = registered.find(route => route.path === SKILLS_MARKET_PATH)
  ok('the market route is registered', marketRoute !== undefined, JSON.stringify(registered.map(route => route.path)))
  eq('and it is an exact route, not a prefix', marketRoute.kind, 'exact')

  /** Drive the handler with a fake request and response. */
  const call = async (method, cookie, options2 = {}) => {
    const req = { method, url: options2.url ?? SKILLS_MARKET_PATH, headers: cookie === undefined ? {} : { cookie } }
    let captured = null
    const res = {
      headersSent: false,
      writeHead(status, headers) { captured = { status, headers }; this.headersSent = true },
      end(body) { captured = { ...captured, body } },
    }
    seen.length = 0
    await marketRoute.handler(req, res)
    return captured
  }

  const posted = await call('POST')
  eq('a non-GET is refused with 405', posted.status, 405)
  eq('naming the method it does accept', posted.headers.allow, 'GET')
  eq('and touching nothing', seen.length, 0)

  seen.length = 0
  const searched = await call('GET', 'feishu_session=abc123', { url: `${SKILLS_MARKET_PATH}?q=${encodeURIComponent('权限测试')}` })
  eq('a term in the request reaches SkillHub', queryOf(2).find(([key]) => key === 'q')[1], '权限测试')
  eq('and the answer is a normal 200', searched.status, 200)

  const answered = await call('GET', 'feishu_session=abc123')
  eq('a success answers HTTP 200', answered.status, 200)
  const envelope = JSON.parse(answered.body)
  eq('with ok: true', envelope.ok, true)
  eq('and the snapshot under `data`', envelope.data.items.length, 2)
  eq('and no caching, because a published skill can be withdrawn',
    answered.headers['cache-control'], 'no-store')

  sessionAnswer = { status: 200, body: { configured: true, authenticated: false } }
  const refused = await call('GET', 'feishu_session=abc123')
  eq('a domain failure is still HTTP 200', refused.status, 200)
  const refusedEnvelope = JSON.parse(refused.body)
  eq('carrying ok: false', refusedEnvelope.ok, false)
  eq('with the code the modal switches on', refusedEnvelope.error.code, 'no-session')
  eq('and a sentence for a human', typeof refusedEnvelope.error.message, 'string')
  sessionAnswer = { status: 200, body: { configured: true, authenticated: true, user: { email: 'li.yh9@asiainfo-sec.com' } } }

  const anonymous = await call('GET')
  eq('a browser with no session is not an error the server hides', anonymous.status, 200)
  eq('it is a state the modal renders', JSON.parse(anonymous.body).error.code, 'no-session')
}

server.close()

// ── report ───────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`skills-route: ${failures.length}/${checks} checks FAILED`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log(`skills-route: ${checks} checks passed`)
