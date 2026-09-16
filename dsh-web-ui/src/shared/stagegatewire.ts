/**
 * The wire contract of the FDE stage gate: what the browser half asks before it
 * lets a project enter a stage, and every shape it reads back.
 *
 * It is shared by TYPE on both sides of the carrier and by VALUE for the route
 * path and the one fact both halves must agree on without asking each other:
 * WHICH transitions carry a gate. That map is the reason this module exists — a
 * client that gated a transition the host does not know about would send a
 * request the host refuses, and a host that gated one the client does not know
 * about would never be asked. Because the host half spawns processes and the
 * browser half must never see `node:*`, this module stays deliberately inert:
 * types, three strings, and two plain lookup functions.
 *
 * ## What a gate is here
 *
 * A gate guards the ENTRY to one stage: before a project may move into that
 * stage, a checklist of artifacts must be found. Every item is a named piece of
 * evidence, not a boolean flag — the answer carries WHICH entry satisfied an
 * item (its name, its link, and where in the folder it sits), because "missing
 * 功能清单" is only actionable next to "found 需求分析 v2.docx".
 *
 * ## Why the answer is never a refusal
 *
 * The route answers HTTP 200 for every outcome a page can render: `passed`,
 * `blocked`, and "the check could not run at all" (`ok: false` with a Feishu
 * failure code, exactly like every other Feishu-backed route in this plugin).
 * None of those is a transport failure, and the browser half must show all three
 * — a gate that silently disappears when the network hiccups is worse than one
 * that says it could not check.
 *
 * @module dsh-web-ui/shared/stagegatewire
 */

/** Path prefix of every route the stage gate owns. */
export const STAGE_GATE_ROUTE_PREFIX = '/dsh-web-ui/stage-gate'

/** The one route: *may this project enter that stage, and if not, why not*. */
export const STAGE_GATE_CHECK_PATH = `${STAGE_GATE_ROUTE_PREFIX}/check`

/**
 * The one route that WRITES: *record that a person answered a manual item*.
 *
 * A manual item is the one thing on a checklist a folder cannot answer, so its
 * answer has to be RECORDED — with who gave it and when — instead of inferred. It
 * is a POST for the same reason every other mutation in this plugin is: it changes
 * state, and a body is not a URL.
 */
export const STAGE_GATE_CONFIRM_PATH = `${STAGE_GATE_ROUTE_PREFIX}/confirm`

/**
 * The gates this plugin knows, keyed by the STAGE INDEX they guard the entry to.
 *
 * Stage indices are the client's own vocabulary (see `src/client/stage.ts`, whose
 * `STAGE_KEYS` is the order of the flow), and this module deliberately repeats
 * only the number: the host must be able to validate a request without importing
 * a browser module, and the client must be able to ask "is this transition
 * gated" without a round trip.
 *
 * One gate today. Adding one is a row here plus its requirements in
 * `src/host/stage-gate.ts` — and the flow's own order decides the number.
 */
export const GATE_BY_ENTRY_STAGE: Readonly<Record<number, StageGateId>> = {
  /** Entry to 技术选型与详设: 需求明确's own outputs must exist first. */
  1: 'requirement-to-design',
  /** Entry to 代码开发与自测: the design has to be written down first. */
  2: 'design-to-development',
  /** Entry to 测试环境验收: the self-test evidence has to exist first. */
  3: 'development-to-test',
  /** Entry to 上线部署: the test evidence has to exist first. */
  4: 'test-to-deploy',
  /**
   * Entry to 上线验收: the release document AND a built installer.
   *
   * The one gate whose checklist reaches OUTSIDE Feishu — see
   * {@link StageGateItemSource}.
   */
  5: 'deploy-to-acceptance',
}

/** Every gate this deployment runs, by the stage they guard the entry to. */
export type StageGateId =
  | 'requirement-to-design'
  | 'design-to-development'
  | 'development-to-test'
  | 'test-to-deploy'
  | 'deploy-to-acceptance'

/**
 * One required item of a gate.
 *
 * The ids are stable and shared: the host decides what satisfies one, and the
 * browser half names it in the operator's language (`stageGate.item.<id>` keys in
 * `src/client/locales.ts`), so the checklist's words are copy rather than data
 * travelling from the host.
 *
 * Two KINDS share the id space, and the difference is who can answer them:
 *
 * - a **folder item** is read from the project's Feishu folder (the host's job,
 *   with evidence: which entry satisfied it and where it sits);
 * - a **manual item** is a judgement a person makes — "has this been agreed with
 *   the customer?" is not a file — so the host can only report the ANSWER ON
 *   RECORD, and the operator is asked in the gate's own dialog.
 */
export type StageGateItemId =
  | 'requirement-analysis'
  | 'feature-list'
  | 'html-demo'
  | 'detail-design'
  | 'self-test-cases'
  | 'self-test-report'
  | 'test-cases'
  | 'test-report'
  | 'release-doc'
  | 'release-package'
  | 'customer-confirmation'

/**
 * Where an item's verdict comes from.
 *
 * Two sources, because two of this deployment's outputs live in different places
 * and only one of them is Feishu. A folder item is read from the project's own
 * Feishu folder with `lark-cli`; a WORKSPACE item is read from the project's local
 * directory on the host — that is where a built installer exists, and no Feishu
 * permission can see it. The distinction travels on every result so the dialog can
 * say which checklist line it is looking at.
 */
export type StageGateItemSource =
  /** The project's Feishu folder. */
  | 'folder'
  /** The project's local workspace directory. */
  | 'workspace'
  /** A person's answer, recorded on the project. */
  | 'manual'

/**
 * The manual items, by gate: the ones a person answers.
 *
 * Kept apart from the folder requirements so both halves can tell "the folder does
 * not hold it" from "nobody has answered yet" — which are different sentences to
 * an operator, and different fixes.
 */
export const STAGE_GATE_MANUAL_ITEMS: Readonly<Record<StageGateId, readonly StageGateItemId[]>> = {
  'requirement-to-design': ['customer-confirmation'],
  'design-to-development': [],
  'development-to-test': [],
  'test-to-deploy': [],
  'deploy-to-acceptance': [],
}

/** Whether one item is answered by a person rather than read from a folder. */
export function isManualItem(id: StageGateItemId): boolean {
  return Object.values(STAGE_GATE_MANUAL_ITEMS).some(items => items.includes(id))
}

/**
 * A manual item's recorded answer.
 *
 * `by` is resolved on the HOST from the operator's own Feishu login rather than
 * sent by the page: the whole value of recording a human judgement is that it
 * names the human, and a browser-supplied name is a name nobody checked.
 */
export interface StageGateConfirmation {
  /** Which manual item this answers. */
  readonly item: StageGateItemId
  /** True when it has been answered with "yes, this holds". */
  readonly confirmed: boolean
  /** Who recorded it; `''` when the host could not resolve an identity. */
  readonly by: string
  /** Epoch ms of the answer; `0` when nothing has been recorded. */
  readonly at: number
}

/** Where one satisfied item was found. */
export interface StageGateEvidence {
  /** The entry's own name in the folder. */
  readonly name: string
  /** The entry's Feishu link, so the operator can open the proof. */
  readonly url: string
  /**
   * The entry's path inside the project's folder, `/`-joined and starting at the
   * folder itself (`/需求/需求分析 v2`), because a match three levels down is only
   * meaningful next to where it was found.
   */
  readonly path: string
  /** True when the evidence is itself a directory rather than a document. */
  readonly directory: boolean
  /**
   * The entry's size in bytes, `0` when the source cannot say.
   *
   * It travels because it is what separates a BUILT artifact from a placeholder:
   * a package item requires a non-empty file (see `src/host/stage-gate.ts`), and a
   * 0-byte `setup.exe` is a file nobody built.
   */
  readonly sizeBytes: number
}

/** One item's verdict. */
export interface StageGateItemResult {
  /** Which artifact this is. */
  readonly id: StageGateItemId
  /** Where this item's verdict comes from. */
  readonly source: StageGateItemSource
  /** True when the artifact is there. */
  readonly met: boolean
  /** The first match, or `null` when the item is unmet. */
  readonly evidence: StageGateEvidence | null
  /** How many entries matched — one is enough, several are worth saying. */
  readonly matches: number
}

/**
 * Why a gate could not be evaluated at all.
 *
 * Distinct from "an item is missing": the fix is a different act (create or
 * associate the project's Feishu folder), and the operator should be told which
 * one it is instead of reading a checklist that was never read.
 */
export type StageGateReason =
  /** The project has no folder in the archive yet. */
  | 'no-folder'
  /** Several same-named folders exist, so which one holds the outputs is unknown. */
  | 'ambiguous-folder'

/** The verdict, as the route sends it. */
export interface StageGateReport {
  /** Which gate was evaluated. */
  readonly gate: StageGateId
  /**
   * `passed` only when every folder item is met AND every manual item is
   * confirmed on record.
   *
   * One status rather than two, so a caller cannot read "the artifacts are all
   * there" as permission to proceed: what the dialog shows is a checklist, and
   * the verdict is about the whole checklist.
   */
  readonly status: 'passed' | 'blocked'
  /** Set when the folder checklist could not be read; `null` when it was. */
  readonly reason: StageGateReason | null
  /**
   * Every verdict that was OBTAINED: folder items first (in the gate's own order),
   * then workspace items.
   *
   * A half that could not be read contributes nothing rather than reporting its
   * items as "unmet" — `reason` says the folder was never looked at, and claiming a
   * file is missing from a drive nobody opened would be a lie. Each result carries
   * its own `source`, so a reader can tell the two halves apart.
   */
  readonly items: readonly StageGateItemResult[]
  /**
   * Every MANUAL item of this gate with whatever is on record.
   *
   * Always one entry per manual item, answered or not, because the dialog has to
   * ask about the unanswered ones — an absent entry would be indistinguishable
   * from an item this build does not know.
   */
  readonly confirmations: readonly StageGateConfirmation[]
  /** The folder that was searched, so the dialog can link it. */
  readonly folder: { readonly name: string; readonly url: string } | null
  /**
   * The local workspace the workspace items were read from, and whether that read
   * worked at all.
   *
   * `readable: false` is a state rather than an error — a project whose directory
   * has been moved cannot satisfy a package item, and the dialog has to say WHY
   * instead of reporting a bare "not found" for a file nobody could look for.
   * `path` is echoed because it is what the host actually read: the page sent a
   * path, and a stale one is worth seeing.
   */
  readonly workspace: { readonly path: string; readonly readable: boolean } | null
  /**
   * True when a walk stopped at its own bound (the Feishu folder's, or the local
   * workspace's), so only part of it was read.
   *
   * It travels rather than being folded into `blocked` because it changes what
   * "missing" means: an item unmet by a truncated walk may exist further down, and
   * the dialog has to say so.
   */
  readonly truncated: boolean
}

/** Every item id this build knows, so a decode can reject one it does not. */
export const STAGE_GATE_ITEM_IDS: readonly StageGateItemId[] = [
  'requirement-analysis',
  'feature-list',
  'html-demo',
  'detail-design',
  'self-test-cases',
  'self-test-report',
  'test-cases',
  'test-report',
  'release-doc',
  'release-package',
  'customer-confirmation',
]

/**
 * The gate that guards entry to the stage at index `stage`, if any.
 *
 * A has-own-property read rather than a plain index: a stage with no gate must
 * answer `undefined` rather than inherit whatever `Object.prototype` happens to
 * carry, because the caller's next move is to advance the project.
 * @param stage - the stage index being entered.
 * @returns the gate id, or undefined when that transition is ungated.
 */
export function gateForEntryStage(stage: number): StageGateId | undefined {
  return Object.prototype.hasOwnProperty.call(GATE_BY_ENTRY_STAGE, stage)
    ? GATE_BY_ENTRY_STAGE[stage]
    : undefined
}
