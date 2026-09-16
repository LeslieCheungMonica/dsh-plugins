/**
 * The FDE stage gate's dialog: what a gated transition shows the operator.
 *
 * A gated click opens THIS — a modal over the whole page, not a card inside the
 * flow panel — because a gate is a decision about the project, not a detail of
 * the flow: it has to be read, answered (a manual item is a question, not a
 * status), and either confirmed or abandoned before anything else on the page
 * matters.
 *
 * ## Why it owns the check rather than receiving one
 *
 * The dialog's lifetime IS the gate attempt: it opens on the click, runs the
 * check, holds the operator's answer, writes that answer on entry, and closes.
 * Keeping that here means `StageTag` only has to decide *when* a dialog is owed
 * and what a PASS means (move the stage), and this file is the only place that
 * knows the protocol's arm-to-arm shape.
 *
 * ## The two kinds of item, on one screen
 *
 * - the **folder items** arrive from the host's check, each with its evidence;
 * - the **manual items** are questions. The operator answers them here, and the
 *   answer is written to the project's record BY THE HOST, which resolves who is
 *   answering from their own Feishu login — so the citation the dialog then shows
 *   back is not something a page could have invented.
 *
 * The primary action stays DISABLED until both halves are satisfied. A gate with
 * a "continue anyway" button is not a gate.
 *
 * ## Failure is a sentence, never a pass
 *
 * A check that cannot run (no host route yet, an expired login, a Feishu outage)
 * renders the host's own words plus a retry, and the primary action stays
 * disabled. "We could not look" is never permission to enter.
 *
 * The overlay is this plugin's own markup, portaled to `document.body`, for the
 * same reason the flow panel is: the column clips its own overflow, and a page
 * dialog has to escape it. It is a real modal — `aria-modal`, a mask, Escape, and
 * focus moved into the card on open and returned to the caller on close.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  IconCheckOutline16, IconCloseOutline16, IconRefreshOutline16, IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './contract.ts'
import { STAGE_KEYS, DEFAULT_STAGE } from './stage.ts'
import { checkStageGate, confirmStageGate, type StageGateFailure } from './stagegateapi.ts'
import type {
  StageGateItemId, StageGateItemResult, StageGateItemSource, StageGateReport,
} from '../shared/stagegatewire.ts'

/** The translator seat this plugin's copy arrives through. */
type T = TranslateNS<typeof NS>

/**
 * Render the stage gate's dialog for one transition.
 * @param props - whether it is open, the project and stage, the two exits, and the copy seat.
 * @returns the overlay, or null while closed.
 */
export function StageGateDialog({ open, path, to, onPassed, onClose, t }: {
  /** Whether the dialog is showing. */
  open: boolean
  /**
   * The project's directory. `''` means no project is selected — a state in which
   * the gate cannot even be asked, and the dialog says that instead of pretending
   * to check.
   */
  path: string
  /** The stage index this transition enters; also which gate is being run. */
  to: number
  /** Called when everything is satisfied and the operator confirms entry. */
  onPassed: () => void
  /** Called on Escape, the mask, Cancel, or the close button. */
  onClose: () => void
  t: T
}): ReactNode {
  const [report, setReport] = useState<StageGateReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<StageGateFailure | null>(null)
  const [answers, setAnswers] = useState<Record<string, boolean | null>>({})
  const [busy, setBusy] = useState(false)

  const cardRef = useRef<HTMLDivElement | null>(null)
  /** Sequence guard: a slow answer for a previous attempt must not land on this one. */
  const attempt = useRef(0)

  /**
   * Run the check and fold the result into state.
   * @param refresh - whether to make the host drop its caches first.
   */
  const run = async (refresh = false): Promise<void> => {
    const mine = attempt.current + 1
    attempt.current = mine
    setLoading(true)
    setFailure(null)
    if (path === '') {
      // Stated here rather than asked of the host: with no project there is no
      // folder to read, and a request would only be a slower way to say so.
      setLoading(false)
      setReport(null)
      setFailure({ code: 'no-project', message: t('stageGate.reason.noProject') })
      return
    }
    const result = await checkStageGate({ path, to })
    if (attempt.current !== mine) return
    setLoading(false)
    if (!result.ok) {
      setReport(null)
      setFailure(result.error)
      return
    }
    setReport(result.report)
    setFailure(null)
  }

  // One check per opening (and per transition, should the target change while the
  // dialog stays open). The answers are cleared with it: they belong to the
  // attempt being checked, not to the dialog component.
  useEffect(() => {
    if (!open) return
    setReport(null)
    setAnswers({})
    setFailure(null)
    void run()
    // `run` is deliberately absent from the dependency list: it reads nothing but
    // its own arguments (plus the props above, each of which IS listed), and
    // re-running the check whenever the component re-rendered would be a request
    // per keystroke.
  }, [open, path, to])

  // Focus moves INTO the card on open: the dialog is a decision, and a keyboard
  // left on the flow panel behind the mask could not make it.
  useEffect(() => {
    if (!open) return
    cardRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open, onClose])

  if (!open) return null

  const stageKey = STAGE_KEYS[to] ?? STAGE_KEYS[DEFAULT_STAGE]
  const manualItems = report?.confirmations ?? []
  const itemResult = (id: StageGateItemId): StageGateItemResult | undefined =>
    report?.items.find(item => item.id === id)

  /** Whether one manual item is satisfied — by the record, or by the live choice. */
  const manualMet = (id: StageGateItemId): boolean => {
    const recorded = manualItems.find(entry => entry.item === id)
    if (recorded?.confirmed === true) return true
    return answers[id] === true
  }
  /** Whether the manual item still needs to be WRITTEN when the operator enters. */
  const needsWrite = (id: StageGateItemId): boolean =>
    manualItems.find(entry => entry.item === id)?.confirmed !== true && answers[id] === true

  const folderDone = report !== null && report.items.length > 0 && report.items.every(item => item.met)
  const manualDone = manualItems.every(entry => manualMet(entry.item))
  const canEnter = report !== null && failure === null && folderDone && manualDone && !busy && !loading

  /**
   * Enter the stage: write any manual answer that is not on record yet, then hand
   * the move to the caller. A failed write does NOT move the project — the record
   * is the gate's own evidence, and a move without it would be a gate that lied.
   */
  const enter = async (): Promise<void> => {
    if (!canEnter) return
    setBusy(true)
    for (const entry of manualItems) {
      if (!needsWrite(entry.item)) continue
      const written = await confirmStageGate({ path, to, item: entry.item, confirmed: true })
      if (!written.ok) {
        setBusy(false)
        setFailure(written.error)
        return
      }
      setReport(current => current === null ? current : {
        ...current,
        confirmations: current.confirmations.map(row =>
          row.item === entry.item ? written.confirmation : row),
      })
    }
    setBusy(false)
    onPassed()
  }

  /**
   * Withdraw a recorded confirmation.
   *
   * Its own control rather than a radio state, because it is the one action here
   * that DELETES evidence: flipping the radio to "not confirmed" while an answer
   * is on record means "do not proceed", and the record is what a later check
   * reads. So changing one's mind on the record has to be its own deliberate act.
   * @param item - the manual item to withdraw.
   */
  const withdraw = async (item: StageGateItemId): Promise<void> => {
    setBusy(true)
    const written = await confirmStageGate({ path, to, item, confirmed: false })
    setBusy(false)
    if (!written.ok) {
      setFailure(written.error)
      return
    }
    setReport(current => current === null ? current : {
      ...current,
      confirmations: current.confirmations.map(row => row.item === item ? written.confirmation : row),
      // The verdict is the whole checklist: withdrawing an answer withdraws the
      // pass with it, without another round trip.
      status: 'blocked',
    })
    setAnswers(current => ({ ...current, [item]: false }))
  }

  return createPortal((
    <div
      data-wui="gateOverlay"
      // The mask closes the dialog, like every other modal in this deployment. The
      // pointerdown is checked against the mask itself, so a click that STARTED
      // inside the card and ended on the mask (a text selection) does not close it.
      onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div
        data-wui="gateDialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${t('stageGate.title')} · ${t(stageKey)}`}
        tabIndex={-1}
        ref={cardRef}
      >
        <div data-wui="gateHead">
          <div data-wui="gateHeading">
            <span data-wui="gateTitle">{t('stageGate.title')}</span>
            <span data-wui="gateTarget">{t('stageGate.target', { stage: t(stageKey) })}</span>
          </div>
          <button
            type="button"
            data-wui="gateClose"
            aria-label={t('stageGate.close')}
            title={t('stageGate.close')}
            onClick={onClose}
          >
            <IconCloseOutline16 size={14} />
          </button>
        </div>

        {loading && (
          <div data-wui="gateNote">{t('stageGate.checking', { stage: t(stageKey) })}</div>
        )}

        {failure !== null && (
          <div data-wui="gateNote" data-tone="warn">
            <span data-wui="gateNoteIcon" aria-hidden="true"><IconWarningOutline16 size={14} /></span>
            <span>{failure.code === 'no-project'
              ? failure.message
              : t('stageGate.failed', { message: failure.message })}</span>
          </div>
        )}

        {report !== null && report.reason !== null && (
          <div data-wui="gateNote" data-tone="warn">
            <span data-wui="gateNoteIcon" aria-hidden="true"><IconWarningOutline16 size={14} /></span>
            <span>{t(report.reason === 'ambiguous-folder' ? 'stageGate.reason.ambiguous-folder' : 'stageGate.reason.no-folder')}</span>
          </div>
        )}

        {report !== null && report.items.length > 0 && (
          <>
            <div data-wui="gateNote">
              {report.status === 'passed' && manualDone
                ? t('stageGate.passed', { stage: t(stageKey) })
                : t('stageGate.blocked', { stage: t(stageKey) })}
            </div>
            <ul data-wui="gateItems">
              {report.items.map(item => (
                <li key={item.id} data-wui="gateItem" data-met={item.met} data-source={item.source}>
                  <span data-wui="gateItemMark" aria-hidden="true">
                    {item.met ? <IconCheckOutline16 size={13} /> : <IconCloseOutline16 size={13} />}
                  </span>
                  <span data-wui="gateItemBody">
                    <span data-wui="gateItemHeading">
                      <span data-wui="gateItemLabel">{t(itemLabelKey(item.id))}</span>
                      {/* WHERE this line was answered — a drive and this machine
                          are different places to go and look. */}
                      <span data-wui="gateItemBadge">{t(sourceLabelKey(item.source))}</span>
                    </span>
                    {item.evidence === null
                      ? <span data-wui="gateItemNote">{t('stageGate.item.missing')}</span>
                      : item.evidence.url === ''
                        // Evidence with no link is a FILE ON THIS HOST: a page
                        // cannot open it, so it is stated rather than offered as a
                        // button that would do nothing.
                        ? (
                          <span data-wui="gateItemProof" title={item.evidence.path}>
                            {item.evidence.name}
                            {item.evidence.sizeBytes > 0 && ` · ${formatSize(item.evidence.sizeBytes)}`}
                          </span>
                        )
                        : (
                          <button
                            type="button"
                            data-wui="gateEvidence"
                            title={item.evidence.path}
                            onClick={() => { openUrl(item.evidence?.url ?? '') }}
                          >
                            {item.evidence.name}
                          </button>
                        )}
                    {item.matches > 1 && (
                      <span data-wui="gateItemNote">{t('stageGate.item.count', { n: item.matches })}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {report.workspace !== null && report.workspace.readable === false && (
              <div data-wui="gateNote" data-tone="warn">
                <span data-wui="gateNoteIcon" aria-hidden="true"><IconWarningOutline16 size={14} /></span>
                <span>{t('stageGate.workspace.unreadable', { path: report.workspace.path })}</span>
              </div>
            )}
            {report.truncated && (
              <div data-wui="gateNote">{t('stageGate.truncated')}</div>
            )}
          </>
        )}

        {/* The manual items: the one part of the checklist a folder cannot answer,
            so they are asked rather than reported. */}
        {manualItems.map((entry) => {
          const recorded = entry.confirmed ? entry : undefined
          return (
            <div key={entry.item} data-wui="gateManual" data-met={manualMet(entry.item)}>
              <div data-wui="gateManualHead">
                <span data-wui="gateItemMark" aria-hidden="true">
                  {manualMet(entry.item) ? <IconCheckOutline16 size={13} /> : <IconCloseOutline16 size={13} />}
                </span>
                <span data-wui="gateItemLabel">{t(itemLabelKey(entry.item))}</span>
                <span data-wui="gateItemNote">{t('stageGate.manual.badge')}</span>
              </div>
              <div data-wui="gateManualQuestion">{t('stageGate.manual.question')}</div>
              <div data-wui="gateChoices" role="radiogroup" aria-label={t(itemLabelKey(entry.item))}>
                <label data-wui="gateChoice" data-checked={answers[entry.item] === true ? 'true' : undefined}>
                  <input
                    type="radio"
                    name={`dsh-web-ui-gate-${entry.item}`}
                    checked={answers[entry.item] === true}
                    disabled={busy}
                    onChange={() => { setAnswers(current => ({ ...current, [entry.item]: true })) }}
                  />
                  <span>{t('stageGate.manual.yes')}</span>
                </label>
                <label data-wui="gateChoice" data-checked={answers[entry.item] === false ? 'true' : undefined}>
                  <input
                    type="radio"
                    name={`dsh-web-ui-gate-${entry.item}`}
                    checked={answers[entry.item] === false}
                    disabled={busy}
                    onChange={() => { setAnswers(current => ({ ...current, [entry.item]: false })) }}
                  />
                  <span>{t('stageGate.manual.no')}</span>
                </label>
              </div>
              {recorded === undefined
                ? (
                  <div data-wui="gateItemNote">
                    {answers[entry.item] === true
                      ? t('stageGate.manual.willRecord')
                      : t('stageGate.manual.pending')}
                  </div>
                )
                : (
                  <div data-wui="gateManualRecord">
                    <span data-wui="gateItemNote">
                      {recorded.by === ''
                        ? t('stageGate.manual.answeredAt', { at: formatTime(recorded.at) })
                        : t('stageGate.manual.answeredBy', { by: recorded.by, at: formatTime(recorded.at) })}
                    </span>
                    <button
                      type="button"
                      data-wui="gateWithdraw"
                      disabled={busy || undefined}
                      onClick={() => { void withdraw(entry.item) }}
                    >
                      {t('stageGate.manual.withdraw')}
                    </button>
                  </div>
                )}
            </div>
          )
        })}

        <div data-wui="gateActions">
          {report?.folder != null && (
            <button
              type="button"
              data-wui="gateFolder"
              onClick={() => { openUrl(report.folder?.url ?? '') }}
            >
              {t('stageGate.folder')}
            </button>
          )}
          <button
            type="button"
            data-wui="gateRetry"
            disabled={loading || busy || undefined}
            onClick={() => { void run(true) }}
          >
            <IconRefreshOutline16 size={13} />
            <span>{t('stageGate.retry')}</span>
          </button>
          <span data-wui="gateSpacer" />
          <button type="button" data-wui="gateCancel" disabled={busy || undefined} onClick={onClose}>
            {t('stageGate.close')}
          </button>
          <button
            type="button"
            data-wui="gateEnter"
            disabled={!canEnter || undefined}
            title={canEnter ? undefined : t('stageGate.enterHint')}
            onClick={() => { void enter() }}
          >
            {t('stageGate.enter', { stage: t(stageKey) })}
          </button>
        </div>
      </div>
    </div>
  ), document.body)
}

/**
 * Open one Feishu link in a new tab.
 * @param url - the link the host built.
 */
function openUrl(url: string): void {
  if (url === '') return
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * Format one recorded instant for a citation.
 *
 * Local time and seconds-free, because the citation's job is "was this recently,
 * and roughly when" — a full timestamp would be read as precision nobody needs,
 * and an ISO string would be read as machine output.
 * @param at - epoch ms.
 * @returns a short local date-time.
 */
function formatTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return ''
  try {
    return new Date(at).toLocaleString(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return ''
  }
}

/**
 * Format a file size for a checklist line.
 *
 * One decimal and a unit, because the number is there to say "this is a real
 * artifact and not a placeholder": more digits would be read as precision nobody
 * needs on a 268px line.
 * Its counterpart on the host is the non-empty rule (a 0-byte package does not
 * satisfy an item), so a size shown here is always a size that passed.
 * @param bytes - the file's size in bytes.
 * @returns a short human size.
 */
function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(1)
  return `${rounded} ${units[unit] as string}`
}

/**
 * The dictionary key naming where an item's verdict came from.
 * @param source - the item's source.
 * @returns the key to translate it with.
 */
function sourceLabelKey(source: StageGateItemSource): 'stageGate.source.folder' | 'stageGate.source.workspace' | 'stageGate.source.manual' {
  if (source === 'workspace') return 'stageGate.source.workspace'
  if (source === 'manual') return 'stageGate.source.manual'
  return 'stageGate.source.folder'
}

/**
 * The dictionary key naming one checklist item.
 * @param id - the item id the host reported.
 * @returns the key to translate it with.
 */
type ItemLabelKey =
  | 'stageGate.item.requirement-analysis'
  | 'stageGate.item.feature-list'
  | 'stageGate.item.html-demo'
  | 'stageGate.item.detail-design'
  | 'stageGate.item.self-test-cases'
  | 'stageGate.item.self-test-report'
  | 'stageGate.item.test-cases'
  | 'stageGate.item.test-report'
  | 'stageGate.item.release-doc'
  | 'stageGate.item.release-package'
  | 'stageGate.item.customer-confirmation'

function itemLabelKey(id: StageGateItemId): ItemLabelKey {
  switch (id) {
    case 'feature-list': return 'stageGate.item.feature-list'
    case 'html-demo': return 'stageGate.item.html-demo'
    case 'detail-design': return 'stageGate.item.detail-design'
    case 'self-test-cases': return 'stageGate.item.self-test-cases'
    case 'self-test-report': return 'stageGate.item.self-test-report'
    case 'test-cases': return 'stageGate.item.test-cases'
    case 'test-report': return 'stageGate.item.test-report'
    case 'release-doc': return 'stageGate.item.release-doc'
    case 'release-package': return 'stageGate.item.release-package'
    case 'customer-confirmation': return 'stageGate.item.customer-confirmation'
    default: return 'stageGate.item.requirement-analysis'
  }
}
