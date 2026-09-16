/**
 * The file page: `GET /dsh-web-ui/file?path=…&theme=…`.
 *
 * It exists because of where a file link in the transcript can PUT the file. The
 * conversation already links every path it names — a tool row's summary, a prose
 * mention — through one opener, and a deployment can answer "show it inside the
 * GUI" instead of "hand it to the editor" (`FileViewer` in the conversation's
 * contract). Showing it means rendering it somewhere a browser can display, and
 * a browser cannot frame `file:///…` from an `http://` page at all: the panel
 * that shows this page is served from the GUI's own origin, so the content has to
 * come from a route on that origin. Hence this page rather than a `file:` URL.
 *
 * ## What it is
 *
 * A TEXT page and nothing else: escaped content in a `<pre>` with a line-number
 * gutter, plus a header naming the file, its size, and its lines. There is no
 * script in it, on purpose — it is framed SAME-ORIGIN (a direct tab in the
 * sidebar, not a relayed one), so a page with no script is a page with no way to
 * reach the GUI's DOM. Escaping is therefore the whole security surface, and it
 * is one function with one test.
 *
 * ## Trust boundary
 *
 * Identical to this plugin's other routes (`/git/*`, `/lark/*`, `/term/*`): the
 * caller is a browser on this machine and the path is one the transcript itself
 * named. The GUI is a local operator tool that already reads arbitrary
 * directories on the client's say-so and, when the terminal row is enabled, runs
 * arbitrary commands there; a stricter rule here would be theatre, not a
 * boundary. What this route DOES refuse is unbounded work: a directory, a
 * binary, or a file past the size cap answers with a page that says so.
 *
 * @module dsh-web-ui/host/file-routes
 */
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { query, sendMethodNotAllowed } from './http.ts'

/**
 * Route path of the file page, registered as a PREFIX.
 *
 * The page is addressed `/dsh-web-ui/file/<basename>?path=<absolute>`: the
 * trailing segment is decoration the route ignores, and it is there because the
 * URL is what a TAB BAR shows — the sidebar labels a tab by the last path
 * segment, so without it every file tab would read the same. The absolute path
 * travels in the query, where it cannot be mangled by URL path rules.
 */
export const FILE_PATH = '/dsh-web-ui/file'

/**
 * Largest file this route will render, in bytes.
 *
 * A reader wants to LOOK at a file a turn named; a 40MB log is not that, and
 * streaming it into an iframe would stall the panel. Past this the page says the
 * file is too large and gives its size, which is the honest answer.
 */
const MAX_BYTES = 2 * 1024 * 1024

/** Bytes inspected for a NUL when deciding whether a file is binary. */
const BINARY_PROBE_BYTES = 8192

/** How many lines the page renders before it says the rest is omitted. */
const MAX_LINES = 20_000

/**
 * Marker every page this module serves carries.
 *
 * The client capability probes the route before it trusts it (see the client's
 * `fileViewer`), because the two halves of this plugin update DIFFERENTLY: the
 * browser bundle reloads with the page, the host half only registers its routes
 * at a `dsh web` start. So "new client, old host" is an ordinary state — it is
 * the state right after this feature is installed — and without a marker the
 * missing route would fall through to the SPA fallback and put the GUI ITSELF
 * inside the sidebar tab. The marker is what the probe can recognise.
 */
const PAGE_MARKER = 'dsh-web-ui-file-page'

/** Static page styling. No script, no font loading, no external request. */
const PAGE_CSS = `
:root { color-scheme: dark; }
body[data-theme='light'] { color-scheme: light; }
body {
  margin: 0;
  background: #0e1013;
  color: #e6e8ec;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif;
  font-size: 13px;
}
body[data-theme='light'] { background: #ffffff; color: #1d2129; }
header {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.10);
  background: #16181d;
}
body[data-theme='light'] header { background: #f7f8fa; border-bottom-color: rgba(0, 0, 0, 0.08); }
h1 { margin: 0; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.meta { color: #8b93a1; font-size: 12px; overflow-wrap: anywhere; }
main { padding: 12px 0 24px; }
pre {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 0 12px;
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  line-height: 18px;
}
.line { display: contents; }
.no { padding-right: 8px; text-align: right; color: #5c6470; user-select: none; }
body[data-theme='light'] .no { color: #98a0ad; }
.code { white-space: pre-wrap; overflow-wrap: anywhere; }
.note { margin: 0; padding: 16px; color: #8b93a1; line-height: 20px; }
`

/**
 * Escape one string for HTML text content.
 *
 * The page's entire injection surface: file content is attacker-influenced in the
 * ordinary case (it is whatever the agent read), and this is what stops a file
 * containing `</pre><script>` from becoming markup.
 * @param text - raw text.
 * @returns text safe inside an element body or an attribute value.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

/** Format a byte count for the header. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Render the whole page.
 * @param title - the file's own name.
 * @param meta - the header's second line.
 * @param body - already-escaped markup for the content area.
 * @param theme - the GUI's theme, passed through by the caller.
 * @returns a complete HTML document.
 */
function page(title: string, meta: string, body: string, theme: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="${PAGE_MARKER}" content="1">
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body data-theme="${escapeHtml(theme)}">
<header>
<h1>${escapeHtml(title)}</h1>
<div class="meta">${escapeHtml(meta)}</div>
</header>
<main>${body}</main>
</body>
</html>
`
}

/**
 * Render file content as the gutter-and-code grid.
 * @param text - the file's text.
 * @returns the escaped markup, plus whether lines were dropped.
 */
function renderLines(text: string): { body: string; lines: number; truncated: boolean } {
  // A trailing newline is a line TERMINATOR, not an empty last line.
  const all = text.split('\n')
  if (all.length > 1 && all[all.length - 1] === '') all.pop()
  const shown = all.slice(0, MAX_LINES)
  const body = shown.map((line, index) =>
    `<span class="line"><span class="no">${String(index + 1)}</span>`
    + `<span class="code">${escapeHtml(line)}</span></span>`).join('\n')
  return { body: `<pre>${body}</pre>`, lines: all.length, truncated: all.length > shown.length }
}

/**
 * Answer with a page that states a fact instead of content.
 * @param res - the response to own.
 * @param status - HTTP status.
 * @param title - the headline.
 * @param note - the sentence under it.
 * @param theme - the GUI's theme.
 */
function sendNotice(res: ServerResponse, status: number, title: string, note: string, theme: string): void {
  const html = page(title, note, `<p class="note">${escapeHtml(note)}</p>`, theme)
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
  })
  res.end(html)
}

/**
 * Register the file page.
 *
 * Registered through `ctx.effect` like every other route here, so unloading the
 * plugin removes it with the fiber.
 * @param ctx - a context where `webServer` is available.
 */
export function registerFileRoutes(ctx: Context): void {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: FILE_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return }
        const params = query(req)
        const theme = params.get('theme') === 'light' ? 'light' : 'dark'
        const path = params.get('path') ?? ''
        if (path === '') {
          sendNotice(res, 400, '缺少文件路径', '这个地址需要一个 path 参数。', theme)
          return
        }

        let info
        try {
          info = await stat(path)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          sendNotice(res, 404, basename(path), `读不到这个文件：${reason}`, theme)
          return
        }
        if (info.isDirectory()) {
          sendNotice(res, 400, basename(path), '这是一个目录，不是文件。', theme)
          return
        }
        if (info.size > MAX_BYTES) {
          sendNotice(res, 413, basename(path),
            `文件太大，暂不在这里展示：${formatBytes(info.size)}（上限 ${formatBytes(MAX_BYTES)}）。`, theme)
          return
        }

        let buffer: Buffer
        try {
          buffer = await readFile(path)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          sendNotice(res, 500, basename(path), `读取失败：${reason}`, theme)
          return
        }
        if (buffer.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
          sendNotice(res, 415, basename(path),
            `这是一个二进制文件（${formatBytes(info.size)}），这里只展示文本内容。`, theme)
          return
        }

        const { body, lines, truncated } = renderLines(buffer.toString('utf8'))
        const meta = [
          path,
          formatBytes(info.size),
          `${String(lines)} 行`,
          new Date(info.mtimeMs).toLocaleString(),
          truncated ? `只展示前 ${String(MAX_LINES)} 行` : null,
        ].filter(part => part !== null).join(' · ')
        const html = page(basename(path), meta, body, theme)
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(html),
          'cache-control': 'no-store',
        })
        res.end(html)
      },
    }),
    'dsh-web-ui: file page route',
  )
}
