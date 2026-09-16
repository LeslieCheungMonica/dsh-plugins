/**
 * Offline harness for the account dock: the column's bottom-left corner.
 *
 * What is under test is a MOVE and a REVEAL, and both have a failure mode that
 * only shows up in the rendered tree:
 *
 * 1. **The move.** The identity and the sign-out action used to be a capsule in
 *    the frame's top-right corner. They are now a row at the column's bottom-left
 *    and a row inside the drawer above it. The identity is not this plugin's to
 *    render — it arrives through the `sidebar.account` seat — so the harness
 *    checks the SEAT PROTOCOL: what owner share the occupant is handed, that a
 *    deployment with no occupant still gets a row (the fallback), and that the
 *    sign-out row comes from `sidebar.account.menu`.
 * 2. **The reveal.** Clicking the row opens an upward drawer holding Usage,
 *    Settings, and the account's own rows in that order; clicking again, pressing
 *    Escape, or a pointerdown outside closes it. In the rail the column is 56px
 *    wide and clips its overflow, so the row must EXPAND the column instead of
 *    opening a drawer that cannot fit. And "closed" must mean HIDDEN rather than
 *    unmounted: the shipped Settings shell renders the body-portaled onboarding
 *    surface from inside itself, so the harness asserts that the settings
 *    occupant stays rendered while the drawer is shut.
 *
 * The Usage figures are checked against the host's own projection shape
 * (`tokenUsage` / `contextPressure`, read off the session LIST snapshot), with
 * the arithmetic asserted independently of the DOM: a wrong cache-hit or a
 * mis-clamped occupancy would still render something plausible.
 *
 * Usage: pnpm harness:account-dock   (builds the bundle first, then runs this)
 */
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:3080/',
  pretendToBeVisual: true,
})
for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'PointerEvent', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true })
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { createElement: h, act, Fragment, useSyncExternalStore } = await import('react')
const { createRoot } = await import('react-dom/client')
const {
  AccountDock, PluginsDialog, UsagePanel,
  billedInputTokens, cacheHitPercent, contextOccupancy, formatTokens, moduleShortName,
} = await import('./out/account-dock.js')
const { zh } = await import('../../src/client/locales.ts')

/** The real dictionary, filled the way the framework fills it. */
const fill = (template, params) => template.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? ''))
const t = (key, params = {}) => {
  const template = zh[key]
  if (template === undefined) throw new Error(`missing locale key ${key}`)
  return fill(template, params)
}

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

// ── the arithmetic, asserted without rendering ────────────────────────────
{
  eq('formatTokens: under 1K', formatTokens(517), '517')
  eq('formatTokens: one decimal under three digits', formatTokens(12_240), '12.2K')
  eq('formatTokens: integer from three digits', formatTokens(517_400), '517K')
  eq('formatTokens: millions', formatTokens(1_240_000), '1.2M')

  const usage = { uncachedInputTokens: 112_000, outputTokens: 76_700, cacheReadTokens: 17_700_000, cacheWriteTokens: 0 }
  eq('billedInputTokens sums the three prompt buckets', billedInputTokens(usage), 17_812_000)
  eq('cacheHitPercent', cacheHitPercent(usage), 99)
  eq('cacheHitPercent with no billed input', cacheHitPercent({ uncachedInputTokens: 0, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }), null)

  // The numerator prefers the carried-forward projection; the sample is the fallback.
  eq('occupancy prefers projectedTokens',
    contextOccupancy({ projectedTokens: 185_000, pressureTokens: 200_000, contextWindow: 1_000_000 })?.percent, 19)
  eq('occupancy falls back to pressureTokens',
    contextOccupancy({ pressureTokens: 185_000, contextWindow: 1_000_000 })?.percent, 19)
  eq('occupancy clamps at 100',
    contextOccupancy({ projectedTokens: 2_000_000, contextWindow: 1_000_000 })?.percent, 100)
  eq('occupancy without a capacity', contextOccupancy({ projectedTokens: 185_000 }), null)
  eq('occupancy without a sample', contextOccupancy({ contextWindow: 1_000_000 }), null)
}

// ── the session feed the dock reads ──────────────────────────────────────
let sessionState = {
  phase: 'ready',
  ids: ['s1'],
  byId: { s1: { id: 's1' } },
  current: undefined,
}
const listeners = new Set()
/**
 * Publish a new session snapshot and let React settle. Always called through
 * `act`, because the framework hook re-renders the dock synchronously on notify.
 * @param next - the next `SessionListState`-shaped snapshot.
 */
const setSessions = async (next) => {
  await act(async () => {
    sessionState = next
    for (const listener of listeners) listener()
  })
}
/** A `SnapshotSelectorHook` over the harness's one mutable snapshot. */
const useSessions = (selector) => useSyncExternalStore(
  (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  () => selector(sessionState),
  () => selector(sessionState),
)

/** What the harness's fake seats recorded, so the protocol can be asserted. */
const seatCalls = []
const renderSlot = (key, share, opts = {}) => {
  seatCalls.push({ key, share })
  if (key === 'sidebar.account') {
    return opts.fallback ?? null
  }
  if (key === 'sidebar.settings') {
    return h('button', { type: 'button', 'aria-haspopup': 'dialog', 'data-seat': 'settings' }, '设置')
  }
  if (key === 'sidebar.account.menu') {
    return h('button', { type: 'button', 'data-seat': 'logout' }, '退出登录')
  }
  return null
}

/** How many times the dock asked the host for its plugin inventory. */
let inventoryCalls = 0
/** The plugin inventory the dock's Plugins block reads, or a rejection. */
let inventoryAnswer = () => Promise.resolve({ entries: [] })
const listPlugins = () => {
  inventoryCalls += 1
  return inventoryAnswer()
}

const root = createRoot(document.getElementById('root'))
const render = async (props) => {
  await act(async () => {
    root.render(h(AccountDock, {
      wide: true,
      expandSidebar: () => {},
      renderSlot,
      useSessions,
      listPlugins,
      t,
      ...props,
    }))
  })
}

/**
 * Open the Plugins modal from its drawer row. The row OPENS and never toggles
 * (the mask covers it while the modal is up, so a second click is not a gesture a
 * reader can perform), which means the harness has to close the modal itself
 * before re-opening it — and that is exactly the remount the fetch rides on.
 * @returns {Promise<void>} resolves once React has settled.
 */
const openPlugins = async () => {
  if ($$('[data-stub="Modal"]').length > 0) await press('Escape')
  await clickDrawerRow('插件')
  await settle()
}

const $ = (selector) => document.querySelector(selector)
/** The Plugins modal's own note. Scoped to the modal, so the Usage block's note
 * (which shares the same styling attribute) can never answer for it. */
const pluginsNote = () => $('[data-wui="pluginsDialog"] [data-wui="pluginNote"]')?.textContent?.trim() ?? null
/** The Plugins modal's failure sentence, or null when it is not in that state. */
const pluginsFailure = () => $('[data-wui="pluginFailure"] p')?.textContent?.trim() ?? null
const $$ = (selector) => [...document.querySelectorAll(selector)]
const text = (selector) => $(selector)?.textContent?.trim() ?? null

/** Let a resolved promise's `then` run, inside `act` so React settles with it. */
const settle = async () => { await act(async () => { await Promise.resolve() }) }

const click = async (selector) => {
  const el = $(selector)
  if (el === null) throw new Error(`harness: no element for ${selector}`)
  await act(async () => {
    el.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true }))
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
}

/**
 * Click one of the drawer's rows by its label. The rows are addressed by what
 * they SAY rather than by index, so re-ordering the drawer is a visible test
 * failure instead of a silent mis-click.
 * @param {string} label - the row's exact text.
 * @returns {Promise<void>} resolves once React has settled.
 */
const clickDrawerRow = async (label) => {
  const row = $$('[data-wui="drawerRow"]')
    .find(node => (node.textContent ?? '').trim() === label)
  if (row === undefined) {
    throw new Error(`harness: no drawer row "${label}" among ${$$('[data-wui="drawerRow"]').map(n => n.textContent.trim()).join(', ')}`)
  }
  await act(async () => {
    row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
}
const outsidePointerDown = async () => {
  await act(async () => {
    document.body.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true }))
  })
}
const press = async (key) => {
  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

// ── 1. the closed row ────────────────────────────────────────────────────
await render()
eq('the row exists', $$('[data-wui="accountRow"]').length, 1)
eq('the drawer is hidden at rest, not unmounted', $('[data-wui="accountDrawer"]').getAttribute('data-open'), null)
// The load-bearing half of "not unmounted": the shipped Settings shell renders
// the body-portaled ONBOARDING surface from inside itself, so it has to stay
// mounted while the drawer is shut or a fresh deployment never sees the welcome.
eq('the settings occupant is rendered even while the drawer is closed',
  seatCalls.some(c => c.key === 'sidebar.settings' && c.share.wide === true), true)
eq('the row is not expanded', $('[data-wui="accountRow"]').getAttribute('aria-expanded'), 'false')
eq('the fallback identity renders when no occupant answers the seat', text('[data-wui="accountIdentity"]'), 'ForgeX')
eq('the seat is asked with the column state',
  JSON.stringify(seatCalls.find(c => c.key === 'sidebar.account')?.share), JSON.stringify({ wide: true }))
eq('the chevron points up while the drawer is shut', $('[data-wui="accountChevron"]').getAttribute('data-open'), null)

// ── 2. open: the drawer, its order, and its seats ────────────────────────
seatCalls.length = 0
await click('[data-wui="accountRow"]')
eq('the row opens the drawer', $('[data-wui="accountDrawer"]').getAttribute('data-open'), 'true')
eq('the row reports itself expanded', $('[data-wui="accountRow"]').getAttribute('aria-expanded'), 'true')
eq('the chevron flips', $('[data-wui="accountChevron"]').getAttribute('data-open'), 'true')
eq('the seat share is unchanged by the drawer (the row owns that state)',
  JSON.stringify(seatCalls.find(c => c.key === 'sidebar.account')?.share), JSON.stringify({ wide: true }))
eq('the drawer holds its six rows in order', JSON.stringify($$('[data-wui="accountDrawer"] button').map(b => b.textContent.trim())),
  JSON.stringify(['使用情况', '插件', '技能', '产品卡', '设置', '退出登录']))
eq('the rows come from the three expected seats',
  JSON.stringify([...new Set(seatCalls.map(c => c.key))].sort()),
  JSON.stringify(['sidebar.account', 'sidebar.account.menu', 'sidebar.settings']))
eq('Settings is asked for the WIDE trigger, never the rail circle',
  JSON.stringify(seatCalls.find(c => c.key === 'sidebar.settings')?.share), JSON.stringify({ wide: true }))
eq('the account menu gets no owner share', JSON.stringify(seatCalls.find(c => c.key === 'sidebar.account.menu')?.share), '{}')
eq('the usage disclosure starts collapsed', $$('[data-wui="drawerBody"]').length, 0)
eq('and the plugins modal starts closed', $$('[data-stub="Modal"]').length, 0)

// ── 2b. the two not-yet-built rows ───────────────────────────────────────
// They are placeholders BY REQUEST, so what is pinned is that they are present,
// that they say so, and that a click is inert — a later change that wires one up
// has to come here and change this, rather than silently inheriting a no-op.
const placeholders = $$('[data-wui="drawerRow"][data-placeholder="true"]')
eq('both placeholder rows render', placeholders.length, 2)
eq('they name what they will open',
  JSON.stringify(placeholders.map(el => el.textContent.trim())), JSON.stringify(['技能', '产品卡']))
eq('and they say they are not built yet',
  JSON.stringify(placeholders.map(el => el.getAttribute('title'))),
  JSON.stringify([zh['drawer.placeholder'], zh['drawer.placeholder']]))
// Addressed as "an icon child", not as an `svg`: the shipped icon set arrives
// through the harness's stub (a span), while this row's product-card glyph is
// this plugin's own inline svg — the assertion is about the slot being filled.
eq('each carries an icon',
  JSON.stringify($$('[data-wui="drawerRow"][data-placeholder="true"] [data-wui="drawerRowIcon"]').map(el => el.children.length)),
  JSON.stringify([1, 1]))
// A placeholder must not promise a surface it does not open.
eq('a placeholder announces no dialog', placeholders.filter(el => el.hasAttribute('aria-haspopup')).length, 0)
eq('and holds no disclosure state', placeholders.filter(el => el.hasAttribute('aria-expanded')).length, 0)
await clickDrawerRow('技能')
eq('clicking 技能 opens nothing', $$('[data-stub="Modal"]').length, 0)
eq('and does not close the drawer', $('[data-wui="accountDrawer"]').getAttribute('data-open'), 'true')
await clickDrawerRow('产品卡')
eq('clicking 产品卡 opens nothing either', $$('[data-stub="Modal"]').length, 0)
eq('with no body revealed', $$('[data-wui="drawerBody"]').length, 0)
eq('and the drawer still open', $('[data-wui="accountDrawer"]').getAttribute('data-open'), 'true')
eq('and nothing is read from the host before a disclosure is opened', inventoryCalls, 0)

// ── 3. the Usage disclosure (the first drawer row) ───────────────────────
await click('[data-wui="drawerRow"]')
eq('the disclosure opens the usage body', $$('[data-wui="drawerBody"]').length, 1)
eq('with no session it says so', text('[data-wui="usageNote"]'), zh['usage.noSession'])
eq('the disclosure reports itself expanded', $('[data-wui="drawerRow"]').getAttribute('aria-expanded'), 'true')

// A session with a durable projection.
await setSessions({
  phase: 'ready',
  ids: ['s1'],
  current: 's1',
  byId: {
    s1: {
      id: 's1',
      projectionValues: {
        tokenUsage: { uncachedInputTokens: 112_000, outputTokens: 76_700, cacheReadTokens: 17_700_000, cacheWriteTokens: 0 },
        contextPressure: { projectedTokens: 185_000, contextWindow: 1_000_000 },
      },
    },
  },
})
eq('the context reading renders numerator and capacity', text('[data-wui="usageContextFigures"]'), '185K / 1M')
eq('the bar carries the percentage', $('[data-wui="usageBar"]').getAttribute('aria-valuenow'), '19')
eq('the percentage is written out too', text('[data-wui="usageBarLabel"]'), '19%')
eq('the figures are input, output and cache hit in order',
  JSON.stringify($$('[data-wui="usageFigureLabel"]').map(el => el.textContent)), JSON.stringify(['输入', '输出', '缓存命中']))
eq('the input figure is the billed total', $$('[data-wui="usageFigureValue"]')[0].textContent, '17.8M')
eq('the output figure', $$('[data-wui="usageFigureValue"]')[1].textContent, '76.7K')
eq('the cache-hit figure', $$('[data-wui="usageFigureValue"]')[2].textContent, '99%')
ok('the input tooltip names the three buckets',
  $$('[data-wui="usageFigure"]')[0].getAttribute('title').includes('17.7M'))
ok('the scope sentence states the log, not the window',
  (text('[data-wui="usageFoot"]') ?? '').includes('完整日志'))

// A session that has billed nothing: zeros would read as a measurement.
await setSessions({
  phase: 'ready',
  ids: ['s2'],
  current: 's2',
  byId: { s2: { id: 's2', projectionValues: { tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } } },
})
eq('a session with no billing says so instead of showing zeros', text('[data-wui="usageNote"]'), zh['usage.noUsage'])

// Usage reported, but no request has named a capacity yet.
await setSessions({
  phase: 'ready',
  ids: ['s3'],
  current: 's3',
  byId: { s3: { id: 's3', projectionValues: { tokenUsage: { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } } } },
})
eq('without a capacity the context line is explained, not faked', text('[data-wui="usageNote"]'), zh['usage.noContext'])
// A 0% cache hit is a reading, not an absence: an uncached prompt is exactly
// what 0% means, so the figure stays — unlike a null share, which is dropped.
eq('the token figures still render, cache hit included', $$('[data-wui="usageFigure"]').length, 3)
eq('and 0% is written as 0%', $$('[data-wui="usageFigureValue"]')[2].textContent, '0%')

// ── 4. the Plugins modal ─────────────────────────────────────────────────
// The short-name rules, asserted without rendering: they are three string edits
// that decide what a card title says.
eq('moduleShortName drops the scope', moduleShortName('@deepseek-ai/dsh-web-ui'), 'web-ui')
eq('moduleShortName drops cordis:', moduleShortName('cordis:group'), 'group')
eq('moduleShortName drops cordis-plugin-', moduleShortName('cordis-plugin-foo'), 'foo')
eq('moduleShortName drops the dsh- prefix', moduleShortName('dsh-stage-gate'), 'stage-gate')
eq('moduleShortName drops dsh-host-', moduleShortName('@x/dsh-host-plugin-inventory'), 'plugin-inventory')
eq('moduleShortName drops dsh-client-ui-', moduleShortName('@deepseek-ai/dsh-client-ui-sidebar'), 'ui-sidebar')
eq('moduleShortName leaves a bare name alone', moduleShortName('my-sider'), 'my-sider')

inventoryAnswer = () => Promise.resolve({
  entries: [
    { entryId: 'dsh-web-ui', moduleName: '@deepseek-ai/dsh-web-ui', enabled: true, fiberPhase: 'active' },
    { entryId: 'dsh-feishu-login', moduleName: 'dsh-feishu-login', enabled: true, fiberPhase: 'active' },
    { entryId: 'old-thing', moduleName: 'cordis-plugin-old-thing', enabled: true, fiberPhase: 'failed' },
    { entryId: 'off-thing', moduleName: 'dsh-off-thing', enabled: false, fiberPhase: null },
  ],
})
await openPlugins()
eq('the row opens a modal, not an inline block', $$('[data-stub="Modal"]').length, 1)
eq('the modal is titled like the settings page', text('[data-stub="ModalTitle"]'), zh['plugin.title'])
eq('and it explains what it is showing', text('[data-stub="ModalDescription"]'), zh['plugin.intro'])
eq('the drawer stays open behind the modal', $('[data-wui="accountDrawer"]').getAttribute('data-open'), 'true')
eq('the row marks itself as the dialog trigger',
  $('[data-wui="drawerRow"][aria-haspopup="dialog"]') !== null, true)
eq('opening the modal reads the host once', inventoryCalls, 1)

// The catalogue reproduces the page: a search row, the "插件列表" heading with its
// count, and one card per entry.
eq('the catalogue heading is the page\'s own', text('[data-wui="pluginCatalogHeading"] h3'), zh['plugin.catalog'])
eq('the search row renders', $('[data-wui="pluginSearchField"] input') !== null, true)
eq('the count rides the heading', text('[data-wui="pluginCatalogHeading"] span'), '4')
eq('one card per entry', $$('[data-wui="pluginCard"]').length, 4)
eq('the cards carry the short module names in host order',
  JSON.stringify($$('[data-wui="pluginCardTitle"]').map(el => el.textContent)),
  JSON.stringify(['web-ui', 'feishu-login', 'old-thing', 'off-thing']))
eq('the full module specifier stays reachable as the title',
  $('[data-wui="pluginCardTitle"]').getAttribute('title'), '@deepseek-ai/dsh-web-ui')
eq('the phase dots match the host phases',
  JSON.stringify($$('[data-wui="pluginDot"]').map(el => el.getAttribute('data-phase'))),
  JSON.stringify(['active', 'active', 'failed']))
eq('the tags read 已启用 / 已停用, as the page words them',
  JSON.stringify($$('[data-wui="pluginTag"]').map(el => el.textContent)),
  JSON.stringify(['已启用', '已启用', '已启用', '已停用']))
eq('a disabled card carries no dot at all',
  $$('[data-wui="pluginCard"][data-enabled="false"] [data-wui="pluginDot"]').length, 0)
eq('the accessible name of a card carries the phase in words',
  $('[data-wui="pluginCardBody"]').getAttribute('aria-label'), 'web-ui, 已挂载, 已启用')

// The detail disclosure: entry id, configuration, Cordis state — the page's own
// three facts, and only the first two when the entry has no live Fiber.
eq('cards start collapsed', $$('[data-wui="pluginCardDetails"]').length, 0)
await click('[data-wui="pluginCardBody"]')
eq('a card expands in place', $$('[data-wui="pluginCardDetails"]').length, 1)
eq('and reports itself expanded', $('[data-wui="pluginCardBody"]').getAttribute('aria-expanded'), 'true')
eq('the detail names the Loader entry', text('[data-wui="pluginEntryId"]'), 'dsh-web-ui')
eq('and lists configuration + Cordis state',
  JSON.stringify($$('[data-wui="pluginFacts"] dt').map(el => el.textContent)),
  JSON.stringify([zh['plugin.configuration'], zh['plugin.cordis']]))
eq('with the phase spelled out',
  JSON.stringify($$('[data-wui="pluginFacts"] dd').map(el => el.textContent)),
  JSON.stringify(['已启用', '已挂载']))
await click('[data-wui="pluginCardBody"]')
eq('clicking again collapses it', $$('[data-wui="pluginCardDetails"]').length, 0)
// A disabled entry has no live Fiber, so it reports configuration only.
const disabledCard = $$('[data-wui="pluginCardBody"]')[3]
await act(async () => { disabledCard.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
eq('a disabled card lists configuration alone', $$('[data-wui="pluginFacts"] dt').length, 1)

// The filter: this deployment's Loader tree is ~180 entries, so it is not a
// nicety. It matches the module specifier AND the entry id, case-insensitively.
const typeInFilter = async (value) => {
  const field = $('[data-wui="pluginSearchField"] input')
  await act(async () => {
    // React reads `value` through its own tracker, so the setter has to be the
    // one the DOM defines — assigning `field.value` directly is swallowed.
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    setter.call(field, value)
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
await typeInFilter('OLD')
eq('the filter narrows the grid', $$('[data-wui="pluginCard"]').length, 1)
eq('and the count follows it', text('[data-wui="pluginCatalogHeading"] span'), '1')
eq('the surviving card is the one matched', text('[data-wui="pluginCardTitle"]'), 'old-thing')
await typeInFilter('off-thing')
eq('the filter also matches the Loader entry id', $$('[data-wui="pluginCard"]').length, 1)
eq('and a disabled entry is filterable', text('[data-wui="pluginTag"]'), '已停用')
await typeInFilter('nothing-matches-this')
eq('no match is explained, not silent', pluginsNote(), zh['plugin.noMatch'])
eq('and the count reads zero', text('[data-wui="pluginCatalogHeading"] span'), '0')
await typeInFilter('')
eq('clearing the filter restores the grid', $$('[data-wui="pluginCard"]').length, 4)

// A refusal is a state with the host's own words and a way out, not an empty list.
inventoryAnswer = () => Promise.reject(new Error('this host composes no plugin inventory unit'))
await openPlugins()
eq('a refusal is reported in the host\'s own words', pluginsFailure(),
  zh['plugin.error'].replace('{message}', 'this host composes no plugin inventory unit'))
eq('and it offers the retry the page offers',
  $('[data-wui="pluginFailure"] button')?.textContent, zh['plugin.retry'])
eq('with no stale cards behind it', $$('[data-wui="pluginCard"]').length, 0)

// The retry is a real re-read, not a re-render.
inventoryAnswer = () => Promise.resolve({ entries: [
  { entryId: 'only', moduleName: 'dsh-only', enabled: true, fiberPhase: 'active' },
] })
await click('[data-wui="pluginFailure"] button')
await settle()
eq('retry reads the host again', inventoryCalls, 3)
eq('and renders what came back', $$('[data-wui="pluginCard"]').length, 1)

// No entries is its own answer, distinct from a refusal.
inventoryAnswer = () => Promise.resolve({ entries: [] })
await openPlugins()
eq('an empty inventory says so', pluginsNote(), zh['plugin.empty'])

// Every open is a fresh read, because the modal mounts its catalogue per open.
inventoryAnswer = () => Promise.resolve({ entries: [
  { entryId: 'dsh-web-ui', moduleName: '@deepseek-ai/dsh-web-ui', enabled: true, fiberPhase: 'active' },
] })
eq('opens so far', inventoryCalls, 4)
await openPlugins()
eq('re-opening reads the host again', inventoryCalls, 5)

// Escape belongs to the modal while it is up: it must close the MODAL and leave
// the drawer where the reader opened it from.
await press('Escape')
eq('Escape closes the modal', $$('[data-stub="Modal"]').length, 0)
eq('and leaves the drawer open behind it', $('[data-wui="accountDrawer"]').getAttribute('data-open'), 'true')

// A pointerdown in the page (i.e. outside the drawer root) is swallowed for as
// long as the modal is up — which is what keeps a portaled modal's own clicks
// from being read as "clicked away from the drawer".
await openPlugins()
await outsidePointerDown()
eq('a pointerdown outside does not close the drawer while the modal is up',
  $('[data-wui="accountDrawer"]').getAttribute('data-open'), 'true')
await press('Escape')
eq('the modal closes again', $$('[data-stub="Modal"]').length, 0)

// ── 4. closing ───────────────────────────────────────────────────────────
await press('Escape')
eq('Escape closes the drawer', $('[data-wui="accountDrawer"]').getAttribute('data-open'), null)

await click('[data-wui="accountRow"]')
eq('it reopens', $('[data-wui="accountDrawer"]').getAttribute('data-open'), 'true')
await outsidePointerDown()
eq('a pointerdown outside closes it', $('[data-wui="accountDrawer"]').getAttribute('data-open'), null)
await click('[data-wui="accountRow"]')
await click('[data-wui="accountRow"]')
eq('a second click on the row closes it', $('[data-wui="accountDrawer"]').getAttribute('data-open'), null)

// ── 5. the rail ──────────────────────────────────────────────────────────
// The rail is 56px wide and the column clips its own overflow, so a drawer
// opened there could not be read. Activating the row must EXPAND the column
// instead, and the drawer the reader asked for then arrives with the width.
let expanded = 0
seatCalls.length = 0
await render({ wide: false, expandSidebar: () => { expanded += 1 } })
eq('the rail opens no drawer', $('[data-wui="accountDrawer"]').getAttribute('data-open'), null)
eq('the rail renders no chevron (there is nothing to point at)', $$('[data-wui="accountChevron"]').length, 0)
await click('[data-wui="accountRow"]')
eq('the rail row expands the column', expanded, 1)
eq('and asks for no drawer while still narrow', $('[data-wui="accountDrawer"]').getAttribute('data-open'), null)
eq('the seat is told it is narrow',
  JSON.stringify(seatCalls.filter(c => c.key === 'sidebar.account').at(-1)?.share), JSON.stringify({ wide: false }))
// The frame then reports the column wide: the drawer the reader asked for appears.
await render({ wide: true, expandSidebar: () => { expanded += 1 } })
eq('once wide, the pending drawer is open', $('[data-wui="accountDrawer"]').getAttribute('data-open'), 'true')

// ── 6. the usage block is usable on its own ──────────────────────────────
await setSessions({ phase: 'ready', ids: [], byId: {}, current: undefined })
await act(async () => {
  root.render(h(Fragment, null, h(UsagePanel, { useSessions, t })))
})
eq('UsagePanel without a current session explains itself', text('[data-wui="usageNote"]'), zh['usage.noSession'])

await act(async () => { root.unmount() })

// ── report ───────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`account-dock: ${failures.length}/${checks} checks FAILED`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log(`account-dock: ${checks} checks passed`)
