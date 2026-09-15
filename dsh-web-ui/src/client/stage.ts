/**
 * The FDE delivery flow: the six ordered stages a project moves through, and the
 * one fact this plugin holds about it — which stage the project is at.
 *
 * The flow is a LINE, not a checklist. Everything the tag renders follows from
 * that one order (`StageTag.tsx`): a stage is `done` because it sits BEHIND the
 * current one, `current` because it IS it, and `pending` because it sits AHEAD
 * of it. There is therefore no per-stage flag to keep in step — one index
 * decides the whole picture, which is why nothing here can go inconsistent.
 *
 * The current stage is a per-PROJECT fact for the same reason the project
 * selection is: it describes one project's delivery, and the tag sits in a
 * project-scoped column. It lives in `localStorage` keyed by the project's
 * workspace id, so a reload and a project switch both keep their own stage
 * without this module holding any state.
 *
 * Why not the shared selection store (see `project.ts`): that store exists so
 * two registrations agree on one fact. This one has exactly one reader — the
 * tag — so a store would add a cross-slot contract for nothing.
 *
 * Why not the host: nothing on the host records delivery progress, and inventing
 * a record would make the tag lie about work the operator has not done here. It
 * is the operator's own note to themselves, and it is stored as one.
 */
import type { WebUiKey } from './locales.ts'

/**
 * The stages, in delivery order.
 *
 * Each entry is a DICTIONARY KEY, so the flow is spelled once and every surface
 * reads it in the operator's language — the `satisfies` clause is what keeps
 * that true: a stage added here without its copy fails the typecheck instead of
 * rendering a raw key.
 */
export const STAGE_KEYS = [
  'stage.requirement',
  'stage.design',
  'stage.development',
  'stage.test',
  'stage.deploy',
  'stage.acceptance',
] as const satisfies readonly WebUiKey[]

/** One stage of the flow. */
export type StageKey = (typeof STAGE_KEYS)[number]

/** Where a stage sits relative to the current one. */
export type StageState = 'done' | 'current' | 'pending'

/** How many stages the flow has: what the tag's counter counts to. */
export const STAGE_COUNT = STAGE_KEYS.length

/**
 * Where a project sits before anyone moves it: the FIRST stage.
 *
 * The default is the beginning of the flow, not "unknown", because that is what
 * a project without a recorded stage is: its requirements are the thing being
 * worked out.
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

/** Storage key of the persisted per-project stage map. */
const STORE_KEY = 'dsh-web-ui.fde-stage'

/** The scope key of "no project is selected": one bucket, not a crash. */
export const NO_PROJECT_SCOPE = '__none__'

/**
 * Force an index into the flow.
 * @param index - a possibly out-of-range, possibly non-numeric index.
 * @returns a valid stage index, falling back to the first stage.
 */
function clampStage(index: unknown): number {
  if (typeof index !== 'number' || !Number.isInteger(index)) return DEFAULT_STAGE
  return Math.min(STAGE_COUNT - 1, Math.max(0, index))
}

/**
 * Read the whole persisted map.
 *
 * Every failure mode (blocked storage, truncated JSON, a value written by an
 * older version, an array) degrades to "nothing recorded", because the tag's
 * only job is to show a stage: an unreadable note must never take the column
 * down, and must never stop the NEXT write from succeeding.
 * @returns the scope-key to index map, empty when nothing is readable.
 */
function readMap(): Record<string, unknown> {
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * The stage a project is at.
 * @param scopeKey - the project's scope key (see {@link NO_PROJECT_SCOPE}).
 * @returns the recorded stage index, or the first stage when none is recorded.
 */
export function readStage(scopeKey: string): number {
  return clampStage(readMap()[scopeKey])
}

/**
 * Record a project's stage.
 *
 * Persistence is best-effort by design: a browser that refuses `localStorage`
 * (private mode, a locked-down profile) still gets a working tag for this
 * session — it simply forgets the stage on reload, which is a smaller failure
 * than a control that does nothing when clicked.
 * @param scopeKey - the project's scope key.
 * @param index - the stage to record.
 */
export function writeStage(scopeKey: string, index: number): void {
  const map = readMap()
  map[scopeKey] = clampStage(index)
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(map))
  } catch {
    // See above: a refused write costs the reload, nothing else.
  }
}

/**
 * Where one stage sits relative to the current one — the whole rule the tag
 * renders from.
 * @param index - the stage being asked about.
 * @param current - the project's current stage index.
 * @returns `done` behind the current stage, `current` on it, `pending` ahead.
 */
export function stageStateAt(index: number, current: number): StageState {
  if (index < current) return 'done'
  if (index === current) return 'current'
  return 'pending'
}

