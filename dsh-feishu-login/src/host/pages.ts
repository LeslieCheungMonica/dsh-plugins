/**
 * Server-rendered HTML: the login page, its error states, and the tiny bridge
 * an embedded QR flow lands on.
 *
 * These pages are **not** the GUI's `index.html` and deliberately do not go
 * through the webserver's index taps: a page whose job is to keep somebody out
 * must not carry the boot manifest that would boot the app behind it.
 *
 * Nothing here is a build artifact on purpose. The login page has to exist
 * before the application does — that is the whole point — so it is one HTML
 * string with inline styles and inline script, and it renders on a host where
 * the frontend dist may not even be resolvable.
 *
 * @module dsh-feishu-login/host/pages
 */
import type { Endpoints } from './feishu.ts'
import { authorizeLegacyUrl, authorizeUrl, qrPageUrl } from './feishu.ts'
import type { ResolvedConfig } from './config.ts'
import { escapeHtml } from './util.ts'

/**
 * AsiaInfo's emblem, as the mark this deployment's other surfaces already
 * carry (the same three paths dsh-web-ui's sidebar uses). Inline so the login
 * page has no asset route and no build step; disable it with
 * `showBrandMark: false` when this login page fronts something else.
 */
const BRAND_MARK = [
  "M30.5217155,23.7101734 C29.9818629,25.2370105 28.5489309,26.7598083 25.5677273,27.2647147 C22.7475184,27.7413464 19.8167758,28.0604473 11.4923136,27.4214377 C11.4923136,27.4214377 11.0613927,27.3560018 10.4222201,27.230785 C8.462251,26.9076449 4.12661028,25.881675 1.65642443,22.8683934 C1.52506565,22.7068234 1.4081243,22.5452533 1.29278488,22.3756047 C2.50143096,27.2687776 5.70303466,31.4194241 10.1083237,33.80431 C14.5136128,36.1891959 19.7127216,36.5864328 24.4239448,34.8980922 C27.5757545,33.30178 29.5637575,31.1197764 30.331886,28.4094386 C30.7892388,26.7888909 30.7572001,25.164304 30.5185116,23.7101734",
  "M33.8873837,9.10424007 C32.9090847,7.39435131 31.657093,5.8594533 30.182105,4.56169785 L30.182105,4.56977636 C27.0070671,2.55015062 23.9746016,1.91114103 21.170412,2.67455956 C19.6742035,3.07848471 18.403067,3.84594249 17.3618084,4.69822455 C18.9437205,4.40255135 20.9725729,4.89291648 22.8997023,7.25103149 C24.7187011,9.47261981 26.4584039,11.872743 30.0747752,19.465728 C30.0747752,19.465728 31.5461538,23.269895 31.5461538,25.3436467 C31.5461538,25.4325103 31.5637751,25.595696 31.5637751,25.595696 C31.5770707,26.6275754 31.4443758,27.6560929 31.1696987,28.650178 C30.7795398,30.0035579 30.1059814,31.2567387 29.1945112,32.325089 C36.3410362,26.8862159 38.3539254,16.9313164 33.8897866,9.10424007",
  "M18.1379465,3.06879051 C18.1435533,3.0639434 18.150762,3.05990415 18.1563688,3.0558649 C18.1916114,3.03647649 18.227655,3.01062529 18.2612956,2.99042903 C18.3237712,2.95488361 18.3846447,2.92499315 18.4463193,2.89025559 C19.2267906,2.43062765 20.0633887,2.07567794 20.9349274,1.83439525 C22.5368638,1.39654039 24.2060814,1.38765404 25.9185514,1.77946143 C23.5886339,0.698262235 21.055066,0.13616526 18.4903725,0.131446828 C9.1445098,0.144742605 1.40828752,7.46179896 0.795383646,16.8676814 L0.805796232,16.8676814 C0.789776868,17.0219808 0.792980741,17.1690096 0.785772027,17.3184619 C0.776961378,17.5220402 0.773757505,17.722387 0.7713546,17.9259653 L1.19586773,17.9259653 L0.769752664,17.9259653 L1.19586773,17.9259653 L0.769752664,17.9259653 L0.769752664,17.9259653 L0.769752664,17.9259653 L0.769752664,17.9300046 L0.769752664,17.9300046 C0.769752664,17.9712049 0.769752664,18.0107896 0.769752664,18.0495664 C0.819412691,19.665267 1.33443523,21.0935463 2.32282995,22.3004747 C3.68447585,23.9654541 5.73255147,24.9793063 7.54994825,25.5924646 C6.55434481,24.3516066 6.01289033,22.3659105 7.04694024,19.5764035 C8.04414562,16.8773756 9.23278239,14.1573437 13.9504849,7.20013692 C13.9504849,7.20013692 16.363802,4.16261981 18.1411504,3.0558649 L18.1379465,3.06879051 Z",
]

/** The mark as an inline SVG element (currentColor, so it follows the card's ink). */
const BRAND_MARK_SVG = `<svg class="mark" viewBox="0.767 0.1 35.5 35.833" width="34" height="34" aria-hidden="true"><g fill="currentColor" fill-rule="nonzero">${
  BRAND_MARK.map(path => `<path d="${path}" />`).join('')
}</g></svg>`

/**
 * Shared stylesheet of every page this plugin serves. Kept as one string so
 * the login card, the error card, and the bridge page cannot drift apart.
 */
const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f5f6f8;
  --card: #ffffff;
  --ink: #14161a;
  --muted: #6b7280;
  --line: #e5e7eb;
  --accent: #2f6bff;
  --accent-ink: #ffffff;
  --danger: #c2341f;
  --ok: #10734a;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e1013;
    --card: #171a1f;
    --ink: #eef0f4;
    --muted: #98a0ad;
    --line: #262b33;
    --accent: #6f9dff;
    --accent-ink: #0b1220;
    --danger: #ff8a75;
    --ok: #4fd39a;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 20px;
}
.card {
  width: 100%;
  max-width: 420px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 18px;
  padding: 32px 32px 26px;
  box-shadow: 0 18px 50px rgba(15, 23, 42, .10);
  text-align: center;
}
.brand { display: flex; align-items: center; justify-content: center; gap: 10px; color: var(--ink); }
.brand .mark { flex: 0 0 auto; }
.brand .name { font-size: 19px; font-weight: 650; letter-spacing: .01em; }
h1 { margin: 22px 0 6px; font-size: 21px; font-weight: 650; }
p.sub { margin: 0; color: var(--muted); font-size: 13.5px; }
.qr {
  margin: 20px auto 6px;
  width: 300px;
  height: 300px;
  max-width: 100%;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: #fff;
  overflow: hidden;
  position: relative;
}
.qr iframe { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
/*
 * Feishu's own QR page puts the code BELOW its language switcher and title at
 * narrow widths: measured in this composition, the code sits at y=183..407 while
 * the frame is only 300px tall — so the visible window held the language bar and
 * cut the code off. The frame is therefore made tall enough for the whole page
 * and shifted up so the window lands exactly on the code, which needs no
 * undocumented endpoint and no cross-origin script access.
 */
.qr iframe.offset { height: 472px; margin-top: -172px; }
.qr .placeholder {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: #6b7280; font-size: 13px; background: #fff; text-align: center; padding: 12px;
}
.hint { margin: 14px 0 0; color: var(--muted); font-size: 13px; }
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  margin-top: 18px; padding: 10px 20px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--line); background: transparent; color: var(--ink);
  font: inherit; font-weight: 550; text-decoration: none;
}
.btn:hover { border-color: var(--accent); color: var(--accent); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.btn.primary:hover { opacity: .92; color: var(--accent-ink); }
.status { margin-top: 16px; font-size: 13px; color: var(--muted); min-height: 20px; }
.status.ok { color: var(--ok); }
.status.error { color: var(--danger); }
.foot {
  margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--line);
  color: var(--muted); font-size: 12px; text-align: left; word-break: break-all;
}
.foot code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
details summary { cursor: pointer; }
.bad { color: var(--danger); font-weight: 600; }
.rows { margin: 18px 0 0; text-align: left; font-size: 13px; color: var(--muted); }
.rows div { display: flex; gap: 10px; padding: 5px 0; border-bottom: 1px dashed var(--line); }
.rows b { flex: 0 0 92px; color: var(--ink); font-weight: 550; }
.rows span { word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
`

/**
 * Wrap page content in the shared document shell.
 * @param title - the document title (already plain text).
 * @param body - the body markup (already escaped by its builder).
 * @returns the full HTML document.
 */
function document_(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`
}

/** Inputs of {@link renderLoginPage}. */
export interface LoginPageOptions {
  /** Normalized configuration. */
  config: ResolvedConfig
  /** Resolved endpoint table. */
  endpoints: Endpoints
  /** Where Feishu must send the browser back to (printed as a setup aid). */
  redirectUri: string
  /** Where to land after a successful login. */
  next: string
  /** Signed OAuth `state` for this page's flow. */
  state: string
  /** An error line to show instead of a fresh QR (e.g. a refused callback). */
  error?: string | undefined
  /** Whether the previous attempt was refused by the allowlist. */
  denied?: boolean | undefined
}

/**
 * Render the login page: brand, headline, the Feishu QR, and the always-present
 * top-level fallback for browsers that block the embedded flow's third-party
 * cookies (or for a user who simply prefers the full Feishu page).
 * @param options - see {@link LoginPageOptions}.
 * @returns the HTML document.
 */
export function renderLoginPage(options: LoginPageOptions): string {
  const { config, endpoints, redirectUri, next, state } = options
  const authorize = authorizeUrl(endpoints, {
    appId: config.appId,
    redirectUri,
    state,
    scopes: config.scopes,
  })
  const authorizeLegacy = authorizeLegacyUrl(endpoints, {
    appId: config.appId,
    redirectUri,
    state,
    scopes: config.scopes,
  })
  const qrPage = qrPageUrl(endpoints, {
    appId: config.appId,
    redirectUri,
    state,
    scopes: config.scopes,
  })

  const brand = `<div class="brand">${config.showBrandMark ? BRAND_MARK_SVG : ''}<span class="name">${escapeHtml(config.brandName)}</span></div>`

  const qrArea = renderQrArea(config, { qrPage })

  const status = options.denied === true
    ? `<div class="status error" id="status">飞书已确认你的身份，但该账号不在允许访问的名单内。</div>`
    : options.error !== undefined && options.error !== ''
      ? `<div class="status error" id="status">${escapeHtml(options.error)}</div>`
      : '<div class="status" id="status">等待扫码…</div>'

  const fallback = config.mode === 'embed'
    ? `<a class="btn" href="${escapeHtml(authorize)}">在新窗口 / 整页打开飞书登录</a>`
    : ''

  const foot = config.showRedirectUri
    ? `<div class="foot">
         回调地址必须已在飞书开放平台「安全设置 → 重定向 URL」中登记（完全一致，不支持通配符）：<br />
         <code>${escapeHtml(redirectUri)}</code>
       </div>`
    : ''

  // The marker is a contract with the desktop shells: a native window that
  // probes "/" for the boot graph to decide whether a DSH host is already
  // serving a port sees this login page instead, and needs a way to tell "a
  // gated DSH host" apart from "some other service owns the port".
  return document_(`${config.brandName} · 登录`, `<div class="card" data-dsh-feishu-login="login">
  ${brand}
  <h1>${escapeHtml(config.title)}</h1>
  <p class="sub">${escapeHtml(config.subtitle)}</p>
  ${qrArea}
  ${status}
  ${fallback}
  ${foot}
</div>
<script>
(function () {
  var NEXT = ${JSON.stringify(next)};
  var SESSION = ${JSON.stringify(`${config.routePrefix}/session`)};
  var status = document.getElementById('status');
  var stopped = false;

  function fail(message) {
    if (status) { status.className = 'status error'; status.textContent = message; }
  }

  function succeed(session) {
    if (stopped) return;
    stopped = true;
    if (status) {
      status.className = 'status ok';
      status.textContent = '登录成功' + (session && session.user && session.user.name ? '：' + session.user.name : '') + '，正在进入…';
    }
    window.location.replace(NEXT);
  }

  // Polling is what makes the embedded QR flow work even when the scanned
  // page cannot reach the top document; the callback bridge also redirects
  // directly, so both paths converge on the same session cookie.
  function poll() {
    if (stopped) return;
    fetch(SESSION, { headers: { accept: 'application/json' }, cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (body) {
        if (body && body.authenticated === true) { succeed(body); return; }
        if (body && body.configured === false) { fail('登录未配置：缺少 appId / appSecret。'); return; }
        window.setTimeout(poll, 1500);
      })
      .catch(function () { window.setTimeout(poll, 2500); });
  }
  poll();

  ${config.qrEmbed === 'sdk' ? renderQrSdkScript(endpoints, authorizeLegacy) : ''}
})();
</script>`)
}

/**
 * The QR surface of the login page for one embed technique.
 * @param config - normalized configuration.
 * @param urls - the flow's embeddable QR page URL.
 * @returns the markup.
 */
function renderQrArea(
  config: ResolvedConfig,
  urls: { qrPage: string },
): string {
  if (config.mode === 'embed' && config.qrEmbed === 'page') {
    return `<div class="qr"><div class="placeholder">正在加载飞书二维码…</div><iframe class="offset" src="${escapeHtml(urls.qrPage)}" title="飞书扫码登录" allow="clipboard-write" referrerpolicy="no-referrer"></iframe></div>
<p class="hint">扫码后本页会自动进入；若二维码没有出现，请使用下面的按钮。</p>`
  }
  if (config.mode === 'embed') {
    // The SDK mounts its own iframe into the holder below; no placeholder is
    // drawn over it (an absolutely positioned one would hide the QR).
    return `<div class="qr"><div id="dsh-feishu-qr"></div></div>
<p class="hint">二维码加载中；若长时间未出现，请使用下面的按钮打开飞书登录页。</p>`
  }
  // `redirect` mode never renders this body: the handler 302s to Feishu.
  return '<p class="hint">正在前往飞书登录页…</p>'
}

/**
 * The official QR SDK bootstrap. The SDK renders Feishu's QR inside the login
 * page and reports a `tmp_code` over `postMessage`; the page then appends it to
 * the legacy authorize URL, which is what Feishu turns into the callback.
 *
 * Every message is validated through the SDK's own `matchOrigin`/`matchData`
 * (the docs' requirement), and a failure falls back to the top-level button
 * rather than leaving a dead QR on screen.
 * @param endpoints - resolved endpoints (the SDK script URL).
 * @param authorizeLegacy - the `goto` URL the SDK requires.
 * @returns the inline script.
 */
function renderQrSdkScript(endpoints: Endpoints, authorizeLegacy: string): string {
  return `var GOTO = ${JSON.stringify(authorizeLegacy)};
  var SDK = ${JSON.stringify(endpoints.qrSdk)};
  var holder = document.getElementById('dsh-feishu-qr');
  if (holder) {
    var script = document.createElement('script');
    script.src = SDK;
    script.async = true;
    script.onerror = function () { fail('飞书二维码组件加载失败，请使用下面的按钮打开飞书登录页。'); };
    script.onload = function () {
      var api = window.QRLogin;
      if (typeof api !== 'function') { fail('飞书二维码组件未就绪，请使用下面的按钮打开飞书登录页。'); return; }
      var qr = api({ id: 'dsh-feishu-qr', goto: GOTO, width: '300', height: '300', style: 'width:300px;height:300px' });
      window.addEventListener('message', function (event) {
        try {
          if (!qr || !qr.matchOrigin || !qr.matchData) return;
          if (!qr.matchOrigin(event.origin) || !qr.matchData(event.data)) return;
          var data = event.data || {};
          if (data.source === 'qrcode' && data.tmp_code) {
            window.location.href = GOTO + '&tmp_code=' + encodeURIComponent(data.tmp_code);
          }
        } catch (error) { /* a hostile or unexpected message is ignored */ }
      });
    };
    document.head.appendChild(script);
  }`
}

/**
 * Render a plain message page (everything that is not a success: a refused
 * callback, an unconfigured gate, a transport failure).
 * @param options - title, detail lines, and the primary action.
 * @returns the HTML document.
 */
export function renderMessagePage(options: {
  /** Document + headline text. */
  title: string
  /** One-line explanation under the headline. */
  message: string
  /** Extra label/value rows (identities, redirect URI, error text). */
  rows?: Array<{ label: string; value: string }> | undefined
  /** Optional primary action. */
  action?: { label: string; href: string } | undefined
  /** Whether the headline reads as a failure. */
  bad?: boolean | undefined
}): string {
  const rows = (options.rows ?? []).length === 0 ? '' : `<div class="rows">${
    (options.rows ?? []).map(row => `<div><b>${escapeHtml(row.label)}</b><span>${escapeHtml(row.value)}</span></div>`).join('')
  }</div>`
  const action = options.action === undefined
    ? ''
    : `<a class="btn primary" href="${escapeHtml(options.action.href)}">${escapeHtml(options.action.label)}</a>`
  const head = options.bad === true
    ? `<h1 class="bad">${escapeHtml(options.title)}</h1>`
    : `<h1>${escapeHtml(options.title)}</h1>`
  return document_(options.title, `<div class="card">
  ${head}
  <p class="sub">${escapeHtml(options.message)}</p>
  ${rows}
  ${action}
</div>`)
}

/**
 * Render the bridge an embedded QR flow lands on: the iframe's own callback
 * response. Because the frame is same-origin with the login page, this can
 * move the top window directly; the `postMessage` and the link are there for
 * the cases where a browser refuses that.
 * @param next - the sanitized post-login path.
 * @returns the HTML document.
 */
export function renderCallbackBridge(next: string): string {
  return document_('登录成功', `<div class="card">
  <h1>登录成功</h1>
  <p class="sub">正在进入…</p>
  <a class="btn primary" href="${escapeHtml(next)}">立即进入</a>
</div>
<script>
(function () {
  var NEXT = ${JSON.stringify(next)};
  try { if (window.top) { window.top.location.replace(NEXT); return; } } catch (error) { /* cross-origin top: fall through */ }
  try { window.parent.postMessage({ type: 'dsh-feishu-login', next: NEXT }, window.location.origin); } catch (error) { /* ignore */ }
  window.location.replace(NEXT);
})();
</script>`)
}
