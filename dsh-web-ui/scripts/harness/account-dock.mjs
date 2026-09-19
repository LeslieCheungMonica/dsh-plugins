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
const { createPortal } = await import('react-dom')
const {
  AccountDock, PluginsDialog, SkillsDialog, UsagePanel, searchMarketSkills,
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

/** Whether the stubbed settings panel is showing (see the seat stub below). */
let settingsPanelOpen = false

/** What the harness's fake seats recorded, so the protocol can be asserted. */
const seatCalls = []
const renderSlot = (key, share, opts = {}) => {
  seatCalls.push({ key, share })
  if (key === 'sidebar.account') {
    return opts.fallback ?? null
  }
  if (key === 'sidebar.settings') {
    // The shipped SettingsRoot renders the trigger AND (once opened) a
    // full-viewport panel with role="dialog"; this stub reproduces exactly that
    // pair, because the dock's dismissal rule is a property of the PAGE — it
    // stands down while any dialog is up — and a stub without the dialog could
    // not test it.
    return h(Fragment, null,
      h('button', {
        type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': String(settingsPanelOpen),
        'data-seat': 'settings',
        onClick: () => { settingsPanelOpen = true; void render({}) },
      }, '设置'),
      settingsPanelOpen
        ? createPortal(h('div', { role: 'dialog', 'aria-modal': 'true', 'aria-label': '设置', 'data-seat': 'settings-panel' },
          h('button', { type: 'button', 'data-seat': 'settings-close', onClick: () => { settingsPanelOpen = false; void render({}) } }, '关闭')), document.body)
        : null)
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

/** How many times the Skills modal asked the host for the marketplace. */
let marketCalls = 0
/** What that read answers: an empty-but-valid marketplace until a case says otherwise. */
let marketAnswer = () => Promise.resolve({
  ok: true,
  data: { items: [], total: 0, verifiedEmail: 'li.yh9@asiainfo-sec.com' },
})
const listMarketSkills = (term) => {
  marketCalls += 1
  // The TERM is forwarded: the face method takes one since search was added, and a
  // harness wrapper that swallowed it would pass every assertion about a term while
  // testing nothing.
  return marketAnswer(term)
}

/** How many times the Skills modal asked what is installed, and what it answers. */
let installedCalls = 0
/** A host with no skills installed: one root, present and empty. */
const EMPTY_SCAN = {
  ok: true,
  data: {
    personal: [],
    shared: [],
    // The root is reported even when empty, which is what distinguishes "no skills"
    // from "no directories to look in".
    roots: [{ source: 'user-dsh', path: '/home/operator/.dsh/skills', exists: true, count: 0 }],
  },
}
let installedAnswer = () => Promise.resolve(EMPTY_SCAN)
const listInstalledSkills = () => {
  installedCalls += 1
  return installedAnswer()
}

/** How many times an install was asked for, and what the host answers. */
let installCalls = 0
let installAnswer = () => Promise.resolve({
  ok: true,
  data: { name: 'fixture-skill', directory: '/home/operator/.dsh/skills/fixture-skill', files: 3, bytes: 42, version: '2.0.3' },
})
const installMarketSkill = () => {
  installCalls += 1
  return installAnswer()
}

const root = createRoot(document.getElementById('root'))
/**
 * Render the dock, plus optional siblings beside it.
 *
 * The siblings exist because one surface is mounted rather than opened: the
 * Plugins dialog lost its drawer row (see the drawer section) while staying
 * shipped, so §4 mounts it NEXT TO the dock. Rendering it this way — rather than
 * in place of the dock — is what keeps the dock mounted, and with it the drawer
 * state every later assertion reads.
 *
 * @param props - dock prop overrides.
 * @param siblings - extra elements rendered beside the dock.
 */
const render = async (props, siblings = null) => {
  await act(async () => {
    root.render(h(Fragment, null, h(AccountDock, {
      wide: true,
      expandSidebar: () => {},
      renderSlot,
      useSessions,
      listPlugins,
      listMarketSkills,
      listInstalledSkills,
      installMarketSkill,
      projectPath: undefined,
      t,
      ...props,
    }), siblings))
  })
}

/**
 * Open the Plugins modal. The drawer no longer offers a row for it (see the
 * drawer section), so the dialog is mounted directly — the surface is kept
 * shipped, and mounting it here is what keeps it verified. A re-open IS a
 * remount: the read below runs again, which is what its assertions expect.
 * @returns {Promise<void>} resolves once React has settled.
 */
/** Whether the mounted Plugins dialog is open. Module state because the dialog is
 * driven directly here — its drawer row is gone — and Escape must still be able
 * to close it, exactly as the real onClose would. */
let pluginsDialogOpen = false
const pluginsDialog = () => h(PluginsDialog, {
  open: pluginsDialogOpen,
  onClose: () => { pluginsDialogOpen = false; void render({}, pluginsDialog()) },
  listPlugins,
  t,
})

/**
 * Open the Plugins modal: shut, then open.
 *
 * The dialog reads the inventory on the OPEN transition, so mounting it
 * already-open would render a surface that never asked — this is the same
 * gesture the old drawer row performed (close, then click again).
 * @returns {Promise<void>} resolves once React has settled.
 */
const openPlugins = async () => {
  pluginsDialogOpen = false
  await render({}, pluginsDialog())
  pluginsDialogOpen = true
  await render({}, pluginsDialog())
  await settle()
}

/**
 * Open the Skills modal from its drawer row.
 *
 * Like the Plugins modal, the row OPENS and never toggles, so re-opening means
 * closing first — and because the modal only mounts its read while it is open,
 * that remount IS the refresh every case below rides on.
 * @returns {Promise<void>} resolves once React has settled.
 */
const openSkills = async () => {
  if ($$('[data-stub="Modal"]').length > 0) await press('Escape')
  await clickDrawerRow('技能')
}

/** Mount a fresh dialog. A re-open IS a remount here: both reads run again, and
 * the tab state starts over, which is what the assertions below expect. */
const mountDialog = async () => {
  await act(async () => { root.render(null) })
  await act(async () => {
    root.render(h(Fragment, null, h(SkillsDialog, {
      open: true,
      onClose: () => {},
      projectPath: undefined,
      listMarketSkills,
      listInstalledSkills,
      installMarketSkill,
      t,
    })))
  })
  await settle()
}

/** The names a grid is showing, in order. */
const gridNames = selector => $$(`${selector} [data-wui="skillName"]`).map(el => el.textContent.trim())

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
// Five rows, not six: 插件 is not offered (see the drawer section below).
eq('the drawer holds its five rows in order', JSON.stringify($$('[data-wui="accountDrawer"] button').map(b => b.textContent.trim())),
  JSON.stringify(['使用情况', '技能', '产品卡', '设置', '退出登录']))
eq('the rows come from the three expected seats',
  JSON.stringify([...new Set(seatCalls.map(c => c.key))].sort()),
  JSON.stringify(['sidebar.account', 'sidebar.account.menu', 'sidebar.settings']))
eq('Settings is asked for the WIDE trigger, never the rail circle',
  JSON.stringify(seatCalls.find(c => c.key === 'sidebar.settings')?.share), JSON.stringify({ wide: true }))
eq('the account menu gets no owner share', JSON.stringify(seatCalls.find(c => c.key === 'sidebar.account.menu')?.share), '{}')
eq('the usage disclosure starts collapsed', $$('[data-wui="drawerBody"]').length, 0)
eq('and the plugins modal starts closed', $$('[data-stub="Modal"]').length, 0)

// ── 2b. the 技能 row, and the one row still to build ─────────────────────
// 产品卡 is a placeholder BY REQUEST, so what is pinned is that it is present,
// that it says so, and that a click is inert — a later change that wires it up
// has to come here and change this, rather than silently inheriting a no-op.
const placeholders = $$('[data-wui="drawerRow"][data-placeholder="true"]')
eq('the one placeholder row renders', placeholders.length, 1)
eq('it names what it will open',
  JSON.stringify(placeholders.map(el => el.textContent.trim())), JSON.stringify(['产品卡']))
eq('and it says it is not built yet',
  JSON.stringify(placeholders.map(el => el.getAttribute('title'))),
  JSON.stringify([zh['drawer.placeholder']]))
// Addressed as "an icon child", not as an `svg`: the shipped icon set arrives
// through the harness's stub (a span), while this row's product-card glyph is
// this plugin's own inline svg — the assertion is about the slot being filled.
eq('each remaining placeholder carries an icon',
  JSON.stringify($$('[data-wui="drawerRow"][data-placeholder="true"] [data-wui="drawerRowIcon"]').map(el => el.children.length)),
  JSON.stringify([1]))
// A placeholder must not promise a surface it does not open.
eq('a placeholder announces no dialog', placeholders.filter(el => el.hasAttribute('aria-haspopup')).length, 0)
eq('and holds no disclosure state', placeholders.filter(el => el.hasAttribute('aria-expanded')).length, 0)
await clickDrawerRow('产品卡')
eq('clicking 产品卡 opens nothing', $$('[data-stub="Modal"]').length, 0)
eq('with no body revealed', $$('[data-wui="drawerBody"]').length, 0)
eq('and the drawer still open', $('[data-wui="accountDrawer"]').getAttribute('data-open'), 'true')
eq('and nothing is read from the host before a disclosure is opened', inventoryCalls, 0)

// 插件 is NOT offered in this drawer any more, at the operator's request. The
// modal itself is kept whole and is verified in §4 by mounting it directly; what
// this asserts is the deployment's decision — the row that opened it is gone, so
// a reader who wants the loaded-plugin list uses Settings → Plugins.
eq('the drawer offers no 插件 row',
  $$('[data-wui="drawerRow"]').filter(node => node.textContent.trim() === zh['plugin.title']).length, 0)

// 技能 is a REAL trigger now: it opens this plugin's own modal, and it is
// addressed by its label like every other row.
const skillsRow = () => $$('[data-wui="drawerRow"]').find(node => node.textContent.trim() === '技能')
// The installed read is held open across the click below, so the state a reader
// sees WHILE it is in flight is asserted rather than assumed.
let resolveInstalledScan
installedAnswer = () => new Promise(resolve => { resolveInstalledScan = resolve })
eq('the skills row marks itself as a dialog trigger', skillsRow().getAttribute('aria-haspopup'), 'dialog')
eq('and no longer promises an unbuilt surface', skillsRow().hasAttribute('data-placeholder'), false)
eq('nor carries the placeholder tooltip', skillsRow().hasAttribute('title'), false)
const marketOpens = marketCalls
await clickDrawerRow('技能')
eq('clicking 技能 opens a modal', $$('[data-stub="Modal"]').length, 1)
eq('titled 技能', text('[data-stub="ModalTitle"]'), zh['skill.title'])
eq('and it explains what it is showing', text('[data-stub="ModalDescription"]'), zh['skill.intro'])
eq('the drawer stays open behind it', $('[data-wui="accountDrawer"]').getAttribute('data-open'), 'true')
// The skills read does not exist yet, so opening this modal must not reach the
// host at all — the inventory counter is the witness that it does not.
eq('and the skills modal reads nothing from the host', inventoryCalls, 0)

// ── 2c. the skills modal's shape, with nothing installed yet ─────────────
eq('the installed section is headed', text('[data-wui="skillInstalledHeading"] h3'), zh['skill.installed'])
eq('the tab strip is a real tablist', $('[data-wui="skillTabs"]').getAttribute('role'), 'tablist')
eq('the two scope tabs render in order',
  JSON.stringify($$('[data-wui="skillTab"]').map(el => el.textContent.trim())),
  JSON.stringify([zh['skill.scope.public'], zh['skill.scope.personal']]))
eq('公共 is the tab a reader lands on',
  $('[data-wui="skillTab"][data-active="true"]').textContent.trim(), zh['skill.scope.public'])
eq('the current tab reports itself selected',
  JSON.stringify($$('[data-wui="skillTab"]').map(el => el.getAttribute('aria-selected'))),
  JSON.stringify(['true', 'false']))
// The installed block is a READ now, so its empty state is an ANSWER rather than
// a starting condition — and a section that has not answered says so instead.
eq('the installed block says it is being read',
  text('[data-wui="skillNote"]'), zh['skill.installed.loading'])
eq('and shows no count it does not have yet', $$('[data-wui="skillInstalledHeading"] span').length, 0)
await act(async () => { resolveInstalledScan(EMPTY_SCAN) })
eq('no cards while there is nothing installed', $$('[data-wui="skillCard"]').length, 0)
eq('the empty public tab says so in its own words', text('[data-wui="skillNote"]'), zh['skill.empty.public'])
eq('and the scan is asked once per open', installedCalls, 1)
eq('with the count the answer carries', text('[data-wui="skillInstalledHeading"] span'), '0')
installedAnswer = () => Promise.resolve(EMPTY_SCAN)
eq('the pane is a tabpanel', $('[data-wui="skillPane"]').getAttribute('role'), 'tabpanel')

await click('[data-wui="skillTabs"] [data-wui="skillTab"]:nth-child(2)')
eq('the personal tab becomes current',
  $('[data-wui="skillTab"][data-active="true"]').textContent.trim(), zh['skill.scope.personal'])
eq('and it says so in its own words', text('[data-wui="skillNote"]'), zh['skill.empty.personal'])
await click('[data-wui="skillTabs"] [data-wui="skillTab"]:nth-child(1)')
eq('switching back returns to the public tab', text('[data-wui="skillNote"]'), zh['skill.empty.public'])

// The marketplace is a SECTION below the installed block, not a third tab: it
// answers a different question (what could be installed) inside the same modal.
eq('the marketplace is its own section', text('[data-wui="skillMarketHeading"] h3'), zh['skill.market'])
eq('the two sections are separated', $$('[data-wui="skillDivider"]').length, 1)
eq('the marketplace adds no third tab',
  $$('[data-wui="skillTab"]').some(el => el.textContent.trim() === zh['skill.market']), false)

// Opening the modal is what reads the marketplace, so the read happens HERE and
// not at the desk: a skill published since the last open cannot be missing.
await settle()
eq('opening the skills modal reads the marketplace once', marketCalls, marketOpens + 1)
eq('a marketplace with no matches says so', text('[data-wui="skillMarketNote"]'), zh['skill.empty.market'])
eq('the count is the server\'s own, not the card count', text('[data-wui="skillMarketHeading"] span'), '0')
eq('and lists no cards', $$('[data-wui="skillMarketCard"]').length, 0)
eq('the account the list was read as is named',
  text('[data-wui="skillMarketIdentity"]'), zh['skill.market.identity'].replace('{email}', 'li.yh9@asiainfo-sec.com'))

// Escape belongs to the modal while it is up, exactly as for Plugins.
await press('Escape')
eq('Escape closes the skills modal', $$('[data-stub="Modal"]').length, 0)
eq('and leaves the drawer open behind it', $('[data-wui="accountDrawer"]').getAttribute('data-open'), 'true')

// ── 2d. the marketplace's read: cards, failures, and the retry ──────────
// The read is the host's, so what this section checks is the CONTRACT with it:
// which fields become a card, that a failure is a state rather than a blank
// section, and that the retry is a real re-read.
/** A read the test resolves by hand, so "in flight" is observable at all. */
let pendingMarket
marketAnswer = () => new Promise((resolve) => { pendingMarket = resolve })
const beforeCards = marketCalls
await openSkills()
// The read is in flight: the section says so rather than rendering an empty
// grid, because "nothing matched" and "not answered yet" look nothing alike.
eq('an unanswered marketplace says it is being read', text('[data-wui="skillMarketNote"]'), zh['skill.market.loading'])
eq('and shows no count it does not have yet', $$('[data-wui="skillMarketHeading"] span').length, 0)
eq('the read ran once for this open', marketCalls, beforeCards + 1)
await act(async () => {
  pendingMarket({
    ok: true,
    data: {
      items: [
        { namespace: 'fde', slug: 'order-rework', displayName: '订单中心重构', summary: '把订单中心拆成两个服务。', latestVersion: '1.2.0', assetOwnership: 'PUBLIC' },
        { namespace: 'fde', slug: 'my-draft', displayName: '我的草稿技能', summary: '', latestVersion: '0.1.0', assetOwnership: 'PRIVATE' },
      ],
      total: 7,
      verifiedEmail: 'li.yh9@asiainfo-sec.com',
    },
  })
})
eq('the heading counts the SERVER\'s total, not the returned slice',
  text('[data-wui="skillMarketHeading"] span'), '7')
eq('one card per item, in the server\'s order',
  JSON.stringify($$('[data-wui="skillMarketCard"] [data-wui="skillName"]').map(el => el.textContent.trim())),
  JSON.stringify(['订单中心重构', '我的草稿技能']))
eq('a card is titled with the display name and bodied with the summary',
  text('[data-wui="skillMarketGrid"] [data-wui="skillDescription"]'), '把订单中心拆成两个服务。')
// An empty summary is a fact about a skill, not a gap to fill with a placeholder.
eq('a skill with no summary renders no body line', $$('[data-wui="skillMarketCard"] [data-wui="skillDescription"]').length, 1)
eq('a PRIVATE asset is labelled as one',
  JSON.stringify($$('[data-wui="skillMarketCard"] [data-wui="skillTag"]').map(el => el.textContent.trim())),
  JSON.stringify([zh['skill.tag.personal']]))
eq('and only that one is',
  $('[data-wui="skillMarketCard"] [data-wui="skillName"]').textContent.trim(), '订单中心重构')

// Every code the host can send has its own sentence. The loop is the point: a
// code with no entry would render a missing key, not a wrong word.
for (const code of ['no-session', 'no-email', 'unauthorized', 'unreachable', 'http-error', 'unreadable', 'host-unmounted']) {
  marketAnswer = () => Promise.resolve({ ok: false, error: { code, message: `detail for ${code}` } })
  await openSkills()
  await settle()
  eq(`a ${code} failure reads as its own sentence`,
    text('[data-wui="skillFailure"] p'),
    zh[`skill.error.${code}`].replace('{message}', `detail for ${code}`))
}

// A failure does not blank the section it belongs to, and does not touch the one
// above it: the installed block is this plugin's own data and cannot be taken
// down by SkillHub being unreachable.
eq('a failed read leaves no stale cards', $$('[data-wui="skillMarketCard"]').length, 0)
eq('nor a count', $$('[data-wui="skillMarketHeading"] span').length, 0)
eq('the section heading survives the failure', text('[data-wui="skillMarketHeading"] h3'), zh['skill.market'])
eq('and the installed block is untouched',
  text('[data-wui="skillInstalledHeading"] h3'), zh['skill.installed'])

// The retry is a real re-read, not a re-render.
marketAnswer = () => Promise.resolve({
  ok: true,
  data: {
    items: [{ namespace: 'fde', slug: 'only', displayName: '唯一的技能', summary: '回来了。', latestVersion: '1.0.0', assetOwnership: 'PUBLIC' }],
    total: 1,
    verifiedEmail: 'li.yh9@asiainfo-sec.com',
  },
})
const beforeRetry = marketCalls
await click('[data-wui="skillFailure"] button')
eq('the retry asks the host again', marketCalls, beforeRetry + 1)
await settle()
eq('and renders what came back', text('[data-wui="skillMarketCard"] [data-wui="skillName"]'), '唯一的技能')
eq('with the failure gone', $$('[data-wui="skillFailure"]').length, 0)

// A rejected promise is the GUI's OWN host being gone, which the face reports
// with the same vocabulary as every domain failure.
marketAnswer = () => Promise.reject(new Error('Failed to fetch'))
const beforeReopen = marketCalls
await openSkills()
eq('re-opening the modal reads again', marketCalls, beforeReopen + 1)
await settle()
eq('a host that cannot be reached is reported as the host, not the network',
  text('[data-wui="skillFailure"] p'),
  zh['skill.error.host-unmounted'].replace('{message}', 'Failed to fetch'))
eq('with no cards behind it', $$('[data-wui="skillMarketCard"]').length, 0)

// Escape belongs to the modal while it is up, exactly as for Plugins.
await press('Escape')
eq('Escape closes the skills modal', $$('[data-stub="Modal"]').length, 0)
eq('and leaves the drawer open behind it', $('[data-wui="accountDrawer"]').getAttribute('data-open'), 'true')

// ── 2e. the client's own transport arms, driven through the REAL api ─────
// Everything above mocks the face method, so the layer that decides whether the
// DSH host answered AT ALL has no coverage there — and that layer is where a
// reader's sentence comes from. It is exercised here with a stubbed global
// `fetch`, because the failure it must distinguish is a real one: a host half
// that was rebuilt but not restarted answers the SPA's HTML for a route it does
// not know, which is NOT a network problem and must not be explained as one.
const realFetch = globalThis.fetch
const answerWith = (body, status = 200) => {
  globalThis.fetch = async () => ({ status, text: async () => body })
}
const SPA_FALLBACK = '<!doctype html><html><head></head><body></body></html>'

answerWith(SPA_FALLBACK)
const unmounted = await searchMarketSkills()
eq('a route the host does not know is reported as an unmounted host', unmounted.ok, false)
eq('with its own code, not the network one', unmounted.error.code, 'host-unmounted')
// The distinction is the whole point: this failure's fix is a RESTART, and the
// reader must not be sent to check a VPN for it.
eq('and a sentence that does NOT blame the network',
  zh[`skill.error.${unmounted.error.code}`].includes('VPN'), false)
ok('naming the rebuild-and-restart instead',
  zh[`skill.error.${unmounted.error.code}`].includes('重启'), zh[`skill.error.${unmounted.error.code}`])
ok('while keeping the host\'s own words as the detail',
  unmounted.error.message.includes('page instead of JSON'), unmounted.error.message)

globalThis.fetch = async () => { throw new Error('Failed to fetch') }
const hostGone = await searchMarketSkills()
eq('a host that cannot be reached is the same code', hostGone.error.code, 'host-unmounted')
ok('with the transport reason attached', hostGone.error.message.includes('Failed to fetch'), hostGone.error.message)

answerWith(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'SkillHub refused the token' } }))
const refused = await searchMarketSkills()
eq('a domain failure passes its code through untouched', refused.error.code, 'unauthorized')
eq('and the host\'s sentence with it', refused.error.message, 'SkillHub refused the token')

answerWith(JSON.stringify({ ok: true, data: { items: [
  { namespace: 'ywaqtest', slug: 'jcbfai7e', displayName: '命名空间测试', summary: '命名空间测试', latestVersion: '2.0.3', assetOwnership: 'PUBLIC' },
  { namespace: 'global', slug: 'only-a-slug', summary: '', latestVersion: '2.0.3', assetOwnership: 'PERSONAL' },
], total: 2, verifiedEmail: 'li.yh9@asiainfo-sec.com' } }))
const real = await searchMarketSkills()
eq('a real answer is mapped', real.ok, true)
eq('the display name is the title', real.data.items[0].displayName, '命名空间测试')
eq('and the slug is the fallback when there is none', real.data.items[1].displayName, 'only-a-slug')
eq('an unknown ownership reads as PUBLIC, the quieter label', real.data.items[1].assetOwnership, 'PUBLIC')
eq('the server total travels', real.data.total, 2)
eq('and so does the identity the list was read as', real.data.verifiedEmail, 'li.yh9@asiainfo-sec.com')

answerWith('not json at all')
eq('a body that is not JSON is unreadable', (await searchMarketSkills()).error.code, 'unreadable')
answerWith(JSON.stringify({ ok: true }))
eq('a success without data is unreadable', (await searchMarketSkills()).error.code, 'unreadable')
answerWith('null')
eq('an empty envelope is unreadable', (await searchMarketSkills()).error.code, 'unreadable')

// The two halves wired together: the dialog, the real api, and a host answer.
answerWith(JSON.stringify({ ok: true, data: { items: [
  { namespace: 'ywaqtest', slug: 'jcbfai7e', displayName: '命名空间测试', summary: '命名空间测试', latestVersion: '2.0.3', assetOwnership: 'PUBLIC' },
], total: 2, verifiedEmail: 'li.yh9@asiainfo-sec.com' } }))
await render({ listMarketSkills: searchMarketSkills })
await openSkills()
await settle()
eq('the dialog renders what the real api read',
  text('[data-wui="skillMarketCard"] [data-wui="skillName"]'), '命名空间测试')
eq('with the identity line from the same answer',
  text('[data-wui="skillMarketIdentity"]'), zh['skill.market.identity'].replace('{email}', 'li.yh9@asiainfo-sec.com'))
globalThis.fetch = realFetch
await render()

// ── 2f. the skills modal's search: two consumers, one box ────────────────
// The installed block filters what it already has, instantly and locally; the
// marketplace re-asks SkillHub, because it holds a PAGE and a local filter would
// silently miss every match past it. Both halves are asserted here, and so is the
// one thing that makes the market half safe to type into: an answer for an OLDER
// term must not land on a newer one.
const typeInSearch = async (value) => {
  const field = $('[data-wui="skillSearchField"] input')
  await act(async () => {
    // React reads `value` through its own tracker, so the setter has to be the one
    // the DOM defines — assigning `field.value` directly is swallowed.
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    setter.call(field, value)
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}

const SEARCH_SCAN = {
  ok: true,
  data: {
    personal: [
      { name: 'test-design-case-generator', description: '根据需求文档生成测试用例。', version: '2.0.3', source: 'user-dsh', scope: 'personal', market: { namespace: 'ywaqtest', slug: 'jcbfai7e', version: '2.0.3', installedAt: 'x' } },
      { name: 'hand-copied', description: '手工拷进来的，没有来源记录。', version: undefined, source: 'user-dsh', scope: 'personal', market: undefined },
    ],
    shared: [
      { name: 'project-skill', description: '项目自带的。', version: undefined, source: 'project-dsh', scope: 'public', market: undefined },
      { name: 'k8s-ops', description: 'Kubernetes 集群运维、部署和故障排查。', version: undefined, source: 'user-agents', scope: 'public', market: undefined },
    ],
    roots: [{ source: 'user-dsh', path: '/home/operator/.dsh/skills', exists: true, count: 4 }],
  },
}
/** What the market answers per term, and every term it was asked for. */
const marketAsked = []
marketAnswer = (term) => {
  marketAsked.push(term ?? null)
  return Promise.resolve({ ok: true, data: { items: [
    { namespace: 'ywaqtest', slug: 'jcbfai7e', displayName: '命名空间测试', summary: '命名空间测试。', latestVersion: '2.0.3', assetOwnership: 'PUBLIC' },
  ], total: 1, verifiedEmail: 'li.yh9@asiainfo-sec.com' } })
}
installedAnswer = () => Promise.resolve(SEARCH_SCAN)
await mountDialog()

eq('the search row is the plugins modal\'s own control',
  $('[data-wui="skillSearchField"] input')?.getAttribute('placeholder'), zh['skill.search'])
eq('and it caps the term the way the route does',
  $('[data-wui="skillSearchField"] input').getAttribute('maxlength'), '100')
eq('with every installed skill shown before anyone types', $$('[data-wui="skillCard"]').length, 2)
eq('and the count saying so', text('[data-wui="skillInstalledHeading"] span'), '4')

// The installed block answers on the keystroke: no request, no waiting. The active
// tab is 公共, whose skills are project-skill and k8s-ops — so a term that appears
// only in a DESCRIPTION proves the description is searched too.
const beforeTypingCount = marketAsked.length
await typeInSearch('集群')
eq('the installed list matches a DESCRIPTION, not just a name',
  JSON.stringify(gridNames('[data-wui="skillGrid"]')), JSON.stringify(['k8s-ops']))
eq('and the count follows the filter', text('[data-wui="skillInstalledHeading"] span'), '1')
eq('while no request goes out for the local half yet', marketAsked.length, beforeTypingCount)
// The market half waits for the typing to settle.
eq('the marketplace is not asked on the keystroke', marketAsked.length, beforeTypingCount)
eq('and says what it is doing',
  text('[data-wui="skillMarketNote"]'), zh['skill.market.searching'])

// Let the debounce elapse, and the market read happens once, with the term.
await act(async () => { await new Promise(resolve => { setTimeout(resolve, 600) }) })
eq('after the debounce the marketplace is asked exactly once', marketAsked.length, beforeTypingCount + 1)
eq('with the term the reader typed', marketAsked.at(-1), '集群')

// The other tab filters too, and by the same rule.
await click('[data-wui="skillTabs"] [data-wui="skillTab"]:nth-child(2)')
await typeInSearch('用例')
eq('the personal tab matches a description as well',
  JSON.stringify(gridNames('[data-wui="skillGrid"]')), JSON.stringify(['test-design-case-generator']))
await typeInSearch('手工')
eq('and narrows further on a different term',
  JSON.stringify(gridNames('[data-wui="skillGrid"]')), JSON.stringify(['hand-copied']))
await click('[data-wui="skillTabs"] [data-wui="skillTab"]:nth-child(1)')

// A term nobody matches: the installed block must NOT claim the machine is empty.
await typeInSearch('zzz-nothing-matches')
await act(async () => { await new Promise(resolve => { setTimeout(resolve, 600) }) })
eq('a term that matches no installed skill says so', text('[data-wui="skillNote"]'), zh['skill.noMatch'])
eq('rather than claiming nothing is installed', text('[data-wui="skillNote"]') === zh['skill.empty.public'], false)
eq('and the count reads zero, not the machine\'s total', text('[data-wui="skillInstalledHeading"] span'), '0')

// Clearing restores both halves, and asks the market for the whole catalogue again.
await typeInSearch('')
await act(async () => { await new Promise(resolve => { setTimeout(resolve, 600) }) })
// In the order the HOST reported it (its own rank order), not the alphabet: the
// plugin renders what the scan said rather than re-sorting it.
eq('clearing restores the installed list',
  JSON.stringify(gridNames('[data-wui="skillGrid"]')), JSON.stringify(['project-skill', 'k8s-ops']))
eq('and the market is asked with NO term', marketAsked.at(-1), null)

// The staleness guard: a slow answer for an older term must not replace a newer
// one. Both reads are in flight at once, and the OLD one answers LAST.
let resolveOld
marketAnswer = (term) => {
  marketAsked.push(term ?? null)
  if (term === 'aaa') return new Promise(resolve => { resolveOld = resolve })
  return Promise.resolve({ ok: true, data: { items: [
    { namespace: 'n', slug: 'newer', displayName: '新查询的结果', summary: '新的。', latestVersion: '1', assetOwnership: 'PUBLIC' },
  ], total: 1, verifiedEmail: 'li.yh9@asiainfo-sec.com' } })
}
await typeInSearch('aaa')
await act(async () => { await new Promise(resolve => { setTimeout(resolve, 600) }) })
await typeInSearch('bbb')
await act(async () => { await new Promise(resolve => { setTimeout(resolve, 600) }) })
eq('the newer term rendered its own result', text('[data-wui="skillMarketCard"] [data-wui="skillName"]'), '新查询的结果')
await act(async () => {
  resolveOld({ ok: true, data: { items: [
    { namespace: 'n', slug: 'older', displayName: '旧查询的迟到结果', summary: '旧的。', latestVersion: '1', assetOwnership: 'PUBLIC' },
  ], total: 1, verifiedEmail: 'li.yh9@asiainfo-sec.com' } })
})
eq('and an older answer arriving late does not replace it',
  text('[data-wui="skillMarketCard"] [data-wui="skillName"]'), '新查询的结果')

// A failed SEARCH leaves the other half alone.
marketAnswer = (term) => {
  marketAsked.push(term ?? null)
  return Promise.resolve({ ok: false, error: { code: 'unreachable', message: 'search failed' } })
}
await typeInSearch('k8s')
await act(async () => { await new Promise(resolve => { setTimeout(resolve, 600) }) })
eq('a failed search is reported in the market section',
  text('[data-wui="skillFailure"] p'), zh['skill.error.unreachable'].replace('{message}', 'search failed'))
eq('and the installed filter still answers',
  JSON.stringify(gridNames('[data-wui="skillGrid"]')), JSON.stringify(['k8s-ops']))
eq('with its count', text('[data-wui="skillInstalledHeading"] span'), '1')

marketAnswer = () => Promise.resolve({ ok: true, data: { items: [], total: 0, verifiedEmail: '' } })
installedAnswer = () => Promise.resolve(EMPTY_SCAN)

// Back to the dock, with its drawer open, which is where the sections below pick up.
await render()
await click('[data-wui="accountRow"]')

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
eq('the kept surface is still a modal, not an inline block', $$('[data-stub="Modal"]').length, 1)
eq('the modal is titled like the settings page', text('[data-stub="ModalTitle"]'), zh['plugin.title'])
eq('and it explains what it is showing', text('[data-stub="ModalDescription"]'), zh['plugin.intro'])
eq('the drawer stays open behind the modal', $('[data-wui="accountDrawer"]').getAttribute('data-open'), 'true')
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

// Escape closes the kept modal itself. The drawer-stands-down half of this
// contract — Escape and outside pointerdowns belonging to the modal while it is
// up — is asserted in §3 through the 技能 modal, which still has a row: the dock
// stands down for a modal it knows about, and it can no longer know about this one.
await press('Escape')
eq('Escape closes the modal', $$('[data-stub="Modal"]').length, 0)

await openPlugins()
await press('Escape')
eq('the modal closes again', $$('[data-stub="Modal"]').length, 0)

// ── 4. closing ───────────────────────────────────────────────────────────
await press('Escape')
eq('Escape closes the drawer', $('[data-wui="accountDrawer"]').getAttribute('data-open'), null)

await click('[data-wui="accountRow"]')
eq('it reopens', $('[data-wui="accountDrawer"]').getAttribute('data-open'), 'true')

// The SHIPPED settings panel is a full-viewport layer too, and it PORTALS to the
// page body (see dsh-client-ui-settings-general) — so every click in it is
// "outside" this drawer's root. What keeps the drawer in place is the rule that
// reads the PAGE for a live dialog rather than a list of this plugin's own flags.
await click('[data-seat="settings"]')
eq('the settings row opens the shipped panel', $$('[data-seat="settings-panel"]').length, 1)
await outsidePointerDown()
eq('a pointerdown while that panel is up does not close the drawer',
  $('[data-wui="accountDrawer"]').getAttribute('data-open'), 'true')
eq('the panel is still up after that pointerdown', $$('[data-seat="settings-panel"]').length, 1)
if ($('[data-seat="settings-close"]') !== null) await click('[data-seat="settings-close"]')
eq('and closing the panel still leaves the drawer open',
  $('[data-wui="accountDrawer"]').getAttribute('data-open'), 'true')

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

// ── 7. the installed block, driven by the SCAN ───────────────────────────
// The installed list is a read of this host now, so what this section pins is the
// contract with it: which root a skill came from decides its tab and its label,
// the two tabs split one answer, and the marketplace's cards know what is already
// installed from the same answer rather than from a name that would never match.
const SCAN = {
  ok: true,
  data: {
    personal: [
      {
        name: 'fixture-skill', description: '一个从市场装下来的技能。', version: '2.0.3',
        source: 'user-dsh', scope: 'personal',
        market: { namespace: 'ywaqtest', slug: 'jcbfai7e', version: '2.0.3', installedAt: '2026-09-16T07:00:00.000Z' },
      },
      {
        name: 'hand-copied', description: '手工拷进来的，没有来源记录。', version: undefined,
        source: 'user-dsh', scope: 'personal', market: undefined,
      },
    ],
    shared: [
      { name: 'project-skill', description: '项目自带的。', version: undefined, source: 'project-dsh', scope: 'public', market: undefined },
      { name: 'linked-skill', description: '共享根里的。', version: undefined, source: 'user-agents', scope: 'public', market: undefined },
    ],
    roots: [
      { source: 'project-dsh', path: '/work/app/.dsh/skills', exists: true, count: 1 },
      { source: 'project-agents', path: '/work/app/.agents/skills', exists: false, count: 0 },
      { source: 'user-dsh', path: '/home/operator/.dsh/skills', exists: true, count: 2 },
      { source: 'user-agents', path: '/home/operator/.agents/skills', exists: true, count: 1 },
    ],
  },
}
installedAnswer = () => Promise.resolve(SCAN)
marketAnswer = () => Promise.resolve({
  ok: true,
  data: {
    items: [
      { namespace: 'ywaqtest', slug: 'jcbfai7e', displayName: '命名空间测试', summary: '已经装过的那一个。', latestVersion: '2.0.3', assetOwnership: 'PUBLIC' },
      { namespace: 'ywaqtest', slug: 'brand-new', displayName: '还没装的', summary: '一个可以安装的技能。', latestVersion: '1.0.0', assetOwnership: 'PUBLIC' },
    ],
    total: 2,
    verifiedEmail: 'li.yh9@asiainfo-sec.com',
  },
})
// Restored after the real-catalogue case above, which replaces this answer.
const MARKET_FIXTURE = marketAnswer
const installedBefore = installedCalls
await mountDialog()

eq('the installed heading counts both tabs', text('[data-wui="skillInstalledHeading"] span'), '4')
eq('the public tab lists the shared roots, in the order the host reported',
  JSON.stringify(gridNames('[data-wui="skillGrid"]')), JSON.stringify(['project-skill', 'linked-skill']))
eq('a shared card is labelled with the root it came from',
  JSON.stringify($$('[data-wui="skillGrid"] [data-wui="skillTag"]').map(el => el.textContent.trim())),
  JSON.stringify([zh['skill.tag.project'], zh['skill.tag.agents']]))
eq('and carries the description its SKILL.md declares',
  text('[data-wui="skillGrid"] [data-wui="skillDescription"]'), '项目自带的。')
eq('the roots the scan looked in are named',
  text('[data-wui="skillRoots"]'), zh['skill.installed.roots'].replace('{n}', '4').replace('{paths}',
    '/work/app/.dsh/skills · /work/app/.agents/skills · /home/operator/.dsh/skills · /home/operator/.agents/skills'))
eq('the scan ran once for this open', installedCalls, installedBefore + 1)

await click('[data-wui="skillTabs"] [data-wui="skillTab"]:nth-child(2)')
eq('the personal tab lists what the marketplace installed',
  JSON.stringify(gridNames('[data-wui="skillGrid"]')), JSON.stringify(['fixture-skill', 'hand-copied']))
// A root label in the personal tab would only repeat the tab's own name, so that
// tab labels the VERSION instead — and says nothing for a hand-copied skill.
eq('a marketplace install is labelled with its version',
  JSON.stringify($$('[data-wui="skillGrid"] [data-wui="skillTag"]').map(el => el.textContent.trim())),
  JSON.stringify(['v2.0.3']))

// The install action, and the state it is in before anyone touches it.
await click('[data-wui="skillTabs"] [data-wui="skillTab"]:nth-child(1)')
const cards = $$('[data-wui="skillMarketCard"]')
eq('every marketplace card carries an action row', $$('[data-wui="skillMarketCard"] [data-wui="skillCardActions"]').length, 2)
eq('the card for an installed asset shows 已安装 rather than a button',
  cards[0].querySelector('[data-wui="skillInstallDone"]')?.textContent, zh['skill.install.done'])
eq('and offers nothing to press', cards[0].querySelector('[data-wui="skillInstallButton"]'), null)
eq('a card that is not installed offers the install button',
  cards[1].querySelector('[data-wui="skillInstallButton"]')?.textContent, zh['skill.install'])
eq('with an accessible name naming the skill',
  cards[1].querySelector('[data-wui="skillInstallButton"]').getAttribute('aria-label'),
  zh['skill.install.aria'].replace('{name}', '还没装的'))

// Installing: the button becomes a state while the host works.
let resolveInstall
installAnswer = () => new Promise(resolve => { resolveInstall = resolve })
const installButtons = () => $$('[data-wui="skillInstallButton"]')
await click('[data-wui="skillMarketCard"]:nth-of-type(2) [data-wui="skillInstallButton"]')
eq('installing asks the host once', installCalls, 1)
eq('and the card reports it is working',
  $('[data-wui="skillMarketCard"]:nth-of-type(2) [data-wui="skillInstallBusy"]')?.textContent,
  zh['skill.install.busy'])
eq('with nothing left to press on that card',
  $('[data-wui="skillMarketCard"]:nth-of-type(2) [data-wui="skillInstallButton"]'), null)
eq('while the other card is untouched', cards[0].querySelector('[data-wui="skillInstallDone"]')?.textContent, zh['skill.install.done'])

// The host answers, and the installed list is re-read — because the only authority
// on what is on disk is the scan, not a flag this component set.
const installedBeforeInstall = installedCalls
await act(async () => {
  resolveInstall({
    ok: true,
    data: { name: 'brand-new', directory: '/home/operator/.dsh/skills/brand-new', files: 4, bytes: 99, version: '1.0.0' },
  })
})
await settle()
eq('a successful install re-reads what is installed', installedCalls, installedBeforeInstall + 1)
eq('and the card settles on 已安装',
  $('[data-wui="skillMarketCard"]:nth-of-type(2) [data-wui="skillInstallDone"]')?.textContent,
  zh['skill.install.done'])

// What a card says, in the case the REAL catalogue is entirely made of: an asset
// whose SkillHub `summary` is a copy of its display name. A description that just
// repeats the title reads as a card with no description — which is how this was
// reported — so the body is empty and the card's identity line carries the facts
// instead. The assets this deployment's label=FDE catalogue holds are both like
// this (`命名空间测试`, `权限测试`).
marketAnswer = () => Promise.resolve({
  ok: true,
  data: {
    items: [
      { namespace: 'ywaqtest', slug: 'jcbfai7e', displayName: '命名空间测试', summary: '命名空间测试', latestVersion: '2.0.3', assetOwnership: 'PUBLIC' },
      { namespace: 'ywaqtest', slug: 'brand-new', displayName: '还没装的', summary: '还没装的', latestVersion: '1.0.0', assetOwnership: 'PUBLIC' },
    ],
    total: 2,
    verifiedEmail: 'li.yh9@asiainfo-sec.com',
  },
})
installedAnswer = () => Promise.resolve({
  ok: true,
  data: {
    personal: [
      {
        name: 'test-design-case-generator',
        // The package's OWN description, which the scan read from its SKILL.md and
        // which says what the skill does — the thing the marketplace's summary did
        // not.
        description: '根据需求文档生成测试用例，支持 Markdown 源文件输出，并可自动转换为 FreeMind、Excel 等其他格式。',
        version: '2.0.3', source: 'user-dsh', scope: 'personal',
        market: { namespace: 'ywaqtest', slug: 'jcbfai7e', version: '2.0.3', installedAt: '2026-09-16T08:30:00.000Z' },
      },
    ],
    shared: [],
    roots: [{ source: 'user-dsh', path: '/home/operator/.dsh/skills', exists: true, count: 1 }],
  },
})
await mountDialog()
const realCards = $$('[data-wui="skillMarketCard"]')
// Card 0 is installed here and card 1 is not, and they take the two different
// routes through the decision above — which is the whole point of the fixture.
eq('the installed card is described by its package, not by the repeating summary',
  realCards[0].querySelector('[data-wui="skillDescription"]') !== null, true)
eq('while the uninstalled one renders NO description rather than echoing its title',
  realCards[1].querySelectorAll('[data-wui="skillDescription"]').length, 0)
eq('an installed asset is described by its PACKAGE, not by SkillHub\'s stub',
  realCards[0].querySelector('[data-wui="skillDescription"]')?.textContent,
  '根据需求文档生成测试用例，支持 Markdown 源文件输出，并可自动转换为 FreeMind、Excel 等其他格式。')
eq('the identity line names the asset by namespace and slug',
  realCards[0].querySelector('[data-wui="skillMeta"]')?.textContent, 'ywaqtest/jcbfai7e · v2.0.3')
eq('and the version the marketplace would install',
  realCards[1].querySelector('[data-wui="skillMeta"]')?.textContent, 'ywaqtest/brand-new · v1.0.0')
eq('a card with no description still says what it is',
  realCards[1].querySelectorAll('[data-wui="skillDescription"]').length, 0)
eq('every card carries an identity line', $$('[data-wui="skillMarketCard"] [data-wui="skillMeta"]').length, 2)
// A summary that says something NEW still wins over the identity line's silence.
marketAnswer = () => Promise.resolve({
  ok: true,
  data: {
    items: [{ namespace: 'fde', slug: 'k8s-ops', displayName: 'k8s-ops', summary: 'Kubernetes 集群运维、部署和故障排查。', latestVersion: '20260805.022120', assetOwnership: 'PUBLIC' }],
    total: 1,
    verifiedEmail: 'li.yh9@asiainfo-sec.com',
  },
})
installedAnswer = () => Promise.resolve(EMPTY_SCAN)
await mountDialog()
eq('a real summary is the card body', text('[data-wui="skillMarketCard"] [data-wui="skillDescription"]'),
  'Kubernetes 集群运维、部署和故障排查。')

// Back to the two-item fixture the sections below were written against.
installedAnswer = () => Promise.resolve(SCAN)
marketAnswer = MARKET_FIXTURE
await mountDialog()

// A refused install is a sentence IN the card it belongs to, with a retry.
installAnswer = () => Promise.resolve({ ok: false, error: { code: 'unsafe-archive', message: 'entry "../evil" escapes the target directory' } })
await click('[data-wui="skillMarketCard"]:nth-of-type(2) [data-wui="skillInstallButton"]')
await settle()
eq('a failed install is explained in its own card',
  $('[data-wui="skillMarketCard"]:nth-of-type(2) [data-wui="skillInstallError"]')?.textContent,
  zh['skill.error.unsafe-archive'].replace('{message}', 'entry "../evil" escapes the target directory'))
eq('and the card offers a retry rather than the original words',
  $('[data-wui="skillMarketCard"]:nth-of-type(2) [data-wui="skillInstallButton"]')?.textContent,
  zh['skill.install.retry'])
eq('a failed install changed nothing installed', $$('[data-wui="skillInstallDone"]').length, 1)

// The retry is a real second attempt, and the refusal a reader meets most often
// (the asset is already there) is rendered as a STATE, not as an error.
installAnswer = () => Promise.resolve({ ok: false, error: { code: 'already-installed', message: '`brand-new` is already installed in /home/operator/.dsh/skills/brand-new' } })
const beforeInstallRetry = installCalls
await click('[data-wui="skillMarketCard"]:nth-of-type(2) [data-wui="skillInstallButton"]')
await settle()
eq('the retry asks the host again', installCalls, beforeInstallRetry + 1)
eq('an already-installed answer is a state with its own sentence',
  $('[data-wui="skillMarketCard"]:nth-of-type(2) [data-wui="skillInstallError"]')?.textContent,
  zh['skill.error.already-installed'].replace('{message}', '`brand-new` is already installed in /home/operator/.dsh/skills/brand-new'))
eq('and still nothing was written', $$('[data-wui="skillInstallDone"]').length, 1)

// A scan that fails takes the installed block down and leaves the market alone:
// two reads, two states, and one of them cannot take the other with it.
installedAnswer = () => Promise.resolve({ ok: false, error: { code: 'install-failed', message: 'could not read /home/operator/.dsh/skills: EACCES' } })
marketAnswer = () => Promise.resolve({
  ok: true,
  data: { items: [{ namespace: 'n', slug: 's', displayName: '市场还在', summary: '', latestVersion: '1', assetOwnership: 'PUBLIC' }], total: 1, verifiedEmail: 'li.yh9@asiainfo-sec.com' },
})
await mountDialog()
eq('a failed scan is reported in the installed block',
  text('[data-wui="skillInstalledHeading"] + [data-wui="skillTabs"] ~ [data-wui="skillPane"] [data-wui="skillFailure"] p')
  ?? text('[data-wui="skillPane"] [data-wui="skillFailure"] p'),
  zh['skill.error.install-failed'].replace('{message}', 'could not read /home/operator/.dsh/skills: EACCES'))
eq('and the marketplace still renders', text('[data-wui="skillMarketCard"] [data-wui="skillName"]'), '市场还在')
eq('with its install button intact', $('[data-wui="skillInstallButton"]')?.textContent, zh['skill.install'])
// With no scan answer there is no count and no 已安装 claim to make.
eq('no count is shown without a scan', $$('[data-wui="skillInstalledHeading"] span').length, 0)
eq('and the market does not claim anything is installed', $$('[data-wui="skillInstallDone"]').length, 0)

installedAnswer = () => Promise.resolve(SCAN)
marketAnswer = () => Promise.resolve({ ok: true, data: { items: [], total: 0, verifiedEmail: '' } })

// ── report ───────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`account-dock: ${failures.length}/${checks} checks FAILED`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log(`account-dock: ${checks} checks passed`)
