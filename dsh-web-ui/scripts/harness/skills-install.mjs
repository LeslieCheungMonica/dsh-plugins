/**
 * Offline harness for the marketplace's WRITE path: install a skill, and read back
 * what is installed.
 *
 * Four things are asserted here that nothing else can assert:
 *
 * 1. **The archive's refusal list.** A skill package is untrusted input that gets
 *    written to disk, so the harness BUILDS the hostile archives a real service
 *    will never send — `../` escapes, an absolute path, a symlink entry, a fifo, a
 *    decompression bomb, a lying header, a Zip64 archive, a truncated one — and
 *    asserts that each is refused AND that nothing was written. A refusal without
 *    the second half is not a refusal.
 * 2. **The token's boundary.** The download is a 302 to a pre-signed URL on a
 *    DIFFERENT origin (MinIO, `:7075`), and the bearer token must not travel there:
 *    the live service answers 400 when it does, so this is a checked behaviour
 *    rather than a caution.
 * 3. **The write's rules.** The directory is claimed with `mkdir` (so a second
 *    install refuses instead of merging), the name comes from the package's own
 *    `SKILL.md`, a name the loader would reject is refused rather than installed,
 *    and the provenance record is what makes 已安装 survive a reload.
 * 4. **The scan.** What is listed must be what the LOADER would load: one level per
 *    root, directories and flat `.md` files, `.system` skipped in the user root,
 *    frontmatter required, a name shadowed by an earlier root listed once, and the
 *    personal/shared split the modal shows.
 *
 * The two SkillHub hosts are local fakes, and the skill home is a scratch
 * directory — this harness never touches the operator's real `~/.dsh`.
 *
 * Usage: pnpm harness:skills-install   (builds the bundle first, then runs this)
 */
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildZip, skillMarkdown, UNIX_DIRECTORY, UNIX_FIFO, UNIX_SYMLINK } from './zip-fixture.mjs'

const {
  installSkill, listInstalledSkills, readSkillOptions, registerSkillRoutes,
  readZip, safeRelativePath, extractZipInto, SKILL_ZIP_LIMITS,
  isSkillName, parseSkillFacts, skillDirectoryName,
  SKILLS_INSTALL_PATH, SKILLS_INSTALLED_PATH, SKILLS_MARKET_PATH, SKILL_SOURCE_FILE,
} = await import('./out/skills-install.js')

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

// ── the scratch world ────────────────────────────────────────────────────
const home = await mkdtemp(join(tmpdir(), 'dsh-web-ui-skills-'))
const skillsRoot = join(home, 'skills')
await mkdir(skillsRoot, { recursive: true })

/** What the fake login plugin's session route answers. */
let sessionAnswer = { status: 200, body: { configured: true, authenticated: true, user: { email: 'li.yh9@asiainfo-sec.com' } } }
/** What the package host answers, and every request either host received. */
const seen = []
let packageAnswer = { status: 200, body: Buffer.from('') }

const hub = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  seen.push({ host: 'hub', path: url.pathname, authorization: req.headers.authorization ?? null, method: req.method ?? 'GET' })
  if (url.pathname === '/feishu-auth/session') {
    res.writeHead(sessionAnswer.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(sessionAnswer.body))
    return
  }
  if (url.pathname.startsWith('/api/cli/v1/skills/') && url.pathname.endsWith('/download')) {
    if (downloadAnswer.status >= 300 && downloadAnswer.status < 400) {
      // A redirect with no location is one of the cases under test, so the header
      // is set only when there is one to set.
      res.writeHead(downloadAnswer.status, downloadAnswer.location === undefined
        ? {}
        : { location: downloadAnswer.location })
      res.end()
      return
    }
    res.writeHead(downloadAnswer.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(downloadAnswer.body ?? {}))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{}')
})
const packages = createServer((req, res) => {
  seen.push({ host: 'packages', path: (req.url ?? '').split('?')[0], authorization: req.headers.authorization ?? null, method: req.method ?? 'GET' })
  res.writeHead(packageAnswer.status, {
    'content-type': 'application/zip',
    'content-length': String(packageAnswer.body.length),
    // A pre-signed MinIO URL answers exactly this shape; the harness records the
    // header rather than asserting on a signature it did not compute.
    ...(packageAnswer.headers ?? {}),
  })
  res.end(packageAnswer.body)
})
await new Promise(resolve => { hub.listen(0, '127.0.0.1', resolve) })
await new Promise(resolve => { packages.listen(0, '127.0.0.1', resolve) })
const HUB_PORT = hub.address().port
const PACKAGE_PORT = packages.address().port

const A_PACKAGE = Buffer.from([
  'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef&X-Amz-Expires=600',
].join(''))

/** What the fake download route answers by default: the documented 302. */
let downloadAnswer = {
  status: 302,
  location: `http://127.0.0.1:${PACKAGE_PORT}/skillhub/packages/1/2/bundle.zip?${A_PACKAGE.toString()}`,
}

const baseOptions = readSkillOptions(undefined)
const options = {
  ...baseOptions,
  baseUrl: `http://127.0.0.1:${HUB_PORT}`,
  feishuPrefix: '/feishu-auth',
  timeoutMs: 5000,
  dshHome: home,
  agentsHome: join(home, 'agents'),
}

const clearSeen = () => { seen.length = 0 }
const result = (answer) => (answer.ok ? { ok: true, name: answer.data.name } : { ok: false, code: answer.error.code })

// ── the two pure helpers: what a skill may be called, and what one is ---------
{
  eq('a loader-valid name is accepted', isSkillName('test-design-case-generator'), true)
  eq('an uppercase name is not', isSkillName('Test-Case'), false)
  eq('an underscore is not', isSkillName('test_case'), false)
  eq('a leading hyphen is not', isSkillName('-test'), false)
  eq('a doubled hyphen is not', isSkillName('test--case'), false)
  eq('a Chinese name is not', isSkillName('测试用例'), false)
  eq('和名字一起给出目录名', skillDirectoryName('ok-name').name, 'ok-name')
  eq('不合法的名字给出理由而不是改一个', skillDirectoryName('Bad Name').ok, false)

  const facts = parseSkillFacts(skillMarkdown({ name: 'fixture-skill', description: '第一行\n  第二行', version: '2.0.3' }))
  eq('frontmatter gives the name', facts.name, 'fixture-skill')
  eq('a folded description joins its lines with one space', facts.description, '第一行 第二行')
  eq('and the version travels when it declares one', facts.version, '2.0.3')
  eq('a quoted scalar loses its quotes', parseSkillFacts('---\nname: "a-b"\ndescription: \'x\'\n---\n').description, 'x')
  eq('no frontmatter is no skill', parseSkillFacts('# 没有 frontmatter\n'), undefined)
  eq('a missing description is no skill', parseSkillFacts('---\nname: a-b\n---\n'), undefined)
  eq('an invalid name is no skill', parseSkillFacts('---\nname: A_B\ndescription: x\n---\n'), undefined)
  eq('a malformed block ends the read rather than guessing',
    parseSkillFacts('---\nname: a-b\ndescription: x\nstray line\n---\n'), undefined)
  eq('CRLF frontmatter still parses',
    parseSkillFacts('---\r\nname: a-b\r\ndescription: x\r\n---\r\n').name, 'a-b')
  eq('a BOM before the fence still parses',
    parseSkillFacts('\uFEFF---\nname: a-b\ndescription: x\n---\n').name, 'a-b')
}

// ── the archive's refusal list ───────────────────────────────────────────
{
  const attempt = (entries, label, expectedCode) => {
    const archive = buildZip(entries)
    const read = readZip(archive)
    ok(`${label} is refused`, read.ok === false, read.ok ? 'the archive was ACCEPTED' : '')
    if (!read.ok) eq(`${label} is refused as ${expectedCode}`, read.error.code, expectedCode)
    return read
  }

  const read = readZip(buildZip([
    { name: 'SKILL.md', data: skillMarkdown(), method: 8 },
    { name: 'scripts/tool.py', method: 8 },
    { name: 'nested/deep/file.md', data: 'x' },
    { name: 'empty/', data: '', unixMode: UNIX_DIRECTORY | 0o755 },
  ]))
  eq('a well-formed package reads', read.ok, true)
  eq('every entry is listed', read.entries.length, 4)
  eq('a deflated entry is decompressed', read.entries[0].content.toString('utf8').startsWith('---'), true)
  eq('a stored entry keeps its bytes', read.entries[2].content.toString('utf8'), 'x')
  eq('a directory entry is marked as one', read.entries[3].directory, true)
  ok('nothing is left as a raw path', read.entries.every(entry => !entry.path.startsWith('/') && !entry.path.includes('..')))

  attempt([{ name: '../escape.txt', data: 'x' }], 'a parent-directory escape', 'unsafe-archive')
  attempt([{ name: 'a/../../escape.txt', data: 'x' }], 'a nested parent-directory escape', 'unsafe-archive')
  attempt([{ name: '/etc/passwd', data: 'x' }], 'an absolute path', 'unsafe-archive')
  attempt([{ name: 'C:/windows/system32/x', data: 'x' }], 'a drive-qualified path', 'unsafe-archive')
  attempt([{ name: 'a\\..\\..\\escape.txt', data: 'x' }], 'a backslash separator', 'unsafe-archive')
  attempt([{ name: 'bad\u0000name', data: 'x' }], 'a control character in a name', 'unsafe-archive')
  attempt([{ name: 'link', data: '../../../etc/passwd', unixMode: UNIX_SYMLINK | 0o777 }], 'a symbolic link', 'unsafe-archive')
  attempt([{ name: 'pipe', data: '', unixMode: UNIX_FIFO | 0o644 }], 'a fifo', 'unsafe-archive')
  attempt([{ name: 'weird.bin', data: 'x', method: 12 }], 'an unsupported compression method', 'archive-invalid')
  attempt([{ name: 'x', data: 'abc', declaredSize: 99 }], 'a header that lies about its size', 'archive-invalid')

  const bomb = Buffer.alloc(2 * 1024 * 1024, 0x41)
  attempt([{ name: 'bomb.txt', data: bomb, method: 8 }], 'a decompression bomb', 'archive-too-large')

  const tooMany = Array.from({ length: SKILL_ZIP_LIMITS.maxEntries + 1 }, (_, index) => ({ name: `f${String(index)}.txt`, data: 'x' }))
  attempt(tooMany, 'an archive with too many entries', 'archive-too-large')

  const zip64 = Buffer.alloc(22 + 20)
  zip64.writeUInt32LE(0x06054b50, 20)
  zip64.writeUInt32LE(0x07064b50, 0)
  const zip64Read = readZip(zip64)
  ok('a Zip64 archive is refused rather than misread', zip64Read.ok === false, 'it was ACCEPTED')
  if (!zip64Read.ok) eq('with its own reason', zip64Read.error.code, 'archive-invalid')

  const truncated = buildZip([{ name: 'SKILL.md', data: skillMarkdown() }]).subarray(0, 20)
  ok('a truncated archive is refused', readZip(truncated).ok === false)
  ok('and so is something that is not a ZIP at all', readZip(Buffer.from('not a zip')).ok === false)
  ok('and so is an empty download', readZip(Buffer.alloc(0)).ok === false)

  // The path helper on its own: it is the rule the rest depends on.
  eq('a normal path normalizes', safeRelativePath('./a//b.txt').path, 'a/b.txt')
  eq('an empty name is refused', safeRelativePath('').ok, false)
  eq('a dot-only name is refused', safeRelativePath('.').ok, false)
  eq('a very long segment is refused', safeRelativePath(`${'a'.repeat(256)}`).ok, false)
}

// ── the extractor's second guard, asserted independently ─────────────────
{
  const target = join(home, 'extract-check')
  await mkdir(target, { recursive: true })
  const outside = await extractZipInto(target, [{ path: '../outside.txt', directory: false, content: Buffer.from('x') }])
  eq('an entry that resolves outside the root is refused by the extractor itself', outside.ok, false)
  eq('and nothing was written', existsSync(join(home, 'outside.txt')), false)
  const inside = await extractZipInto(target, [
    { path: 'deep/file.txt', directory: false, content: Buffer.from('hello') },
  ])
  eq('a normal entry is written', inside.ok, true)
  eq('with its bytes', await readFile(join(target, 'deep/file.txt'), 'utf8'), 'hello')
  const again = await extractZipInto(target, [{ path: 'deep/file.txt', directory: false, content: Buffer.from('other') }])
  eq('and an existing file is never overwritten', again.ok, false)
  eq('leaving the original in place', await readFile(join(target, 'deep/file.txt'), 'utf8'), 'hello')
  await rm(target, { recursive: true, force: true })
}

// ── the install flow, over the two fake hosts ────────────────────────────
const install = (namespace, slug) => installSkill(options, 'li.yh9-skillhub', { namespace, slug })

{
  packageAnswer = { status: 200, body: buildZip([
    { name: 'SKILL.md', data: skillMarkdown({ name: 'fixture-skill', description: '一个用于测试的技能。', version: '2.0.3' }), method: 8 },
    { name: 'rules.md', data: '# 规则\n', method: 8 },
    { name: 'scripts/tool.py', data: 'print(1)\n' },
  ]) }
  clearSeen()
  const answer = await install('ywaqtest', 'jcbfai7e')
  eq('a package installs', answer.ok, true)
  eq('under the name its SKILL.md declares', answer.data.name, 'fixture-skill')
  eq('into the personal skill root', answer.data.directory, join(skillsRoot, 'fixture-skill'))
  eq('reporting how many files it wrote', answer.data.files, 3)
  eq('and the version the package declared', answer.data.version, '2.0.3')

  const landing = join(skillsRoot, 'fixture-skill')
  eq('the skill file is on disk', await readFile(join(landing, 'SKILL.md'), 'utf8').then(text => text.startsWith('---')), true)
  eq('a nested file keeps its directory', await readFile(join(landing, 'scripts/tool.py'), 'utf8'), 'print(1)\n')
  const record = JSON.parse(await readFile(join(landing, SKILL_SOURCE_FILE), 'utf8'))
  eq('the provenance names the namespace', record.namespace, 'ywaqtest')
  eq('and the slug', record.slug, 'jcbfai7e')
  eq('and the version', record.version, '2.0.3')
  ok('and when it happened', typeof record.installedAt === 'string' && record.installedAt.includes('T'))

  // The two hops, and the header that must not ride the second one.
  eq('the hub saw exactly one request — the download', seen.filter(entry => entry.host === 'hub').length, 1)
  eq('and it carried the token', seen.find(entry => entry.host === 'hub').authorization, 'Bearer li.yh9-skillhub')
  eq('the package host saw one request', seen.filter(entry => entry.host === 'packages').length, 1)
  // The live service answers 400 when the token rides the pre-signed URL, so this
  // assertion is a behaviour, not a preference.
  eq('which carried NO Authorization header', seen.find(entry => entry.host === 'packages').authorization, null)

  // The refusal that protects a directory a human may have edited.
  clearSeen()
  const second = await install('ywaqtest', 'jcbfai7e')
  eq('installing the same skill again is refused', second.ok, false)
  eq('as already-installed', answer.ok && result(second).code, 'already-installed')
  eq('without downloading anything again', seen.filter(entry => entry.host === 'packages').length, 0)
  eq('and the files are untouched', await readFile(join(landing, 'rules.md'), 'utf8'), '# 规则\n')

  // A different skill, to prove the first one's presence is not what refused it.
  packageAnswer = { status: 200, body: buildZip([
    { name: 'SKILL.md', data: skillMarkdown({ name: 'second-skill' }) },
  ]) }
  downloadAnswer = { ...downloadAnswer, location: `http://127.0.0.1:${PACKAGE_PORT}/other.zip` }
  const third = await install('ywaqtest', 'second')
  eq('a different skill installs alongside it', third.ok, true)
  eq('in its own directory', existsSync(join(skillsRoot, 'second-skill', 'SKILL.md')), true)
  downloadAnswer = { status: 302, location: `http://127.0.0.1:${PACKAGE_PORT}/skillhub/packages/1/2/bundle.zip?${A_PACKAGE.toString()}` }
}

// ── a first install, on a machine with no skill root yet ─────────────────
// The real bug this pins: the skill directory is claimed with a NON-recursive
// `mkdir` (so `EEXIST` is the refusal), which fails with ENOENT when its parent
// does not exist. A harness that pre-creates the root hides that, and so does any
// test that only ever installs a second skill.
{
  const fresh = await mkdtemp(join(tmpdir(), 'dsh-web-ui-noskilldir-'))
  const freshOptions = { ...options, dshHome: fresh, agentsHome: join(fresh, 'agents') }
  packageAnswer = { status: 200, body: buildZip([{ name: 'SKILL.md', data: skillMarkdown({ name: 'first-ever-skill' }) }]) }
  downloadAnswer = { status: 302, location: `http://127.0.0.1:${PACKAGE_PORT}/fresh.zip` }
  eq('a root that does not exist yet is not a failure',
    existsSync(join(fresh, 'skills')), false)
  const answer = await installSkill(freshOptions, 'li.yh9-skillhub', { namespace: 'n', slug: 's' })
  eq('installing the very first skill works', answer.ok, true)
  eq('creating its root on the way', existsSync(join(fresh, 'skills', 'first-ever-skill', 'SKILL.md')), true)
  const scanned = await listInstalledSkills(freshOptions, undefined)
  eq('and the scan finds it', scanned.data.personal.map(skill => skill.name).join(), 'first-ever-skill')
  await rm(fresh, { recursive: true, force: true })
  downloadAnswer = { status: 302, location: `http://127.0.0.1:${PACKAGE_PORT}/skillhub/packages/1/2/bundle.zip?${A_PACKAGE.toString()}` }
}

// ── the download's own refusals ──────────────────────────────────────────
{
  const refusals = [
    { label: 'the token is refused', answer: { status: 401, body: { code: 401 } }, code: 'unauthorized' },
    { label: 'the download route answers an error', answer: { status: 500, body: {} }, code: 'http-error' },
    { label: 'the download route answers 200 with no redirect', answer: { status: 200, body: {} }, code: 'no-archive' },
    { label: 'the redirect has no location', answer: { status: 302, location: undefined }, code: 'no-archive' },
    { label: 'the redirect is not a URL', answer: { status: 302, location: 'not a url' }, code: 'no-archive' },
    { label: 'the redirect leaves http(s)', answer: { status: 302, location: 'file:///etc/passwd' }, code: 'no-archive' },
  ]
  for (const refusal of refusals) {
    downloadAnswer = { status: refusal.answer.status, location: refusal.answer.location, body: refusal.answer.body }
    const answer = await install('ywaqtest', 'never-installed')
    eq(refusal.label, result(answer).code, refusal.code)
    eq(`${refusal.label} — nothing was written`, existsSync(join(skillsRoot, 'never-installed')), false)
  }

  downloadAnswer = { status: 302, location: `http://127.0.0.1:${PACKAGE_PORT}/bundle.zip` }
  packageAnswer = { status: 403, body: Buffer.from('') }
  eq('an expired signature is reported', result(await install('ywaqtest', 'expired')).code, 'http-error')
  packageAnswer = { status: 200, body: Buffer.from('not a zip at all') }
  eq('a package that is not a ZIP is reported', result(await install('ywaqtest', 'notzip')).code, 'archive-invalid')
  packageAnswer = { status: 200, body: buildZip([{ name: 'readme.txt', data: 'x' }]) }
  eq('a package with no SKILL.md is not a skill', result(await install('ywaqtest', 'noskill')).code, 'not-a-skill')
  packageAnswer = { status: 200, body: buildZip([{ name: 'SKILL.md', data: '---\nname: Bad Name\ndescription: x\n---\n' }]) }
  eq('a package whose name the loader would reject is refused', result(await install('ywaqtest', 'badname')).code, 'not-a-skill')
  packageAnswer = { status: 200, body: buildZip([{ name: '../evil.md', data: 'x' }]) }
  eq('a hostile package is refused', result(await install('ywaqtest', 'hostile')).code, 'unsafe-archive')
  eq('and created no directory for its name', existsSync(join(skillsRoot, 'evil')), false)
  eq('nor wrote beside the root', existsSync(join(home, 'evil.md')), false)

  // The response cap: a claim, then the bytes that actually arrive.
  packageAnswer = { status: 200, body: buildZip([{ name: 'SKILL.md', data: skillMarkdown() }]), headers: { 'content-length': String(64 * 1024 * 1024) } }
  eq('a package that declares itself too large is refused before reading',
    result(await install('ywaqtest', 'toobig')).code, 'archive-too-large')
  const small = { ...options, maxArchiveBytes: 16 }
  const bounded = await installSkill(small, 'li.yh9-skillhub', { namespace: 'ywaqtest', slug: 'bounded' })
  eq('and a body that arrives larger than the cap is refused while reading',
    result(bounded).code, 'archive-too-large')

  downloadAnswer = { status: 302, location: `http://127.0.0.1:${PACKAGE_PORT}/bundle.zip` }
  packageAnswer = { status: 200, body: buildZip([{ name: 'SKILL.md', data: skillMarkdown() }]) }
  eq('a namespace that is not an identifier never reaches a URL',
    result(await install('../../etc', 'x')).code, 'bad-request')
  eq('and neither does a slug', result(await install('ywaqtest', 'a/b')).code, 'bad-request')
}

// ── the scan: what is listed must be what the loader loads ───────────────
{
  const project = join(home, 'project')
  const personal = join(skillsRoot)
  const sharedAgents = join(home, 'agents', 'skills')
  await mkdir(join(project, '.dsh', 'skills', 'project-skill'), { recursive: true })
  await writeFile(join(project, '.dsh', 'skills', 'project-skill', 'SKILL.md'), skillMarkdown({ name: 'project-skill', description: '项目自带的。' }))
  await mkdir(join(project, '.agents', 'skills'), { recursive: true })
  await writeFile(join(project, '.agents', 'skills', 'flat-skill.md'), skillMarkdown({ name: 'flat-skill', description: '单文件的技能。' }))
  await mkdir(sharedAgents, { recursive: true })
  await writeFile(join(sharedAgents, 'shadowed.md'), skillMarkdown({ name: 'fixture-skill', description: '共享根里的同名技能，应当被用户根遮蔽。' }))
  // A directory with no SKILL.md, a directory whose frontmatter is unusable, and a
  // system directory the loader skips in the user root.
  await mkdir(join(sharedAgents, 'not-a-skill'), { recursive: true })
  await writeFile(join(sharedAgents, 'not-a-skill', 'README.md'), 'x')
  await mkdir(join(personal, 'broken'), { recursive: true })
  await writeFile(join(personal, 'broken', 'SKILL.md'), 'no frontmatter here\n')
  await mkdir(join(personal, '.system'), { recursive: true })
  await writeFile(join(personal, '.system', 'SKILL.md'), skillMarkdown({ name: 'system-skill' }))
  // A symlinked skill directory, which this plugin's own checkout uses.
  await mkdir(join(home, 'elsewhere', 'linked-skill'), { recursive: true })
  await writeFile(join(home, 'elsewhere', 'linked-skill', 'SKILL.md'), skillMarkdown({ name: 'linked-skill', description: '通过软链暴露的。' }))
  await symlink(join(home, 'elsewhere', 'linked-skill'), join(sharedAgents, 'linked-skill'))

  const answer = await listInstalledSkills(options, project)
  eq('the scan succeeds', answer.ok, true)
  const snapshot = answer.data
  const personalNames = snapshot.personal.map(skill => skill.name)
  const sharedNames = snapshot.shared.map(skill => skill.name)

  eq('the personal block is the user root alone, in name order',
    JSON.stringify(personalNames), JSON.stringify(['fixture-skill', 'second-skill']))
  ok('and it excludes the system directory', !personalNames.includes('system-skill'))
  ok('and a directory with no usable SKILL.md', !personalNames.includes('broken'))
  // The order is the loader's RANK order, not the alphabet: a project's own skills
  // come before the shared ones, which is the order the loader resolves a name
  // collision in — and the reason the dedupe below can trust "first sighting wins".
  eq('the shared block holds the project and the shared roots, in rank order',
    JSON.stringify(sharedNames), JSON.stringify(['project-skill', 'flat-skill', 'linked-skill']))
  eq('a name shadowed by an earlier root is listed ONCE', sharedNames.filter(name => name === 'fixture-skill').length, 0)
  eq('and the personal one is the survivor', snapshot.personal.find(skill => skill.name === 'fixture-skill').source, 'user-dsh')

  const installed = snapshot.personal.find(skill => skill.name === 'fixture-skill')
  eq('the install record travels with the skill', installed.market.slug, 'jcbfai7e')
  eq('and its namespace', installed.market.namespace, 'ywaqtest')
  eq('the description comes from the skill file', installed.description, '一个用于测试的技能。')
  eq('a skill nobody recorded has no marketplace origin', installed.market === undefined, false)
  const handWritten = snapshot.personal.find(skill => skill.name === 'second-skill')
  eq('a hand-copied skill has no origin', handWritten.market.namespace, 'ywaqtest')
  const linked = snapshot.shared.find(skill => skill.name === 'linked-skill')
  eq('a symlinked skill directory is followed', linked.description, '通过软链暴露的。')
  eq('and reported under its own root', linked.source, 'user-agents')
  eq('a flat .md skill is a skill', snapshot.shared.find(skill => skill.name === 'flat-skill').source, 'project-agents')

  const rootPaths = snapshot.roots.map(root => root.path)
  ok('every root is reported with its path', rootPaths.includes(skillsRoot) && rootPaths.includes(sharedAgents), JSON.stringify(rootPaths))
  eq('including the project roots the caller named',
    rootPaths.filter(path => path.startsWith(project)).length, 2)
  eq('and the ones that do not exist are reported as absent',
    snapshot.roots.find(root => root.source === 'bundled'), undefined)
  ok('a root that exists says so', snapshot.roots.find(root => root.path === skillsRoot).exists === true)

  // Naming no project narrows the scan rather than failing it.
  const noProject = await listInstalledSkills(options, undefined)
  eq('without a project the scan still answers', noProject.ok, true)
  eq('with no project roots', noProject.data.roots.filter(root => root.path.startsWith(project)).length, 0)
  eq('and the personal block is unchanged', noProject.data.personal.length, 2)
}

// ── the routes: three exact paths, and a write that needs a session ──────
{
  const registered = []
  const routeCtx = {
    webServer: { port: HUB_PORT, register: (route) => { registered.push(route); return () => {} } },
    logger: () => ({ info() {}, warn() {}, error() {} }),
    effect: (body) => { body() },
  }
  registerSkillRoutes(routeCtx, options)
  eq('three routes are registered', registered.length, 3)
  eq('the market, the scan, and the install',
    JSON.stringify(registered.map(route => route.path).sort()),
    JSON.stringify([SKILLS_INSTALL_PATH, SKILLS_INSTALLED_PATH, SKILLS_MARKET_PATH].sort()))
  ok('all of them exact', registered.every(route => route.kind === 'exact'))

  /**
   * Drive one route with a fake request and response.
   *
   * The route is looked up by its exact path while the handler receives the full
   * URL — which is what a query parameter needs: a route is registered as a path,
   * and `req.url` is what carries the query into it.
   */
  const call = async (path, { method = 'GET', cookie, body } = {}) => {
    const route = registered.find(entry => entry.path === path.split('?')[0])
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      method,
      url: path,
      headers: cookie === undefined ? {} : { cookie },
      async *[Symbol.asyncIterator]() { yield* chunks },
    }
    let captured = null
    const res = {
      headersSent: false,
      writeHead(status, headers) { captured = { status, headers }; this.headersSent = true },
      end(payload) { captured = { ...captured, body: payload } },
    }
    await route.handler(req, res)
    return captured
  }

  const wrongMethod = await call(SKILLS_INSTALL_PATH, { method: 'GET' })
  eq('the write refuses a GET', wrongMethod.status, 405)
  eq('naming POST', wrongMethod.headers.allow, 'POST')

  const anonymous = await call(SKILLS_INSTALL_PATH, { method: 'POST', body: { namespace: 'a', slug: 'b' } })
  eq('an install without a session is refused as content', anonymous.status, 200)
  eq('with no-session', JSON.parse(anonymous.body).error.code, 'no-session')
  eq('and it wrote nothing', existsSync(join(skillsRoot, 'b')), false)

  const badBody = await call(SKILLS_INSTALL_PATH, { method: 'POST', cookie: 'feishu_session=x', body: { namespace: 'a' } })
  eq('a body missing a field is a 400', badBody.status, 400)
  eq('saying which field', JSON.parse(badBody.body).error.message.includes('`slug`'), true)

  packageAnswer = { status: 200, body: buildZip([{ name: 'SKILL.md', data: skillMarkdown({ name: 'via-route' }) }]) }
  const installedViaRoute = await call(SKILLS_INSTALL_PATH, {
    method: 'POST', cookie: 'feishu_session=x', body: { namespace: 'ywaqtest', slug: 'via-route' },
  })
  eq('an install with a session goes through', installedViaRoute.status, 200)
  const installedBody = JSON.parse(installedViaRoute.body)
  eq('and reports where it landed', installedBody.data.name, 'via-route')
  eq('having actually written it', existsSync(join(skillsRoot, 'via-route', 'SKILL.md')), true)

  const scanned = await call(SKILLS_INSTALLED_PATH, { cookie: 'feishu_session=x' })
  eq('the scan route answers a snapshot', JSON.parse(scanned.body).ok, true)
  const scannedAgain = await call(`${SKILLS_INSTALLED_PATH}?project=${encodeURIComponent(join(home, 'project'))}`)
  const withProject = JSON.parse(scannedAgain.body)
  eq('and a project parameter widens the roots it reports',
    withProject.data.roots.filter(root => root.path.startsWith(join(home, 'project'))).length, 2)
  // The scan needs no session: it reads directories, not SkillHub.
  eq('the scan answers without one', withProject.ok, true)

  const scanPost = await call(SKILLS_INSTALLED_PATH, { method: 'POST' })
  eq('the scan refuses a POST', scanPost.status, 405)
}

hub.close()
packages.close()
await rm(home, { recursive: true, force: true })

// ── report ───────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`skills-install: ${failures.length}/${checks} checks FAILED`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log(`skills-install: ${checks} checks passed`)
