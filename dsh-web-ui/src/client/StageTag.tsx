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
 *   node ahead of it stays grey.
 *
 * ## The panel moves the project ONE step, and never without its gate
 *
 * Two rules, both positional, both derived from the same index:
 *
 * 1. **Only the NEXT node is a move.** A jump would record work nobody did, and a
 *    step back would un-record work that was done, so every other row is locked
 *    (`isStageLocked`) — greyed, `disabled`, and explained by its tooltip rather
 *    than silently inert.
 * 2. **A gated transition opens the GATE DIALOG instead of moving.** The rows that
 *    carry a gate come from `GATE_BY_ENTRY_STAGE`; clicking one hands the
 *    transition to `StageGateDialog.tsx`, which checks the project's Feishu folder
 *    against the outputs the stage requires AND asks the operator the manual items
 *    this deployment decided a person must answer. Only that dialog's PASS calls
 *    back here, and only then does the stage move.
 *
 * The gate cannot be a client-side check for the same reason the Feishu panel is
 * not one: part of it needs the operator's `lark-cli` login and part of it needs a
 * record of WHO answered. Both live on the host (`src/host/stage-gate.ts`), and a
 * check that could not RUN is still not permission to enter — "we could not look"
 * is its own sentence in the dialog, never a pass.
 *
 * The gate's verdict is NOT a per-node flag, and not a card in this panel either:
 * a gate is a decision about the project, so it takes the page's whole attention
 * in a modal. What a row says HERE stays positional (done / running / not
 * started), which is what keeps one index deciding the whole picture.
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
  DEFAULT_STAGE, STAGE_COUNT, STAGE_KEYS,
  canEnterStage, isFinalStage, isStageLocked, readStage, stageStateAt, stageStatusKey, writeStage,
} from './stage.ts'
import type { StageState } from './stage.ts'
import { StageGateDialog } from './StageGateDialog.tsx'
import { gateForEntryStage } from '../shared/stagegatewire.ts'

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
 * @param props - the project scope, its directory, the rail flag, and the copy seat.
 * @returns the tag, its portaled panel, and the gate dialog a gated click opens.
 */
export function StageTag({ scopeKey, scopePath, scopeLabel, rail, t }: {
  /**
   * The project this tag reports on — its workspace id. The stage is that
   * project's own fact, so this is also the persistence key; while no project is
   * selected the column passes one shared bucket instead (NO_PROJECT_SCOPE), so
   * "no project" is a scope rather than a crash.
   */
  scopeKey: string
  /**
   * The project's DIRECTORY, which is what a gate check is asked about: the host
   * resolves the project's Feishu folder from its record, keyed by path. Absent
   * while no project is selected — and the gate dialog then states that it cannot
   * check rather than letting the stage move.
   */
  scopePath?: string | undefined
  /** The project's name, shown in the panel so the flow is never ambiguous. */
  scopeLabel?: string | undefined
  /** Rail layout: the tag shrinks to the ring alone (see the stylesheet). */
  rail: boolean
  t: T
}): ReactNode {
  const [stage, setStage] = useState(() => readStage(scopeKey))
  const [open, setOpen] = useState(false)
  /** The gate dialog's subject: the stage index a gated click is trying to enter. */
  const [gateTo, setGateTo] = useState<number | null>(null)
  /**
   * The same fact as a ref, for the dismissal listeners below.
   *
   * They are registered once per opening, so a closure over `gateTo` would go
   * stale — and they need it: while the gate dialog is up, the modal owns the page,
   * so a pointerdown or an Escape INSIDE it is not an outside click for this panel.
   * Without this, the first click on the dialog's own primary button would close
   * the flow behind it, and Escape would close both.
   */
  const gateOpen = useRef(false)

  // Follow the project. The stage belongs to the SELECTED project, so switching
  // projects must re-read rather than carry the previous one's stage across — and
  // a gate dialog belongs to the previous project's transition, so it is dropped
  // for the same reason. (The panel is not closed here: the trigger is the same
  // control either way, and a panel that vanished on a project switch would look
  // like a crash.)
  useEffect(() => {
    setStage(readStage(scopeKey))
    setGateTo(null)
    gateOpen.current = false
  }, [scopeKey])

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
      // The gate dialog is a modal over this panel: what happens inside it is not
      // an outside click here.
      if (gateOpen.current) return
      // Both refs: see the module comment on the portal.
      if (triggerRef.current?.contains(event.target) === true) return
      if (panelRef.current?.contains(event.target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Escape belongs to the dialog while it is open (see `gateOpen`).
      if (gateOpen.current) return
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
  //
  // The current row is the one row a mouse cannot be moved to make inert — its
  // click is a no-op but it stays ENABLED, precisely so it can take this focus
  // (see `isStageLocked`).
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

  // A move re-labels EVERY row, which has one consequence the focus effect above
  // cannot cover: the row that held the keyboard becomes a locked, `disabled`
  // button, and disabling the focused element drops focus to the page body — so
  // the operator's next Tab would restart at the top of the document, outside the
  // panel they are looking at. A move therefore hands the keyboard to the row the
  // project moved TO. It only does so when focus was LOST (the body has it): a
  // panel that owns focus somewhere else keeps it.
  useEffect(() => {
    if (!open) return
    const active = document.activeElement
    if (active !== null && active !== document.body) return
    panelRef.current?.querySelector<HTMLElement>('[aria-current="step"]')?.focus()
  }, [stage, open])

  const stageKey = STAGE_KEYS[stage] ?? STAGE_KEYS[DEFAULT_STAGE]

  /**
   * Record the step, and clear the dialog's subject with it: a moved stage is the
   * feedback for the click, exactly as it has always been.
   * @param next - the stage to record.
   */
  const advance = (next: number): void => {
    setStage(next)
    writeStage(scopeKey, next)
    setGateTo(null)
    gateOpen.current = false
  }

  /**
   * Handle a click on one node: the only place the stage ever moves.
   * @param index - the clicked stage.
   */
  const choose = (index: number): void => {
    // The current stage is where the project already is, so its click is a no-op
    // rather than a re-write — and it stays clickable so the panel can focus it.
    if (index === stage) return
    // Everything else is locked except the next stage: see `canEnterStage`.
    if (!canEnterStage(stage, index)) return
    // A gated transition is not a move but a DECISION, so it opens the dialog;
    // this component learns the outcome from that dialog's pass and nowhere else.
    if (gateForEntryStage(index) !== undefined) {
      setGateTo(index)
      gateOpen.current = true
      return
    }
    advance(index)
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
              const locked = isStageLocked(index, stage)
              return (
                <li
                  key={key}
                  data-wui="stageRow"
                  data-state={state}
                  // The flow's END, marked so the stylesheet can give it the closed
                  // look (see stage.ts: the terminal node is reached BY finishing).
                  data-final={isFinalStage(index) || undefined}
                >
                  <button
                    type="button"
                    data-wui="stageNodeButton"
                    // Locked rows are disabled AND marked, because `disabled` is
                    // what stops the click while the attribute is what the
                    // stylesheet and the tests read.
                    data-locked={locked || undefined}
                    disabled={locked || undefined}
                    title={index === stage
                      ? t('stage.node.current')
                      : locked ? t('stage.node.locked') : t('stage.node.hint', { stage: t(key) })}
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
                    {/* One index still decides this row: `stageStatusKey` is the
                        single place the terminal node's word differs. */}
                    <span data-wui="stageStatus">{t(stageStatusKey(index, stage))}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ), document.body)}

      {/* The gate: a modal over the page, because it is a decision about the
          project rather than a detail of the flow (see StageGateDialog.tsx). */}
      <StageGateDialog
        open={gateTo !== null}
        path={scopePath ?? ''}
        to={gateTo ?? DEFAULT_STAGE}
        onPassed={() => { if (gateTo !== null) advance(gateTo) }}
        onClose={() => {
          const closed = gateTo
          setGateTo(null)
          gateOpen.current = false
          // The dialog was opened by a click on the NEXT row, so closing it hands
          // the keyboard back to that row: focus would otherwise fall to the page
          // body and the operator would have to Tab in from nowhere. The row index
          // is the stage being entered, which is `closed` — read from the state
          // being replaced rather than from the panel, which is still one render
          // behind.
          if (closed === null) return
          panelRef.current
            ?.querySelectorAll<HTMLElement>('[data-wui="stageNodeButton"]')[closed]
            ?.focus()
        }}
        t={t}
      />
    </>
  )
}
