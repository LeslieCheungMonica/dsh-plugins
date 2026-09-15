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
 *   KEEP=1 node scripts/smoke-git.mjs     # leave the fixtures behind for inspection
 *
 * Requirements: `git` on PATH, plus `jsdom` symlinked into node_modules
 * (dev-only, like playwright — see README, "Verifying").
 */
import { execFileSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// ── the fixtures ─────────────────────────────────────────────────────────────
//
// Everything this test creates lives under ONE per-run sandbox, and the sandbox
// is proved to be outside any work tree before a single repository is made. That
// guard is not decoration: `$TMPDIR` on macOS can itself be a repository (this
// test once made it one by clicking its own Initialize button at the wrong
// path), and a fixture directory that is really inside somebody's work tree
// silently turns every "not a repository" assertion into a lie.
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-web-ui-smoke-'))
/**
 * Run one git command and return its status without throwing.
 * @param args - the argv.
 * @returns the exit status.
 */
const probeGit = (...args) => {
  try { execFileSync('git', args, { cwd: sandbox, stdio: 'pipe' }); return 0 } catch { return 1 }
}
if (probeGit('rev-parse', '--show-toplevel') === 0) {
  console.error(
    `smoke-git: refusing to run — the fixture directory ${sandbox} is inside an existing work tree,\n`
    + 'which would make every "not a repository" assertion meaningless. Run this from a machine or\n'
    + 'a TMPDIR without a .git above it, or set TMPDIR to a clean directory.',
  )
  process.exit(2)
}

/** The populated repository the drawer's normal behaviour is tested against. */
const root = join(sandbox, 'repo')
/** A directory with no repository in it, for the host-side init/remote phase. */
const blank = join(sandbox, 'blank')
/** A SECOND one, still empty when the browser phase clicks Initialize itself. */
const virgin = join(sandbox, 'virgin')
mkdirSync(root)
mkdirSync(blank)
mkdirSync(virgin)

// Cleanup runs from the exit hook, so a failing assertion (this script exits
// non-zero) or a thrown error cannot leave repositories behind in $TMPDIR. A
// SIGNAL is the gap that hook cannot cover — `exit` does not fire on SIGTERM —
// so an interrupted run is cleaned up explicitly too.
process.on('exit', () => { rmSync(sandbox, { recursive: true, force: true }) })
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    rmSync(sandbox, { recursive: true, force: true })
    process.exit(130)
  })
}
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
check('overview reads the repository identity',
  answer.status === 200 && answer.body.ok && answer.body.data.repo.name === 'repo'
  && answer.body.data.repo.root.endsWith('/repo'), answer.body.data?.repo?.name)
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
answer = await get(`/dsh-web-ui/git/overview?dir=${encodeURIComponent(blank)}`)
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
  answer.body.data.total >= 7 && journalled.every(command => command.startsWith('git ')),
  `${answer.body.data?.total} records, newest ${journalled[0]}`)
check('the journal records the command line, not just the action name',
  journalled.includes('git stash pop stash@{0}') && journalled.includes('git tag -a -m smoke v9.9.9'), journalled.join(' | '))
check('a REFUSED action is not journalled — nothing ran',
  !journalled.some(command => command.includes('upload-pack') || command.includes('bad..name')), `${answer.body.data.total} records`)

// ── init and remotes, against a directory that is not a repository yet ───────
console.log('\n# phase 1b — a brand-new project\n')

const BLANK = `dir=${encodeURIComponent(blank)}`

answer = await get(`/dsh-web-ui/git/overview?${BLANK}`)
check('a directory with no repository says so by name',
  answer.body.ok === false && answer.body.error.code === 'not-a-repo', answer.body.error?.message?.slice(0, 44))

answer = await post({ dir: blank, action: 'checkout', args: { ref: 'main' } })
check('every OTHER action still refuses to run outside a repository',
  answer.body.ok === false && answer.body.error.code === 'not-a-repo')

answer = await post({ dir: blank, action: 'init', args: { branch: 'trunk' } })
check('init creates a repository where there was none',
  answer.body.ok === true && answer.body.data.ok && answer.body.data.command === 'git init -b trunk', answer.body.data?.command)
check('.git now exists in the directory', existsSync(join(blank, '.git')))

answer = await get(`/dsh-web-ui/git/overview?${BLANK}`)
check('the new repository reports its unborn HEAD as the initial branch',
  answer.body.ok === true && answer.body.data.repo.unborn === true && answer.body.data.head.unborn === true
  && answer.body.data.head.branch === 'trunk',
  `unborn=${answer.body.data?.head?.unborn} branch=${answer.body.data?.head?.branch}`)
check('the new repository has no remote, and says so by having none',
  answer.body.data.remotes.length === 0)

answer = await post({ dir: blank, action: 'init', args: { branch: 'bad..name' } })
check('init validates the initial branch name through git', answer.body.error?.code === 'bad-request', answer.body.error?.message)

answer = await post({ dir: blank, action: 'remote-add', args: { name: 'origin', url: 'git@github.com:example/new-project.git' } })
check('remote-add points a new remote at a URL',
  answer.body.data?.command === 'git remote add origin git@github.com:example/new-project.git', answer.body.data?.command)
answer = await get(`/dsh-web-ui/git/overview?${BLANK}`)
check('the remote is now readable, with its URL',
  answer.body.data.remotes.length === 1 && answer.body.data.remotes[0].url === 'git@github.com:example/new-project.git',
  JSON.stringify(answer.body.data?.remotes))

answer = await post({ dir: blank, action: 'remote-add', args: { name: 'upstream', url: 'ext::sh -c whoami' } })
check('an ext:: transport URL is refused — it would run a command', answer.body.error?.code === 'bad-request', answer.body.error?.message)
answer = await post({ dir: blank, action: 'remote-add', args: { name: 'upstream', url: '--upload-pack=touch /tmp/pwned' } })
check('an option-shaped URL is refused', answer.body.error?.code === 'bad-request', answer.body.error?.message)
answer = await post({ dir: blank, action: 'remote-add', args: { name: 'origin', url: '' } })
check('an empty URL is refused with a sentence, not git noise',
  answer.body.error?.code === 'bad-request' && answer.body.error.message.includes('required'), answer.body.error?.message)

answer = await post({ dir: blank, action: 'remote-set-url', args: { name: 'origin', url: 'https://github.com/example/new-project.git' } })
check('remote-set-url re-points it',
  answer.body.data?.command === 'git remote set-url origin https://github.com/example/new-project.git', answer.body.data?.command)
answer = await post({ dir: blank, action: 'remote-rename', args: { name: 'origin', to: 'upstream' } })
check('remote-rename keeps the URL under a new name', answer.body.data?.command === 'git remote rename origin upstream')
answer = await get(`/dsh-web-ui/git/overview?${BLANK}`)
check('the rename moved the URL rather than dropping it',
  answer.body.data.remotes.length === 1 && answer.body.data.remotes[0].name === 'upstream'
  && answer.body.data.remotes[0].url === 'https://github.com/example/new-project.git',
  JSON.stringify(answer.body.data?.remotes))
answer = await post({ dir: blank, action: 'remote-remove', args: { name: 'upstream' } })
check('remote-remove forgets it', answer.body.data?.command === 'git remote remove upstream')
answer = await get(`/dsh-web-ui/git/overview?${BLANK}`)
check('the repository is back to no remote', answer.body.data.remotes.length === 0)

answer = await get(`/dsh-web-ui/git/records?${BLANK}`)
check('the init itself is in the journal',
  answer.body.ok === true && answer.body.data.records.some(record => record.command === 'git init -b trunk'),
  answer.body.data?.records?.map(record => record.command).join(' | '))


// ── phase 1c: the command bar, over real processes ───────────────────────────
console.log('\n# phase 1c — the command bar\n')

// The terminal service drives two host seams. Here they are stand-ins that keep
// the test on THIS code while still running real OS processes: a subprocess
// stand-in with the exact handle shape the service consumes, and a sandbox that
// wraps argv unchanged. The confinement seam's own behaviour is not this
// plugin's to test — what IS tested is that the service calls it, and refuses to
// run when it will not wrap.
const nodeSpawn = spawn
const toHandle = (child) => ({
  pid: child.pid ?? -1,
  stdin: child.stdin ?? undefined,
  stdout: child.stdout ?? undefined,
  stderr: child.stderr ?? undefined,
  collected: {},
  done: new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => { resolve({ exitCode: code, signal: signal ?? null }) })
  }),
  terminate() { child.kill('SIGKILL') },
  async waitForExit() {
    await new Promise(resolve => { child.on('close', resolve); child.on('error', resolve) })
    return true
  },
})
/** A subprocess stand-in that never actually spawns anything (for refuse paths). */
const inertSpawn = () => { throw new Error('the service spawned despite a refusal') }
const makeSubprocess = (spawnImpl) => ({
  async resolveExecutable(command) { return command },
  spawn: spawnImpl,
})
const okSubprocess = makeSubprocess(spec => toHandle(nodeSpawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'] })))
const throwingSubprocess = makeSubprocess(inertSpawn)
const okSandbox = { confine: argv => ({ argv: [...argv], enforcement: 'full', denialSignatures: [] }) }
const refusingSandbox = { confine: () => { throw new Error('no runner available') } }
const policyStub = { resolve: () => ({ mode: 'workspace-write', workspaceRoot: sandbox }) }
const termOptions = {
  enabled: true,
  mode: 'auto',
  timeoutMs: 20_000,
  bufferBytes: 64 * 1024,
  shell: '/bin/bash',
  history: 20,
}

/** Wait until a run settles, polling the service the way the panel does. */
const settleRun = async (service, id) => {
  let offset = 0
  let text = ''
  let run = null
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const answer = service.poll(id, offset)
    if (!answer.ok) return { run, text, error: answer.error }
    offset = answer.data.next
    text += answer.data.output
    run = answer.data.run
    if (!run.running) return { run, text }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return { run, text, error: { code: 'timeout', message: 'the run never settled' } }
}

{
  const { createTerminalService, readTerminalOptions } = await import('../src/host/term.ts')

  // The switch, before anything else: this surface runs what an operator types,
  // so it is opted INTO. A deployment that never enables it must have no
  // command-execution route registered at all.
  check('the command bar is OFF unless the row asks for it',
    readTerminalOptions(undefined).enabled === false
    && readTerminalOptions({}).enabled === false
    && readTerminalOptions({ enabled: true }).enabled === true)
  check('a non-boolean switch is rejected at boot, with the field named',
    (() => { try { readTerminalOptions({ enabled: 'yes' }); return false } catch { return true } })())

  const service = createTerminalService(
    { subprocess: okSubprocess, sandbox: okSandbox, sandboxPolicy: policyStub },
    termOptions,
  )

  // A command runs, its output is readable, and its exit status is reported.
  const started = await service.start(root, 'echo hello && echo oops >&2')
  check('the command bar starts a command', started.ok === true, started.ok === false ? started.error.message : started.data.id)
  if (started.ok) {
    const settled = await settleRun(service, started.data.id)
    check('its stdout and stderr both arrive', settled.text.includes('hello') && settled.text.includes('oops'), JSON.stringify(settled.text))
    check('a successful command reports exit 0', settled.run?.exitCode === 0 && settled.run?.running === false,
      `exit=${String(settled.run?.exitCode)} running=${String(settled.run?.running)}`)
    check('it runs in the directory it was given', settled.run?.dir === root)
    check('the run reports the sandbox mode it actually executed under', settled.run?.sandboxMode === 'workspace-write', settled.run?.sandboxMode)
    check('it knows its own length', (settled.run?.bytes ?? 0) > 0 && settled.run?.truncated === false)

    // The offset contract: a second reader starting from zero gets the retained
    // output again, and a reader at the end gets nothing.
    const replay = service.poll(started.data.id, 0)
    check('a poll from zero replays the retained output', replay.ok && replay.data.output.includes('hello'), JSON.stringify(replay.ok ? replay.data.output : replay.error))
    const tail = service.poll(started.data.id, settled.run?.bytes ?? 0)
    check('a poll from the end returns nothing new', tail.ok && tail.data.output === '' && tail.data.next === (settled.run?.bytes ?? 0),
      JSON.stringify(tail.ok ? tail.data : tail.error))
  }

  // A failing command is not an error — it is a result with a code.
  const failed = await service.start(root, 'exit 7')
  const failedSettled = failed.ok ? await settleRun(service, failed.data.id) : null
  check('a failing command reports its exit code rather than a transport error',
    failedSettled?.run?.exitCode === 7, String(failedSettled?.run?.exitCode))

  // Stopping a long command: the reason the panel has a Stop button at all.
  const long = await service.start(root, 'sleep 30')
  check('a long command starts', long.ok === true)
  if (long.ok) {
    const killed = service.kill(long.data.id)
    check('kill is accepted', killed.ok === true)
    const settled = await settleRun(service, long.data.id)
    check('the killed command settles instead of running forever',
      settled.run?.running === false, `running=${String(settled.run?.running)}`)
    check('and a second kill is a safe no-op', service.kill(long.data.id).ok === true)
  }

  // The refusals.
  const empty = await service.start(root, '   ')
  check('an empty command is refused', empty.ok === false && empty.error.code === 'no-command')
  const nowhere = await service.start(join(sandbox, 'does-not-exist'), 'echo hi')
  check('a directory that does not exist is refused', nowhere.ok === false && nowhere.error.code === 'no-directory', nowhere.ok === false ? nowhere.error.message : '')
  const relative = await service.start('relative/path', 'echo hi')
  check('a relative directory is refused', relative.ok === false && relative.error.code === 'bad-request')
  const unknown = service.poll('term-does-not-exist', 0)
  check('polling an unknown run is refused', unknown.ok === false && unknown.error.code === 'unknown-run')
  check('killing an unknown run is refused', service.kill('term-nope').ok === false)
  const all = service.list()
  const commands = all.ok ? all.data.map(run => run.command) : []
  check('the run list holds every command started, newest first',
    all.ok && commands.length === 3 && commands[0] === 'sleep 30' && commands[2] === 'echo hello && echo oops >&2',
    commands.join(' | '))

  // The window: output past the retention cap is dropped from the FRONT, the
  // run says so, and a reader holding an offset inside the dropped region is
  // answered from the window with the gap made explicit rather than silently.
  const tiny = createTerminalService(
    { subprocess: okSubprocess, sandbox: okSandbox, sandboxPolicy: policyStub },
    { ...termOptions, bufferBytes: 4_096 },
  )
  const flood = await tiny.start(root, 'for i in $(seq 1 400); do echo "line $i of a long stream"; done')
  const flooded = flood.ok ? await settleRun(tiny, flood.data.id) : null
  check('a chatty command is retained as a window, not a whole transcript',
    flooded?.run?.truncated === true, `bytes=${String(flooded?.run?.bytes)} truncated=${String(flooded?.run?.truncated)}`)
  if (flood.ok) {
    const stale = tiny.poll(flood.data.id, 0)
    check('a reader whose offset fell out of the window is answered from the window, and told',
      stale.ok && stale.data.from > 0 && stale.data.from < stale.data.next,
      stale.ok ? `from=${String(stale.data.from)} next=${String(stale.data.next)}` : stale.error.message)
    check('the window is what it claims to be', stale.ok && Buffer.byteLength(stale.data.output) <= 4_096,
      stale.ok ? `${String(Buffer.byteLength(stale.data.output))} bytes` : '')
  }

  // Confinement is not optional: if the runner will not wrap the command, the
  // command must not run at all.
  const refused = createTerminalService(
    { subprocess: throwingSubprocess, sandbox: refusingSandbox, sandboxPolicy: policyStub },
    termOptions,
  )
  const denied = await refused.start(root, 'echo should-not-run')
  check('a sandbox that refuses to wrap stops the command before it spawns',
    denied.ok === false && denied.error.code === 'sandbox-refused', denied.ok === false ? denied.error.message : 'ran anyway')

  // Nothing is spawned when the command line itself is unacceptable.
  const guarded = createTerminalService(
    { subprocess: throwingSubprocess, sandbox: okSandbox, sandboxPolicy: policyStub },
    termOptions,
  )
  check('an unacceptable command line never reaches the process seam',
    (await guarded.start(root, '  ')).ok === false
    && (await guarded.start('nope', 'echo hi')).ok === false)

  service.dispose()
  tiny.dispose()
  refused.dispose()
  guarded.dispose()
}

/** The terminal host the browser phase talks to (assigned below). */
let domTerminal = null

// The same service, over the real routes.
{
  const { createTerminalService } = await import('../src/host/term.ts')
  const { registerTerminalRoutes } = await import('../src/host/term-routes.ts')
  const termService = createTerminalService(
    { subprocess: okSubprocess, sandbox: okSandbox, sandboxPolicy: policyStub },
    termOptions,
  )
  const termRoutes = new Map()
  registerTerminalRoutes({
    effect: fn => fn(),
    logger: () => ({ info() {}, warn() {}, error(message) { console.error('host:', message) } }),
    webServer: {
      register: (route) => { termRoutes.set(route.path, route.handler); return () => termRoutes.delete(route.path) },
    },
  }, termService)

  const termServer = createServer(async (req, res) => {
    const handler = termRoutes.get(new URL(req.url, 'http://x').pathname)
    if (handler === undefined) { res.writeHead(404); res.end(); return }
    await handler(req, res)
  })
  await new Promise(resolve => termServer.listen(0, '127.0.0.1', resolve))
  const termOrigin = `http://127.0.0.1:${termServer.address().port}`
  const postTerm = async (path, body) => {
    const response = await fetch(`${termOrigin}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }

  const ran = await postTerm('/dsh-web-ui/term/run', { dir: root, command: 'echo via-http' })
  check('the run route starts a command', ran.status === 200 && ran.body.ok === true, ran.body.ok === false ? ran.body.error.message : ran.body.data.id)
  if (ran.body.ok === true) {
    let offset = 0
    let text = ''
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const poll = await fetch(`${termOrigin}/dsh-web-ui/term/poll?id=${ran.body.data.id}&from=${offset}`).then(r => r.json())
      if (!poll.ok) break
      offset = poll.data.next
      text += poll.data.output
      if (!poll.data.run.running) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    check('the poll route streams the output back', text.includes('via-http'), JSON.stringify(text))
    const listed = await fetch(`${termOrigin}/dsh-web-ui/term/list`).then(r => r.json())
    check('the list route reports the run', listed.ok === true && listed.data.some(run => run.id === ran.body.data.id))
    const killed = await postTerm('/dsh-web-ui/term/kill', { id: ran.body.data.id })
    check('killing a settled run is accepted, not an error', killed.status === 200 && killed.body.ok === true)
  }

  const badMethod = await fetch(`${termOrigin}/dsh-web-ui/term/run?dir=${DIR}`)
  check('the run route answers 405 to a GET', badMethod.status === 405 && badMethod.headers.get('allow') === 'POST')
  const badBody = await fetch(`${termOrigin}/dsh-web-ui/term/run`, { method: 'POST', body: 'not json' })
  check('a non-JSON body is a 400', badBody.status === 400)
  const badShape = await postTerm('/dsh-web-ui/term/run', { dir: root })
  check('a body missing `command` is a 400', badShape.status === 400 && badShape.body.error.message.includes('command'))
  const noId = await fetch(`${termOrigin}/dsh-web-ui/term/poll`)
  check('a poll without an id is a 400', noId.status === 400)
  const unknownPoll = await fetch(`${termOrigin}/dsh-web-ui/term/poll?id=term-nope&from=0`).then(r => r.json())
  check('polling an unknown run answers inside the envelope', unknownPoll.ok === false && unknownPoll.error.code === 'unknown-run')

  // Left running on purpose: the browser phase drives the real panel against
  // these routes, so the command bar is exercised end to end rather than mocked.
  domTerminal = { service: termService, origin: termOrigin, server: termServer }
}

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
// A browser resolves bare `MutationObserver` to `window.MutationObserver`; this
// realm has no window, so the harness republishes the ones the bundle uses.
globalThis.MutationObserver = window.MutationObserver
// The floating trigger re-queries at most once per frame, so the DOM needs a
// frame clock — jsdom has none.
globalThis.requestAnimationFrame = callback => setTimeout(() => { callback(0) }, 0)
globalThis.cancelAnimationFrame = handle => { clearTimeout(handle) }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = (await import('react')).default
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const h = React.createElement
const nodeFetch = globalThis.fetch
// The client bundle builds RELATIVE urls, so the stub re-anchors them at the
// route server this test owns.
globalThis.fetch = (input, init) => {
  if (typeof input !== 'string' || !input.startsWith('/')) return nodeFetch(input, init)
  // Two route servers, one page: the command bar's routes live on their own, as
  // they do in the real host (where they are one server with more rows).
  const base = input.startsWith('/dsh-web-ui/term/') ? domTerminal.origin : origin
  return nodeFetch(`${base}${input}`, init)
}

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

/**
 * The primitives the plugin uses for BEHAVIOUR are listed explicitly, so a
 * missing one fails this test loudly. Icons are not: there are seventy of them,
 * a hand-kept list drifts the moment someone adds an import, and the list is not
 * what proves an icon exists — the check further down reads the REAL package's
 * declarations for that.
 */
const primitivesStub = new Proxy({
  Tooltip: ({ children }) => h(React.Fragment, null, children),
  Menu,
  Modal,
  Button: asTag('button', 'Button'),
  Input: props => h('input', { 'data-stub': 'Input', ...props }),
}, {
  get: (target, key) => {
    if (key in target) return target[key]
    return typeof key === 'string' && key.startsWith('Icon') ? icon(key) : undefined
  },
})

const shared = {
  'react': React,
  'react/jsx-runtime': require('react/jsx-runtime'),
  'react-dom': require('react-dom'),
  'react-dom/client': require('react-dom/client'),
  '@deepseek-ai/dsh-client-ui-primitives': primitivesStub,
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

/**
 * The scopes this composition declares, as the slot core knows them. Only the
 * slots the applied plugin actually touches need to be here.
 */
const SLOT_SCOPES = {
  'sidebar': 'root',
  'sidebar.workspaces': 'root',
  'sidebar.brand.name': 'root',
  'conversation.hero.brand.mark': 'root',
  'conversation.session.header.utilities': 'session',
  'shell.overlay': 'root',
}

/** Every registration the applied plugin made. */
const registrations = []
/** Store handle -> the scope it first mounted under (the core's `handleScopes`). */
const handleScopes = new Map()
/**
 * Record one registration, enforcing the TWO register-time rules that have
 * already cost this plugin a silent failure. This stub is deliberately stricter
 * than a recorder: registering into an undeclared slot, or mounting one shared
 * store handle under two different scopes, throws here exactly as the real core
 * throws — because the real throw was caught and downgraded to a console warning
 * upstream, and the symptom was a button that simply was not on the page.
 * @param options - the registration options.
 * @param component - the registered component.
 */
const recordRegistration = (options, component) => {
  const scope = SLOT_SCOPES[options.name]
  if (scope === undefined) throw new Error(`registered into an undeclared slot "${options.name}"`)
  if (options.store !== undefined && typeof options.store !== 'function') {
    const pinned = handleScopes.get(options.store)
    if (pinned !== undefined && pinned !== scope) {
      throw new Error(
        `store handle mounted under "${options.name}" (scope "${scope}") is already mounted under `
        + `scope "${pinned}" — one handle, one scope`,
      )
    }
    handleScopes.set(options.store, scope)
  }
  registrations.push({
    name: options.name,
    options,
    component,
    face: options.inject === undefined ? {} : options.inject(),
  })
  return () => {}
}

plugin.apply({
  effect: fn => fn(),
  on: () => {},
  logger: () => ({ info() {}, warn() {}, error() {} }),
  locale: { register: () => () => {} },
  slots: {
    inject: (name, factory) => { registrations.push({ name, dispose: factory() }) },
    register: recordRegistration,
  },
  workspaces: new Proxy({}, { get: () => () => {} }),
  sessions: { open() {}, binding: () => undefined },
  layout: { toggleSidebar() {} },
})
// The stylesheet is injected by apply into the real document, so it can be
// asserted here rather than trusted: a CSS edit once deleted the action bar's
// whole rule block while every other check still passed, because nothing looked
// at the styles. These two lines are that regression, fenced.
const styleTag = window.document.head.querySelector('style[data-plugin="dsh-web-ui"]')
check('apply injects this plugin\'s stylesheet', styleTag !== null)
const css = styleTag?.textContent ?? ''
check('the stylesheet carries the action bar rules',
  css.includes("[data-wui='actionBar']") && css.includes("[data-wui='actionButton']")
  && css.includes("var(--dsh-web-ui-bar-top"), `${css.length} bytes`)
check('the stylesheet carries the drawer rules',
  css.includes("[data-wui='gitDrawer']") && css.includes("[data-wui='gitLayer']"))

// Icons are stubbed generically above, so the stub cannot prove an icon EXISTS.
// This does: every icon identifier the built bundle mentions must be declared by
// the real primitives package — which catches both a typo and an icon that was
// renamed or removed upstream, without a hand-kept list to drift.
const declaredIcons = new Set(
  (readFileSync('node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/types/icons/index.d.ts', 'utf8')
    .match(/Icon[A-Za-z0-9]+/g) ?? []),
)
const usedIcons = new Set(readFileSync(BUNDLE, 'utf8').match(/Icon[A-Za-z0-9]+/g) ?? [])
const absentIcons = [...usedIcons].filter(name => !declaredIcons.has(name))
check('every icon the bundle uses exists in the primitives package',
  absentIcons.length === 0, absentIcons.join(', '))

const bar = registrations.find(entry => entry.options?.id === 'dsh-web-ui-actions')
check('the action bar registers into the shell overlay',
  bar !== undefined && bar.name === 'shell.overlay', bar?.name)
check('the bar is ONE registration — no second trigger to keep in sync',
  registrations.filter(entry => entry.options?.id?.startsWith('dsh-web-ui-a')).length === 1)
check('the bar registers no inject face — it drives nothing but its own panels',
  Object.keys(bar?.face ?? {}).length === 0, JSON.stringify(Object.keys(bar?.face ?? {})))
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
  'bar.aria': 'Panel controls', 'bar.details': 'Panel', 'bar.details.show': 'Show the details panel',
  'bar.details.hide': 'Hide the details panel', 'bar.details.unavailable': 'No details panel yet',
  'bar.terminal': 'Terminal', 'bar.terminal.show': 'Show the bottom command bar', 'bar.terminal.hide': 'Hide it',
  'term.title': 'Terminal', 'term.resize': 'Resize', 'term.runs': 'Runs', 'term.run': 'Run', 'term.stop': 'Stop',
  'term.clear': 'Clear', 'term.close': 'Close', 'term.jump': 'Jump to the end',
  'term.placeholder': 'Type a command and press Enter', 'term.empty': 'No command yet.', 'term.waiting': 'Running…',
  'term.noOutput': 'No output.', 'term.gap': '… {bytes} bytes dropped …', 'term.truncated': 'truncated',
  'term.truncated.hint': 'earlier output was dropped', 'term.mode': 'sandbox: {mode}', 'term.mode.hint': 'the policy',
  'term.status.running': 'running', 'term.status.ok': 'ok', 'term.status.failed': 'exit {code}',
  'term.status.timeout': 'timeout', 'term.status.signalled': 'stopped by {signal}',
  'git.init': 'Initialize repository', 'git.init.title': 'Initialize a git repository',
  'git.init.message': 'Create a git repository in {path}?', 'git.init.branch': 'Initial branch name',
  'git.init.label': 'Initial branch name', 'git.init.done': 'The repository exists.',
  'git.remotes.count': 'Remotes ({n})', 'git.remote.title': 'Remotes', 'git.remote.add': 'Add remote',
  'git.remote.add.title': 'Add a remote', 'git.remote.add.name': 'Remote name', 'git.remote.name': 'Remote name',
  'git.remote.url': 'Remote URL', 'git.remote.url.placeholder': 'git@github.com:…', 'git.remote.edit.title': 'Change the remote URL',
  'git.remote.rename.title': 'Rename the remote', 'git.remote.rename.name': 'New remote name',
  'git.remote.remove': 'Remove remote', 'git.remote.remove.title': 'Remove remote',
  'git.remote.remove.message': 'Remove {name} ({url})?', 'git.remote.copy': 'Copy the URL',
  'git.remote.auth.hint': 'Push credentials belong to git; this plugin never stores a password.',
  'time.now': 'just now', 'time.minutes': '{n} min', 'time.hours': '{n} h', 'time.days': '{n} d',
  'time.months': '{n} mo', 'time.years': '{n} y',
}
const t = (key, params) => {
  let text = dictionary[key] ?? key
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}

const workspaces = [{ workspaceId: 'w1', path: root, title: 'scratch', sessionIds: ['s1'], createdAt: '', updatedAt: '' }]

// The framework synthesizes `useStore` and the inject face from a registration's
// `store:` / `inject:` declarations. The test stands in for exactly those two
// things, backed by one mutable cell, so the assertions below exercise the same
// contract the shell provides.

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

/** Props for the action bar. A root-scope seat has no session id. */
const barProps = (items, sessions = { current: 's1', byId: {} }) => ({
  useSessions: selector => selector(sessions),
  useWorkspaces: selector => selector({ items, recentWorkspaceId: 'w1' }),
  t,
})

const barButtons = () => [...qa('[data-wui="actionButton"]')]
const barButton = label => barButtons().find(button => button.querySelector('[data-wui="actionButtonLabel"]')?.textContent === label)

await act(async () => { root_.render(h(bar.component, barProps(workspaces))) })
await settle()

check('the action bar renders as one group', q('[data-wui="actionBar"]') !== null)
check('the bar offers the Git control', barButton('Git') !== undefined,
  barButtons().map(button => button.textContent).join(' | '))
check('the bar carries exactly one control',
  barButtons().length === 1, barButtons().map(button => button.textContent).join(' | '))
check('the right-panel and terminal controls are gone, as asked',
  barButton('Panel') === undefined && barButton('Terminal') === undefined)
check('the git drawer starts closed', q('[data-wui="gitDrawer"]') === null)
check('the git control is not marked pressed while the drawer is closed',
  barButton('Git')?.getAttribute('aria-pressed') === 'false')

await act(async () => { root_.render(h(bar.component, barProps([]))) })
await settle()
check('a session with no project disables the Git control', barButton('Git')?.disabled === true)
await act(async () => { root_.render(h(bar.component, barProps(workspaces))) })
await settle()

await click(barButton('Git'))
check('the drawer opens', q('[data-wui="gitDrawer"]') !== null)
check('the Git control reports itself pressed while the drawer is open',
  barButton('Git')?.getAttribute('aria-pressed') === 'true')
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

// ── the remotes section ──────────────────────────────────────────────────────
await waitFor(() => section('Remotes (') !== undefined, 'the remotes section')
const remoteCount = section('Remotes (')?.textContent
check('a repository with no remote shows an empty remotes section', remoteCount === 'Remotes (0)', remoteCount)
check('the empty section explains that push credentials belong to git',
  [...qa('[data-wui="gitNote"]')].some(element => element.textContent.includes('never stores a password')))

const addRemote = tiny('Add remote')
check('the remotes section offers Add remote', addRemote !== undefined)
await click(addRemote)
const remoteFields = qa('[data-stub="Input"]')
check('the add-remote prompt asks for a URL and a name', remoteFields.length === 2, `${remoteFields.length} fields`)
await type(remoteFields[0], 'git@github.com:example/drawer.git')
await click(qa('[data-stub="Button"]').find(element => element.textContent === 'OK'))
await waitFor(() => section('Remotes (1)') !== undefined, 'the new remote')
// Every row in this tab has a trailing menu, so the remotes ones are reached
// through the remotes SECTION rather than by document order.
// `section[...]`, not `[...]`: the branches tab's own root is also marked
// `data-wui="gitSection"`, and it contains every row in the tab.
const remotesSection = [...qa('section[data-wui="gitSection"]')]
  .find(element => element.querySelector('[data-wui="gitDisclosure"]')?.textContent.startsWith('Remotes ('))
check('adding a remote shows it with its URL',
  remotesSection?.querySelector('[data-wui="gitRemoteName"]')?.textContent === 'origin'
  && remotesSection?.querySelector('[data-wui="gitRowName"]')?.textContent === 'git@github.com:example/drawer.git',
  `${remotesSection?.querySelector('[data-wui="gitRemoteName"]')?.textContent} ${remotesSection?.querySelector('[data-wui="gitRowName"]')?.textContent}`)

const remoteMenu = remotesSection.querySelector('[data-wui="gitRowAction"]')
await click(remoteMenu)
const remoteVerbs = qa('[data-menu-id]').map(element => element.textContent)
check('the remote row menu offers the address verbs',
  remoteVerbs.includes('Change the remote URL') && remoteVerbs.includes('Remove remote'), remoteVerbs.join(','))
await click(qa('[data-menu-id]').find(element => element.textContent === 'Change the remote URL'))
const urlField = qa('[data-stub="Input"]')[0]
check('the edit prompt starts from the current URL', urlField?.value === 'git@github.com:example/drawer.git', urlField?.value)
await type(urlField, 'https://github.com/example/drawer.git')
await click(qa('[data-stub="Button"]').find(element => element.textContent === 'OK'))
await waitFor(() => remotesSection.querySelector('[data-wui="gitRowName"]')?.textContent === 'https://github.com/example/drawer.git', 'the new URL')
check('changing the address updates the row',
  remotesSection.querySelector('[data-wui="gitRowName"]')?.textContent === 'https://github.com/example/drawer.git',
  remotesSection.querySelector('[data-wui="gitRowName"]')?.textContent)

await click(remotesSection.querySelector('[data-wui="gitRowAction"]'))
await click(qa('[data-menu-id]').find(element => element.textContent === 'Remove remote'))
check('removing a remote asks first, naming it and its URL',
  qa('[data-stub="Modal"]').some(element => element.textContent.includes('https://github.com/example/drawer.git')))
await click(qa('[data-stub="Button"]').find(element => element.textContent === 'Remove remote'))
await waitFor(() => section('Remotes (0)') !== undefined, 'the removal')
check('confirming removes the remote', section('Remotes (0)') !== undefined)

// The drawer's own commands, read back from the host: this is what proves the
// buttons reached `git` with the argv this plugin built.
const drawerCommands = (await get(`/dsh-web-ui/git/records?${DIR}`)).body.data.records.map(record => record.command)
check('the journal holds the remote verbs the drawer ran',
  drawerCommands.includes('git remote add origin git@github.com:example/drawer.git')
  && drawerCommands.includes('git remote set-url origin https://github.com/example/drawer.git')
  && drawerCommands.includes('git remote remove origin'),
  drawerCommands.slice(0, 3).join(' | '))

// A repository the drawer cannot read must say so by name, not render an empty
// list that looks like a clean tree. This gets a FRESH root, and the drawer is
// closed first: it is SHARED state now, so a fresh render would otherwise start
// with it already open and the click below would close it instead of opening it.
await click(barButton('Git'))
await waitFor(() => q('[data-wui="gitDrawer"]') === null, 'the drawer to close')
root_.unmount()
const outsider = createRoot(container)
await act(async () => {
  outsider.render(h(bar.component, barProps([{ ...workspaces[0], path: virgin }])))
})
await settle()
await click(barButton('Git'))
await waitFor(() => q('[data-wui="gitEmptyTitle"]') !== null, 'the not-a-repository answer')
check('a non-repository is reported by name',
  q('[data-wui="gitEmptyTitle"]')?.textContent.includes('is not a repo') === true,
  q('[data-wui="gitEmptyTitle"]')?.textContent)

// The whole point of the init verb: the operator fixes the state from the
// sentence that named it, without leaving the page for a terminal.
const initButton = qa('[data-wui="gitPrimaryButton"]').find(element => element.textContent === 'Initialize repository')
check('a directory with no repository offers to create one', initButton !== undefined)
await click(initButton)
const initFields = qa('[data-stub="Input"]')
check('the init prompt pre-fills the initial branch name', initFields.length === 1 && initFields[0].value === 'main', initFields[0]?.value)
await type(initFields[0], 'trunk')
await click(qa('[data-stub="Button"]').find(element => element.textContent === 'OK'))
await waitFor(() => q('[data-wui="gitBranchChip"]')?.textContent === 'trunk', 'the initialized repository')
check('initializing turns the drawer into a working repository drawer',
  q('[data-wui="gitBranchChip"]')?.textContent === 'trunk', q('[data-wui="gitBranchChip"]')?.textContent)
check('the freshly initialized repository reports itself as empty',
  q('[data-wui="gitEmptyTitle"]') === null && q('[data-wui="gitDrawer"]') !== null)
await act(async () => { outsider.unmount() })

// ── the bar carries only the Git control ─────────────────────────────────────
// The right-panel and terminal controls were built and then removed at the
// operator's request. What has to hold now is that neither is reachable from the
// page: no button, and — for the terminal — no panel either. The terminal's own
// implementation is still covered by the host phase above, so a stopped feature
// cannot quietly rot.
const aloneRoot = createRoot(container)
await act(async () => { aloneRoot.render(h(bar.component, barProps(workspaces))) })
await settle()
check('one control is on the bar, and it is Git',
  barButtons().length === 1 && barButton('Git') !== undefined,
  barButtons().map(button => button.textContent).join(' | '))
check('no panel control is reachable', barButton('Panel') === undefined)
check('no terminal control is reachable', barButton('Terminal') === undefined)
check('and no terminal panel is mounted', q('[data-wui="termPanel"]') === null)
await act(async () => { aloneRoot.unmount() })


// ── wrap up ──────────────────────────────────────────────────────────────────
// Both route servers are closed and the process exits explicitly: a stray
// listener would keep the event loop alive, and a suite that never returns is
// indistinguishable from one that is still working.
server.close()
domTerminal?.server.close()
if (process.env.KEEP === '1') console.log(`\nleft behind: ${sandbox}`)
console.log(failed === 0
  ? `\n${String(results.length)} checks passed`
  : `\n${String(failed)} of ${String(results.length)} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
