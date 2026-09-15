/**
 * The FDE stage tag: the project's current stage, directly above the New Session
 * button, and the flow it belongs to.
 *
 * Two surfaces, one fact (see `stage.ts` for the fact itself):
 *
 * - the TAG is a status row — a progress ring, the stage's name, its position in
 *   the flow, and a chevron. It is deliberately NOT accent-filled: the column's
 *   one filled control is New Session, and a second primary surface next to it
 *   would make the operator choose between two "main" things.
 * - the PANEL is the flow, top to bottom, in delivery order. Every node behind
 *   the current one carries a green check, the current one marks itself as the
 *   running step (a pulsing marker, a tinted row, the word "运行中"), and every
 *   node ahead of it stays grey. Clicking a node moves the project to that
 *   stage.
 *
 * Why the panel is PORTALED to `document.body` and positioned from the anchor's
 * viewport rect: the column sets `overflow: hidden` (it is a sliding track), so
 * an in-place panel would be clipped at the 56px rail edge the moment the
 * sidebar collapses. It is fixed-positioned and viewport-clamped by
 * `useAnchoredPosition`, exactly like the shared Menu's own portal mode.
 *
 * The consequence of that portal is one thing this component has to own: an
 * outside-pointer dismiss must check BOTH the trigger and the panel, because the
 * panel is not inside the trigger's subtree any more. The shared
 * `useDismissOnOutsidePointer` takes a single root and would therefore close the
 * panel on every click INSIDE it, so the two-ref check is written out here.
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  IconCheckOutline16, IconChevronDownOutline14, useAnchoredPosition,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './contract.ts'
import {
  DEFAULT_STAGE, STAGE_COUNT, STAGE_KEYS, STAGE_STATUS_KEYS,
  readStage, stageStateAt, writeStage,
} from './stage.ts'
import type { StageState } from './stage.ts'

/** The translator seat this plugin's copy arrives through. */
type T = TranslateNS<typeof NS>

/** Distance the panel keeps below the tag. */
const PANEL_GAP = 6

/** Distance the panel keeps from every viewport edge. */
const PANEL_MARGIN = 12

/**
 * Where the panel sits before it has been measured: hidden but LAID OUT at the
 * origin, so the first placement reads real dimensions (a `display: none` panel
 * would measure zero and misplace itself near the viewport edge).
 */
const UNPLACED: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/**
 * Render the current stage of one project, with the flow behind it.
 * @param props - the project scope, the rail flag, and the copy seat.
 * @returns the tag and, while it is open, its portaled panel.
 */
export function StageTag({ scopeKey, scopeLabel, rail, t }: {
  /**
   * The project this tag reports on — its workspace id. The stage is that
   * project's own fact, so this is also the persistence key; while no project is
   * selected the column passes one shared bucket instead (NO_PROJECT_SCOPE), so
   * "no project" is a scope rather than a crash.
   */
  scopeKey: string
  /** The project's name, shown in the panel so the flow is never ambiguous. */
  scopeLabel?: string | undefined
  /** Rail layout: the tag shrinks to the ring alone (see the stylesheet). */
  rail: boolean
  t: T
}): ReactNode {
  const [stage, setStage] = useState(() => readStage(scopeKey))
  const [open, setOpen] = useState(false)

  // Follow the project. The stage belongs to the SELECTED project, so switching
  // projects must re-read rather than carry the previous one's stage across.
  // (The panel is not closed here: the trigger is the same control either way,
  // and a panel that vanished on a project switch would look like a crash.)
  useEffect(() => { setStage(readStage(scopeKey)) }, [scopeKey])

  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const position = useAnchoredPosition({
    open,
    anchorRef: triggerRef,
    panelRef,
    gap: PANEL_GAP,
    margin: PANEL_MARGIN,
  })

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      // Both refs: see the module comment on the portal.
      if (triggerRef.current?.contains(event.target) === true) return
      if (panelRef.current?.contains(event.target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      // Escape is a keyboard dismissal: returning focus to the trigger is what
      // keeps the next Tab from restarting at the top of the document.
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // Focus lands on the stage the project is AT — once per opening, and only once
  // the panel has been PLACED. Both halves are load-bearing:
  //
  //   - the panel is portaled to the end of the page body, so something has to
  //     move focus into it; otherwise Tab from the trigger lands on the New
  //     Session button and walks away from a panel the operator just opened;
  //   - while it is unplaced (`position === null`) the panel is
  //     `visibility: hidden`, and a hidden subtree cannot take focus at all — the
  //     call would silently do nothing, which is exactly what it did before this
  //     dependency existed.
  //
  // The once-per-open flag is what keeps a scroll or a resize (which re-places the
  // panel and so re-runs this effect) from yanking the keyboard back to the
  // current node while the operator is reading another one.
  const focused = useRef(false)
  useEffect(() => {
    if (!open) {
      focused.current = false
      return
    }
    if (focused.current || position === null) return
    focused.current = true
    panelRef.current?.querySelector<HTMLElement>('[aria-current="step"]')?.focus()
  }, [open, position])

  const stageKey = STAGE_KEYS[stage] ?? STAGE_KEYS[DEFAULT_STAGE]
  const choose = (next: number): void => {
    setStage(next)
    writeStage(scopeKey, next)
  }

  return (
    <>
      <button
        type="button"
        data-wui="stageTag"
        data-wui-rail-in="true"
        data-step={stage}
        data-open={open || undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('stage.tag.label', { stage: t(stageKey), n: stage + 1, total: STAGE_COUNT })}
        title={t('stage.tag.hint')}
        ref={triggerRef}
        onClick={() => { setOpen(value => !value) }}
      >
        {/* The ring states the position in the flow (and the rail keeps it as
            the tag's whole content); the words state the stage. */}
        <span data-wui="stageRing" aria-hidden="true" />
        {!rail && <span data-wui="stageTagLabel">{t(stageKey)}</span>}
        {!rail && (
          <span data-wui="stageTagCount" aria-hidden="true">{`${stage + 1}/${STAGE_COUNT}`}</span>
        )}
        {!rail && (
          <span data-wui="stageTagChevron" aria-hidden="true"><IconChevronDownOutline14 size={14} /></span>
        )}
      </button>

      {open && createPortal((
        <div
          data-wui="stagePanel"
          role="dialog"
          aria-label={t('stage.flow.title')}
          ref={panelRef}
          style={position ?? UNPLACED}
        >
          <div data-wui="stagePanelHead">
            <span data-wui="stagePanelTitle">{t('stage.flow.title')}</span>
            <span data-wui="stagePanelCount">{`${stage + 1} / ${STAGE_COUNT}`}</span>
          </div>
          {/* The project the flow belongs to. Without it, a panel opened right
              after a project switch could be read as the previous project's. */}
          {scopeLabel !== undefined && (
            <div data-wui="stagePanelScope" title={scopeLabel}>{scopeLabel}</div>
          )}
          <ul data-wui="stageList">
            {STAGE_KEYS.map((key, index) => {
              const state: StageState = stageStateAt(index, stage)
              return (
                <li key={key} data-wui="stageRow" data-state={state}>
                  <button
                    type="button"
                    data-wui="stageNodeButton"
                    title={t('stage.node.hint', { stage: t(key) })}
                    aria-current={state === 'current' ? 'step' : undefined}
                    onClick={() => { choose(index) }}
                  >
                    <span data-wui="stageNodeCell">
                      <span data-wui="stageNode" aria-hidden="true">
                        {/* The check belongs to THIS stage and everything behind
                            it; a stage ahead of it stays an empty ring. The
                            running one is drawn a touch larger, which is the
                            only difference motion does not already say. */}
                        {state !== 'pending' && <IconCheckOutline16 size={state === 'current' ? 13 : 12} />}
                      </span>
                    </span>
                    <span data-wui="stageLabel">{t(key)}</span>
                    <span data-wui="stageStatus">{t(STAGE_STATUS_KEYS[state])}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ), document.body)}
    </>
  )
}
