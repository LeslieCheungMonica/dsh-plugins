/**
 * The browser half of the FDE stage gate: ask the host whether a project's
 * Feishu folder holds the outputs a stage requires.
 *
 * The module is deliberately dumb — it builds one URL, decodes one report, and
 * turns everything else into a renderable failure — because ALL the judgement
 * lives on the host: whether an entry satisfies an item is a fact about the
 * operator's folder, and a browser cannot read it (no `lark-cli`, no credential).
 *
 * The one decision this module does make is the shape of failure. A gate whose
 * check cannot be completed must not look like a pass, so every arm here ends in
 * `ok: false` with a sentence, and the caller (`StageTag.tsx`) treats both a
 * refusal and an unreadable answer as "stay where you are, and say why".
 * @module dsh-web-ui/client/stagegateapi
 */
import {
  STAGE_GATE_CHECK_PATH, STAGE_GATE_CONFIRM_PATH,
  type StageGateConfirmation, type StageGateEvidence, type StageGateItemId, type StageGateItemResult,
  type StageGateId, type StageGateItemSource, type StageGateReason, type StageGateReport,
} from '../shared/stagegatewire.ts'

/** A failure the dialog renders, in the operator's words. */
export interface StageGateFailure {
  /** A stable code: a Feishu failure's own (`not-logged-in`, `scope-missing`, …). */
  readonly code: string
  /** One sentence, already fit to show. */
  readonly message: string
}

/** The outcome of one check. */
export type StageGateResult =
  | { readonly ok: true; readonly report: StageGateReport }
  | { readonly ok: false; readonly error: StageGateFailure }

/** The outcome of recording (or withdrawing) one manual answer. */
export type StageGateConfirmResult =
  | { readonly ok: true; readonly confirmation: StageGateConfirmation }
  | { readonly ok: false; readonly error: StageGateFailure }

/**
 * Read one string field of a wire record.
 * @param raw - the record.
 * @param key - the field name.
 * @returns the value, or `''` when it is absent or not a string.
 */
function str(raw: unknown, key: string): string {
  if (typeof raw !== 'object' || raw === null) return ''
  const value = (raw as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

/** Every item id the client will render, so an unknown one is dropped rather than shown raw. */
const ITEM_IDS: readonly StageGateItemId[] = [
  'requirement-analysis', 'feature-list', 'html-demo',
  'detail-design', 'self-test-cases', 'self-test-report', 'test-cases', 'test-report',
  'release-doc', 'release-package', 'customer-confirmation',
]

/** Every gate id, so a report for a gate this build does not know is refused. */
const GATE_IDS: readonly StageGateId[] = [
  'requirement-to-design', 'design-to-development', 'development-to-test',
  'test-to-deploy', 'deploy-to-acceptance',
]

/**
 * Narrow a wire value to an item source.
 * @param value - the raw value.
 * @returns the source, defaulting to `folder` for an older host that sent none.
 */
function toSource(value: unknown): StageGateItemSource {
  return value === 'workspace' || value === 'manual' ? value : 'folder'
}

/**
 * Narrow a wire value to an item id.
 * @param value - the raw value.
 * @returns the id, or undefined when the host named something this build does not know.
 */
function toItemId(value: unknown): StageGateItemId | undefined {
  return typeof value === 'string' && (ITEM_IDS as readonly string[]).includes(value)
    ? value as StageGateItemId
    : undefined
}

/**
 * Decode one item result.
 * @param raw - the wire record.
 * @returns the item, or undefined when it carries no id this build knows.
 */
function toItem(raw: unknown): StageGateItemResult | undefined {
  const id = toItemId(typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['id'] : undefined)
  if (id === undefined) return undefined
  const record = raw as Record<string, unknown>
  const evidence = record['evidence']
  const matches = record['matches']
  const size = typeof evidence === 'object' && evidence !== null
    ? (evidence as Record<string, unknown>)['sizeBytes']
    : undefined
  return {
    id,
    source: toSource(record['source']),
    met: record['met'] === true,
    evidence: typeof evidence === 'object' && evidence !== null
      ? {
        name: str(evidence, 'name'),
        url: str(evidence, 'url'),
        path: str(evidence, 'path'),
        directory: (evidence as Record<string, unknown>)['directory'] === true,
        // A source that cannot report a size sends none: `0` is "unknown" here,
        // exactly as the host means it.
        sizeBytes: typeof size === 'number' && Number.isFinite(size) ? size : 0,
      } satisfies StageGateEvidence
      : null,
    // A count the host did not send is zero, not `NaN`: the card multiplies it
    // into a sentence ("还有 2 个"), and `NaN` there would be a visible bug.
    matches: typeof matches === 'number' && Number.isFinite(matches) ? matches : 0,
  }
}

/**
 * Decode one recorded manual answer.
 * @param raw - the wire record.
 * @returns the answer, or undefined when it names no item this build knows.
 */
function toConfirmation(raw: unknown): StageGateConfirmation | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const item = toItemId(record['item'])
  if (item === undefined) return undefined
  const at = record['at']
  return {
    item,
    confirmed: record['confirmed'] === true,
    by: str(record, 'by'),
    at: typeof at === 'number' && Number.isFinite(at) ? at : 0,
  }
}

/**
 * Decode a report.
 * @param raw - the wire record.
 * @returns the report, or undefined when the shape is unusable.
 */
function toReport(raw: unknown): StageGateReport | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const gate = record['gate']
  if (typeof gate !== 'string' || !(GATE_IDS as readonly string[]).includes(gate)) return undefined
  const reason = record['reason']
  const folder = record['folder']
  const workspace = record['workspace']
  const items = record['items']
  const confirmations = record['confirmations']
  return {
    gate: gate as StageGateId,
    status: record['status'] === 'passed' ? 'passed' : 'blocked',
    reason: reason === 'no-folder' || reason === 'ambiguous-folder' ? reason as StageGateReason : null,
    items: Array.isArray(items)
      ? items.flatMap((item) => {
        const decoded = toItem(item)
        return decoded === undefined ? [] : [decoded]
      })
      : [],
    // An unanswered manual item is one the HOST declined to answer, not one this
    // build should invent: the dialog asks about what the report names, and a
    // missing list renders as "nothing to ask", never as a silent pass.
    confirmations: Array.isArray(confirmations)
      ? confirmations.flatMap((entry) => {
        const decoded = toConfirmation(entry)
        return decoded === undefined ? [] : [decoded]
      })
      : [],
    folder: typeof folder === 'object' && folder !== null
      ? { name: str(folder, 'name'), url: str(folder, 'url') }
      : null,
    workspace: typeof workspace === 'object' && workspace !== null
      ? { path: str(workspace, 'path'), readable: (workspace as Record<string, unknown>)['readable'] !== false }
      : null,
    truncated: record['truncated'] === true,
  }
}

/**
 * Ask the host whether a project may enter one stage.
 * @param input - the project's path and the stage index being entered.
 * @returns the report, or a renderable failure.
 */
export async function checkStageGate(input: {
  path: string
  to: number
}): Promise<StageGateResult> {
  const params = new URLSearchParams({ path: input.path, to: String(input.to) })
  let response: Response
  try {
    // The path constant carries the prefix already: it is the two-ended literal
    // the host registers, so neither end may restate it (that is how a route ends
    // up requested under a doubled prefix, which reads as a 404 and looks like a
    // plugin that was never installed).
    response = await fetch(`${STAGE_GATE_CHECK_PATH}?${params.toString()}`, {
      headers: { accept: 'application/json' },
    })
  } catch (reason) {
    return {
      ok: false,
      error: {
        code: 'unreachable',
        message: reason instanceof Error ? reason.message : String(reason),
      },
    }
  }

  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text) as unknown
  } catch {
    return {
      ok: false,
      error: {
        code: 'unreachable',
        // The SPA fallback answers index.html with 200, so "not JSON" is the
        // signature of a host half that does not serve this route yet — which is
        // what a client bundle ahead of its host looks like.
        message: '宿主未提供门禁接口（返回的不是 JSON）。请重启 `dsh web` 后刷新页面。',
      },
    }
  }
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: { code: 'unreadable', message: '宿主返回了无法识别的门禁数据。' } }
  }

  const record = body as Record<string, unknown>
  if (record['ok'] !== true) {
    return {
      ok: false,
      error: {
        code: str(record['error'], 'code') || 'failed',
        message: str(record['error'], 'message') || '门禁校验失败。',
      },
    }
  }
  const report = toReport(record['report'])
  if (report === undefined) {
    return { ok: false, error: { code: 'unreadable', message: '宿主返回了无法识别的门禁数据。' } }
  }
  return { ok: true, report }
}

/**
 * Record — or withdraw — the operator's answer to one MANUAL item.
 *
 * The request carries the answer and NOT the identity: the host resolves who is
 * answering from the operator's own Feishu login, so a confirmation on record is
 * a citation rather than a claim.
 * @param input - the project, the stage being entered, the item, and the answer.
 * @returns the answer as recorded, or a renderable failure.
 */
export async function confirmStageGate(input: {
  path: string
  to: number
  item: StageGateItemId
  confirmed: boolean
}): Promise<StageGateConfirmResult> {
  let response: Response
  try {
    response = await fetch(STAGE_GATE_CONFIRM_PATH, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        path: input.path,
        to: input.to,
        item: input.item,
        confirmed: input.confirmed,
      }),
    })
  } catch (reason) {
    return {
      ok: false,
      error: {
        code: 'unreachable',
        message: reason instanceof Error ? reason.message : String(reason),
      },
    }
  }

  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text) as unknown
  } catch {
    return {
      ok: false,
      error: {
        code: 'unreachable',
        message: '宿主未提供门禁接口（返回的不是 JSON）。请重启 `dsh web` 后刷新页面。',
      },
    }
  }
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: { code: 'unreadable', message: '宿主返回了无法识别的门禁数据。' } }
  }
  const record = body as Record<string, unknown>
  if (record['ok'] !== true) {
    return {
      ok: false,
      error: {
        code: str(record['error'], 'code') || 'failed',
        message: str(record['error'], 'message') || '无法记录人工确认结果。',
      },
    }
  }
  const confirmation = toConfirmation(record['confirmation'])
  if (confirmation === undefined) {
    return { ok: false, error: { code: 'unreadable', message: '宿主返回了无法识别的门禁数据。' } }
  }
  return { ok: true, confirmation }
}
