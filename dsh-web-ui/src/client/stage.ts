/**
 * The FDE delivery flow, as the browser sees it: the ordered nodes a project moves
 * through — ending at a TERMINAL 完成 node — in the operator's own words, plus
 * every view this plugin derives from the order.
 *
 * The flow is a LINE, not a checklist. Everything the tag renders follows from
 * that one order (`StageTag.tsx`): a node is `done` because it sits BEHIND the
 * current one, `current` because it IS it, and `pending` because it sits AHEAD of
 * it. There is therefore no per-node flag to keep in step — one index decides the
 * whole picture, which is why nothing here can go inconsistent.
 *
 * ## The line is walked, not jumped
 *
 * A move is ONE step forward, and only one: {@link canEnterStage} is the whole
 * rule the TAG applies, and it is what makes the flow a delivery pipeline rather
 * than a slider. Backward moves are refused for the same reason — the flow records
 * work that has been DONE, so "going back" would be un-recording it — and an
 * operator who finds an earlier node unfinished has the gated transition below to
 * stop them instead (see `src/shared/stagegatewire.ts` for the gates themselves).
 *
 * The consequence is deliberate: a node that is not the current one and not the
 * next one is LOCKED, and the lock is positional — one index still decides
 * everything, so there is no per-row lock flag either.
 *
 * ## The order is shared, and the node lives on the HOST
 *
 * Which nodes exist and in what order is the SHARED fact
 * (`src/shared/stageflow.ts`), because the node is persisted on the project's own
 * record and the host judges every move against it (see `src/host/projects.ts`).
 * This module adds the one thing the host must not know: the WORDS, mapped from
 * those stable ids — so a deployment can rename 完成 without touching what is
 * stored on disk.
 *
 * The record is the host's, so nothing here reads or writes a position: the tag
 * asks `larkapi.ts`, which asks `POST /project/stage`. What is still here is the
 * BRIDGE for a browser that recorded a node before the host did — see
 * {@link legacyStageIndexOf} — because that note only ever existed in one browser.
 *
 * Why the tag used to keep it in `localStorage` and why that changed: a note to
 * oneself kept a reload but not another browser, and correcting a mistake meant
 * opening devtools. The host was not an option while nothing there recorded
 * delivery progress; now that the project's record exists, the node belongs with
 * the other facts about a project that DSH itself has no field for.
 */
import { FLOW_STAGE_IDS, stageAt } from '../shared/stageflow.ts'
import type { FlowStageId } from '../shared/stageflow.ts'
import type { WebUiKey } from './locales.ts'

/**
 * Each node's dictionary key, by its shared id.
 *
 * The map is what keeps the two spellings of the flow — the ids the host knows and
 * the words the operator reads — from drifting: it is checked for COMPLETENESS
 * against `FlowStageId`, so adding a node to the flow without deciding what to
 * call it fails the typecheck instead of rendering a raw key.
 */
const STAGE_KEY_BY_ID = {
  requirement: 'stage.requirement',
  design: 'stage.design',
  development: 'stage.development',
  test: 'stage.test',
  deploy: 'stage.deploy',
  acceptance: 'stage.acceptance',
  /** The TERMINAL node: reaching it means the delivery is handed over. */
  done: 'stage.done',
} as const satisfies Record<FlowStageId, WebUiKey>

/** One node's dictionary key. */
export type StageKey = (typeof STAGE_KEY_BY_ID)[FlowStageId]

/**
 * The nodes, in delivery order — the SHARED order, read through the words above.
 *
 * Each entry is a DICTIONARY KEY, so the flow is spelled once and every surface
 * reads it in the operator's language. Nothing here may reorder it: a position in
 * this array is what the tag, the counter and the gate map all mean by "node n".
 */
export const STAGE_KEYS: readonly StageKey[] = FLOW_STAGE_IDS.map(id => STAGE_KEY_BY_ID[id])

/** Where a node sits relative to the current one. */
export type StageState = 'done' | 'current' | 'pending'

/** How many nodes the flow has: what the tag's counter counts to. */
export const STAGE_COUNT = STAGE_KEYS.length

/**
 * Where a project sits before anything is recorded: the FIRST node.
 *
 * The default is the beginning of the flow, not "unknown", because that is what a
 * project nobody has placed is: its requirements are the thing being worked out.
 * It is the display default for a record that holds no node — never for a node
 * that could not be READ, which is a state of its own (`StageTag.tsx`).
 */
export const DEFAULT_STAGE = 0

/**
 * The dictionary key of each state's word, kept here rather than built by
 * template string so the three keys are checked against the dictionary too.
 */
export const STAGE_STATUS_KEYS = {
  done: 'stage.status.done',
  current: 'stage.status.current',
  pending: 'stage.status.pending',
} as const satisfies Record<StageState, WebUiKey>

/**
 * The scope key of "no project is selected": one bucket, not a crash.
 *
 * It is still the tag's React identity for "the column is not scoped to a
 * project" — there is simply nothing to persist under it any more, because a node
 * belongs to a project and the host keys records by the project's directory.
 */
export const NO_PROJECT_SCOPE = '__none__'

/**
 * One node's word.
 *
 * Total by construction: a position outside the flow reads as the first node's
 * word rather than rendering nothing, which is the one answer a caller can always
 * do something with.
 * @param index - the node's position, possibly outside the flow.
 * @returns the dictionary key of that node's name.
 */
export function stageKeyAt(index: number): StageKey {
  const id = stageAt(index)
  return id === undefined ? STAGE_KEY_BY_ID.requirement : STAGE_KEY_BY_ID[id]
}

/**
 * Whether a node is the flow's END.
 *
 * The last node is terminal by definition: there is nothing after it to move on
 * to, so a project sitting on it has finished the delivery rather than started a
 * piece of work. Everything else about it stays positional.
 * @param index - the node being asked about.
 * @returns true when `index` is the final node of the flow.
 */
export function isFinalStage(index: number): boolean {
  return index === STAGE_COUNT - 1
}

/**
 * The word a node's row carries, given where the project is.
 *
 * Positional, with ONE exception that is itself a fact about the flow rather than
 * about the node: the terminal node is reached BY finishing, so while the project
 * sits on it the honest word is "已完成" and not "运行中" — nothing is running at
 * the end of a delivery. It is stated here, once, so the panel and the tag cannot
 * disagree about it.
 * @param index - the node being asked about.
 * @param current - the project's current node.
 * @returns the dictionary key of the row's status word.
 */
export function stageStatusKey(index: number, current: number): WebUiKey {
  if (index === current && isFinalStage(index)) return 'stage.status.finished'
  return STAGE_STATUS_KEYS[stageStateAt(index, current)]
}

/**
 * Where one node sits relative to the current one — the whole rule the tag renders
 * from.
 * @param index - the node being asked about.
 * @param current - the project's current node.
 * @returns `done` behind the current node, `current` on it, `pending` ahead.
 */
export function stageStateAt(index: number, current: number): StageState {
  if (index < current) return 'done'
  if (index === current) return 'current'
  return 'pending'
}

/**
 * Whether a node may be entered from the project's current node.
 *
 * One step forward is the ONLY move the flow allows: a jump would record work that
 * was never done, and a step back would un-record it. The host enforces the same
 * rule on the write (`ProjectStore.setStage`), and the tag applies it here so a
 * locked row is visible as locked before anything is asked.
 * @param current - the project's current node.
 * @param target - the node the operator clicked.
 * @returns true when `target` is exactly the next node.
 */
export function canEnterStage(current: number, target: number): boolean {
  return target === current + 1
}

/**
 * Whether one node is LOCKED: neither the node the project is at (which is not a
 * move) nor the one it may move to.
 *
 * The current node is deliberately not locked — it is the row the panel puts focus
 * on when it opens, and a disabled button cannot take focus — while its click is a
 * no-op (see `choose` in `StageTag.tsx`).
 * @param index - the node being asked about.
 * @param current - the project's current node.
 * @returns true when the row offers no move at all.
 */
export function isStageLocked(index: number, current: number): boolean {
  return index !== current && !canEnterStage(current, index)
}

/**
 * The storage key of the node this browser recorded before the host kept it.
 *
 * Kept as a VALUE rather than deleted history: it is what an upgrading operator's
 * browser still holds, and {@link legacyStageIndexOf} is the only reader.
 */
const LEGACY_STORE_KEY = 'dsh-web-ui.fde-stage'

/**
 * The node this browser recorded before the host held it.
 *
 * A ONE-WAY READ, and the whole migration: an operator whose project was
 * mid-delivery when the node moved to the host would otherwise be sent back to
 * 需求明确 by a change they never made. The tag reads this only while the host has
 * NO node for the project, sends it as the host's first registration, and never
 * consults it again — the host's record is the truth, and this is only how the old
 * truth reaches it.
 *
 * The key is deliberately NOT cleared once it has been used. A registration that
 * did not get through (the host was down, the browser refused the write) has to be
 * able to happen on the next visit, and a leftover note nothing reads is a far
 * smaller problem than a delivery position that was lost. Every failure mode —
 * blocked storage, a truncated value, a position written by an older version —
 * degrades to "this browser never recorded one", because a stale note must never
 * be able to move a project.
 * @param scopeKey - the project's scope key.
 * @returns the recorded position, or null when this browser holds none.
 */
export function legacyStageIndexOf(scopeKey: string): number | null {
  try {
    const raw = window.localStorage.getItem(LEGACY_STORE_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const value = (parsed as Record<string, unknown>)[scopeKey]
    // The old writer clamped before storing, so an out-of-range value can only
    // come from a hand-edit; clamping rather than trusting it keeps a hand-edit
    // from being read as a node the flow does not have.
    if (typeof value !== 'number' || !Number.isInteger(value)) return null
    return Math.min(STAGE_COUNT - 1, Math.max(0, value))
  } catch {
    return null
  }
}
