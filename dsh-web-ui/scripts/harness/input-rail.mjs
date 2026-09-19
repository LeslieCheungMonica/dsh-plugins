/**
 * Offline harness for the input-anchor rail in the conversation column's left
 * edge: the ticks that mark the user's own inputs, the preview that expands on
 * hover, the jump, and the current-position marker.
 *
 * What is under test is a MAPPING and a JUMP, and both have failure modes that a
 * screenshot cannot tell apart from success:
 *
 * 1. **The mapping.** A tick's vertical position must come from the row's offset
 *    in the loaded content, so the rail is a picture of the conversation rather
 *    than an evenly spaced legend. The harness lays out a fake transcript with
 *    explicit geometry (jsdom reports zeros, so every box is stated) and asserts
 *    the arithmetic independently of the DOM — a rail that spaced ticks evenly
 *    would still look plausible.
 * 2. **The jump.** Clicking a tick must put that input at the top of the
 *    scrollport using the SAME arithmetic `ChatView` uses to restore a reader
 *    position (`scrollTop += flowTop(row, el) - anchorTop`), because two
 *    disagreeing conventions would make the rail and the paging anchor fight.
 *
 * The anchors are the rows ui-conversation marks with `data-chat-flow-kind`:
 * `user` (turn-opening) and `steering` (admitted mid-turn) are what a person
 * typed; `context` is injected history and must NOT become a tick.
 *
 * Usage: pnpm harness:input-rail   (builds the bundle first, then runs this)
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

const { collectAnchors, tickPositions, activeAnchorIndex, previewLine } = await import('./out/input-rail.js')

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
const deep = (label, actual, expected) => {
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

// ── the fake transcript ───────────────────────────────────────────────────
/** A box the component may measure; jsdom answers every real box with zeros. */
const box = (element, { top, height = 40 }) => {
  element.getBoundingClientRect = () => ({
    top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top,
    toJSON: () => ({}),
  })
  return element
}

/**
 * Build a conversation scrollport holding one column of node rows.
 *
 * `scrollTop` is a real accessor because jsdom's own is inert: the jump under
 * test is a write to it, and a read-back after a programmatic scroll is exactly
 * what a broken implementation would get away with otherwise.
 *
 * @param options - the rows to lay out (kind, text, contentOffset) and the
 *   scrollport's own geometry.
 * @returns the scrollport element, its column, and the row elements by kind.
 */
function transcript({ rows, scrollHeight = 1000, clientHeight = 400, scrollTop = 0 }) {
  const scrollport = document.createElement('div')
  scrollport.setAttribute('data-conversation-scroll', '')
  const column = document.createElement('div')
  column.setAttribute('data-chat-flow', '')
  scrollport.append(column)
  let top = scrollTop
  Object.defineProperty(scrollport, 'scrollTop', {
    get: () => top,
    set: (value) => { top = value },
    configurable: true,
  })
  Object.defineProperty(scrollport, 'scrollHeight', { get: () => scrollHeight, configurable: true })
  Object.defineProperty(scrollport, 'clientHeight', { get: () => clientHeight, configurable: true })
  box(scrollport, { top: 0, height: clientHeight })
  const elements = rows.map((row) => {
    const element = document.createElement('div')
    element.setAttribute('data-chat-anchor-key', row.key)
    element.setAttribute('data-chat-flow-key', row.key)
    element.setAttribute('data-chat-flow-kind', row.kind)
    element.textContent = row.text
    // Rows are positioned in VIEWPORT coordinates: what is on screen moves up as
    // the reader scrolls, while the content offset the rail maps does not.
    box(element, { top: row.top - scrollTop, height: row.height ?? 40 })
    column.append(element)
    return element
  })
  document.body.append(scrollport)
  return { scrollport, column, elements }
}

const ROWS = [
  { key: 'n1', kind: 'user', text: '第一个问题', top: 100 },
  { key: 'n2', kind: 'assistant', text: '回答', top: 200 },
  { key: 'n3', kind: 'context', text: '注入的上下文', top: 300 },
  { key: 'n4', kind: 'tool-call', text: 'tool', top: 350 },
  { key: 'n5', kind: 'steering', text: '追加要求', top: 400 },
]

// ── the arithmetic, asserted without rendering ────────────────────────────
{
  eq('previewLine keeps the first line',
    previewLine('  第一行  \n第二行\n第三行'), '第一行')
  eq('previewLine collapses a run of whitespace to one space',
    previewLine('一句话   里  的空格'), '一句话 里 的空格')
  eq('previewLine skips leading blank lines',
    previewLine('\n   \n真正的第一行\n第二行'), '真正的第一行')
  eq('previewLine truncates with an ellipsis',
    previewLine('x'.repeat(120)), `${'x'.repeat(80)}…`)
  eq('previewLine of an empty row', previewLine('  \n '), '')
}

{
  const { scrollport } = transcript({ rows: ROWS })
  const anchors = collectAnchors(scrollport)
  eq('only typed inputs become anchors', anchors.length, 2)
  deep('in DOM order, with their kinds', anchors.map(a => [a.key, a.kind]), [['n1', 'user'], ['n5', 'steering']])
  eq('with their preview text', anchors[0].text, '第一个问题')
  eq('and their offset in the loaded content', anchors[1].top, 400)
  scrollport.remove()
}

{
  // A scrolled reader: the same rows report different viewport boxes, so a
  // content offset that ignored `scrollTop` would collapse to the raw box top.
  const { scrollport } = transcript({ rows: ROWS, scrollTop: 250 })
  const anchors = collectAnchors(scrollport)
  eq('a scrolled scrollport still yields content offsets', anchors[0].top, 100)
  scrollport.remove()
}

{
  // The stack is a LIST, not a map: the anchors are grouped and centred, so a
  // reader reaches them in one glance instead of chasing ticks down the rail.
  const geometry = { railHeight: 200, markerHeight: 6, gap: 10, minGap: 3 }
  const positions = tickPositions(3, geometry)
  deep('three anchors stack at the preferred gap', positions, [87, 97, 107])
  eq('the stack is centred in the rail',
    positions[0], geometry.railHeight - (positions.at(-1) + geometry.markerHeight))
  eq('a lone anchor sits in the middle',
    tickPositions(1, geometry)[0], (geometry.railHeight - geometry.markerHeight) / 2)
  deep('no anchors, no ticks', tickPositions(0, geometry), [])
}

{
  // A long loaded window must still fit: the gap shrinks before anything leaves
  // the rail, because a tick outside the rail is a tick nobody can click.
  const geometry = { railHeight: 200, markerHeight: 6, gap: 10, minGap: 3 }
  const fitted = tickPositions(30, geometry)
  eq('a crowded stack shrinks its gap to fit', fitted[1] - fitted[0], 6)
  ok('and stays inside the rail',
    fitted[0] >= 0 && fitted.at(-1) + geometry.markerHeight <= geometry.railHeight,
    `${fitted[0]}..${fitted.at(-1)}`)
  eq('still centred while it shrinks',
    fitted[0], geometry.railHeight - (fitted.at(-1) + geometry.markerHeight))
}

{
  // Past the floor there is nowhere left to shrink to. The stack overflows
  // SYMMETRICALLY and stays centred, which is the one state the rail accepts
  // losing anchors to: an anchor count that far past the rail's height is a
  // loaded window the reader is better off navigating with the preview list.
  const geometry = { railHeight: 200, markerHeight: 6, gap: 10, minGap: 3 }
  const crowded = tickPositions(100, geometry)
  eq('the gap never goes below the floor', crowded[1] - crowded[0], 3)
  ok('and the overflow is symmetric, not piled at one end',
    Math.abs((crowded[0] + crowded.at(-1) + geometry.markerHeight) / 2 - geometry.railHeight / 2) <= 1,
    `${crowded[0]}..${crowded.at(-1)}`)
}

{
  const anchors = [
    { key: 'a', kind: 'user', text: 'a', top: 100 },
    { key: 'b', kind: 'user', text: 'b', top: 500 },
    { key: 'c', kind: 'user', text: 'c', top: 900 },
  ]
  eq('above the first anchor the first one is current',
    activeAnchorIndex(anchors, { scrollTop: 0, viewportHeight: 400 }), 0)
  eq('past an anchor the next one becomes current',
    activeAnchorIndex(anchors, { scrollTop: 400, viewportHeight: 400 }), 1)
  eq('midline decides, not the top edge',
    activeAnchorIndex(anchors, { scrollTop: 550, viewportHeight: 400 }), 1)
  eq('the last anchor is current at the bottom',
    activeAnchorIndex(anchors, { scrollTop: 700, viewportHeight: 400 }), 2)
  eq('no anchors means no current anchor',
    activeAnchorIndex([], { scrollTop: 0, viewportHeight: 400 }), -1)
}

// ── the rail, mounted against a fake transcript ───────────────────────────
const { createElement: h, act, useSyncExternalStore } = await import('react')
const { createRoot } = await import('react-dom/client')
const { InputRail, JUMP_INSET, MARKER_HEIGHT, RAIL_INSET, TICK_GAP } = await import('./out/input-rail.js')
const { zh } = await import('../../src/client/locales.ts')

const fill = (template, params) => template.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? ''))
/** The real dictionary, filled the way the framework fills it. */
const t = (key, params = {}) => {
  const template = zh[key]
  if (template === undefined) throw new Error(`missing locale key ${key}`)
  return fill(template, params)
}

const $ = selector => document.querySelector(selector)
const $$ = selector => [...document.querySelectorAll(selector)]

/** The session list's `current`, as the global seat's hook reports it. */
let sessionState = { current: 's1' }
const sessionListeners = new Set()
const useSessions = selector => useSyncExternalStore(
  listener => { sessionListeners.add(listener); return () => { sessionListeners.delete(listener) } },
  () => selector(sessionState),
  () => selector(sessionState),
)

/**
 * The injected face's per-session rail view, with its reads recorded.
 * @param initial - the paging facts this session starts with.
 * @returns the face, its loadOlder tally, and a publisher for paging changes.
 */
function railFace(initial = {}) {
  const state = { hasMore: false, loadingOlder: false, ...initial }
  const listeners = new Set()
  const calls = { loadOlder: 0 }
  return {
    calls,
    face: {
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      hasMore: () => state.hasMore,
      loadingOlder: () => state.loadingOlder,
      loadOlder: () => { calls.loadOlder += 1 },
    },
    /** Publish a paging change the way the session store would. */
    publish: async (next) => {
      await act(async () => {
        Object.assign(state, next)
        for (const listener of listeners) listener()
      })
    },
  }
}

const root = createRoot(document.getElementById('root'))
/** Mount the rail with one session's rail face. */
const mountRail = async (rails) => {
  await act(async () => {
    root.render(h(InputRail, {
      useSessions,
      t,
      rail: { sessionRail: id => (id === undefined ? undefined : rails.face) },
    }))
  })
}
const unmountRail = async () => { await act(async () => { root.render(null) }) }
const click = async (element) => {
  await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
}
/** Enter or leave the rail the way a pointer does (React derives these from over/out). */
const pointer = async (element, type, from) => {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, relatedTarget: from }))
  })
}
const scrollTo = async (element, top) => {
  await act(async () => {
    element.scrollTop = top
    element.dispatchEvent(new dom.window.Event('scroll'))
  })
}
{
  const { scrollport } = transcript({ rows: ROWS, scrollHeight: 1000, clientHeight: 400 })
  const rails = railFace()
  await mountRail(rails)

  const ticks = $$('[data-wui="railTick"]')
  eq('one tick per typed input', ticks.length, 2)
  deep('with their kinds in reading order', ticks.map(el => el.dataset.kind), ['user', 'steering'])

  const anchors = collectAnchors(scrollport)
  const tops = ticks.map(el => Number.parseFloat(el.style.top))
  ok('ticks are ordered by content offset', tops[0] < tops[1], JSON.stringify(tops))
  // Grouped, not spread: the anchors sit one gap apart whatever their content
  // offsets are, and the stack is centred in the rail's own height.
  eq('the anchors stack at one uniform gap', tops[1] - tops[0], TICK_GAP)
  const railHeight = scrollport.clientHeight - RAIL_INSET * 2
  eq('centred in the rail',
    tops[0] - RAIL_INSET, railHeight - ((tops[1] - RAIL_INSET) + MARKER_HEIGHT))
  ok('no tick is drawn outside the rail',
    tops.every(top => top >= 0 && top + MARKER_HEIGHT <= scrollport.clientHeight), JSON.stringify(tops))
  eq('the first input is current before any scroll', ticks[0].dataset.active, 'true')

  // ── the tip ─────────────────────────────────────────────────────────────
  // The reader is pointing at ONE tick, so the words that answer "which input is
  // this?" belong beside THAT tick — not pinned to the top of the rail, which is
  // where a whole-list preview put them and, on a long conversation, nowhere near
  // the pointer.
  eq('nothing is shown before a tick is hovered', $$('[data-wui="railTip"]').length, 0)
  await pointer(ticks[1], 'mouseover', document.body)
  const tips = $$('[data-wui="railTip"]')
  eq('hovering a tick shows that input alone', tips.length, 1)
  eq('in its own words', tips[0]?.textContent, fill(zh['rail.item.label'], { n: 2, text: '追加要求' }))
  eq('hanging beside the tick it belongs to',
    Number.parseFloat(tips[0]?.style.top ?? ''), Number.parseFloat(ticks[1].style.top) + MARKER_HEIGHT / 2)
  eq('and beside the rail rather than over it', tips[0]?.style.left, '100%')
  await pointer(ticks[1], 'mouseout', document.body)
  eq('leaving the tick hides it', $$('[data-wui="railTip"]').length, 0)
  await pointer(ticks[0], 'mouseover', document.body)
  eq('the other tick answers for itself',
    $('[data-wui="railTip"]')?.textContent, fill(zh['rail.item.label'], { n: 1, text: '第一个问题' }))
  eq('one tip at a time', $$('[data-wui="railTip"]').length, 1)
  await pointer(ticks[0], 'mouseout', document.body)
  await pointer($('[data-wui="railTrack"]'), 'mouseover', document.body)
  eq('hovering the empty strip shows nothing', $$('[data-wui="railTip"]').length, 0)

  // ── the jump ────────────────────────────────────────────────────────────
  await click(ticks[1])
  eq('clicking a tick puts that input at the jump inset',
    scrollport.scrollTop, anchors[1].top - JUMP_INSET)
  eq('and marks it current at once', $$('[data-wui="railTick"]')[1].dataset.active, 'true')

  // ── the current position ────────────────────────────────────────────────
  await scrollTo(scrollport, 0)
  eq('scrolling back makes the first input current again',
    $$('[data-wui="railTick"]')[0].dataset.active, 'true')
  await scrollTo(scrollport, 300)
  eq('scrolling past an input hands the marker to the next one',
    $$('[data-wui="railTick"]')[1].dataset.active, 'true')

  await unmountRail()
  scrollport.remove()
}

{
  // ONE input still gets a tick. The rule used to hide the whole rail below two,
  // and that was wrong on a real conversation: a long agent turn has one prompt
  // under dozens of tool calls, so "jump back to the top of this turn" is exactly
  // the case the rail is for — and hiding it also hid the older-history chevron,
  // which is the only way back to earlier inputs.
  const { scrollport } = transcript({ rows: [ROWS[0]], scrollHeight: 400, clientHeight: 400 })
  const rails = railFace({ hasMore: true })
  await mountRail(rails)
  const single = $$('[data-wui="railTick"]')
  eq('a single input still gets its tick', single.length, 1)
  eq('centred, since there is nothing to space it against',
    Number.parseFloat(single[0]?.style.top ?? ''), RAIL_INSET + (scrollport.clientHeight - RAIL_INSET * 2 - MARKER_HEIGHT) / 2)
  eq('and the way back to earlier inputs is still offered', $$('[data-wui="railOlder"]').length, 1)
  await unmountRail()
  scrollport.remove()
}

{
  // A window with nothing typed in it — the state a long agent turn really
  // reaches, where the tail holds tool calls and assistant steps and the prompt
  // that started them has fallen out of the loaded window. The rail still has a
  // job here: it is where the way BACK lives, so it stays, offering the chevron
  // and no ticks.
  const { scrollport } = transcript({ rows: [ROWS[1], ROWS[2]], scrollHeight: 400, clientHeight: 400 })
  await mountRail(railFace({ hasMore: true }))
  eq('with history still unloaded the rail stays, for the way back',
    $$('[data-wui="inputRail"]').length, 1)
  eq('offering the chevron', $$('[data-wui="railOlder"]').length, 1)
  eq('and no ticks, because nothing in this window was typed',
    $$('[data-wui="railTick"]').length, 0)
  await unmountRail()
  scrollport.remove()
}

{
  // Nothing typed and nothing left to load: the rail would be a bare marker with
  // nothing behind it.
  const { scrollport } = transcript({ rows: [ROWS[1], ROWS[2]], scrollHeight: 400, clientHeight: 400 })
  await mountRail(railFace())
  eq('with no typed input and no more history, no rail',
    $$('[data-wui="inputRail"]').length, 0)
  await unmountRail()
  scrollport.remove()
}

{
  const { scrollport } = transcript({ rows: ROWS })
  sessionState = { current: undefined }
  await mountRail(railFace())
  eq('no current session means no rail', $$('[data-wui="inputRail"]').length, 0)
  sessionState = { current: 's1' }
  await unmountRail()
  scrollport.remove()
}

{
  // Paging: the rail's top entry is the only way it grows backwards.
  const { scrollport } = transcript({ rows: ROWS })
  const rails = railFace()
  await mountRail(rails)
  eq('no older entry while the window is complete', $$('[data-wui="railOlder"]').length, 0)

  await rails.publish({ hasMore: true })
  eq('an older entry appears when history remains', $$('[data-wui="railOlder"]').length, 1)
  await click($('[data-wui="railOlder"]'))
  eq('clicking it loads exactly one page', rails.calls.loadOlder, 1)

  await rails.publish({ loadingOlder: true })
  ok('a page in flight disables the entry', $('[data-wui="railOlder"]').disabled === true)
  await click($('[data-wui="railOlder"]'))
  eq('and a disabled entry loads nothing', rails.calls.loadOlder, 1)

  await rails.publish({ hasMore: false, loadingOlder: false })
  eq('the entry goes away with the last page', $$('[data-wui="railOlder"]').length, 0)

  await unmountRail()
  scrollport.remove()
}

// ── report ───────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`input-rail: ${failures.length}/${checks} checks FAILED`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log(`input-rail: ${checks} checks passed`)
