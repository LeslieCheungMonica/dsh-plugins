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
 *
 * ## The node is the HOST's, so every move is a round trip
 *
 * The node is persisted on the project's record (`src/host/projects.ts`), which is
 * what makes it outlive one browser, and it is why this component can no longer
 * decide anything about it on its own:
 *
 * - the node is READ for the selected project, and re-read when the selection
 *   changes — the tag is never allowed to carry one project's node across to
 *   another, and a node that could not be read is a STATE of its own, never the
 *   first node (see `StageRead`);
 * - a move is a WRITE the host may refuse. What the tag shows afterwards is the
 *   host's record, not the row that was clicked: a kept click would display a
 *   delivery position the record does not hold, which is the one thing persisting
 *   it here is for. A refusal is also not an error to swallow — it is a sentence
 *   next to the flow, in the panel the operator is looking at;
 * - this browser's OLD note (`legacyStageIndexOf`) is read once, only while the
 *   host holds no node for the project, and sent as the host's first registration.
 *   That is the whole migration, and it happens before the tag shows anything, so
 *   a project mid-delivery does not lose its place.
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
  canEnterStage, isFinalStage, isStageLocked, legacyStageIndexOf, stageKeyAt, stageStateAt,
  stageStatusKey,
} from './stage.ts'
import type { StageState } from './stage.ts'
import { StageGateDialog } from './StageGateDialog.tsx'
import { readProjectRecord, writeProjectStage } from './larkapi.ts'
import { gateForEntryStage } from '../shared/stagegatewire.ts'
import { stageAt, stageIndexOf } from '../shared/stageflow.ts'

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
 * What this component knows about the project's node.
 *
 * Four states because the node is a fact of the HOST's and the title has to be
 * honest about not having it yet:
 *
 * - `known` — the project's position in the flow, which is what the tag draws;
 * - `reading` — ask in flight (or about to be): every row is inert, because a
 *   click would move a project from a position nobody has read;
 * - `failed` — the answer could not be read. Deliberately NOT the first node: a
 *   project at 完成 would be shown as 需求明确, which is the exact lie that
 *   persisting the node is meant to prevent;
 * - `no-project` — nothing is selected, so there is no record to ask about and no
 *   move to make. The host is not asked at all.
 */
type StageRead =
  | { readonly state: 'known'; readonly index: number }
  | { readonly state: 'reading' }
  | { readonly state: 'failed'; readonly message: string }
  | { readonly state: 'no-project' }

/**
 * Render the current stage of one project, with the flow behind it.
 * @param props - the project scope, its directory, the rail flag, and the copy seat.
 * @returns the tag, its portaled panel, and the gate dialog a gated click opens.
 */
export function StageTag({ scopeKey, scopePath, scopeLabel, rail, openInSidebar, t }: {
  /**
   * The project this tag reports on — its workspace id. The tag holds no state
   * under it (the node lives on the host, keyed by the project's path); it is the
   * React identity of "which project is this", so a switch re-reads rather than
   * carrying the previous project's node across. While no project is selected the
   * column passes one shared bucket instead (NO_PROJECT_SCOPE).
   */
  scopeKey: string
  /**
   * The project's DIRECTORY: the key of its record on the host, which is where the
   * node lives AND what a gate check is asked about (the host resolves the
   * project's Feishu folder from it). Absent while no project is selected, and the
   * tag then reads nothing and can move nothing.
   */
  scopePath?: string | undefined
  /** The project's name, shown in the panel and sent with a first registration. */
  scopeLabel?: string | undefined
  /** Rail layout: the tag shrinks to the ring alone (see the stylesheet). */
  rail: boolean
  /** Show a Feishu link in the GUI's web sidebar when one is mounted (see StageGateDialog). */
  openInSidebar?: ((url: string) => boolean) | undefined
  t: T
}): ReactNode {
  const [read, setRead] = useState<StageRead>(
    // A tag with no project has nothing to ask about, so it starts in that state
    // rather than in `reading`: the effect below would otherwise flash a read that
    // never happens.
    scopePath === undefined ? { state: 'no-project' } : { state: 'reading' },
  )
  /** How many times the read has been asked for: what a retry bumps. */
  const [attempt, setAttempt] = useState(0)
  /** A move the host refused (or a read that failed), in the operator's words. */
  const [notice, setNotice] = useState<string | null>(null)
  /** A write is in flight: no second move may be started from the same state. */
  const [busy, setBusy] = useState(false)
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

  // Follow the project. The node belongs to the SELECTED project, so switching
  // projects asks about the new one rather than carrying the previous one's node
  // across — and a gate dialog belongs to the previous project's transition, so it
  // is dropped for the same reason. (The panel is not closed here: the trigger is
  // the same control either way, and a panel that vanished on a project switch
  // would look like a crash.)
  //
  // `live` guards the ASYNC half: a slow read for the project the operator has
  // already left must not land as the new project's node. That is a worse bug than
  // a stale label — it would move the wrong project.
  useEffect(() => {
    setGateTo(null)
    setNotice(null)
    gateOpen.current = false
    if (scopePath === undefined) {
      setRead({ state: 'no-project' })
      return
    }
    let live = true
    setRead({ state: 'reading' })
    void (async () => {
      const answer = await readProjectRecord(scopePath)
      if (!live) return
      if (!answer.ok) {
        setRead({ state: 'failed', message: answer.error.message })
        return
      }
      const hosted = answer.value?.stage ?? null
      if (hosted !== null) {
        setRead({ state: 'known', index: stageIndexOf(hosted) })
        return
      }
      // The host holds no node for this project, so this browser's own old note is
      // the FIRST REGISTRATION — see `legacyStageIndexOf`. A browser that recorded
      // nothing has nothing to register, and the flow's first node stands for a
      // project nobody has placed.
      const legacy = legacyStageIndexOf(scopeKey)
      const node = legacy === null ? undefined : stageAt(legacy)
      if (node === undefined || scopeLabel === undefined || scopeLabel === '') {
        setRead({ state: 'known', index: legacy ?? DEFAULT_STAGE })
        return
      }
      const registered = await writeProjectStage({ path: scopePath, name: scopeLabel, stage: node })
      if (!live) return
      // A registration the host refused (or could not be asked) falls back to what
      // this browser had: the operator's next click is a first registration the
      // host may still accept, and showing nothing at all would be worse than
      // showing the position they last recorded.
      const landed = registered.ok ? registered.value?.stage ?? null : null
      setRead({
        state: 'known',
        index: landed === null ? legacy ?? DEFAULT_STAGE : stageIndexOf(landed),
      })
    })()
    return () => { live = false }
  }, [scopeKey, scopePath, scopeLabel, attempt])

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
  // project moved TO. It only does so when focus was LOST: a panel that owns focus
  // somewhere else keeps it.
  //
  // Why `disabled` is checked and not just "is it the body": at this point the
  // keyboard is usually still ON the row that is being disabled. React applies the
  // disabled property during the commit, and the browser blurs the control it has
  // just disabled LATER — so reading `activeElement` alone finds the doomed row
  // still holding focus, hands nothing on, and the keyboard ends up on the body
  // anyway. The element that IS reachable and WOULD disappear is the one to check.
  useEffect(() => {
    if (!open) return
    const active = document.activeElement
    const lost = active === null || active === document.body
      || (active instanceof HTMLButtonElement && active.disabled)
    if (!lost) return
    panelRef.current?.querySelector<HTMLElement>('[aria-current="step"]')?.focus()
  }, [read, open])

  /**
   * The project's node, or null while it is not known.
   *
   * EVERYTHING the tag draws reads this, which is what keeps "we have not read it
   * yet" from being silently drawn as a node the project might not be at.
   */
  const current = read.state === 'known' ? read.index : null

  /**
   * What the panel's rows are labelled from.
   *
   * The flow's first node stands in while nothing is known, because the PANEL is
   * the flow and its rows have to be about something — the rows are inert in that
   * state, and the panel says why in its own line (see `readOnlyReason`), which is
   * what keeps the stand-in from reading as a claim about the project.
   */
  const display = current ?? DEFAULT_STAGE

  /**
   * Why nothing can be moved right now, in the operator's words — or null while the
   * node IS known.
   *
   * One sentence per state, stated once: the panel's own line and every row's
   * tooltip are both this, so the flow cannot explain itself two ways.
   */
  const readOnlyReason: string | null = read.state === 'known'
    ? null
    : read.state === 'reading'
      ? t('stage.read.pending')
      : read.state === 'failed'
        ? t('stage.read.failed', { message: read.message })
        : t('stage.read.noProject')

  /**
   * Move the project one node forward, through the host.
   *
   * The host is asked, and the answer is what the tag shows: a write that succeeds
   * carries the record it produced, and a write the host REFUSES leaves the project
   * where it was — so the tag asks where that is and says why, rather than keeping
   * the node that was clicked.
   * @param next - the node to enter.
   */
  const advance = async (next: number): Promise<void> => {
    const node = stageAt(next)
    if (scopePath === undefined || node === undefined || read.state !== 'known' || busy) return
    setGateTo(null)
    gateOpen.current = false
    setBusy(true)
    const answer = await writeProjectStage({
      path: scopePath,
      name: scopeLabel ?? '',
      stage: node,
    })
    setBusy(false)
    if (answer.ok) {
      const hosted = answer.value?.stage ?? null
      setRead({
        state: 'known',
        index: hosted === null ? next : stageIndexOf(hosted),
      })
      setNotice(null)
      return
    }
    // Refused, or the host could not be reached. Either way the tag no longer knows
    // where the project stands, and guessing is what this change exists to stop —
    // so ask, and fall back to the last known node only if even that fails.
    if (answer.error.code === 'not-next') {
      const truth = await readProjectRecord(scopePath)
      if (truth.ok) {
        const hosted = truth.value?.stage ?? null
        setRead({ state: 'known', index: hosted === null ? DEFAULT_STAGE : stageIndexOf(hosted) })
      }
    }
    setNotice(t('stage.move.refused', { message: answer.error.message }))
  }

  /**
   * Handle a click on one node: the only place the stage ever moves.
   * @param index - the clicked node.
   */
  const choose = (index: number): void => {
    // Nothing is known, so there is no position to move FROM: the rows are inert
    // in that state (see `readOnlyReason`), and this guard is what keeps a stale
    // click from moving a project whose node was never read.
    if (current === null) return
    // The current node is where the project already is, so its click is a no-op
    // rather than a re-write — and it stays clickable so the panel can focus it.
    if (index === current) return
    // Everything else is locked except the next node: see `canEnterStage`.
    if (!canEnterStage(current, index)) return
    // A gated transition is not a move but a DECISION, so it opens the dialog;
    // this component learns the outcome from that dialog's pass and nowhere else.
    if (gateForEntryStage(index) !== undefined) {
      setGateTo(index)
      gateOpen.current = true
      return
    }
    void advance(index)
  }

  return (
    <>
      <button
        type="button"
        data-wui="stageTag"
        data-wui-rail-in="true"
        // The node is only claimed when it is KNOWN: the attribute is what the
        // stylesheet and the tests read, so leaving it off while nothing has been
        // read is what keeps "unknown" from being rendered as a position.
        data-step={current ?? undefined}
        data-pending={current === null || undefined}
        data-open={open || undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={current === null
          ? t('stage.flow.title')
          : t('stage.tag.label', { stage: t(stageKeyAt(current)), n: current + 1, total: STAGE_COUNT })}
        title={t('stage.tag.hint')}
        ref={triggerRef}
        onClick={() => { setOpen(value => !value) }}
      >
        {/* The ring states the position in the flow (and the rail keeps it as
            the tag's whole content); the words state the node. While none is
            known the tag names the FLOW instead and drops the counter: it is
            still the same control, and it no longer claims a position. */}
        <span data-wui="stageRing" aria-hidden="true" />
        {!rail && (
          <span data-wui="stageTagLabel">
            {current === null ? t('stage.flow.title') : t(stageKeyAt(current))}
          </span>
        )}
        {!rail && current !== null && (
          <span data-wui="stageTagCount" aria-hidden="true">{`${current + 1}/${STAGE_COUNT}`}</span>
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
            <span data-wui="stagePanelCount">
              {current === null ? '' : `${current + 1} / ${STAGE_COUNT}`}
            </span>
          </div>
          {/* The project the flow belongs to. Without it, a panel opened right
              after a project switch could be read as the previous project's. */}
          {scopeLabel !== undefined && (
            <div data-wui="stagePanelScope" title={scopeLabel}>{scopeLabel}</div>
          )}
          {/* Why nothing can be moved, while nothing can be: the node is unread or
              unreadable. It is stated HERE rather than only in a tooltip, because
              the alternative — an inert flow with no reason — reads as a bug. */}
          {readOnlyReason !== null && (
            <div data-wui="stagePanelState" role="status">
              <span>{readOnlyReason}</span>
              {read.state === 'failed' && (
                <button
                  type="button"
                  data-wui="stageRetry"
                  onClick={() => { setAttempt(count => count + 1) }}
                >
                  {t('stage.read.retry')}
                </button>
              )}
            </div>
          )}
          {/* What the host said about the last move — a refusal, in its own words.
              It sits above the list because it explains why the list did not
              change, and it is cleared by the next read or the next move. */}
          {notice !== null && (
            <div data-wui="stageNotice" role="status">{notice}</div>
          )}
          <ul data-wui="stageList">
            {STAGE_KEYS.map((key, index) => {
              // While nothing is known every row is inert and reads as ahead of the
              // project: there is no position to be behind, on, or next after. The
              // REASON is the panel's own line — a row's tooltip is too quiet to
              // carry it alone.
              const state: StageState = current === null ? 'pending' : stageStateAt(index, current)
              const locked = current === null || busy || isStageLocked(index, current)
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
                    title={readOnlyReason !== null
                      ? readOnlyReason
                      : index === current
                        ? t('stage.node.current')
                        : locked ? t('stage.node.locked') : t('stage.node.hint', { stage: t(key) })}
                    aria-current={state === 'current' ? 'step' : undefined}
                    onClick={() => { choose(index) }}
                  >
                    <span data-wui="stageNodeCell">
                      <span data-wui="stageNode" aria-hidden="true">
                        {/* The check belongs to THIS node and everything behind
                            it; a node ahead of it stays an empty ring. The
                            running one is drawn a touch larger, which is the
                            only difference motion does not already say. */}
                        {state !== 'pending' && <IconCheckOutline16 size={state === 'current' ? 13 : 12} />}
                      </span>
                    </span>
                    <span data-wui="stageLabel">{t(key)}</span>
                    {/* One index still decides this row: `stageStatusKey` is the
                        single place the terminal node's word differs. */}
                    <span data-wui="stageStatus">{t(stageStatusKey(index, display))}</span>
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
        onPassed={() => { if (gateTo !== null) void advance(gateTo) }}
        openInSidebar={openInSidebar}
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
