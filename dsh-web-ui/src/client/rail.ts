/**
 * The input-anchor rail's arithmetic: what counts as an anchor, where its tick
 * sits, and which anchor is the one being read.
 *
 * Everything here is pure and DOM-only — no React, no cordis — because the two
 * things that can be wrong about this rail are silent when they are:
 *
 * - **Where a tick sits.** The ticks are a GROUP, not a map: they stack at one
 *   uniform gap, centred in the rail. An earlier version mapped each anchor's
 *   offset in the loaded content onto the rail's height, so that a long answer
 *   looked long — and on a real, long conversation that spread half a dozen
 *   anchors over several hundred pixels, which reads as unrelated marks rather
 *   than as a list of your own inputs. Grouping is the correction, and it is
 *   asserted numerically because a stack that is merely *near* centred, or that
 *   quietly piles up at one end when it grows, still looks deliberate;
 * - **Which anchor is current.** A rule read off the wrong edge (the scrollport's
 *   top rather than its midline) is off by one row for the whole scroll, which
 *   reads as "sometimes laggy" instead of wrong, so the rule is stated once, here.
 *
 * The anchors are the rows ui-conversation already marks for its own paging:
 * `data-chat-anchor-key` on every node row, `data-chat-flow-kind` naming the
 * business kind. `user` (a turn-opening message) and `steering` (a message
 * admitted into a running turn) are what a person typed; `context` is injected
 * history and must never become a tick.
 *
 * @module dsh-web-ui/client/rail
 */

/** The row kinds that count as the user's own input. */
const TYPED_KINDS: ReadonlySet<string> = new Set(['user', 'steering'])

/** Preview budget, in characters, for one anchor's first line. */
const PREVIEW_LIMIT = 80

/** One navigable user input found in the transcript. */
export interface RailAnchor {
  /** The row's `data-chat-anchor-key` — the identity the jump and the active rule use. */
  key: string
  /** Which kind of typed input this is. */
  kind: 'user' | 'steering'
  /** First line of the row's rendered text, whitespace-collapsed and truncated. */
  text: string
  /**
   * The row's top in the scrollport's CONTENT coordinates (viewport offset plus
   * the current `scrollTop`), so the value is stable while the reader scrolls.
   * It answers the JUMP (where to put `scrollTop`) and the current-anchor rule;
   * the tick stack deliberately does not use it.
   */
  top: number
}

/** Geometry the tick stack needs: the rail's own box and the marker metrics. */
export interface TickGeometry {
  /** The rail's drawable height in px. */
  railHeight: number
  /** One marker's height in px. */
  markerHeight: number
  /** The preferred centre-to-centre gap, in px. */
  gap: number
  /**
   * The gap the stack will not go below, in px. Past it the stack overflows
   * {@link TickGeometry.railHeight} symmetrically rather than overlapping itself
   * into an unclickable smear.
   */
  minGap: number
}

/** What the current-anchor rule reads. */
export interface ReaderPosition {
  /** The scrollport's `scrollTop`. */
  scrollTop: number
  /** The scrollport's `clientHeight`. */
  viewportHeight: number
}

/**
 * One session's paging facts and the verb that extends them, as the rail's
 * injected face hands them over.
 *
 * Every member is a plain closure rather than a snapshot object because the
 * component binds the two readers to `useSyncExternalStore`, which compares the
 * VALUE it reads: a fresh object per read would re-render on every commit, while
 * booleans are stable by construction.
 */
export interface SessionRail {
  /** Subscribe to this session's paging facts. Identity-stable per session. */
  subscribe: (listener: () => void) => () => void
  /** Whether older history remains to load. */
  hasMore: () => boolean
  /** Whether a page request is currently in flight. */
  loadingOlder: () => boolean
  /** Request one older page of history. */
  loadOlder: () => void
}

/**
 * Reduce one row's text to the single line a preview shows.
 *
 * Markdown and prose both arrive with their own whitespace, and a preview list
 * is one line tall: the first non-empty line is the part that identifies the
 * input, and an interior run of spaces would only make rows look ragged.
 *
 * @param text - the row's raw text content.
 * @returns the collapsed first line, truncated with an ellipsis when long.
 */
export function previewLine(text: string): string {
  const line = text
    .split('\n')
    .map(part => part.replace(/\s+/g, ' ').trim())
    .find(part => part !== '') ?? ''
  return line.length > PREVIEW_LIMIT ? `${line.slice(0, PREVIEW_LIMIT)}…` : line
}

/**
 * Collect the navigable anchors of the loaded window, in reading order.
 *
 * Reads the DOM rather than the conversation snapshot on purpose: this rail is
 * positioned against what is RENDERED, and the loaded window is exactly the
 * coverage it promises (older history arrives through `loadOlder` at the rail's
 * own top entry, and appears here when it lands).
 *
 * @param scrollport - the conversation's scrollport element.
 * @returns one anchor per typed-input row, in DOM order.
 */
export function collectAnchors(scrollport: HTMLElement): RailAnchor[] {
  const base = scrollport.getBoundingClientRect().top - scrollport.scrollTop
  const anchors: RailAnchor[] = []
  for (const row of scrollport.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')) {
    const kind = row.dataset['chatFlowKind']
    if (kind === undefined || !TYPED_KINDS.has(kind)) continue
    const key = row.dataset['chatAnchorKey']
    if (key === undefined) continue
    anchors.push({
      key,
      kind: kind as RailAnchor['kind'],
      text: previewLine(row.textContent ?? ''),
      top: row.getBoundingClientRect().top - base,
    })
  }
  return anchors
}

/**
 * Lay the anchors out as one centred stack of uniform ticks.
 *
 * One gap for every pair, and the whole stack centred in the rail, so a glance
 * takes in "how many inputs, and where am I among them" without the reader
 * chasing marks down a column. The gap SHRINKS before anything leaves the rail —
 * a tick outside the rail is a tick nobody can click — down to
 * {@link TickGeometry.minGap}, past which the stack overflows symmetrically:
 * losing the ends of a stack that long is the better failure, since a rail with
 * more anchors than its own height is a loaded window the reader navigates with
 * the preview list anyway.
 *
 * @param count - how many anchors the rail has.
 * @param geometry - the rail's box and the marker metrics.
 * @returns one offset in px from the track's top per anchor, top edge of the tick.
 */
export function tickPositions(count: number, geometry: TickGeometry): number[] {
  const { railHeight, markerHeight, gap, minGap } = geometry
  if (count <= 0) return []
  if (count === 1) return [Math.round((railHeight - markerHeight) / 2)]
  const preferred = Math.floor((railHeight - markerHeight) / (count - 1))
  const step = Math.max(minGap, Math.min(gap, preferred))
  const total = (count - 1) * step + markerHeight
  const start = Math.round((railHeight - total) / 2)
  return Array.from({ length: count }, (_, index) => start + index * step)
}

/**
 * Which anchor the reader is in.
 *
 * The scrollport's MIDLINE decides, and the last anchor at or above it wins:
 * the row a reader is looking at is the one that has passed the middle of the
 * viewport, not the one whose top edge happens to be off screen. Above the first
 * anchor the first one is current, so a rail with anchors always has a marker.
 *
 * @param anchors - anchors in reading order.
 * @param position - the scrollport's current scroll position.
 * @returns the current anchor's index, or -1 when there are no anchors.
 */
export function activeAnchorIndex(anchors: readonly RailAnchor[], position: ReaderPosition): number {
  if (anchors.length === 0) return -1
  const midline = position.scrollTop + position.viewportHeight / 2
  let index = 0
  for (const [at, anchor] of anchors.entries()) {
    if (anchor.top <= midline) index = at
    else break
  }
  return index
}
