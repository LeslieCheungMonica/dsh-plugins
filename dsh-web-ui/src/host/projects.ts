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
 * The store is deliberately not a storage-domain unit: this plugin persists four
 * fields for a handful of projects, and a plain document is something an operator
 * can read, hand-edit and back up without knowing DSH's storage internals. The
 * file lives beside the harness's own storages (`~/.dsh/storages/`), and
 * `DSH_WEB_UI_PROJECTS_FILE` points it somewhere else — which is also what the
 * tests use, so no test touches the operator's real records.
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
  /** Epoch ms of the last write, for a tie-break and for support. */
  readonly updatedAt: number
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
   * Insert or replace one project's record.
   *
   * A reader never sees a half-written document: the write goes to a temporary
   * file in the same directory and is moved into place, so a crash mid-write
   * leaves the previous records intact (a rename is atomic within one
   * filesystem, which is why the temporary file is a SIBLING).
   * @param record - the fields to store; `updatedAt` is stamped here.
   * @returns the stored record.
   */
  put: (record: Omit<ProjectRecord, 'updatedAt'>) => Promise<ProjectRecord>
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
      const record: ProjectRecord = { ...input, updatedAt: Date.now() }
      records[input.path] = record
      await save(records)
      return record
    },
  }
}
