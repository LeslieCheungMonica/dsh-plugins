/**
 * The web panel's host-side relay: fetch a URL on the host and hand the response
 * back to the page, so a site that refuses to be framed can still be shown.
 *
 * ## Why a relay exists at all
 *
 * A direct `<iframe src="https://example.com">` is the honest way to show a web
 * page, and it is what a direct tab does. But a large part of the web sends
 * `X-Frame-Options: DENY` or a `frame-ancestors` directive, and a browser
 * applies those no matter who asked — so those pages stay blank, and no amount
 * of client code can change that. The only way to show them is to have a party
 * the browser does not police (the host) fetch the document and serve it from an
 * origin that allows framing. That is this module.
 *
 * ## What it deliberately does NOT do
 *
 * It is a RELAY, not a proxy, and the difference is the whole security story:
 *
 * - **No cookies, no credentials, no `set-cookie`.** Upstream requests are
 *   anonymous and the browser's cookie jar for the upstream origin is not
 *   touched in either direction. A login-gated page therefore arrives logged
 *   out; that is the honest behaviour, and the panel's hint says so.
 * - **Nothing is cached or stored.** Each request fetches.
 * - **It answers documents, not API calls.** The only verb is GET, the body is
 *   either passed through or (for HTML) given a `<base>` element, and every
 *   response is bounded in time and size.
 * - **It strips exactly the headers that exist to stop framing**, plus the
 *   framing-irrelevant transport ones. The panel loads a relayed document in an
 *   iframe WITHOUT `allow-same-origin`, so the relayed page runs on an opaque
 *   origin and cannot reach the GUI's DOM, storage, or the DSH API even though
 *   it is served from the GUI's own origin.
 *
 * Three ways in: the panel itself, curl, and anything else that can reach the
 * host. `config.relay.allowHosts` narrows the third to a list; an empty list
 * (the default) allows any `http(s)` host, which is the useful default on a
 * machine whose GUI only listens on localhost.
 *
 * @module my-sider/host/relay
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RelayProbe, WireErrorCode, WireResponse } from '../shared/wire.ts'
import { RELAY_FETCH_PATH, RELAY_PROBE_PATH } from '../shared/wire.ts'
import type { RelayOptions } from './options.ts'
import { param, query } from './http.ts'

/** What the relay tells an upstream server it is. */
const USER_AGENT = 'my-sider/0.1 (+dsh-web-ui plugin; relay)'

/**
 * Response headers that must never reach the browser, and why:
 * `x-frame-options` / `content-security-policy` are the framing bans this
 * module exists to lift; `set-cookie` is credential state a relay must not
 * carry; the rest describe the upstream CONNECTION (compression and framing of
 * the wire), which no longer describes what we send.
 */
const DROPPED_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'set-cookie',
  'set-cookie2',
  'strict-transport-security',
  'alt-svc',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
  'report-to',
  'nel',
])

/** The relay's host face. */
export interface RelayService {
  /**
   * Answer one `fetch` request by relaying the upstream document.
   * @param req - the request (its `url` query parameter names the target).
   * @param res - the response to own.
   */
  fetch(req: IncomingMessage, res: ServerResponse): Promise<void>
  /**
   * Answer the reachability/framing question about one URL.
   * @param url - the URL to probe.
   * @returns the probe, or why the URL could not be probed at all.
   */
  probe(url: string): Promise<WireResponse<RelayProbe>>
  /** Abort every in-flight upstream request (the plugin's disposal hook). */
  dispose(): void
}

/** One resolved upstream body, already decoded and bounded. */
interface Fetched {
  readonly status: number
  readonly finalUrl: string
  readonly contentType: string
  readonly html: boolean
  readonly body: string
}

/** A relay request that failed for a reason the operator should read. */
class RelayError extends Error {
  /** A stable code for the failure. */
  constructor(public readonly code: WireErrorCode, message: string) {
    super(message)
    this.name = 'RelayError'
  }
}

/**
 * Build one failure value.
 * @param code - the stable machine code.
 * @param message - the human sentence.
 * @returns the failure arm of a response.
 */
function fail(code: WireErrorCode, message: string): { ok: false; error: { code: WireErrorCode; message: string } } {
  return { ok: false, error: { code, message } }
}

/**
 * Read the charset out of a content type.
 * @param contentType - the header value.
 * @returns the lower-cased charset name, or undefined.
 */
function charsetOf(contentType: string): string | undefined {
  const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType)
  return match?.[1]?.toLowerCase()
}

/**
 * Escape text for interpolation into an HTML document.
 * @param text - the raw text.
 * @returns the escaped text.
 */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Render the page the operator sees inside the iframe when the relay fails.
 * A relayed tab has no other channel to report a problem through: an iframe
 * shows a body, and this is the body.
 * @param title - the headline.
 * @param detail - the explanatory sentence.
 * @returns a complete HTML document.
 */
function errorPage(title: string, detail: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 28px 24px; font: 13px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif;
    background: transparent; color: #8a8f98;
  }
  h1 { margin: 0 0 8px; font-size: 14px; font-weight: 600; color: #d9534f; }
  p { margin: 0; max-width: 46em; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body></html>`
}

/**
 * Decide whether a site refuses to be framed, from the headers it sent.
 *
 * A heuristic on purpose, and stated as one: `X-Frame-Options` is
 * unambiguous (any value blocks a cross-origin frame), while `frame-ancestors`
 * is a list that may or may not name this origin. Treating "present but not a
 * wildcard" as blocked errs toward offering the relay, which is the recoverable
 * mistake; the other direction leaves a blank iframe and no explanation.
 * @param headers - the upstream response headers.
 * @returns true when framing is refused.
 */
function frameBlocked(headers: Headers): boolean {
  const xfo = headers.get('x-frame-options')
  if (xfo !== null && xfo.trim() !== '') return true
  const csp = headers.get('content-security-policy')
  if (csp === null) return false
  const directive = /frame-ancestors([^;]*)/i.exec(csp)
  if (directive === null) return false
  const value = (directive[1] ?? '').trim()
  if (value === '') return true
  return !value.split(/\s+/).includes('*')
}

/**
 * Inject a `<base>` element into an HTML document.
 *
 * Without it, a relayed page's relative URLs (`./style.css`, `img/logo.png`)
 * resolve against the GUI's own origin and 404 — the single most common way a
 * relayed page looks "broken" while being fetched perfectly. Inserted as the
 * first thing in `<head>` so that any later tag's own URLs, and every relative
 * URL in the document, resolve against the upstream origin.
 * @param html - the upstream document.
 * @param baseHref - the absolute URL to resolve against (the POST-redirect URL).
 * @returns the patched document.
 */
function injectBase(html: string, baseHref: string): string {
  const tag = `<base href="${escapeHtml(baseHref)}">`
  const head = /<head[^>]*>/i.exec(html)
  if (head !== null) {
    const at = head.index + head[0].length
    return html.slice(0, at) + tag + html.slice(at)
  }
  const htmlTag = /<html[^>]*>/i.exec(html)
  if (htmlTag !== null) {
    const at = htmlTag.index + htmlTag[0].length
    return html.slice(0, at) + `<head>${tag}</head>` + html.slice(at)
  }
  return tag + html
}

/**
 * Build the relay.
 * @param options - the deployment's decisions.
 * @returns the service.
 */
export function createRelayService(options: RelayOptions): RelayService {
  /** In-flight upstream requests, so disposal can abort them. */
  const inflight = new Set<AbortController>()

  /**
   * Validate and normalize a target URL.
   * @param raw - the operator's input.
   * @returns the parsed URL.
   * @throws RelayError when the input is not a usable http(s) URL, or is not allowed.
   */
  const target = (raw: string): URL => {
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      throw new RelayError('bad-request', `"${raw}" is not an absolute URL — include the scheme, e.g. https://…`)
    }
    // `file:`, `data:`, and `javascript:` are not "web addresses this panel can
    // show"; they are filesystem and script surfaces the host must not be asked
    // to fetch on a page's behalf.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new RelayError('bad-request', `"${parsed.protocol}" is not supported — only http and https can be relayed`)
    }
    if (options.allowHosts.length > 0 && !options.allowHosts.includes(parsed.host)) {
      throw new RelayError('bad-request', `the relay is limited to ${options.allowHosts.join(', ')}; ${parsed.host} is not on that list`)
    }
    return parsed
  }

  /**
   * Fetch one URL, bounded in time and size.
   *
   * The body comes back as BYTES, never as text: whether a body is text is the
   * caller's decision (it depends on the content type), and decoding a PNG into a
   * string and re-encoding it corrupts every byte that is not valid UTF-8 — which
   * is most of them.
   * @param url - the validated target.
   * @param readBody - false when only the headers matter (the probe).
   * @returns the response facts, and the bytes when a body was read.
   */
  const upstream = async (url: URL, readBody: boolean): Promise<{ response: Response; bytes: Buffer | null; finalUrl: string }> => {
    const controller = new AbortController()
    inflight.add(controller)
    const timer = setTimeout(() => { controller.abort() }, options.timeoutMs)
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      })
      const finalUrl = response.url === '' ? url.href : response.url
      if (!readBody) {
        // Headers are all the probe needs; the body is cancelled so a large page
        // costs nothing to ask about.
        await response.body?.cancel().catch(() => undefined)
        return { response, bytes: null, finalUrl }
      }
      const declared = Number(response.headers.get('content-length') ?? '0')
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        await response.body?.cancel().catch(() => undefined)
        throw new RelayError('bad-request', `the response declares ${String(declared)} bytes, past the ${String(options.maxBytes)}-byte relay limit`)
      }
      const reader = response.body?.getReader()
      if (reader === undefined) return { response, bytes: Buffer.alloc(0), finalUrl }
      const chunks: Buffer[] = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value === undefined) continue
        size += value.byteLength
        if (size > options.maxBytes) {
          await reader.cancel().catch(() => undefined)
          throw new RelayError('bad-request', `the response is past the ${String(options.maxBytes)}-byte relay limit`)
        }
        chunks.push(Buffer.from(value))
      }
      return { response, bytes: Buffer.concat(chunks), finalUrl }
    } catch (error) {
      if (error instanceof RelayError) throw error
      const reason = error instanceof Error ? error.message : String(error)
      const timedOut = controller.signal.aborted
      throw new RelayError(
        'bad-request',
        timedOut
          ? `the host gave up after ${String(options.timeoutMs)} ms waiting for ${url.host}`
          : `${url.host} could not be reached from the host: ${reason}`,
      )
    } finally {
      clearTimeout(timer)
      inflight.delete(controller)
    }
  }

  /**
   * Write one relayed response, with the framing bans lifted.
   * @param res - the response.
   * @param status - the status to send.
   * @param contentType - the content type to send.
   * @param body - the body to send, exactly as it will go on the wire.
   */
  const writeBody = (res: ServerResponse, status: number, contentType: string, body: string | Buffer): void => {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body),
      // Relayed documents are per-request and must never be reused by a cache:
      // the panel's whole point is showing what the site serves right now.
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  /**
   * Decode a document body using the charset the upstream declared.
   * @param bytes - the raw body.
   * @param contentType - the upstream content type.
   * @returns the text.
   */
  const decode = (bytes: Buffer, contentType: string): string => {
    const charset = charsetOf(contentType) ?? 'utf-8'
    try {
      return new TextDecoder(charset, { fatal: false }).decode(bytes)
    } catch {
      // An unknown charset label must not lose the document; UTF-8 is the right
      // guess on today's web, and a wrong guess shows as mojibake rather than as
      // an empty page.
      return bytes.toString('utf8')
    }
  }

  return {
    async fetch(req, res) {
      const raw = param(query(req), 'url')
      if (raw === undefined) {
        writeBody(res, 400, 'text/html; charset=utf-8', errorPage(
          'No address',
          `This route needs a \`url\` parameter, e.g. ${RELAY_FETCH_PATH}?url=https://example.com/`,
        ))
        return
      }
      try {
        const url = target(raw)
        const { response, bytes, finalUrl } = await upstream(url, true)
        const upstreamType = response.headers.get('content-type') ?? 'application/octet-stream'
        const type = upstreamType.split(';')[0]?.trim().toLowerCase() ?? ''
        const html = type === 'text/html' || type === 'application/xhtml+xml' || type === 'text/plain'
        const payload = bytes ?? Buffer.alloc(0)
        // Text is decoded and re-declared as UTF-8 (and given a `<base>`); every
        // other type is passed through as the bytes the server sent, so images,
        // PDFs, fonts, and archives arrive intact.
        writeBody(
          res,
          response.status,
          html ? 'text/html; charset=utf-8' : upstreamType,
          html ? injectBase(decode(payload, upstreamType), finalUrl) : payload,
        )
      } catch (error) {
        const relay = error instanceof RelayError
          ? error
          : new RelayError('internal', error instanceof Error ? error.message : String(error))
        writeBody(res, 502, 'text/html; charset=utf-8', errorPage('Could not load this page', relay.message))
      }
    },

    async probe(raw) {
      try {
        const url = target(raw)
        const { response, finalUrl } = await upstream(url, false)
        return {
          ok: true,
          data: {
            url: url.href,
            finalUrl,
            status: response.status,
            contentType: (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '',
            frameBlocked: frameBlocked(response.headers),
            unreachable: false,
          },
        }
      } catch (error) {
        const relay = error instanceof RelayError
          ? error
          : new RelayError('internal', error instanceof Error ? error.message : String(error))
        // An unreachable site is an ANSWER, not a transport failure: the panel
        // asks "can I frame this?" and "no, because…" is a useful reply.
        return {
          ok: true,
          data: {
            url: raw,
            finalUrl: raw,
            status: 0,
            contentType: '',
            frameBlocked: false,
            unreachable: true,
            reason: relay.message,
          },
        }
      }
    },

    dispose() {
      for (const controller of inflight) controller.abort()
      inflight.clear()
    },
  }
}

/** Paths this module serves, re-exported so the route module needs one import. */
export { RELAY_FETCH_PATH, RELAY_PROBE_PATH }

/** Narrowing helper for the route layer: a JSON answer with `disabled` when off. */
export const RELAY_DISABLED = fail('disabled', 'the URL relay is switched off in this plugin row\'s config.relay.enabled')
