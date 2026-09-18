/**
 * Offline harness for the sidebar-link capability's provider side.
 *
 * Clicking a Feishu document must show it INSIDE the GUI when the deployment has
 * a sidebar that can hold a page, and open a system tab when it does not. The
 * consumers already ask correctly (see `lark-panel.mjs`); what decides the
 * outcome is the answer they get, and that answer comes from the adapters this
 * plugin registers — one per peer that can show a page (`dsh-web-ui`'s
 * `openInSidebar`, built in `src/client/index.tsx`).
 *
 * Two properties of that seam are worth pinning down offline, because both fail
 * SILENTLY in a live deployment:
 *
 * 1. **The preference is real, not assumed.** `better-sidebar`'s `openTab`
 *    returns nothing and quietly does nothing when the tab type is disabled or no
 *    session is active. An adapter that answered `true` regardless would turn a
 *    document click into NOTHING — the exact failure the capability's boolean
 *    exists to prevent — so every gate the peer applies is checked here as a
 *    `false` answer that lets the caller open a tab instead.
 * 2. **The seed is the peer's own.** The tab is opened by `type` and lands on a
 *    URL with a hostname title, which is how the peer's own link takeover opens
 *    it (`lib/client.js` of `dsh-better-sidebar`). A different id, a missing
 *    title, or an empty URL would open an empty browser tab rather than the
 *    document.
 *
 * The stubs are the peers' services as this plugin declares them — a client
 * bundle may not import a peer's module, so a service is a structural shape and
 * the harness is the only place the two are exercised together.
 *
 * Usage: pnpm harness:sidebar-link   (builds the bundle first, then runs this)
 */
const { betterSidebarOpener, combineOpeners, webSidebarOpener } = await import('./out/sidebar-link.js')

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

/** The tenant this deployment's Feishu links point at. */
const DOC_URL = 'https://asiainfo-sec.feishu.cn/docx/doxcn1'

/**
 * A stub of `dsh-better-sidebar`'s `ctx.betterSidebar`, recording what it was
 * asked so a case can assert BOTH the answer and the calls that produced it.
 *
 * `active` is a separate flag rather than an explicit `sessionId: undefined`,
 * because a defaulted parameter cannot tell "the case passed undefined" from
 * "the case passed nothing" — and "no active session" is one of the states under
 * test, so it has to be sayable.
 *
 * @param options - the two gates the peer itself applies.
 * @returns the service stub and the recorded calls.
 */
function betterStub({ enabled = true, active = true } = {}) {
  /** Every seed handed to `openTab`, in order. */
  const opened = []
  /** Every tab id asked about, in order. */
  const asked = []
  return {
    opened,
    asked,
    service: {
      isTabEnabled: (id) => { asked.push(id); return enabled },
      getSnapshot: () => ({ sessionId: active ? 'session-1' : undefined, state: {}, prefs: {} }),
      openTab: (seed) => { opened.push(seed) },
    },
  }
}

// 1. `my-sider`, the peer this capability was first built for: a thin delegate,
//    and its answer is the answer.
const taker = { calls: [], answer: true, open(url) { this.calls.push(url); return this.answer } }
check('my-sider is handed the link',
  webSidebarOpener(taker)(DOC_URL) === true && taker.calls.length === 1 && taker.calls[0] === DOC_URL,
  JSON.stringify(taker.calls))

const refuser = { calls: [], answer: false, open(url) { this.calls.push(url); return this.answer } }
check('and a sidebar that will not take it says so, so the caller opens a tab',
  webSidebarOpener(refuser)(DOC_URL) === false && refuser.calls.length === 1,
  JSON.stringify(refuser.calls))

// 2. `better-sidebar`: the peer that holds the sidebar in the current deployment.
//    Its browser tab is opened by id, lands on the URL, and is labelled with the
//    host — the same seed its own link takeover builds.
const happy = betterStub()
check('better-sidebar takes the link and answers that it did',
  betterSidebarOpener(happy.service)(DOC_URL) === true, JSON.stringify(happy.opened))
check('opening its browser tab, addressed by URL',
  happy.opened.length === 1 && happy.opened[0].type === 'browser' && happy.opened[0].url === DOC_URL,
  JSON.stringify(happy.opened))
check('and labelled with the host the document lives on',
  happy.opened[0]?.title === 'asiainfo-sec.feishu.cn', JSON.stringify(happy.opened))

// 3. The gates the peer applies itself, each answered as "I did not take it" —
//    a `true` here would be a click that does nothing at all.
const disabled = betterStub({ enabled: false })
check('a disabled browser tab is refused rather than buried',
  betterSidebarOpener(disabled.service)(DOC_URL) === false && disabled.opened.length === 0,
  JSON.stringify(disabled.opened))
check('and the peer was asked about the browser tab by its own id',
  disabled.asked.length === 1 && disabled.asked[0] === 'browser', JSON.stringify(disabled.asked))

const noSession = betterStub({ active: false })
check('with no active session the peer would drop the open, so the link falls back',
  betterSidebarOpener(noSession.service)(DOC_URL) === false && noSession.opened.length === 0,
  JSON.stringify(noSession.opened))

// 4. Degenerate links. An empty one must not open an empty tab; an unparseable
//    one is still handed over — the peer owns its own address gate, and this
//    adapter's job is not to duplicate that policy — but it carries no title.
const empty = betterStub()
check('an empty link opens nothing',
  betterSidebarOpener(empty.service)('') === false && empty.opened.length === 0,
  JSON.stringify(empty.opened))

const odd = betterStub()
check('an unparseable link still reaches the peer, with no invented title',
  betterSidebarOpener(odd.service)('/docx/doxcn1') === true
  && odd.opened.length === 1 && odd.opened[0].url === '/docx/doxcn1' && odd.opened[0].title === undefined,
  JSON.stringify(odd.opened))

// 5. The composed capability: peers are tried in order, the first one that takes
//    the link ends the search, and the list is LIVE — an arm that registers later
//    (this plugin arms each peer through `ctx.inject`) is asked from then on.
const asked = []
const no = (url) => { asked.push(`no:${url}`); return false }
const yes = (url) => { asked.push(`yes:${url}`); return true }
const never = (url) => { asked.push(`never:${url}`); return true }

check('the first peer that takes the link wins and the rest are not asked',
  combineOpeners([no, yes, never])(DOC_URL) === true
  && asked.join(',') === `no:${DOC_URL},yes:${DOC_URL}`, asked.join(','))
check('a peer that declines does not stop the next one',
  combineOpeners([no, yes])('https://feishu.cn/docx/x') === true)
check('with every peer declining, the answer is false — the caller opens a tab',
  combineOpeners([no])(DOC_URL) === false)
check('with no peer mounted at all, the answer is false',
  combineOpeners([])(DOC_URL) === false)

const live = []
const composed = combineOpeners(live)
const before = composed(DOC_URL)
live.push(yes)
check('a peer that mounts later is asked from then on',
  before === false && composed(DOC_URL) === true)

let failed = 0
for (const entry of results) {
  if (!entry.ok) failed += 1
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name}${entry.detail === '' ? '' : `\n      ${entry.detail}`}`)
}
console.log(failed === 0 ? `\n${String(results.length)} checks passed` : `\n${String(failed)} of ${String(results.length)} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
