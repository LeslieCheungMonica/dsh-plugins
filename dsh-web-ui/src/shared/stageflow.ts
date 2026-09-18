/**
 * The SHAPE of the FDE delivery flow: the nodes a project moves through, in
 * order, and the one rule that moves it.
 *
 * It is shared because both halves now need it and neither may import the other.
 * The browser DRAWS the flow (see `src/client/stage.ts`, which maps these ids to
 * the operator's own words), and the HOST validates a move, because the node
 * itself is persisted in the project's record (see `src/host/projects.ts`) and a
 * record the client can set to anything is not a record. The host must refuse
 * "jump straight to 完成" without importing a browser module, and the browser
 * must draw the flow without a round trip.
 *
 * ## Nodes are named by ID, and the record keeps the id
 *
 * The order below IS the flow — a position is a derived view of it. That is what
 * makes the persisted fact durable: inserting a node into the flow would
 * silently change what a stored `4` means, while a stored `'deploy'` still means
 * 上线部署. The one place an index still appears is the gate map
 * (`GATE_BY_ENTRY_STAGE` in `./stagegatewire.ts`), which was written against the
 * flow's order before this module existed and is read by index.
 *
 * ## None of this is copy
 *
 * These ids are not dictionary keys. The words live with the browser
 * (`src/client/locales.ts`), so this module can sit on both sides of the carrier
 * without dragging a browser type along — and a deployment can rename a node
 * without touching what is stored on disk.
 *
 * @module dsh-web-ui/shared/stageflow
 */

/**
 * The nodes, in delivery order.
 *
 * The last entry is the TERMINAL one: it is reached by the same one-step-forward
 * move as every other node, and there is nothing after it.
 */
export const FLOW_STAGE_IDS = [
  'requirement',
  'design',
  'development',
  'test',
  'deploy',
  'acceptance',
  /** The terminal node: the delivery is handed over rather than under way. */
  'done',
] as const

/** One node of the flow. */
export type FlowStageId = (typeof FLOW_STAGE_IDS)[number]

/**
 * Whether a value names a node of this flow.
 *
 * The host's gate on the way in: a request may only ever name a node this build
 * knows, so an unknown id is a bad request rather than a value stored for a
 * future version to misread.
 * @param value - the raw value, from a request body or a stored record.
 * @returns true when `value` is a node of this flow.
 */
export function isFlowStageId(value: unknown): value is FlowStageId {
  return typeof value === 'string' && (FLOW_STAGE_IDS as readonly string[]).includes(value)
}

/**
 * The node at a position in the flow.
 * @param index - a possibly out-of-range, possibly non-integer position.
 * @returns the node there, or undefined when the position is outside the flow.
 */
export function stageAt(index: number): FlowStageId | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= FLOW_STAGE_IDS.length) return undefined
  return FLOW_STAGE_IDS[index]
}

/**
 * Where a node sits in the flow.
 * @param id - the node.
 * @returns its position, counting from the first node.
 */
export function stageIndexOf(id: FlowStageId): number {
  return FLOW_STAGE_IDS.indexOf(id)
}

/**
 * The node after this one — the ONLY node a project at `id` may move to.
 * @param id - the node the project is at.
 * @returns the next node, or undefined at the terminal node.
 */
export function nextStageId(id: FlowStageId): FlowStageId | undefined {
  return stageAt(stageIndexOf(id) + 1)
}
