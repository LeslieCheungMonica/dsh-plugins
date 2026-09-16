/**
 * The FDE stage gate, host side: *does this project's Feishu folder hold the
 * outputs the next stage requires?*
 *
 * ## What this is, and what it deliberately is not
 *
 * The flow's stages are the operator's own notes (see `src/client/stage.ts`), and
 * this module is the one exception: a transition the deployment has decided must
 * not be walked past on an empty folder. The decision is enforced HERE, on the
 * host, and the browser half only renders the verdict — because the check needs
 * the operator's Feishu login, and because a rule a page enforces is not a rule.
 *
 * It is NOT `dsh-stage-gate`'s gate. That plugin registers model-callable tools
 * (`gate_open`/`gate_check`) and refuses a non-agent caller, so a click in a
 * browser cannot reach it at all; what travelled instead is the SHAPE — a named
 * checklist, each item carrying evidence rather than a boolean, and a verdict of
 * PASS/BLOCK that names what is missing. The wire contract is
 * `src/shared/stagegatewire.ts`.
 *
 * ## Three kinds of item, and why they are not the same thing
 *
 * A gate's checklist holds three kinds of requirement, and the host's authority
 * differs for each:
 *
 * - a **folder item** (需求分析 / 详细设计 / 测试报告 / …) is READ from the project's
 *   Feishu folder: the host lists it and reports which entry satisfied the item, and
 *   where;
 * - a **workspace item** (安装包) is READ from the project's LOCAL DIRECTORY on this
 *   host. It is the one thing on a checklist Feishu cannot answer — a built
 *   installer exists as a file on the machine, not in a drive — and it is read with
 *   the same bounds discipline as the folder walk (depth, entry count, and a
 *   `truncated` report when a bound bites);
 * - a **manual item** (与客户需求确认) is ANSWERED by a person. The host cannot read
 *   a customer conversation, so all it can do is hold the answer on record — who
 *   said so and when — and report it. `POST /confirm` is where that answer is
 *   written, and the identity is resolved here from the operator's own Feishu
 *   login rather than trusted from the request.
 *
 * Passed means BOTH: every folder item met AND every manual item confirmed. That
 * is one status on purpose — a client must not be able to read "the artifacts are
 * all there" as permission to proceed.
 *
 * ## The three rules that make a gate trustworthy
 *
 * 1. **Fail closed, and say which failure it is.** A missing login, an
 *    unreachable Feishu, a project with no folder in the archive, an unanswered
 *    manual item: none of those is permission to enter a gated stage, and each
 *    owes the operator a different sentence. "I could not check" is NEVER reported
 *    as "passed".
 * 2. **A gate reads; the one write it owns is an answer.** The check lists the
 *    project's folder and the project's own directory, and creates nothing in
 *    either — no folder, no upload, no file. The two writes this module can produce
 *    are the shared resolver's adoption of a single same-named folder (the same
 *    adoption the panel performs) and the manual answer the operator gave in the
 *    dialog.
 * 3. **A partial read is reported as partial.** The walk is bounded (depth and
 *    folder count), and hitting the bound sets `truncated`, because "not found"
 *    from a walk that stopped early is a different fact from "not found".
 *
 * ## Matching
 *
 * An item is satisfied by the first folder entry whose NAME matches one of its
 * patterns — case-insensitively, at any depth of the project's own folder. Names
 * are matched rather than document contents: the outputs are the operator's own
 * deliverables in their own folder, and this deployment's convention is the name
 * on them. The patterns are data in `GATE_REQUIREMENTS` below, one row per
 * artifact, so a new required output is a row rather than a code path.
 *
 * @module dsh-web-ui/host/stage-gate
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  gateForEntryStage, STAGE_GATE_CHECK_PATH, STAGE_GATE_CONFIRM_PATH, STAGE_GATE_MANUAL_ITEMS,
  type StageGateConfirmation, type StageGateEvidence, type StageGateId, type StageGateItemId,
  type StageGateItemResult, type StageGateReason, type StageGateReport,
} from '../shared/stagegatewire.ts'
import type { FolderResolver } from './folder.ts'
import type { LarkCli, LarkEntry } from './lark.ts'
import { folderNameFromPath } from './lark.ts'
import type { ProjectStore } from './projects.ts'

/**
 * How deep below the project's folder the walk looks.
 *
 * Three levels is the shape this deployment's folders actually have
 * (`需求/需求分析/…`), and a deeper walk would spend requests on a tree nobody
 * puts deliverables in. The bound is reported when it bites (see `truncated`).
 */
const MAX_DEPTH = 3

/**
 * How many folders one check will list.
 *
 * A gate that a hostile or mistaken folder could turn into an unbounded fan-out
 * against a live API is not a gate, it is an outage: 60 folders at Feishu's
 * 50-per-page ceiling is far more than a project's deliverables ever need.
 */
const MAX_FOLDERS = 60

/**
 * How deep below the project directory the workspace walk looks.
 *
 * Four levels covers what a project actually looks like
 * (`dist/mac/订单中心.app/Contents/…`) without descending into a source tree's own
 * nesting, and the bound is reported when it bites (see `truncated`).
 */
const MAX_WORKSPACE_DEPTH = 4

/**
 * How many directory entries one workspace walk will look at.
 *
 * The counterpart of `MAX_FOLDERS`: a gate must not turn an enormous checkout into
 * an unbounded directory walk, and 4000 entries is far more than a delivery's
 * artifacts ever need.
 */
const MAX_WORKSPACE_ENTRIES = 4000

/**
 * Directory names the workspace walk does not enter.
 *
 * Dependencies, VCS metadata and tool caches are where an installer is NOT, and a
 * walk that spends its budget inside them finds nothing while missing the `dist/`
 * beside them. `dist`, `build`, `release` and `out` are deliberately absent from
 * this list: that is exactly where a built package lands.
 */
const PRUNED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', 'env', '__pycache__',
  '.next', '.nuxt', '.cache', '.turbo', '.gradle', '.idea', '.vscode', '.DS_Store',
])

/** One required artifact of one gate. */
interface GateRequirement {
  /** The shared item id the browser half names in the operator's language. */
  readonly id: StageGateItemId
  /**
   * Names that satisfy this item, matched case-insensitively as SUBSTRINGS.
   *
   * Substring rather than equality because the operator's own file names carry
   * versions, dates and project prefixes (`陕西二期-需求分析 v3`), and a gate that
   * only accepted an exact name would block work that is plainly there.
   */
  readonly patterns: readonly RegExp[]
}

/**
 * One workspace output of one gate: a file that has to exist on this host.
 *
 * Same shape as {@link GateRequirement} — an id and the name patterns that satisfy
 * it — because a checklist line is a checklist line wherever it is read from.
 */
interface WorkspaceRequirement {
  /** The shared item id the browser half names in the operator's language. */
  readonly id: StageGateItemId
  /** File names that satisfy this item, matched against the BASE name. */
  readonly patterns: readonly RegExp[]
}

/**
 * Every gate's FOLDER checklist, keyed by the gate.
 *
 * Each entry is the set of outputs the stage BEHIND the gate owes it: 需求明确 owes
 * the entry to 技术选型与详设, the design owes the entry to 代码开发与自测, and so on
 * down the flow. Patterns are matched case-insensitively against entry NAMES at any
 * depth of the project's folder.
 *
 * Two deliberate choices, because a gate that is too strict blocks real work and one
 * that is too loose is decoration:
 *
 * - **substring, not equality**, because the operator's own names carry versions,
 *   dates and project prefixes (`陕西二期-测试报告 v3`);
 * - **the synonyms a delivery actually uses** are listed rather than guessed at
 *   (`测试用例` and `测试案例`, `上线实施` and `实施方案`), so the gate matches the
 *   document the team wrote instead of the one this file imagined.
 */
const GATE_REQUIREMENTS: Readonly<Record<StageGateId, readonly GateRequirement[]>> = {
  'requirement-to-design': [
    { id: 'requirement-analysis', patterns: [/需求分析/i, /需求说明/i, /需求规格/i, /requirement/i] },
    { id: 'feature-list', patterns: [/功能清单/i, /功能列表/i, /feature\s*list/i] },
    { id: 'html-demo', patterns: [/demo/i, /\.html?$/i, /原型/i, /prototype/i] },
  ],
  // The design stage's own output: what 代码开发与自测 has to build from.
  'design-to-development': [
    { id: 'detail-design', patterns: [/详细设计/i, /详设/i, /详细方案/i, /detail(?:ed)?\s*design/i] },
  ],
  'development-to-test': [
    { id: 'self-test-cases', patterns: [/自测用例/i, /自测案例/i, /self[-\s]?test\s*cases?/i] },
    { id: 'self-test-report', patterns: [/自测报告/i, /自测结果/i, /self[-\s]?test\s*report/i] },
  ],
  'test-to-deploy': [
    { id: 'test-cases', patterns: [/测试用例/i, /测试案例/i, /test\s*cases?/i] },
    { id: 'test-report', patterns: [/测试报告/i, /测试结果/i, /test\s*report/i] },
  ],
  'deploy-to-acceptance': [
    { id: 'release-doc', patterns: [/上线实施/i, /实施文档/i, /上线方案/i, /实施方案/i, /release\s*(?:plan|doc)/i] },
  ],
}

/**
 * Every gate's WORKSPACE checklist: the outputs that exist as files on this host.
 *
 * One item today, and it is here because "打包完成的安装包" is not a Feishu document:
 * a delivery's installer lives in the project's own directory (usually under
 * `dist/` or `release/`), and no drive permission can see it. An item is satisfied
 * by a NON-EMPTY file whose name looks like a package — the extension list is what
 * "built" means on the platforms this deployment ships to, and the name keywords
 * catch the archives that carry no useful extension.
 */
const GATE_WORKSPACE_REQUIREMENTS: Readonly<Record<StageGateId, readonly WorkspaceRequirement[]>> = {
  'requirement-to-design': [],
  'design-to-development': [],
  'development-to-test': [],
  'test-to-deploy': [],
  'deploy-to-acceptance': [
    {
      id: 'release-package',
      patterns: [
        // Installers and bundles, by extension.
        /\.(?:dmg|pkg|exe|msi|apk|ipa|deb|rpm|jar|war|tgz|zip|7z)$/i,
        /\.tar\.gz$/i,
        // And the names a build system leaves behind when it carries no extension
        // worth matching (`订单中心-1.2.0-installer`, `setup-release`).
        /安装包/i, /installer/i, /setup/i, /\brelease[-_.]/i,
      ],
    },
  ],
}

/** One entry the walk collected, with where it was found. */
interface WalkedEntry {
  /** The entry as Feishu reported it. */
  readonly entry: LarkEntry
  /** Path inside the project's folder, `/`-joined and starting at `/`. */
  readonly path: string
}

/** What one folder walk produced. */
interface WalkResult {
  /** Every entry read, at every level. */
  readonly entries: readonly WalkedEntry[]
  /** True when a bound stopped the walk, so the folder was only partly read. */
  readonly truncated: boolean
}

/**
 * Read one project's folder, and everything below it, within the bounds above.
 *
 * Breadth-first over a queue of folders, so the SHALLOWEST entries are always
 * read first: if the bounds bite, what was missed is the deepest subtree rather
 * than an arbitrary branch, which is both the most predictable truncation and
 * the one a reader would guess.
 * @param cli - the Feishu adapter.
 * @param rootToken - the project's own folder.
 * @returns every entry read and whether the walk was cut short.
 */
async function walkFolder(cli: LarkCli, rootToken: string): Promise<{ ok: true; value: WalkResult } | { ok: false; code: string; message: string }> {
  const entries: WalkedEntry[] = []
  const queue: { token: string; path: string; depth: number }[] = [{ token: rootToken, path: '', depth: 0 }]
  let listed = 0
  let truncated = false

  while (queue.length > 0) {
    const current = queue.shift() as { token: string; path: string; depth: number }
    if (listed >= MAX_FOLDERS) {
      truncated = true
      break
    }
    listed += 1
    const level = await cli.files({ folderToken: current.token })
    if (!level.ok) return { ok: false, code: level.code, message: level.message }
    for (const entry of level.value.nodes) {
      const path = `${current.path}/${entry.name}`
      entries.push({ entry, path })
      if (entry.expandToken === '') continue
      if (current.depth < MAX_DEPTH) {
        queue.push({ token: entry.expandToken, path, depth: current.depth + 1 })
      } else {
        // A subtree this walk will not open is a subtree it did not read — and
        // that is exactly what `truncated` is for. Staying silent here was a real
        // bug: a deliverable one level below the bound left every item unmet with
        // `truncated: false`, which reads as "the folder does not hold it".
        truncated = true
      }
    }
    // A folder with more pages than the adapter reads in one call is itself a
    // partial read: the listing said so, so the report must too.
    if (level.value.hasMore) truncated = true
  }

  return { ok: true, value: { entries, truncated } }
}

/**
 * Build the checklist verdict from what the walk found.
 *
 * The first match wins each item and the rest are counted: which entry is the
 * evidence matters (the operator opens it), while how many others exist is worth
 * a number rather than a list in a dialog.
 * @param entries - every entry the walk read.
 * @param gate - the gate whose requirements apply.
 * @returns one result per required item, in the gate's own order.
 */
function evaluate(entries: readonly WalkedEntry[], gate: StageGateId): StageGateItemResult[] {
  return GATE_REQUIREMENTS[gate].map((requirement) => {
    const found = entries.filter(({ entry }) =>
      requirement.patterns.some(pattern => pattern.test(entry.name)))
    const first = found[0]
    if (first === undefined) {
      return { id: requirement.id, source: 'folder', met: false, evidence: null, matches: 0 }
    }
    const evidence: StageGateEvidence = {
      name: first.entry.name,
      url: first.entry.url,
      path: first.path,
      directory: first.entry.expandToken !== '',
      // Feishu's listing carries no size, and `0` is the honest "the source cannot
      // say" — the package rule that needs a size applies to workspace items only.
      sizeBytes: 0,
    }
    return { id: requirement.id, source: 'folder', met: true, evidence, matches: found.length }
  })
}

/** One file the workspace walk collected, with where it was found. */
interface WalkedFile {
  /** The file's base name. */
  readonly name: string
  /** Path inside the workspace, `/`-joined and starting at its root. */
  readonly path: string
  /** Size in bytes. */
  readonly sizeBytes: number
}

/** What one workspace walk produced. */
interface WorkspaceWalk {
  /** Every file read, at every level. */
  readonly files: readonly WalkedFile[]
  /** True when a bound stopped the walk, so the workspace was only partly read. */
  readonly truncated: boolean
  /** False when the directory could not be entered at all. */
  readonly readable: boolean
}

/**
 * Read the project's OWN directory, within bounds.
 *
 * The counterpart of {@link walkFolder}, for the outputs that are files on this
 * host rather than documents in a drive. Three rules, each of which exists because
 * of what a project directory actually contains:
 *
 * - **build and dependency directories are pruned** (`.git`, `node_modules`,
 *   virtualenvs, caches), because a walk that descends into them spends its whole
 *   budget on other people's files. `dist/`, `build/`, `release/` and `out/` are
 *   deliberately NOT pruned: that is where a built installer lands;
 * - **the bounds are reported, not silently obeyed**: depth 4, at most 4000 entries,
 *   and a `truncated` flag when either bites — the same discipline as the folder
 *   walk, because "not found" from a walk that stopped early is a different fact;
 * - **an unreadable directory is a state, not an error**: a project whose directory
 *   was moved cannot satisfy a package item, and the report says so instead of
 *   claiming the file is absent.
 * @param root - the project's absolute directory.
 * @returns the files read, whether the walk was cut short, and whether it could look.
 */
async function walkWorkspace(root: string): Promise<WorkspaceWalk> {
  const files: WalkedFile[] = []
  let truncated = false
  let entriesSeen = 0
  const queue: { dir: string; prefix: string; depth: number }[] = [{ dir: root, prefix: '', depth: 0 }]

  // The root itself has to be enterable for anything else to mean "not found".
  try {
    const stats = await stat(root)
    if (!stats.isDirectory()) return { files, truncated: false, readable: false }
  } catch {
    return { files, truncated: false, readable: false }
  }

  while (queue.length > 0) {
    const current = queue.shift() as { dir: string; prefix: string; depth: number }
    let rows: Dirent[]
    try {
      rows = await readdir(current.dir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      // A subtree this process may not enter is a subtree it did not read — which
      // is exactly what `truncated` is for, and never a reason to fail the check.
      truncated = true
      continue
    }
    for (const row of rows) {
      entriesSeen += 1
      if (entriesSeen > MAX_WORKSPACE_ENTRIES) {
        truncated = true
        break
      }
      const name = row.name
      if (PRUNED_DIRECTORIES.has(name)) continue
      const path = current.prefix === '' ? name : `${current.prefix}/${name}`
      if (row.isDirectory()) {
        if (current.depth < MAX_WORKSPACE_DEPTH) {
          queue.push({ dir: join(current.dir, name), prefix: path, depth: current.depth + 1 })
        } else {
          truncated = true
        }
        continue
      }
      if (!row.isFile()) continue
      let sizeBytes = 0
      try {
        sizeBytes = (await stat(join(current.dir, name))).size
      } catch {
        // A file that vanished between listing and stat is reported at size 0, which
        // is what a placeholder looks like — and a package item requires non-empty.
      }
      files.push({ name, path, sizeBytes })
    }
    if (entriesSeen > MAX_WORKSPACE_ENTRIES) break
  }

  return { files, truncated, readable: true }
}

/**
 * Build the WORKSPACE half of a checklist's verdict.
 *
 * The one rule beyond name matching: a package has to be NON-EMPTY. A 0-byte
 * `setup.exe` is a file nobody built, and a gate that accepted it would certify a
 * delivery on the strength of a placeholder.
 * @param files - every file the workspace walk read.
 * @param gate - the gate whose workspace requirements apply.
 * @returns one result per required item, in the gate's own order.
 */
function evaluateWorkspace(files: readonly WalkedFile[], gate: StageGateId): StageGateItemResult[] {
  return GATE_WORKSPACE_REQUIREMENTS[gate].map((requirement) => {
    const found = files.filter(file =>
      file.sizeBytes > 0 && requirement.patterns.some(pattern => pattern.test(file.name)))
    const first = found[0]
    if (first === undefined) {
      return { id: requirement.id, source: 'workspace', met: false, evidence: null, matches: 0 }
    }
    const evidence: StageGateEvidence = {
      name: first.name,
      // No link: this file is on the host, and a page cannot open it. The dialog
      // renders evidence with an empty URL as plain text (see StageGateDialog).
      url: '',
      path: `/${first.path}`,
      directory: false,
      sizeBytes: first.sizeBytes,
    }
    return { id: requirement.id, source: 'workspace', met: true, evidence, matches: found.length }
  })
}

/** The record key of one manual item's answer. */
export function confirmationKey(gate: StageGateId, item: StageGateItemId): string {
  return `${gate}:${item}`
}

/**
 * Read one gate's manual answers out of a project's record.
 *
 * One entry per manual item, answered or not: the dialog has to ASK about the
 * unanswered ones, and an absent entry would be indistinguishable from an item a
 * newer host knows about and this build does not.
 * @param gate - the gate whose manual items are being read.
 * @param record - the project's record, when it has one.
 * @returns the answer on record, or an unanswered entry.
 */
function confirmations(gate: StageGateId, record: { gateConfirmations: Record<string, { by: string; at: number }> } | undefined): StageGateConfirmation[] {
  return STAGE_GATE_MANUAL_ITEMS[gate].map((item) => {
    const answer = record?.gateConfirmations[confirmationKey(gate, item)]
    return answer === undefined
      ? { item, confirmed: false, by: '', at: 0 }
      : { item, confirmed: true, by: answer.by, at: answer.at }
  })
}

/**
 * Whether a report's checklist is fully satisfied.
 * @param items - the folder items.
 * @param answers - the manual answers.
 * @returns true when every item is met and every manual item is confirmed.
 */
function allSatisfied(items: readonly StageGateItemResult[], answers: readonly StageGateConfirmation[]): boolean {
  return items.every(item => item.met) && answers.every(answer => answer.confirmed)
}

/** The routes this module registers, and what they need to answer. */
export interface StageGateDeps {
  /** The Feishu adapter the panel uses — the SAME instance, so its call queue serializes both. */
  readonly cli: LarkCli
  /** This plugin's project records. */
  readonly projects: ProjectStore
  /** The shared folder resolver (one adoption policy for panel and gate). */
  readonly folders: FolderResolver
}

/** Content type of every response this module writes. */
const JSON_TYPE = 'application/json; charset=utf-8'

/**
 * Write one JSON response.
 * @param res - the response to own.
 * @param status - HTTP status.
 * @param body - the value to serialize.
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    // A verdict is a live fact about a folder someone is editing right now.
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Read the query string of a request.
 * @param req - the request.
 * @returns the parsed parameters (a bad URL yields an empty set).
 */
function query(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}

/** Largest request body this module will read, in bytes. */
const MAX_BODY_BYTES = 8 * 1024

/**
 * Read a JSON request body under a hard byte cap.
 * @param req - the request.
 * @returns the parsed value, or a message saying why it could not be read.
 */
async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > MAX_BODY_BYTES) return { ok: false, message: `the request body exceeds ${String(MAX_BODY_BYTES)} bytes` }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return { ok: false, message: 'the request body is empty' }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, message: 'the request body is not valid JSON' }
  }
}

/**
 * Register the stage gate's two routes.
 *
 * They are registered by `registerLarkRoutes` rather than by their own entry
 * point, because a gate must reuse the panel's Feishu adapter: the adapter's
 * serialize queue is what keeps two concurrent token refreshes from racing on one
 * credential file, and a second adapter instance would be a second queue.
 * @param ctx - a context where `webServer` is available.
 * @param deps - the shared adapter, project store, and folder resolver.
 */
export function registerStageGateRoutes(ctx: Context, deps: StageGateDeps): void {
  const log = ctx.logger('web-ui')

  /**
   * Answer one check: resolve the project's folder, read it, and evaluate the
   * whole checklist — folder items from the walk, manual items from the record.
   * @param path - the project's directory.
   * @param gate - the gate being asked about.
   * @param refresh - whether to drop the adapter's caches first.
   * @returns the wire body to send.
   */
  const check = async (path: string, gate: StageGateId, refresh: boolean): Promise<Record<string, unknown>> => {
    // The project's name travels with the path for the same reason the panel
    // sends it: the record is not the authority on the name, and the name is what
    // the archive is searched for when no folder is recorded.
    const record = await deps.projects.get(path)
    const name = (record?.name ?? '') !== '' ? (record?.name ?? '') : folderNameFromPath(path)
    if (name === '') return { ok: false, status: 400, body: { ok: false, error: { code: 'bad-request', message: `\`path\` names no directory: ${path}` } } }

    // Manual answers are read BEFORE the folder, because they are on record
    // rather than in Feishu: a project whose folder cannot be resolved still has
    // an answerable manual item, and the dialog must show it.
    const answers = confirmations(gate, record)

    // The workspace half is read FIRST and independently: it is local, it needs no
    // credential, and a project whose Feishu folder cannot be resolved still has a
    // directory on this host worth reporting on (see `workspace` in the report).
    const workspace = await walkWorkspace(path)
    const workspaceItems = evaluateWorkspace(workspace.files, gate)

    const resolved = await deps.folders.resolve({ path, name, refresh })
    if (!resolved.ok) {
      // A Feishu failure is content, like every other refusal in this plugin: the
      // dialog renders the reason, and the client does NOT advance (an
      // unanswerable gate is closed).
      return { ok: false, status: 200, body: { ok: false, error: { code: resolved.code, message: resolved.message } } }
    }
    const folder = resolved.value.folder
    if (folder === undefined) {
      const reason: StageGateReason = resolved.value.source === 'ambiguous' ? 'ambiguous-folder' : 'no-folder'
      const report: StageGateReport = {
        gate,
        status: 'blocked',
        reason,
        // The folder half was never read, so its items are absent rather than
        // "unmet" — the reason says why — while the workspace half travels.
        items: workspaceItems,
        confirmations: answers,
        folder: null,
        workspace: { path, readable: workspace.readable },
        truncated: workspace.truncated,
      }
      log.warn(`stage gate ${gate} could not be checked for ${path}: ${reason}`)
      return { ok: true, status: 200, body: { ok: true, report } }
    }

    const walked = await walkFolder(deps.cli, folder.folderToken)
    if (!walked.ok) {
      return { ok: false, status: 200, body: { ok: false, error: { code: walked.code, message: walked.message } } }
    }
    const items = [...evaluate(walked.value.entries, gate), ...workspaceItems]
    const report: StageGateReport = {
      gate,
      status: allSatisfied(items, answers) ? 'passed' : 'blocked',
      reason: null,
      items,
      confirmations: answers,
      folder: { name: folder.name, url: folder.url },
      workspace: { path, readable: workspace.readable },
      truncated: walked.value.truncated || workspace.truncated,
    }
    const missing = [
      ...items.filter(item => !item.met).map(item => `${item.id} (${item.source})`),
      ...answers.filter(answer => !answer.confirmed).map(answer => `${answer.item} (manual)`),
    ]
    if (!workspace.readable) log.warn(`stage gate ${gate} could not read the workspace ${path}`)
    log.info(
      `stage gate ${gate} for ${path}: ${report.status}`
      + (missing.length === 0 ? '' : ` (missing ${missing.join(', ')})`)
      + (report.truncated ? ' [partial read]' : ''),
    )
    return { ok: true, status: 200, body: { ok: true, report } }
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: STAGE_GATE_CHECK_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        try {
          if (req.method !== 'GET') {
            res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
            res.end()
            return
          }
          const params = query(req)
          const path = (params.get('path') ?? '').trim()
          if (path === '') {
            sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'the `path` parameter is required' } })
            return
          }
          // `to` names the stage being ENTERED, and only a stage that carries a
          // gate is a meaningful question: an ungated transition is entered
          // without asking the host at all, so asking here is a caller bug.
          const rawTo = (params.get('to') ?? '').trim()
          const to = Number.parseInt(rawTo, 10)
          if (!Number.isInteger(to) || String(to) !== rawTo) {
            sendJson(res, 400, {
              ok: false,
              error: { code: 'bad-request', message: `\`to\` must be a stage index: ${JSON.stringify(rawTo)}` },
            })
            return
          }
          const gate = gateForEntryStage(to)
          if (gate === undefined) {
            sendJson(res, 400, {
              ok: false,
              error: { code: 'bad-request', message: `stage ${String(to)} carries no gate` },
            })
            return
          }
          const answer = await check(path, gate, params.has('refresh'))
          sendJson(res, answer.status as number, answer.body)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          log.error(`stage gate check threw: ${reason}`)
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: 'internal', message: reason } })
          else res.end()
        }
      },
    }),
    'dsh-web-ui: stage gate check route',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: STAGE_GATE_CONFIRM_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        try {
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' })
            res.end()
            return
          }
          const body = await readJsonBody(req)
          if (!body.ok) {
            sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: body.message } })
            return
          }
          const record = typeof body.value === 'object' && body.value !== null
            ? body.value as Record<string, unknown>
            : {}
          const path = typeof record['path'] === 'string' ? record['path'].trim() : ''
          if (path === '') {
            sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '`path` must be a non-empty string' } })
            return
          }
          const rawTo = record['to']
          const to = typeof rawTo === 'number' ? rawTo : Number.NaN
          const gate = Number.isInteger(to) ? gateForEntryStage(to as number) : undefined
          if (gate === undefined) {
            sendJson(res, 400, {
              ok: false,
              error: { code: 'bad-request', message: '`to` must be a stage index whose transition carries a gate' },
            })
            return
          }
          // The item is checked against THIS gate's manual list, so a caller
          // cannot record an answer to an item that is read from the folder —
          // which would be a way to certify an artifact nobody looked at.
          const rawItem = record['item']
          if (typeof rawItem !== 'string' || !STAGE_GATE_MANUAL_ITEMS[gate].includes(rawItem as StageGateItemId)) {
            sendJson(res, 400, {
              ok: false,
              error: {
                code: 'bad-request',
                message: `${JSON.stringify(rawItem)} is not a manual item of ${gate}`,
              },
            })
            return
          }
          const item = rawItem as StageGateItemId
          const confirmed = record['confirmed'] === true

          // WHO answered is resolved HERE, from the operator's own Feishu login,
          // and never taken from the request: the whole value of recording a human
          // judgement is that it names the human, and a page-supplied name is one
          // nobody checked. A missing login leaves the citation blank rather than
          // refusing the answer — the confirmation is still the operator's.
          let by = ''
          if (confirmed) {
            const state = await deps.cli.state()
            if (state.ok) by = state.value.user?.name ?? ''
            else log.warn(`stage gate confirmation recorded without an identity: ${state.message}`)
          }

          const stored = await deps.projects.setGateConfirmation({
            path,
            name: folderNameFromPath(path),
            key: confirmationKey(gate, item),
            confirmed,
            by,
            at: confirmed ? Date.now() : 0,
          })
          const answer = confirmations(gate, stored).find(entry => entry.item === item)
            ?? { item, confirmed: false, by: '', at: 0 }
          log.info(
            `stage gate ${gate} manual item ${item} for ${path}: `
            + (confirmed ? `confirmed${by === '' ? '' : ` by ${by}`}` : 'withdrawn'),
          )
          sendJson(res, 200, { ok: true, confirmation: answer })
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          log.error(`stage gate confirm threw: ${reason}`)
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: 'internal', message: reason } })
          else res.end()
        }
      },
    }),
    'dsh-web-ui: stage gate confirm route',
  )
}
