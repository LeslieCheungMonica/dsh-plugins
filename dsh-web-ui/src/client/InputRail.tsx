/**
 * The input-anchor rail: the conversation column's left edge, one tick per
 * input the reader typed, and a tip that names the tick under the pointer.
 *
 * ## Where it lives, and why
 *
 * It is registered into `shell.overlay` — the frame's root-scope, additive,
 * click-through seat — and positions itself against the transcript's own
 * scrollport (`[data-conversation-scroll]`), which is the arrangement this
 * plugin already uses for its action bar. The alternative was a seat inside
 * ui-conversation, which would mean patching DSH itself and re-applying that
 * patch on every harness upgrade; taking over `conversation.view` was worse
 * still, because that seat is the whole chat view.
 *
 * What that costs is a contract on the harness's DOM: the scrollport element and
 * the per-row `data-chat-anchor-key` / `data-chat-flow-kind` attributes that
 * `ChatView` itself navigates by. Both are read, never written, and the rail
 * degrades to nothing (rather than to something wrong) when they are absent.
 *
 * ## What it promises
 *
 * - **Anchors are what a person typed** — `user` and `steering` rows, never
 *   injected `context`. A rail dotted with machinery would be a transcript
 *   outline, not a way back to your own words.
 * - **The coverage is the loaded window.** Older history arrives through the
 *   rail's own top entry (`loadOlder`, the same verb the shipped paging button
 *   calls), so the rail never silently pulls a long session's whole log.
 * - **The anchors are grouped, not spread.** They stack at one uniform gap,
 *   centred in the rail (see `rail.ts` for why the earlier content-offset mapping
 *   was the wrong picture of a real conversation).
 * - **The jump agrees with the harness.** A click writes `scrollTop` with the
 *   same arithmetic `ChatView` uses to restore a reader position, so the rail and
 *   the paging anchor cannot fight over where the reader is.
 * - **The marker follows the reader's midline**, and a click pins the anchor it
 *   jumped to until the reader scrolls again — otherwise a tick flanked by
 *   closely spaced inputs would light up its neighbour instead of itself.
 * - **Hovering a tick names THAT tick, beside it.** The tip hangs beside the
 *   tick the pointer is on and never over the rail itself, so the words that
 *   answer "which input is this?" arrive where the reader is looking. An earlier
 *   version opened the whole list at the rail's top, which on a long conversation
 *   was nowhere near the pointer. Only one tip exists at a time, and it leaves
 *   with the pointer rather than staying open.
 *
 * @module dsh-web-ui/client/InputRail
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { IconChevronUpOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: `shell.overlay`'s SlotMap entry and the session kit merge in here.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { NS } from './contract.ts'
import { activeAnchorIndex, collectAnchors, tickPositions } from './rail.ts'
import type { RailAnchor, SessionRail } from './rail.ts'

/** Inset from the transcript's box, in px, so the rail never touches its edges. */
export const RAIL_INSET = 8

/** One tick's height, in px — the marker the stack has to keep inside the rail. */
export const MARKER_HEIGHT = 6

/** The centre-to-centre gap the stack is drawn at, in px. */
export const TICK_GAP = 10

/** The gap the stack will not go below, in px, however many anchors it holds. */
const MIN_GAP = 3

/**
 * Where a jumped-to input lands, in px below the scrollport's top edge: far
 * enough down that the first line of the message is not clipped, close enough
 * that the reader sees what they asked for rather than what preceded it.
 */
export const JUMP_INSET = 12

/** The transcript box the rail aligns to, in viewport coordinates. */
interface RailFrame {
  top: number
  left: number
  height: number
}

/** The frame's width the rail occupies while collapsed, in px. */
const RAIL_WIDTH = 14

/**
 * The per-session facts and verbs the rail needs, as the injected face hands
 * them over. Every read is a plain closure so the component can bind it to
 * `useSyncExternalStore`; `subscribe` must be identity-stable per session, and
 * the two readers must return primitives (an identity that changes on every read
 * would re-render forever).
 */
export interface RailReader {
  /** Resolve one session's rail view; undefined when no session is current. */
  sessionRail: (sessionId: SessionId | undefined) => SessionRail | undefined
}

/** Composed props: the global seat's hook, this plugin's copy, and the injected face. */
export type InputRailProps =
  & PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>
  & {
    /** Per-session paging facts and the `loadOlder` verb. */
    rail: RailReader
  }

/**
 * Find the active conversation's scrollport.
 * @returns the scrollport element, or null when no conversation is mounted.
 */
function scrollportOf(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-conversation-scroll]')
}

/**
 * The input-anchor rail.
 * @param props - global seat hook, injected per-session rail view, and copy.
 * @returns the rail, or null when there is nothing to navigate.
 */
export function InputRail({ useSessions, rail, t }: InputRailProps) {
  const sessionId = useSessions(state => state.current)
  // Memoized per session: the face's identity is the subscription identity.
  const session = useMemo(() => rail.sessionRail(sessionId), [rail, sessionId])

  const [scrollport, setScrollport] = useState<HTMLElement | null>(null)
  const [frame, setFrame] = useState<RailFrame | null>(null)
  const [anchors, setAnchors] = useState<readonly RailAnchor[]>([])
  const [scrollTop, setScrollTop] = useState(0)
  /** The anchor the pointer is on, which is the one whose tip is shown. */
  const [hovered, setHovered] = useState<string | null>(null)
  /** The anchor a click jumped to, until the reader scrolls on their own. */
  const [pinned, setPinned] = useState<string | null>(null)

  const subscribe = useCallback(
    (listener: () => void) => session?.subscribe(listener) ?? (() => {}),
    [session],
  )
  const hasMore = useSyncExternalStore(subscribe, () => session?.hasMore() ?? false, () => false)
  const loadingOlder = useSyncExternalStore(subscribe, () => session?.loadingOlder() ?? false, () => false)

  const measure = useCallback((target: HTMLElement | null) => {
    if (target === null) {
      setAnchors([])
      setFrame(null)
      return
    }
    setAnchors(collectAnchors(target))
    const rect = target.getBoundingClientRect()
    setFrame({ top: rect.top, left: rect.left, height: rect.height })
    setScrollTop(target.scrollTop)
  }, [])

  // Resolve the scrollport after mount and whenever the session changes: the
  // transcript is another plugin's tree, so it can appear, move, or go away
  // (a session switch, a view-tab switch) without telling us.
  useEffect(() => {
    const target = scrollportOf()
    setScrollport(target)
    measure(target)
    setPinned(null)
    setHovered(null)
  }, [measure, sessionId])

  // Rows stream in, tools settle, images load: the anchors and the mapped span
  // both move under the rail while the reader does nothing.
  useEffect(() => {
    if (scrollport === null) return
    const remeasure = (): void => { measure(scrollport) }
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(remeasure)
    observer?.observe(scrollport, { childList: true, subtree: true, characterData: true })
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(remeasure)
    resize?.observe(scrollport)
    window.addEventListener('resize', remeasure)
    return () => {
      observer?.disconnect()
      resize?.disconnect()
      window.removeEventListener('resize', remeasure)
    }
  }, [measure, scrollport])

  // Reader scrolling is what owns the marker; our own jump writes land on the
  // value the pin expects, so they keep it instead of clearing it.
  useEffect(() => {
    if (scrollport === null) return
    const onScroll = (): void => {
      const next = scrollport.scrollTop
      setScrollTop(next)
      setPinned(current => {
        if (current === null) return null
        const jumped = anchors.find(anchor => anchor.key === current)
        if (jumped === undefined) return null
        return Math.abs(next - (jumped.top - JUMP_INSET)) <= 1 ? current : null
      })
    }
    scrollport.addEventListener('scroll', onScroll, { passive: true })
    return () => { scrollport.removeEventListener('scroll', onScroll) }
  }, [anchors, scrollport])

  const viewportHeight = scrollport?.clientHeight ?? 0
  const railHeight = Math.max(0, (frame?.height ?? 0) - RAIL_INSET * 2)
  const positions = tickPositions(anchors.length, {
    railHeight,
    markerHeight: MARKER_HEIGHT,
    gap: TICK_GAP,
    minGap: MIN_GAP,
  })
  const hoveredIndex = hovered === null ? -1 : anchors.findIndex(anchor => anchor.key === hovered)
  const pinnedIndex = pinned === null ? -1 : anchors.findIndex(anchor => anchor.key === pinned)
  const activeIndex = pinnedIndex !== -1
    ? pinnedIndex
    : activeAnchorIndex(anchors, { scrollTop, viewportHeight })

  const jump = useCallback((anchor: RailAnchor) => {
    if (scrollport === null) return
    scrollport.scrollTop = Math.max(0, anchor.top - JUMP_INSET)
    setScrollTop(scrollport.scrollTop)
    setPinned(anchor.key)
  }, [scrollport])

  const loadOlder = useCallback(() => {
    if (loadingOlder) return
    session?.loadOlder()
  }, [loadingOlder, session])

  // When there is nothing to draw. Two of these three rules were learned from
  // real conversations rather than reasoned out:
  //
  // - No session, no transcript: nothing to draw at all.
  // - Nothing typed in the loaded window AND no history left to load: a bare
  //   marker with nothing behind it.
  //
  // What is deliberately NOT a reason to hide: one anchor (a long agent turn is
  // one prompt under dozens of tool calls, and that single tick is the useful jump
  // back to the top of the turn) and a window with no typed input but more history
  // to load — this rail is where the way back lives, so it stays and offers the
  // chevron. Hiding it in either state, which an earlier two-anchor rule did, is
  // what removed the rail AND the only route to earlier inputs.
  if (sessionId === undefined || session === undefined || scrollport === null || frame === null) return null
  if (anchors.length === 0 && !hasMore) return null

  const itemLabel = (index: number): string => t('rail.item.label', { n: index + 1, text: anchors[index]?.text ?? '' })

  return (
    <nav
      data-wui="inputRail"
      aria-label={t('rail.aria')}
      style={{
        top: `${frame.top}px`,
        left: `${frame.left}px`,
        height: `${frame.height}px`,
        width: `${RAIL_WIDTH}px`,
      }}
    >
      {/* The window's own edge: while history remains, the rail's top entry is
          the only way it grows backwards — the same `loadOlder` verb the shipped
          paging button calls, reached from where the reader is looking. */}
      {hasMore && (
        <button
          type="button"
          data-wui="railOlder"
          disabled={loadingOlder}
          title={loadingOlder ? t('rail.olderBusy') : t('rail.older')}
          aria-label={loadingOlder ? t('rail.olderBusy') : t('rail.older')}
          onClick={loadOlder}
        >
          <IconChevronUpOutline14 size={14} />
        </button>
      )}
      <div data-wui="railTrack">
        {anchors.map((anchor, index) => (
          <button
            key={anchor.key}
            type="button"
            data-wui="railTick"
            data-kind={anchor.kind}
            data-active={index === activeIndex ? 'true' : undefined}
            style={{ top: `${RAIL_INSET + (positions[index] ?? 0)}px` }}
            aria-label={itemLabel(index)}
            aria-current={index === activeIndex ? 'true' : undefined}
            onMouseEnter={() => { setHovered(anchor.key) }}
            onMouseLeave={() => { setHovered(current => (current === anchor.key ? null : current)) }}
            onClick={() => { jump(anchor) }}
          />
        ))}
      </div>
      {/* The tip hangs beside its own tick, centred on it: `left: 100%` puts it
          clear of the rail rather than over it, and the transforms are the
          anchoring arithmetic rather than decoration — which is why they are
          inline with the rest of the rail's geometry. `aria-hidden` because the
          tick it belongs to already carries the same words as its label, and
          `pointer-events: none` (in styles.ts) so it can never steal the hover
          that produced it. */}
      {hoveredIndex !== -1 && (
        <div
          data-wui="railTip"
          aria-hidden="true"
          style={{
            top: `${RAIL_INSET + (positions[hoveredIndex] ?? 0) + MARKER_HEIGHT / 2}px`,
            left: '100%',
            transform: 'translateY(-50%)',
          }}
        >
          {itemLabel(hoveredIndex)}
        </div>
      )}
    </nav>
  )
}
