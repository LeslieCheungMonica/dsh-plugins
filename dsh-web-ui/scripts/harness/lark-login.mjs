/**
 * Offline harness for the panel's interactive Feishu login.
 *
 * The panel's other failure modes are answered by a retry; "the login does not
 * carry this scope" is not, because retrying changes nothing. It is answered by
 * authorizing: a device flow whose QR the panel shows, whose completion the host
 * detects, and after which the read that failed is simply re-read. This script
 * pins that flow down without a browser and without a real Feishu account, by
 * registering the REAL routes (`registerLarkRoutes`) against a fake webserver
 * and stubbing `lark-cli` on disk.
 *
 * It answers the questions a reviewer would otherwise have to trust:
 *
 * 1. **Which failures offer the flow.** `need_user_authorization` — the shape
 *    the CLI prints when the user identity exists but does not cover the scope,
 *    with or without its `subtype` — is classified as `scope-missing` and carries
 *    the scopes the CLI named, so the panel knows what to ask for. A permission
 *    refusal that is NOT about authorization still reports `forbidden`.
 * 2. **What the flow runs.** The scope goes to `auth login --scope … --no-wait
 *    --json`, the QR is rendered by `auth qrcode`, and completion is a THIRD call
 *    (`auth login --device-code …`) that runs in the background — the only step
 *    the CLI offers that reports whether the user authorized.
 * 3. **That the background child does not block the panel.** The device-code
 *    call waits on a human for up to ten minutes, so it must stay OUT of the
 *    adapter's serialized queue: a folder read issued while a login is pending
 *    still reaches the CLI.
 * 4. **That a login actually lands.** One successful completion drops the
 *    adapter's caches, so the read that failed is re-read from Feishu rather
 *    than served from the copy that failed.
 * 5. **The lifecycle.** `pending` → `done`, `cancel` (which kills the child),
 *    a second start replacing the first, and expiry after `expires_in`.
 * 6. **That nothing from a request becomes an argv element.** A scope is the one
 *    request field that reaches the CLI as a word, so it is validated against the
 *    scope alphabet; a malformed body is a 400 that never starts a process.
 *
 * Usage: node scripts/harness/lark-login.mjs
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'

const STUB_DIR = '/tmp/dsh-web-ui-lark-login'
const STUB = `${STUB_DIR}/lark-cli`
const SCOPE = 'space:document:retrieve'
const VERIFY = 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=STUB&user_code=ABCD-1234'

/** The stub's answer files, rewritten per scenario. */
await mkdir(STUB_DIR, { recursive: true })
await writeFile(STUB, `#!/usr/bin/env bash
# Stub lark-cli for the login harness: it records every argv, serves the
# scenario's answer files, and renders a real (8-byte) PNG for \`auth qrcode\`.
argv="$*"
echo "$argv" >> ${STUB_DIR}/argv.log
printf '<%s>\n' "$@" >> ${STUB_DIR}/args.log
case "$argv" in
  *"auth login --scope"*)
    cat ${STUB_DIR}/wait.json 2>/dev/null || echo '{}'
    ;;
  *"auth login --device-code"*)
    count=$(cat ${STUB_DIR}/device.count 2>/dev/null || echo 0)
    echo $((count + 1)) > ${STUB_DIR}/device.count
    # The real \`lark-cli\` is a Node SHIM that spawns the Go binary, so this
    # stands in for that grandchild: signalling the shim's pid alone would leave
    # it behind, polling a one-shot device code for its full ten minutes.
    sleep 30 &
    grand=$!
    echo $grand > ${STUB_DIR}/grandchild.pid
    # Stands in for a human scanning: the real call blocks until they do.
    sleep "\${STUB_DEVICE_SLEEP:-0.4}"
    cat ${STUB_DIR}/device.json 2>/dev/null || echo '{"ok":true}'
    if [ "\${STUB_DEVICE_KEEP_GRANDCHILD:-0}" != "1" ]; then kill "$grand" 2>/dev/null; fi
    ;;
  *"auth qrcode"*)
    out=""
    prev=""
    for arg in "$@"; do
      if [ "$prev" = "-o" ]; then out="$arg"; fi
      prev="$arg"
    done
    if [ -n "$out" ]; then printf '\\x89PNG\\r\\n\\x1a\\n' > "$out"; fi
    echo '{"ok":true,"data":{"file_path":"'"$out"'"}}'
    ;;
  *"drive files list"*)
    count=$(cat ${STUB_DIR}/list.count 2>/dev/null || echo 0)
    echo $((count + 1)) > ${STUB_DIR}/list.count
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

/** Every path this module registers, after one registration. */
async function collectRoutes() {
  /** Stands in for the host's webserver service. */
  const handlers = new Map()
  /** The subset of a cordis context this registration touches. */
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    effect: (factory) => factory(),
    webServer: {
      register: ({ path, handler }) => { handlers.set(path, handler); return () => {} },
    },
  }
  registerLarkRoutes(ctx)
  return handlers
}

const handlers = await collectRoutes()

/** One synthetic request. */
function fakeRequest({ method = 'GET', url = '/dsh-web-ui/lark', body = undefined } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
}

/** One synthetic response that records what the route wrote, bytes included. */
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
 * Point the stub at one scenario and clear its counters.
 * @param input - the login answers, the listing answer, and the device-call sleep.
 * @returns the handlers for a fresh registration.
 */
async function scenario({ wait, device, list, deviceSleep = '0.4', keepGrandchild = false } = {}) {
  await writeFile(`${STUB_DIR}/wait.json`, JSON.stringify(wait ?? {
    ok: true,
    device_code: 'dc-stub',
    verification_url: VERIFY,
    expires_in: 600,
  }))
  await writeFile(`${STUB_DIR}/device.json`, JSON.stringify(device ?? { ok: true }))
  await writeFile(`${STUB_DIR}/list.json`, JSON.stringify(list ?? listing()))
  process.env['STUB_DEVICE_SLEEP'] = deviceSleep
  process.env['STUB_DEVICE_KEEP_GRANDCHILD'] = keepGrandchild ? '1' : '0'
  for (const file of ['list.count', 'device.count', 'argv.log', 'args.log', 'grandchild.pid']) await rm(`${STUB_DIR}/${file}`, { force: true })
  return collectRoutes()
}

/** One successful folder listing. */
function listing() {
  return {
    ok: true,
    data: {
      files: [{ token: 'doccn1', type: 'docx', name: '计划', url: 'https://feishu.cn/docx/doccn1' }],
      has_more: false,
    },
  }
}

/**
 * Drive one request through one real handler.
 * @param routes - the registered handlers.
 * @param path - the exact pathname to drive.
 * @param options - the request to synthesize.
 * @returns the status, the body, and the raw bytes.
 */
async function call(routes, target, options = {}) {
  // The lookup key is a pathname; the request carries the query string with it.
  const [path, query = ''] = target.split('?')
  const res = fakeResponse()
  const handler = routes.get(path)
  // A route that does not exist yet answers nothing rather than throwing: a
  // missing registration is one of the things this harness is here to report.
  if (handler === undefined) return { status: 0, body: null, bytes: Buffer.alloc(0), contentType: '' }
  await handler(fakeRequest({ ...options, url: query === '' ? path : `${path}?${query}` }), res)
  let body = null
  try { body = JSON.parse(res.bytes.toString('utf8')) } catch { body = res.bytes.toString('utf8') }
  return { status: res.status, body, bytes: res.bytes, contentType: res.headers['content-type'] ?? '' }
}

/** How many times the stub served one kind of call. */
async function count(name) {
  const text = await readFile(`${STUB_DIR}/${name}.count`, 'utf8').catch(() => '0')
  return Number.parseInt(text.trim(), 10) || 0
}

/** The pid of the shim's own child, as the stub wrote it. */
async function grandchildPid() {
  const text = await readFile(`${STUB_DIR}/grandchild.pid`, 'utf8').catch(() => '0')
  return Number.parseInt(text.trim(), 10) || 0
}

/**
 * Whether a pid is still alive.
 * @param pid - the process to probe.
 * @returns true when it exists.
 */
function alive(pid) {
  if (pid === 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Everything the stubbed CLI was asked to do, one argv per line. */
async function argvLog() {
  return readFile(`${STUB_DIR}/argv.log`, 'utf8').catch(() => '')
}

/** Every argv ELEMENT the stubbed CLI was handed, wrapped in `<>`, one per line. */
async function argsLog() {
  return readFile(`${STUB_DIR}/args.log`, 'utf8').catch(() => '')
}

/**
 * Wait for a condition, so the harness never depends on one fixed sleep.
 * @param probe - returns true when the condition holds.
 * @param timeoutMs - how long to keep asking.
 * @returns whether it held.
 */
async function until(probe, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

const LOGIN = '/dsh-web-ui/lark/auth/login'
const STATUS = '/dsh-web-ui/lark/auth/status'
const QR = '/dsh-web-ui/lark/auth/qr.png'
const CANCEL = '/dsh-web-ui/lark/auth/cancel'
const FILES = '/dsh-web-ui/lark/files?folder=fldroot'

// 1. The route set. Four routes rather than one, because the browser does four
//    different things: start, ask, render the image, give up.
check('the login route is registered', typeof handlers.get(LOGIN) === 'function')
check('the login status route is registered', typeof handlers.get(STATUS) === 'function')
check('the QR image route is registered', typeof handlers.get(QR) === 'function')
check('the login cancel route is registered', typeof handlers.get(CANCEL) === 'function')

// 2. Classification: the shape the panel must act on. The CLI prints
//    `need_user_authorization` when the user identity exists but does not cover
//    the scope; the scopes it names are what the flow has to request.
let routes = await scenario({
  list: {
    ok: false,
    identity: 'user',
    error: {
      type: 'authorization',
      subtype: 'need_user_authorization',
      message: `need_user_authorization (user: ou_0123456789abcdef0123456789abcdef)`,
      hint: `run \`lark-cli auth login --scope "${SCOPE}" --no-wait --json\` to get device_code and verification_url`,
      missing_scopes: [SCOPE],
    },
  },
})
let answer = await call(routes, FILES)
check('an authorization failure is reported as a missing scope',
  answer.body?.ok === false && answer.body?.error.code === 'scope-missing',
  JSON.stringify(answer.body))
check('the scopes to request travel with that failure',
  Array.isArray(answer.body?.error.missingScopes) && answer.body?.error.missingScopes.join(' ') === SCOPE,
  JSON.stringify(answer.body))

// 3. The same failure without `subtype` or `missing_scopes` — the message and the
//    hint are the only evidence then, and they are enough.
routes = await scenario({
  list: {
    ok: false,
    identity: 'user',
    error: {
      type: 'authorization',
      message: 'need_user_authorization (user: ou_0123456789abcdef0123456789abcdef)',
      hint: `run \`lark-cli auth login --scope "space:document:retrieve" --no-wait --json\``,
    },
  },
})
answer = await call(routes, FILES)
check('a message-only authorization failure is classified the same way',
  answer.body?.ok === false && answer.body?.error.code === 'scope-missing',
  JSON.stringify(answer.body))
check('and its scope is recovered from the hint',
  Array.isArray(answer.body?.error.missingScopes) && answer.body?.error.missingScopes.join(' ') === SCOPE,
  JSON.stringify(answer.body))

// 4. A refusal that is NOT about the login stays what it was: asking the
//    operator to authorize again would be the wrong fix for a folder they simply
//    cannot read.
routes = await scenario({
  list: {
    ok: false,
    identity: 'user',
    error: { type: 'authorization', subtype: 'permission_denied', message: 'no permission to read this folder' },
  },
})
answer = await call(routes, FILES)
check('a permission refusal is still `forbidden`, not a login prompt',
  answer.body?.ok === false && answer.body?.error.code === 'forbidden' && answer.body?.error.missingScopes === undefined,
  JSON.stringify(answer.body))

// 5. Starting the flow: the scope the failure named is what the CLI is asked
//    for, the QR comes from `auth qrcode`, and completion is a THIRD call the
//    host runs in the background.
routes = await scenario()
const started = await call(routes, LOGIN, { method: 'POST', body: JSON.stringify({ scopes: [SCOPE] }) })
check('starting a login answers the QR and the verification link',
  started.status === 200
  && started.body?.ok === true
  && started.body?.verificationUrl === VERIFY
  && typeof started.body?.qrUrl === 'string'
  && started.body?.qrUrl !== ''
  && started.body?.expiresIn === 600,
  JSON.stringify(started.body))
const startArgv = await argvLog()
const startArgs = await argsLog()
check('the device flow is asked for the scope the failure named',
  startArgs.includes('auth\n') === false && startArgs.includes(`<${SCOPE}>`) && startArgs.includes('<--no-wait>') && startArgs.includes('<--json>'),
  startArgs.trim())
check('the QR is rendered by the CLI, not by this plugin',
  startArgv.includes('auth qrcode'),
  startArgv.trim())
check('completion runs in the background, because it waits on a human',
  await until(async () => (await argvLog()).includes('auth login --device-code dc-stub --json')),
  (await argvLog()).trim())

// 6. The image route: it exists because an <img> can only be fed by a URL, and
//    the host is the only thing that has the file.
const image = await call(routes, QR)
check('the QR image route answers PNG bytes',
  image.status === 200
  && image.contentType === 'image/png'
  && image.bytes.subarray(0, 4).toString('hex') === '89504e47',
  `${String(image.status)} ${image.contentType} ${image.bytes.subarray(0, 4).toString('hex')}`)

// 7. Completion is detected, so the panel can stop waiting and re-read.
const done = await until(async () => (await call(routes, STATUS)).body?.phase === 'done')
const finished = await call(routes, STATUS)
check('the status turns `pending` into `done` when the user authorizes',
  done && finished.body?.ok === true && finished.body?.phase === 'done',
  JSON.stringify(finished.body))

// 8. The login has to land: one success drops the caches, so the folder read
//    that failed is read again instead of served from the copy that failed.
routes = await scenario({ deviceSleep: '0.1' })
await call(routes, FILES)
await call(routes, FILES)
const cachedReads = await count('list')
await call(routes, LOGIN, { method: 'POST', body: JSON.stringify({ scopes: [SCOPE] }) })
const landed = await until(async () => (await call(routes, STATUS)).body?.phase === 'done')
const afterLogin = await call(routes, FILES)
check('a login drops the caches the failed read was cached in',
  cachedReads === 1 && landed && (await count('list')) === 2 && afterLogin.body?.ok === true,
  `reads before login: ${String(cachedReads)}, after: ${String(await count('list'))}`)

// 9. The background child must stay OUT of the adapter's queue: it waits on a
//    human, and a queue that held it would freeze every folder read for ten
//    minutes.
routes = await scenario({ deviceSleep: '3', keepGrandchild: true })
await call(routes, LOGIN, { method: 'POST', body: JSON.stringify({ scopes: [SCOPE] }) })
const grandchild = await until(async () => (await grandchildPid()) !== 0)
const during = await Promise.race([
  call(routes, FILES),
  new Promise((resolve) => setTimeout(() => resolve('blocked'), 1500)),
])
check('a folder read still answers while a login is pending',
  during !== 'blocked' && during.status === 200 && during.body?.ok === true,
  during === 'blocked' ? 'the read did not finish within 1.5s' : JSON.stringify(during.body))
await call(routes, CANCEL, { method: 'POST' })
const reaped = await until(async () => !alive(await grandchildPid()), 5000)
check('cancelling kills the CLI\'s OWN child, not just the shim that spawned it',
  grandchild && reaped,
  `grandchild pid ${String(await grandchildPid())} ${reaped ? 'is gone' : 'is STILL ALIVE'}`)

// 10. Cancel: the child is killed and the session is gone, so a later status
//     cannot report a login nobody is waiting for.
const cancelled = await call(routes, CANCEL, { method: 'POST' })
const idle = await call(routes, STATUS)
check('cancelling ends the session',
  cancelled.status === 200 && cancelled.body?.phase === 'idle' && idle.body?.phase === 'idle',
  `${JSON.stringify(cancelled.body)} ${JSON.stringify(idle.body)}`)
const noQr = await call(routes, QR)
check('cancelling takes the QR away with it',
  noQr.status === 404,
  `${String(noQr.status)} ${String(noQr.body?.error?.code ?? '')}`)

// 11. A second start replaces the first: the CLI's device codes are one-shot,
//     so two live sessions would be two logins racing for one account.
routes = await scenario({ deviceSleep: '3' })
await call(routes, LOGIN, { method: 'POST', body: JSON.stringify({ scopes: [SCOPE] }) })
const second = await call(routes, LOGIN, { method: 'POST', body: JSON.stringify({ scopes: [SCOPE, 'space:folder:create'] }) })
const secondArgs = await argsLog()
check('a second start asks for its own scopes, as one argv element',
  second.body?.ok === true && secondArgs.includes(`<${SCOPE} space:folder:create>`),
  secondArgs.trim())
check('and the session is still one session',
  (await call(routes, STATUS)).body?.phase === 'pending')
await call(routes, CANCEL, { method: 'POST' })

// 12. Expiry: the CLI's device code dies after `expires_in`, and a panel that
//     kept showing a dead QR would send the operator to scan nothing.
routes = await scenario({
  wait: { ok: true, device_code: 'dc-stub', verification_url: VERIFY, expires_in: 1 },
  deviceSleep: '30',
  keepGrandchild: true,
})
await call(routes, LOGIN, { method: 'POST', body: JSON.stringify({ scopes: [SCOPE] }) })
const expired = await until(async () => (await call(routes, STATUS)).body?.expired === true, 4000)
const expiredReaped = await until(async () => !alive(await grandchildPid()), 5000)
check('an expired device code also takes its child down',
  expiredReaped,
  `grandchild pid ${String(await grandchildPid())} ${expiredReaped ? 'is gone' : 'is STILL ALIVE'}`)
const afterExpiry = await call(routes, STATUS)
check('an expired device code is reported as expired',
  expired && afterExpiry.body?.phase === 'idle' && afterExpiry.body?.expired === true,
  JSON.stringify(afterExpiry.body))
await call(routes, CANCEL, { method: 'POST' })

// 13. Nothing from a request may become an argv element. A scope is the one
//     request field that reaches the CLI as a word.
routes = await scenario()
const shellish = await call(routes, LOGIN, { method: 'POST', body: JSON.stringify({ scopes: ['a b; rm -rf /'] }) })
const notJson = await call(routes, LOGIN, { method: 'POST', body: '{nope' })
const empty = await call(routes, LOGIN, { method: 'POST' })
check('a scope outside the scope alphabet is refused before any process starts',
  shellish.status === 400 && shellish.body?.error.code === 'bad-request' && !(await argsLog()).includes('rm'),
  JSON.stringify(shellish.body))
check('a malformed body is a 400', notJson.status === 400, JSON.stringify(notJson.body))
check('an empty body starts the flow with this deployment\'s own scopes',
  empty.status === 200
  && empty.body?.ok === true
  && (await argsLog()).includes('<space:document:retrieve space:folder:create offline_access>'),
  `${JSON.stringify(empty.body)} ${(await argsLog()).trim()}`)
await call(routes, CANCEL, { method: 'POST' })

// 14. A CLI that refuses the device flow is reported as a failure rather than
//     as a QR the operator would scan for nothing.
routes = await scenario({
  wait: { ok: false, error: { type: 'network', subtype: 'unreachable', message: 'dial tcp: no such host' } },
})
const refused = await call(routes, LOGIN, { method: 'POST', body: JSON.stringify({ scopes: [SCOPE] }) })
check('a refused device flow answers the CLI\'s failure',
  refused.status === 200 && refused.body?.ok === false && refused.body?.error.code === 'cli-network',
  JSON.stringify(refused.body))
check('and leaves no QR behind', (await call(routes, QR)).status === 404)

// 15. Nothing is left running: a harness that leaves a child behind is a harness
//     that leaves a process holding a device code.
await call(routes, CANCEL, { method: 'POST' })
const stale = await stat(`${STUB_DIR}/argv.log`).then(() => true).catch(() => false)
check('the stub was actually exercised', stale)

let failed = 0
for (const entry of results) {
  if (!entry.ok) failed += 1
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name}${entry.detail === '' ? '' : `\n      ${entry.detail}`}`)
}
console.log(failed === 0 ? `\n${String(results.length)} checks passed` : `\n${String(failed)} of ${String(results.length)} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
