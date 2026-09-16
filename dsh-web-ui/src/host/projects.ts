/**
 * The project's own record: the facts about a project that DSH does not hold.
 *
 * A DSH workspace is `{ path, title }` and nothing else — the name is the title,
 * and there is nowhere to put "which product this project is". The New Project
 * form asks that question anyway (see `NewProjectDialog`), so this module is
 * where the answer LIVES: one small JSON document, keyed by the project's
 * workspace path.
 *
 * ## Why a file, and why keyed by path
 *
 * The store is deliberately not a storage-domain unit: this plugin persists a
 * handful of fields for a handful of projects — the name, the two product
 * answers, and the Feishu folder the project owns — and a plain document is
 * something an operator can read, hand-edit and back up without knowing DSH's
 * storage internals. The file lives beside the harness's own storages
 * (`~/.dsh/storages/`), and `DSH_WEB_UI_PROJECTS_FILE` points it somewhere else
 * — which is also what the tests use, so no test touches the operator's real
 * records.
 *
 * The key is the workspace PATH rather than its id: the path is what the
 * operator recognizes, what survives a registry rebuild, and what the form
 * already has in hand when it submits. A workspace id is a runtime detail that
 * this plugin never sees on the host side.
 *
 * ## What a record is not
 *
 * It is not authoritative about the NAME. The workspace registry owns the title
 * (that is what `workspace.rename` writes, and what the sidebar renders), so this
 * record's `name` is a COPY of what the operator typed — kept so the edit dialog
 * can show what the project was called even if the registry is rebuilt, and kept
 * in step by the same submit that renames the workspace. A record that disagrees
 * with the registry is stale, not authoritative.
 *
 * @module dsh-web-ui/host/projects
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** What the operator said this project is. Mirrors the form's three answers. */
export type ProductBackground = 'new' | 'existing' | 'unsure'

/** One project's recorded facts. */
export interface ProjectRecord {
  /** The project's name as the operator last typed it (a copy of the title). */
  readonly name: string
  /** The workspace directory: the record's key. */
  readonly path: string
  /** A brand-new product, an existing one, or not yet decided. */
  readonly background: ProductBackground
  /** Chosen product card id; `''` unless `background` is `existing`. */
  readonly productCardId: string
  /**
   * The project's folder in this deployment's Feishu archive — the one created
   * when the project was created — or `''` when none has been established yet.
   *
   * It is recorded HERE because it is the only handle that survives: the folder
   * is created by a side effect the browser cannot see, and nothing else in DSH
   * remembers what Feishu made. A project created before this field existed (or
   * whose create failed) has none, and `GET /folder` is what adopts the folder
   * that is already there.
   */
  readonly larkFolderToken: string
  /** The folder's Feishu URL, recorded beside its token so the panel can link it. */
  readonly larkFolderUrl: string
  /**
   * The answers to the stage gate's MANUAL items, keyed `<gate>:<item>`.
   *
   * A manual item is a judgement — *has this been agreed with the customer?* — so
   * what is stored is not a flag but a citation: WHO answered and WHEN. It lives
   * on the project because that is what the judgement is about, and it survives
   * the harness restarting, which a page's own memory does not.
   *
   * An item answered "no" is ABSENT here rather than stored as `false`: for a gate,
   * "nobody has confirmed this" and "somebody said it does not hold" are the same
   * state, and a record that keeps only the affirmative can never be misread as
   * standing permission.
   */
  readonly gateConfirmations: Record<string, GateConfirmationRecord>
  /** Epoch ms of the last write, for a tie-break and for support. */
  readonly updatedAt: number
}

/** One recorded manual answer. */
export interface GateConfirmationRecord {
  /** Who gave the answer, as the host resolved their Feishu identity. */
  readonly by: string
  /** Epoch ms of the answer. */
  readonly at: number
}

/** The whole document, as it is stored. */
interface Document {
  /** Format marker: a future change can refuse an unknown layout loudly. */
  readonly version: 1
  /** Records by workspace path. */
  readonly projects: Record<string, ProjectRecord>
}

/** Environment variable that pins the document's location. */
const FILE_ENV = 'DSH_WEB_UI_PROJECTS_FILE'

/**
 * The document's default home: beside the harness's own storages.
 *
 * `DSH_HOME` is honoured when it is set, because that is the variable the
 * harness itself uses to relocate its state; otherwise the conventional
 * `~/.dsh` applies. A relocated home must take this file with it, which is why
 * the variable is read before falling back rather than hardcoded.
 * @returns the absolute path of the document.
 */
export function defaultProjectsFile(): string {
  const home = process.env['DSH_HOME']
  const root = home !== undefined && home !== '' ? home : join(homedir(), '.dsh')
  return join(root, 'storages', 'web_ui_projects.json')
}

/**
 * Resolve the document's path.
 * @returns the pinned path when set, else the default location.
 */
function filePath(): string {
  const pinned = process.env[FILE_ENV]
  return pinned !== undefined && pinned !== '' ? pinned : defaultProjectsFile()
}

/**
 * The directory this plugin keeps its documents in.
 *
 * Exported because a SECOND document has to land beside the first: the product
 * catalogue (`./products.ts`) is configuration of the same kind, and pinning one
 * file through `DSH_WEB_UI_PROJECTS_FILE` (as the tests do) must not leave the
 * other behind in the operator's real home.
 * @returns the absolute directory holding this plugin's documents.
 */
export function projectsDirectory(): string {
  return dirname(filePath())
}

/**
 * Narrow an unknown value to a product background.
 * @param value - the raw value.
 * @returns the background, defaulting to `unsure` for anything unrecognized.
 */
export function asBackground(value: unknown): ProductBackground {
  return value === 'new' || value === 'existing' || value === 'unsure' ? value : 'unsure'
}

/**
 * Read the recorded manual answers out of one raw record.
 *
 * Defensive in the same way every other field here is: a document written by an
 * older version has no such field (which is "nothing answered yet"), and an entry
 * whose shape is not a `{ by, at }` pair is dropped rather than rendered as a
 * citation nobody can read.
 * @param raw - the raw field.
 * @returns the answers by key, empty when nothing usable is there.
 */
function toConfirmations(raw: unknown): Record<string, GateConfirmationRecord> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const answers: Record<string, GateConfirmationRecord> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const entry = value as Record<string, unknown>
    const at = entry['at']
    if (typeof at !== 'number' || !Number.isFinite(at)) continue
    answers[key] = { by: typeof entry['by'] === 'string' ? entry['by'] : '', at }
  }
  return answers
}

/**
 * Read one record out of the parsed document.
 * @param raw - the raw record.
 * @param path - the key it was stored under.
 * @returns the record, or undefined when it is unusable.
 */
function toRecord(raw: unknown, path: string): ProjectRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const name = record['name']
  if (typeof name !== 'string') return undefined
  return {
    name,
    path,
    background: asBackground(record['background']),
    productCardId: typeof record['productCardId'] === 'string' ? record['productCardId'] : '',
    // Absent in every record written before projects had a Feishu folder, which
    // is `''` and not a repair: "no folder recorded yet" is the true state of
    // such a record, and `GET /folder` is what resolves it.
    larkFolderToken: typeof record['larkFolderToken'] === 'string' ? record['larkFolderToken'] : '',
    larkFolderUrl: typeof record['larkFolderUrl'] === 'string' ? record['larkFolderUrl'] : '',
    gateConfirmations: toConfirmations(record['gateConfirmations']),
    updatedAt: typeof record['updatedAt'] === 'number' ? record['updatedAt'] : 0,
  }
}

/** One project's facts, and how to write them. */
export interface ProjectStore {
  /**
   * Read one project's record.
   * @param path - the workspace directory.
   * @returns the record, or undefined when the project has none yet.
   */
  get: (path: string) => Promise<ProjectRecord | undefined>
  /**
   * Insert or replace one project's FORM facts: the name and the two product
   * answers.
   *
   * The Feishu folder is deliberately not this call's business. It is written by
   * {@link ProjectStore.setLarkFolder} — the create route and the adopt route —
   * and it is PRESERVED here even though this signature does not carry it: the
   * edit form writes these four fields and nothing else, so a record that lost
   * its folder token on every rename would make the panel forget a folder that
   * still exists in Feishu. Losing a folder is not a state an operator can
   * repair from the UI, so the store refuses to produce it.
   *
   * A reader never sees a half-written document: the write goes to a temporary
   * file in the same directory and is moved into place, so a crash mid-write
   * leaves the previous records intact (a rename is atomic within one
   * filesystem, which is why the temporary file is a SIBLING).
   * @param record - the form's fields; `updatedAt` is stamped here.
   * @returns the stored record.
   */
  put: (record: Omit<ProjectRecord, 'updatedAt' | 'larkFolderToken' | 'larkFolderUrl' | 'gateConfirmations'>) => Promise<ProjectRecord>
  /**
   * Record the project's Feishu folder, or adopt one for it.
   *
   * The name travels with it so a project that has no record at all still gets
   * one: a record whose only facts are "this path, this name, and this folder"
   * is more useful than an adopted folder nothing can show, and `unsure` is the
   * honest answer for a product background nobody was asked about.
   * @param input - the project's path, the folder, and the name to use when the
   * project has no record yet.
   * @returns the stored record.
   */
  setLarkFolder: (input: {
    path: string
    name: string
    folderToken: string
    url: string
  }) => Promise<ProjectRecord>
  /**
   * Record (or clear) one manual answer of one gate.
   *
   * It is a call of its own rather than a field of {@link ProjectStore.put}
   * because the two writes come from different surfaces and carry different
   * authority: the form writes what the operator typed, while this writes a
   * judgement the host itself witnessed (`by` is resolved from the operator's own
   * Feishu login, not sent by the page).
   *
   * A `confirmed: false` answer CLEARS the entry, so a withdrawn confirmation is
   * indistinguishable from one never given — see `gateConfirmations` for why that
   * is the honest encoding.
   * @param input - the project, the gate and item key, the answer, and the citation.
   * @returns the stored record.
   */
  setGateConfirmation: (input: {
    path: string
    name: string
    key: string
    confirmed: boolean
    by: string
    at: number
  }) => Promise<ProjectRecord>
  /** Read every record. */
  all: () => Promise<readonly ProjectRecord[]>
}

/**
 * Build the store over one document.
 *
 * Reads are per call rather than cached: the document is small, the panel's
 * writes are rare (a project is created or edited, not streamed), and a cache
 * would only add a way for an operator's hand-edit to go unnoticed.
 * @returns the store.
 */
export function createProjectStore(): ProjectStore {
  /**
   * Read and parse the document, tolerating every "not there yet" shape.
   *
   * A missing file, an empty one, a malformed one, and a future version are all
   * the same answer — no records — because none of them is a reason to refuse the
   * operator's NEXT write. A malformed document is overwritten by the next write,
   * which is the only repair available without guessing at intent.
   * @returns the records by path.
   */
  const load = async (): Promise<Record<string, ProjectRecord>> => {
    let text: string
    try {
      text = await readFile(filePath(), 'utf8')
    } catch {
      return {}
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      return {}
    }
    if (typeof parsed !== 'object' || parsed === null) return {}
    const document = parsed as Partial<Document>
    if (document.version !== 1 || typeof document.projects !== 'object' || document.projects === null) return {}
    const records: Record<string, ProjectRecord> = {}
    for (const [path, raw] of Object.entries(document.projects)) {
      const record = toRecord(raw, path)
      if (record !== undefined) records[path] = record
    }
    return records
  }

  /**
   * Write the whole document through a sibling temporary file.
   * @param records - the records to store.
   */
  const save = async (records: Record<string, ProjectRecord>): Promise<void> => {
    const target = filePath()
    await mkdir(dirname(target), { recursive: true })
    const document: Document = { version: 1, projects: records }
    const temporary = `${target}.${String(process.pid)}.tmp`
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
  }

  return {
    get: async (path) => (await load())[path],
    all: async () => Object.values(await load()),
    put: async (input) => {
      const records = await load()
      const previous = records[input.path]
      const record: ProjectRecord = {
        ...input,
        // See `ProjectStore.put`: the folder outlives the form that does not
        // carry it.
        larkFolderToken: previous?.larkFolderToken ?? '',
        larkFolderUrl: previous?.larkFolderUrl ?? '',
        // And so does a manual answer: the edit form asks about the product, not
        // about the customer conversation, so a rename must not withdraw one.
        gateConfirmations: previous?.gateConfirmations ?? {},
        updatedAt: Date.now(),
      }
      records[input.path] = record
      await save(records)
      return record
    },
    setLarkFolder: async (input) => {
      const records = await load()
      const previous = records[input.path]
      const record: ProjectRecord = {
        name: previous?.name ?? input.name,
        path: input.path,
        background: previous?.background ?? 'unsure',
        productCardId: previous?.productCardId ?? '',
        larkFolderToken: input.folderToken,
        larkFolderUrl: input.url,
        gateConfirmations: previous?.gateConfirmations ?? {},
        updatedAt: Date.now(),
      }
      records[input.path] = record
      await save(records)
      return record
    },
    setGateConfirmation: async (input) => {
      const records = await load()
      const previous = records[input.path]
      // The map is rebuilt rather than mutated: `previous` came out of a parse and
      // may be frozen by the caller's expectations, so editing it in place would
      // be a write into an object this module does not own.
      const answers: Record<string, GateConfirmationRecord> = { ...(previous?.gateConfirmations ?? {}) }
      if (input.confirmed) answers[input.key] = { by: input.by, at: input.at }
      else delete answers[input.key]
      const record: ProjectRecord = {
        name: previous?.name ?? input.name,
        path: input.path,
        background: previous?.background ?? 'unsure',
        productCardId: previous?.productCardId ?? '',
        larkFolderToken: previous?.larkFolderToken ?? '',
        larkFolderUrl: previous?.larkFolderUrl ?? '',
        gateConfirmations: answers,
        updatedAt: Date.now(),
      }
      records[input.path] = record
      await save(records)
      return record
    },
  }
}
