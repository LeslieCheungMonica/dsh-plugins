/**
 * Offline harness for the docs panel's identity consistency rule.
 *
 * The panel reads Feishu Drive through `lark-cli`, which holds exactly ONE
 * user credential per host, while the GUI's login plugin authenticates each
 * browser separately. Those are two different identity planes, so without a
 * rule the panel happily shows the归档账号's folders to somebody who signed in
 * as themselves.
 *
 * The rule is: the panel serves Drive data only when the browser's own
 * `dsh-feishu-login` session names the SAME Feishu user the CLI is bound to.
 * This script pins that rule down without a browser, a real Feishu account, or
 * a running GUI, by standing up a REAL gate on loopback (a throwaway HTTP
 * server that answers `<prefix>/session`) and stubbing `lark-cli` on disk.
 *
 * It answers the questions a reviewer would otherwise have to trust:
 *
 * 1. **Which answers are allowed to open the door.** A gate that is absent
 *    (404), unreachable, or answering something that is not the gate's JSON is
 *    no gate at all — and a deployment without the login plugin must keep its
 *    docs panel working. Only a CLEAR gate answer can refuse.
 * 2. **That an anonymous browser is refused.** A gate that is mounted and says
 *    `authenticated: false` means nobody signed in, so Drive reads are refused
 *    rather than served to whoever can reach the port.
 * 3. **That a mismatch is refused, and refused WITHOUT touching Feishu.** The
 *    refusal must happen before any Drive read: proving it by asserting the
 *    stubbed CLI was never asked for `drive`.
 * 4. **That open_ids from two different applications are never compared.** A
 *    Feishu `open_id` is scoped to the application that issued it, so an app
 *    mismatch must fall back to allowing the read — the alternative is every
 *    session被锁死 the moment the two sides are pointed at different apps.
 * 5. **That `/state` names both identities**, which is what lets the panel say
 *    "you are signed in as X, the docs account is Y" instead of going blank.
 * 6. **That the login routes stay open.** `/auth/*` is how the operator FIXES a
 *    mismatch, so gating it would make the panel unusable exactly when it is
 *    the only way out.
 *
 * Usage: node scripts/harness/lark-identity.mjs
 */
import { createServer } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'

const STUB_DIR = '/tmp/dsh-web-ui-lark-identity'
const STUB = `${STUB_DIR}/lark-cli`
const PREFIX = '/feishu-auth'

/** The CLI's own account: the one `lark-cli` is bound to on this host. */
const DOCS_APP = 'cli_app0000000000000'
const DOCS_OPEN_ID = 'ou_docs000000000000000000000000000'

/** Somebody else's session: signed in to the GUI, not the CLI's account. */
const VIEWER_OPEN_ID = 'ou_viewer00000000000000000000000000'

/**
 * The stub CLI. Two calls matter here: `auth status` is where the adapter
 * learns which account (and which application) the CLI is bound to, and
 * `drive files list` is the Drive read that must NOT happen on a refusal.
 */
await mkdir(STUB_DIR, { recursive: true })
await writeFile(STUB, `#!/usr/bin/env bash
# Stub lark-cli for the identity harness: records every argv, serves the
# scenario's status document, and answers a folder listing.
argv="$*"
echo "$argv" >> ${STUB_DIR}/argv.log
case "$argv" in
  *"auth status"*)
    cat ${STUB_DIR}/status.json 2>/dev/null || echo '{}'
    ;;
  *"contact +get-user"*)
    cat ${STUB_DIR}/profile.json 2>/dev/null || echo '{"ok":true,"data":{"user":{}}}'
    ;;
  *"drive files list"*)
    cat ${STUB_DIR}/list.json 2>/dev/null || echo '{}'
    ;;
  *) echo '{"ok":true,"data":{}}' ;;
esac
`, { mode: 0o755 })

// The route module reads the CLI path from the environment at call time, so
// pointing it at the stub is what keeps this harness off the operator's account.
process.env['DSH_WEB_UI_LARK_CLI'] = STUB
process.env['DSH_WEB_UI_PROJECTS_FILE'] = `${STUB_DIR}/projects.json`

const { registerLarkRoutes } = await import('../../src/host/routes.ts')

/** One folder listing, which is what an allowed read returns. */
function listing() {
  return {
    ok: true,
    data: {
      files: [{ token: 'doccn1', type: 'docx', name: '计划', url: 'https://feishu.cn/docx/doccn1' }],
      has_more: false,
    },
  }
}

/** The CLI's own status document, as `auth status --json` prints it. */
function statusDoc({ appId = DOCS_APP, openId = DOCS_OPEN_ID, userName = '归档账号' } = {}) {
  return {
    appId,
    identities: { user: { status: 'ready', openId, userName, tokenStatus: 'valid' } },
  }
}

/**
 * Stand up the gate on loopback and answer `<prefix>/session` with one shape.
 * @param answer - what the gate should do for the session route.
 * @returns the port it listens on, and how to stop it.
 */
async function startGate(answer) {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (path !== `${PREFIX}/session`) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    if (answer.kind === 'not-found') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    if (answer.kind === 'html') {
      // What the frontend's SPA fallback answers for an unknown path: a 200
      // whose body is a document, not this route's JSON.
      res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html></html>')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { port, stop: () => new Promise((resolve) => server.close(resolve)) }
}

/**
 * Register the REAL routes against one gate answer and one CLI status.
 * @param input - the gate's answer and the CLI's own identity.
 * @returns the handlers, and a stop function for the gate.
 */
async function scenario({ gate, status, list } = {}) {
  await writeFile(`${STUB_DIR}/status.json`, JSON.stringify(status ?? statusDoc()))
  await writeFile(`${STUB_DIR}/profile.json`, JSON.stringify({
    ok: true,
    data: { user: { name: '归档账号', open_id: DOCS_OPEN_ID, en_name: 'Docs' } },
  }))
  await writeFile(`${STUB_DIR}/list.json`, JSON.stringify(list ?? listing()))
  await rm(`${STUB_DIR}/argv.log`, { force: true })

  const answer = gate ?? { kind: 'json', body: { configured: true, authenticated: false, loginUrl: '/login' } }
  // "Unreachable" is a port nobody listens on: bind one, then let it go. The
  // number stays usable as an address that refuses connections.
  let port = 0
  let stop = async () => {}
  if (answer.kind === 'unreachable') {
    const transient = await startGate({ kind: 'not-found' })
    port = transient.port
    await transient.stop()
  } else {
    const server = await startGate(answer)
    port = server.port
    stop = server.stop
  }

  const handlers = new Map()
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    effect: (factory) => factory(),
    webServer: {
      port,
      register: ({ path, handler }) => { handlers.set(path, handler); return () => {} },
    },
  }
  registerLarkRoutes(ctx, { feishuPrefix: PREFIX })
  return { handlers, stop }
}

/** One synthetic request, iterable so body-carrying routes can read it. */
function fakeRequest({ method = 'GET', url = '/dsh-web-ui/lark', cookie = undefined, body = undefined } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url,
    headers: cookie === undefined ? {} : { cookie },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
}

/** One synthetic response that records what the route wrote. */
function fakeResponse() {
  const chunks = []
  return {
    status: 0,
    headers: {},
    headersSent: false,
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; this.headersSent = true },
    end(text = '') { chunks.push(Buffer.isBuffer(text) ? text : Buffer.from(String(text))) },
    get bytes() { return Buffer.concat(chunks) },
  }
}

/**
 * Drive one request through one real handler.
 * @param routes - the registered handlers.
 * @param target - the exact pathname, query string included.
 * @param options - the request to synthesize.
 * @returns the status and the decoded body.
 */
async function call(routes, target, options = {}) {
  const [path, query = ''] = target.split('?')
  const res = fakeResponse()
  const handler = routes.get(path)
  if (handler === undefined) return { status: 0, body: null }
  await handler(fakeRequest({ ...options, url: query === '' ? path : `${path}?${query}` }), res)
  let body = null
  try { body = JSON.parse(res.bytes.toString('utf8')) } catch { body = res.bytes.toString('utf8') }
  return { status: res.status, body }
}

/** Everything the stubbed CLI was asked to do, one argv per line. */
async function argvLog() {
  return readFile(`${STUB_DIR}/argv.log`, 'utf8').catch(() => '')
}

/** Whether the stubbed CLI was ever asked for a Drive read. */
async function readDrive() {
  return (await argvLog()).includes('drive')
}

const SESSION_COOKIE = 'dsh_feishu_session=stub-token'
const FILES = '/dsh-web-ui/lark/files?folder=fldroot'
const STATE = '/dsh-web-ui/lark/state'
const LOGIN = '/dsh-web-ui/lark/auth/login'

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

/** A gate that answers with one identity verdict. */
const signedIn = (openId, appId = DOCS_APP) => ({
  kind: 'json',
  body: {
    configured: true,
    authenticated: true,
    loginUrl: '/login',
    appId,
    user: { name: '李宁', openId, email: 'li.ning6@asiainfo-sec.com' },
  },
})

// 1. NO GATE. A deployment without the login plugin — or one whose gate is
//    mounted under another prefix — must keep its docs panel working. This is
//    the case that a naive "compare the identities" implementation breaks.
{
  const { handlers, stop } = await scenario({ gate: { kind: 'not-found' } })
  const answer = await call(handlers, FILES, { cookie: SESSION_COOKIE })
  check('a gate that answers 404 is no gate: the read is allowed',
    answer.body?.ok === true && (answer.body?.nodes ?? []).length === 1,
    JSON.stringify(answer.body))
  await stop()
}

// 2. A gate that answers something which is NOT the gate's JSON — the SPA
//    fallback's HTML, for instance. Same rule: not a gate, so allow.
{
  const { handlers, stop } = await scenario({ gate: { kind: 'html' } })
  const answer = await call(handlers, FILES, { cookie: SESSION_COOKIE })
  check('a gate answering HTML is no gate either: the read is allowed',
    answer.body?.ok === true, JSON.stringify(answer.body))
  await stop()
}

// 3. A gate whose socket refuses connections. Still not a gate.
{
  const { handlers } = await scenario({ gate: { kind: 'unreachable' } })
  const answer = await call(handlers, FILES, { cookie: SESSION_COOKIE })
  check('an unreachable gate is no gate: the read is allowed',
    answer.body?.ok === true, JSON.stringify(answer.body))
}

// 4. A MOUNTED gate that says nobody signed in. This is the case the old
//    behaviour got wrong in the other direction: anybody who can reach the
//    port could read the归档账号's Drive without logging in at all.
{
  const { handlers, stop } = await scenario()
  const answer = await call(handlers, FILES, { cookie: SESSION_COOKIE })
  check('a mounted gate with no session refuses the read',
    answer.status === 200 && answer.body?.ok === false && answer.body?.error.code === 'identity-mismatch',
    JSON.stringify(answer.body))
  check('and the refusal never reached Feishu',
    !(await readDrive()), (await argvLog()).trim())
  await stop()
}

// 5. THE DISCRIMINATING CASE: a session for somebody who is not the CLI's
//    account. Anything served here is one operator's folders shown to another.
{
  const { handlers, stop } = await scenario({ gate: signedIn(VIEWER_OPEN_ID) })
  const answer = await call(handlers, FILES, { cookie: SESSION_COOKIE })
  check('a session for a different Feishu user than the CLI refuses the read',
    answer.body?.ok === false && answer.body?.error.code === 'identity-mismatch',
    JSON.stringify(answer.body))
  check('and that refusal never reached Feishu either',
    !(await readDrive()), (await argvLog()).trim())
  await stop()
}

// 6. The same user: the read is served. Without this the rule could be "refuse
//    everything", which would pass every check above.
{
  const { handlers, stop } = await scenario({ gate: signedIn(DOCS_OPEN_ID) })
  const answer = await call(handlers, FILES, { cookie: SESSION_COOKIE })
  check('a session for the CLI\'s own account is allowed through',
    answer.body?.ok === true && (answer.body?.nodes ?? []).length === 1,
    JSON.stringify(answer.body))
  await stop()
}

// 7. OPEN_IDS ARE APPLICATION-SCOPED. When the two sides name different
//    applications their open_ids are drawn from different namespaces, so
//    comparing them would report a mismatch for the SAME person — every
//    session locked out of the panel. The rule falls back to allowing, and
//    says so in the host log.
{
  const { handlers, stop } = await scenario({ gate: signedIn(VIEWER_OPEN_ID, 'cli_otherapp000000000') })
  const answer = await call(handlers, FILES, { cookie: SESSION_COOKIE })
  check('open_ids from different applications are never compared',
    answer.body?.ok === true, JSON.stringify(answer.body))
  await stop()
}

// 8. No cookie at all. A browser that never logged in carries nothing to
//    verify, which is the same state as an anonymous session.
{
  const { handlers, stop } = await scenario()
  const answer = await call(handlers, FILES)
  check('a request with no session cookie at all is refused',
    answer.body?.ok === false && answer.body?.error.code === 'identity-mismatch',
    JSON.stringify(answer.body))
  await stop()
}

// 9. `/state` must NAME BOTH SIDES. A panel that only knows "mismatch" can go
//    blank; one that knows who is who can say what to do about it.
{
  const { handlers, stop } = await scenario({ gate: signedIn(VIEWER_OPEN_ID) })
  const answer = await call(handlers, STATE, { cookie: SESSION_COOKIE })
  check('/state reports the docs account the CLI is bound to',
    answer.body?.ok === true && answer.body?.user?.openId === DOCS_OPEN_ID,
    JSON.stringify(answer.body))
  check('/state reports the signed-in viewer and the mismatch',
    answer.body?.mismatch === true && answer.body?.viewer?.openId === VIEWER_OPEN_ID,
    JSON.stringify(answer.body))
  await stop()
}

// 10. And it reports agreement as agreement, so the panel can render normally.
{
  const { handlers, stop } = await scenario({ gate: signedIn(DOCS_OPEN_ID) })
  const answer = await call(handlers, STATE, { cookie: SESSION_COOKIE })
  check('/state reports a matching viewer without a mismatch',
    answer.body?.mismatch === false && answer.body?.viewer?.openId === DOCS_OPEN_ID,
    JSON.stringify(answer.body))
  await stop()
}

// 11. With no gate at all, `/state` still answers: there is nobody to compare
//     against, and inventing a mismatch would lock out a deployment that has
//     no login plugin.
{
  const { handlers, stop } = await scenario({ gate: { kind: 'not-found' } })
  const answer = await call(handlers, STATE, { cookie: SESSION_COOKIE })
  check('/state answers without a gate, reporting no mismatch and no viewer',
    answer.body?.ok === true && answer.body?.mismatch === false && (answer.body?.viewer ?? null) === null,
    JSON.stringify(answer.body))
  await stop()
}

// 12. THE WAY OUT HAS TO STAY OPEN. `/auth/*` is how an operator replaces the
//     CLI's account with their own; gating it behind the identity rule would
//     leave a mismatched session with no route back.
{
  const { handlers, stop } = await scenario({ gate: signedIn(VIEWER_OPEN_ID) })
  const handlers_ = handlers
  const answer = await call(handlers_, LOGIN, { method: 'POST', body: JSON.stringify({ scopes: [] }) })
  check('the login route answers even while the identity is mismatched',
    answer.status !== 200 || answer.body?.error?.code !== 'identity-mismatch',
    JSON.stringify(answer.body))
  await stop()
}

// 13. The stub was actually exercised — a harness whose stub never ran proves
//     nothing about any of the above.
{
  const { handlers, stop } = await scenario({ gate: signedIn(DOCS_OPEN_ID) })
  await call(handlers, FILES, { cookie: SESSION_COOKIE })
  check('the stubbed CLI was actually exercised', await readDrive(), (await argvLog()).trim())
  await stop()
}

let failed = 0
for (const entry of results) {
  if (!entry.ok) failed += 1
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name}${entry.detail === '' ? '' : `\n      ${entry.detail}`}`)
}
console.log(failed === 0 ? `\n${String(results.length)} checks passed` : `\n${String(failed)} of ${String(results.length)} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
