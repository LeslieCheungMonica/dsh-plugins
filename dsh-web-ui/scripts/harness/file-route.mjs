/**
 * Offline harness for the file page (`GET /dsh-web-ui/file`).
 *
 * The page exists so that a file link in the transcript can be shown inside the
 * GUI: the panel that displays it is served from the GUI's own origin, and a
 * browser refuses to frame `file:///…` from an `http://` page at all. So the
 * route IS the feature's only surface, and what it must get right is bounded:
 *
 * 1. **It renders text as text.** A file containing `</pre><script>` must arrive
 *    as characters, because the page is framed SAME-ORIGIN and a page with no
 *    script is the whole reason it is safe to frame. The escaping is asserted
 *    against the raw bytes, not against a rendered impression.
 * 2. **It names the file honestly.** Line numbers, a size, an mtime, and whether
 *    the line cap dropped anything.
 * 3. **It refuses work it cannot do** with a page that says so rather than an
 *    error body: a missing path, a directory, a binary, and a file past the cap.
 *    Each of those is a different sentence, and the reader is looking at a panel
 *    with no other explanation on it.
 *
 * It runs the REAL route module against a real socket, like `folder-route.mjs`
 * does for the Feishu routes, so the whole request path is under test.
 *
 * Usage: pnpm harness:file-route
 */
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerFileRoutes, escapeHtml, FILE_PATH } from '../../src/host/file-routes.ts'
import { apply as applyPlugin } from '../../src/index.ts'

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

const root = mkdtempSync(join(tmpdir(), 'dsh-web-ui-file-'))
const long = Array.from({ length: 120 }, (_, i) => `line ${String(i + 1)}`).join('\n')
writeFileSync(join(root, 'plain.txt'), `hello\n${long}\n`)
writeFileSync(join(root, 'evil.txt'), '</pre><script>alert(1)</script>\n<b>&amp;</b>\n')
writeFileSync(join(root, 'binary.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x47, 0x0d, 0x0a]))
writeFileSync(join(root, 'big.txt'), 'x'.repeat(3 * 1024 * 1024))
mkdirSync(join(root, 'adir'))

// The route registers itself through ctx.effect, exactly as it does in a fiber.
const routes = new Map()
const disposed = []
registerFileRoutes({
  effect: (fn) => {
    const dispose = fn()
    disposed.push(dispose)
    return () => {}
  },
  webServer: {
    register: (route) => {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
})

// The real webserver registers exact and prefix routes in separate tables
// (`WebRoute.kind`), so the fake models both: a prefix matches itself and
// anything under it, which is what the file page's decorative name segment needs.
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  const handler = routes.get(pathname) ?? [...routes.entries()]
    .filter(([path]) => pathname.startsWith(`${path}/`))
    // Longest prefix wins, as the real table does.
    .sort((a, b) => b[0].length - a[0].length)
    .map(([, entry]) => entry)[0]
  if (handler === undefined) { res.writeHead(404); res.end(); return }
  await handler(req, res)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${String(server.address().port)}`

/** GET one page. */
const get = async (filePath, extra = '') => {
  const response = await fetch(`${origin}${FILE_PATH}?path=${encodeURIComponent(filePath)}${extra}`)
  return { status: response.status, type: response.headers.get('content-type') ?? '', body: await response.text() }
}

// ── the route itself ───────────────────────────────────────────────────────
check('the route registers on the path this plugin publishes',
  routes.has(FILE_PATH), [...routes.keys()].join(' | '))
check('registering is one effect, so unloading the plugin drops the route',
  disposed.length === 1 && typeof disposed[0] === 'function')

{
  const post = await fetch(`${origin}${FILE_PATH}?path=${encodeURIComponent(join(root, 'plain.txt'))}`, { method: 'POST' })
  check('only GET is answered', post.status === 405 && post.headers.get('allow') === 'GET', String(post.status))
}

{
  const res = await get('')
  check('a missing path is a 400 with a page that says so',
    res.status === 400 && res.type.startsWith('text/html') && res.body.includes('需要一个 path 参数'),
    `${String(res.status)} ${res.type}`)
  // The probe's own request: the client asks with no path, so this notice is what
  // it must be able to recognise.
  check('the refusal notice carries the marker too',
    res.body.includes('dsh-web-ui-file-page'), res.body.slice(0, 0))
}

{
  // The URL a tab shows carries the file's name in its path; the route ignores
  // that segment and reads the ABSOLUTE path from the query.
  const res = await fetch(`${origin}${FILE_PATH}/${encodeURIComponent('plain.txt')}`
    + `?path=${encodeURIComponent(join(root, 'plain.txt'))}`)
  const body = await res.text()
  check('the decorative name segment does not change the answer',
    res.status === 200 && body.includes('<h1>plain.txt</h1>'), String(res.status))
}

// ── a text file ────────────────────────────────────────────────────────────
{
  const res = await get(join(root, 'plain.txt'))
  check('a text file is served as HTML', res.status === 200 && res.type.startsWith('text/html'), `${String(res.status)} ${res.type}`)
  check('the header names the file', res.body.includes('<h1>plain.txt</h1>'))
  check('the header carries the path, the size and the line count',
    res.body.includes(join(root, 'plain.txt')) && res.body.includes('行'), res.body.slice(0, 0))
  check('every line is numbered from 1',
    res.body.includes('<span class="no">1</span>') && res.body.includes('<span class="no">121</span>'))
  check('the content is inside a pre', res.body.includes('<pre>') && res.body.includes('line 120'))
  check('the page carries no script at all', !/<script/iu.test(res.body))
  // The marker the client probes for before it trusts the route (see the client's
  // fileViewer): without it, "new client, old host" would put the GUI inside the
  // sidebar tab instead of the file.
  check('every page carries the marker the client probes for',
    res.body.includes('<meta name="dsh-web-ui-file-page" content="1">'))
}

// ── escaping: the page's whole security surface ────────────────────────────
{
  const res = await get(join(root, 'evil.txt'))
  check('a file that looks like markup stays text',
    !res.body.includes('<script>alert(1)</script>') && res.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'),
    res.body.slice(res.body.indexOf('<main>'), res.body.indexOf('<main>') + 160))
  check('and its ampersands are escaped once',
    res.body.includes('&lt;b&gt;&amp;amp;&lt;/b&gt;'))
  check('escapeHtml is the single rule',
    escapeHtml('<a href="x">&\'</a>') === '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;',
    escapeHtml('<a href="x">&\'</a>'))
}

// ── refusals ───────────────────────────────────────────────────────────────
{
  const res = await get(join(root, 'nope.txt'))
  check('a missing file is 404 with the reason', res.status === 404 && res.body.includes('读不到这个文件'), String(res.status))
}
{
  const res = await get(join(root, 'adir'))
  check('a directory says it is a directory',
    res.status === 400 && res.body.includes('这是一个目录'), String(res.status))
}
{
  const res = await get(join(root, 'binary.bin'))
  check('a binary file is refused as binary, not rendered',
    res.status === 415 && res.body.includes('二进制文件'), String(res.status))
  check('and its size is reported', res.body.includes('7 B'), res.body.slice(0, 0))
}
{
  const res = await get(join(root, 'big.txt'))
  check('a file past the cap is refused with its size',
    res.status === 413 && res.body.includes('文件太大') && res.body.includes('2.0 MB'), String(res.status))
}

// ── the theme the GUI asked for ────────────────────────────────────────────
{
  const dark = await get(join(root, 'plain.txt'), '&theme=dark')
  const light = await get(join(root, 'plain.txt'), '&theme=light')
  check('the page wears the theme the GUI passed',
    dark.body.includes('<body data-theme="dark">') && light.body.includes('<body data-theme="light">'))
  check('an unknown theme falls back to dark',
    (await get(join(root, 'plain.txt'), '&theme=chartreuse')).body.includes('data-theme="dark"'))
}

// ── the wiring: the plugin's own apply registers it ────────────────────────
// The route module working is not the same fact as the plugin ASKING for it, and
// a host half that forgets a registration is silent until someone clicks.
{
  const registered = []
  const injected = []
  applyPlugin({
    inject: (deps, callback) => {
      injected.push(...deps)
      callback({
        effect: fn => fn(),
        logger: () => ({ info() {}, warn() {}, error() {} }),
        webServer: {
          register: (route) => {
            if (route.path.startsWith('/dsh-web-ui/')) registered.push(`${route.kind} ${route.path}`)
            return () => {}
          },
        },
      })
      return {}
    },
  })
  check('the plugin registers the file page with the host webserver',
    registered.includes(`prefix ${FILE_PATH}`), registered.join(' | '))
  check('and it does so under the webserver capability, not unconditionally',
    injected.includes('webServer'), injected.join(' | '))
}

server.close()
rmSync(root, { recursive: true, force: true })

let failed = 0
for (const entry of results) {
  if (!entry.ok) failed += 1
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name}${entry.detail === '' ? '' : `\n      ${entry.detail}`}`)
}
console.log(failed === 0 ? `\n${String(results.length)} checks passed` : `\n${String(failed)} of ${String(results.length)} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
