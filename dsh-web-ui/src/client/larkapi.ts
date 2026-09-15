/**
 * The panel's read face over the host's Feishu routes and the project record.
 *
 * This module is deliberately dumb: it fetches five paths, validates only the
 * shape it depends on, and turns every outcome into either a value or a
 * *renderable* error. It holds no state and knows nothing about the tree the
 * component builds from these answers.
 *
 * Its subject is ONE folder — the Feishu folder this deployment created for a
 * project when the project was created — and the two questions the panel asks
 * about it are split between two calls, in the order they matter:
 *
 * 1. `readProjectFolder` — *which folder is this project's?* The host answers
 *    from the project's record, adopts an existing folder by name when the
 *    record has none, and reports "none" or "several" as content rather than as
 *    a failure (see `GET /folder` in `src/host/routes.ts`).
 * 2. `readLarkFiles` — *what is in it?* One page per call, and one call per
 *    subdirectory the operator expands.
 *
 * Two failure modes deserve their own handling rather than a generic throw:
 *
 * - The route answers HTML. That is the SPA fallback, which means the host half
 *   is not mounted (the plugin was rebuilt but the process was not restarted, or
 *   the webserver is not composed at all). "No answer" and "answered a page" are
 *   different operator problems, so they are different messages.
 * - The route answers `{ ok: false }`. The host already phrased that for a
 *   human (a missing CLI, an expired login, a login that lacks a scope), so the
 *   message is passed through with its code intact — the code is what lets the
 *   panel add the fix for that particular failure.
 *
 * @module dsh-web-ui/client/larkapi
 */
import type { ProductCard, ProductCardResult } from './productCards.ts'

/** The signed-in Feishu user, as the host reported it. */
export interface LarkUser {
  /** Display name; empty when the CLI could not read the profile. */
  readonly name: string
  /** English name when the tenant publishes one. */
  readonly enName: string
  /** The user's `open_id`. */
  readonly openId: string
  /** Avatar URL; empty when unavailable. */
  readonly avatarUrl: string
}

/** One entry in a Feishu folder: a document, an uploaded file, or a subfolder. */
export interface LarkEntry {
  /** The entry's own token; what a Feishu link addresses. */
  readonly token: string
  /**
   * The token to LIST when this entry is a directory, `''` when it is a leaf.
   *
   * A plain folder lists by its own token; a shortcut into a folder lists by its
   * target's. The host resolves both into this one field, so "has children" and
   * "what do I expand" are the same question here.
   */
  readonly expandToken: string
  /** `folder` | `docx` | `sheet` | `bitable` | `mindnote` | `slides` | `file` | `shortcut` | … */
  readonly type: string
  /** Title; empty for a handful of entries Feishu reports without one. */
  readonly name: string
  /** Browser link, built by the host; `''` only when Feishu's type has no layout. */
  readonly url: string
}

/** One page of one folder's children. */
export interface LarkLevel {
  /** The entries of this page. */
  readonly nodes: readonly LarkEntry[]
  /** Whether another page exists. */
  readonly hasMore: boolean
  /** Token for that page; null when there is none. */
  readonly pageToken: string | null
}

/** The panel's header facts. */
export interface LarkState {
  /** True when a user identity is present. */
  readonly loggedIn: boolean
  /** The signed-in user; null when nobody is signed in. */
  readonly user: LarkUser | null
}

/** One Feishu folder. */
export interface LarkFolder {
  /** The folder's name — the project's name, as the operator typed it. */
  readonly name: string
  /** The folder's token: what lists its contents and what an attach records. */
  readonly folderToken: string
  /** Shareable link; `''` when neither Feishu nor the host had one. */
  readonly url: string
}

/**
 * Where the folder the panel is about came from.
 *
 * `record` and `adopted` are both "here it is" — the difference is whether this
 * project already knew its folder or the host had to recognize it by name — and
 * the panel reads them the same way. `missing` and `ambiguous` are the two
 * states the operator has to resolve, and they are states rather than errors
 * because neither is a Feishu failure: no folder of that name exists yet, or
 * several do and only the operator knows which one is theirs.
 */
export type FolderSource = 'record' | 'adopted' | 'missing' | 'ambiguous'

/** What the host answered about a project's folder. */
export interface FolderResolution {
  /** The folder to browse; null when none is resolved. */
  readonly folder: LarkFolder | null
  /** How the folder was resolved, or why it was not. */
  readonly source: FolderSource
  /** Same-named folders the host found; offered when `source` is `ambiguous`. */
  readonly candidates: readonly LarkFolder[]
}

/** A failure the panel can render. */
export interface LarkError {
  /** Machine-readable kind (`cli-missing`, `not-logged-in`, `scope-missing`, …). */
  readonly code: string
  /** One line a human can act on. */
  readonly message: string
}

/** A read's outcome. */
export type LarkResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: LarkError }

/** Path prefix of the host's Feishu routes and project record. */
const PREFIX = '/dsh-web-ui/lark'

/**
 * Read one string field of an unknown record.
 * @param raw - the record, when it is one.
 * @param key - the field name.
 * @returns the value, or `''`.
 */
function str(raw: unknown, key: string): string {
  if (typeof raw !== 'object' || raw === null) return ''
  const value = (raw as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

/**
 * Normalize a folder record, dropping anything without a token.
 * @param raw - the wire record.
 * @returns the folder, or null.
 */
function toFolder(raw: unknown): LarkFolder | null {
  const folderToken = str(raw, 'folderToken')
  if (folderToken === '') return null
  return { name: str(raw, 'name'), folderToken, url: str(raw, 'url') }
}

/**
 * Normalize one entry record, dropping anything without a token.
 * @param raw - the wire record.
 * @returns the entry, or null.
 */
function toEntry(raw: unknown): LarkEntry | null {
  const token = str(raw, 'token')
  if (token === '') return null
  return {
    token,
    expandToken: str(raw, 'expandToken'),
    type: str(raw, 'type'),
    name: str(raw, 'name'),
    url: str(raw, 'url'),
  }
}

/**
 * Fetch one route and decode its envelope.
 * @param path - the path below the prefix, with its query string.
 * @param decode - how to build the value from the success body.
 * @param init - the request's method and body, for a mutating route.
 * @returns the decoded value or a renderable error.
 */
async function read<T>(
  path: string,
  decode: (body: Record<string, unknown>) => T,
  init?: RequestInit,
): Promise<LarkResult<T>> {
  let response: Response
  try {
    response = await fetch(`${PREFIX}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
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
    body = JSON.parse(text)
  } catch {
    return {
      ok: false,
      error: {
        code: 'unreachable',
        // The SPA fallback answers index.html with 200, so "not JSON" is the
        // signature of a host half that is not serving these routes.
        message: '宿主未提供飞书接口（返回的不是 JSON）。请重启 `dsh web` 后刷新页面。',
      },
    }
  }
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: { code: 'unreadable', message: '宿主返回了无法识别的数据。' } }
  }
  const record = body as Record<string, unknown>
  if (record['ok'] !== true) {
    const error = record['error']
    return {
      ok: false,
      error: {
        code: str(error, 'code') || 'failed',
        message: str(error, 'message') || '飞书接口调用失败。',
      },
    }
  }
  return { ok: true, value: decode(record) }
}

/**
 * Read the signed-in user.
 * @param refresh - whether to bypass the host's cache.
 * @returns the header facts or a renderable error.
 */
export function readLarkState(refresh = false): Promise<LarkResult<LarkState>> {
  return read(`/state${refresh ? '?refresh=1' : ''}`, (body) => ({
    loggedIn: body['loggedIn'] === true,
    user: toUser(body['user']),
  }))
}

/**
 * Normalize the wire user record.
 * @param raw - the wire record.
 * @returns the user, or null when nobody is signed in.
 */
function toUser(raw: unknown): LarkUser | null {
  if (typeof raw !== 'object' || raw === null) return null
  return {
    name: str(raw, 'name'),
    enName: str(raw, 'enName'),
    openId: str(raw, 'openId'),
    avatarUrl: str(raw, 'avatarUrl'),
  }
}

/**
 * Read which Feishu folder belongs to one project.
 *
 * `name` is the name the sidebar shows for the project. It travels with the
 * request because the host's record is not the authority on it (see
 * `src/host/projects.ts`), and it is what the host searches the archive for when
 * the project has no folder recorded.
 * @param input - the project's path, its name, and whether to drop host caches.
 * @returns the resolution or a renderable error.
 */
export function readProjectFolder(input: {
  path: string
  name: string
  refresh?: boolean | undefined
}): Promise<LarkResult<FolderResolution>> {
  const params = new URLSearchParams({ path: input.path })
  if (input.name.trim() !== '') params.set('name', input.name.trim())
  if (input.refresh === true) params.set('refresh', '1')
  return read(`/folder?${params.toString()}`, (body) => {
    const rows = body['candidates']
    const source = str(body, 'source')
    return {
      folder: toFolder(body['folder']),
      source: source === 'record' || source === 'adopted' || source === 'missing' || source === 'ambiguous'
        ? source
        : 'missing',
      candidates: Array.isArray(rows)
        ? rows.flatMap((row) => {
          const folder = toFolder(row)
          return folder === null ? [] : [folder]
        })
        : [],
    }
  })
}

/**
 * Read one page of one folder's children.
 * @param input - the folder, the page to continue from, and whether to drop host caches.
 * @returns the page or a renderable error.
 */
export function readLarkFiles(input: {
  folderToken: string
  pageToken?: string | undefined
  refresh?: boolean | undefined
}): Promise<LarkResult<LarkLevel>> {
  const params = new URLSearchParams({ folder: input.folderToken })
  if (input.pageToken !== undefined) params.set('pageToken', input.pageToken)
  if (input.refresh === true) params.set('refresh', '1')
  return read(`/files?${params.toString()}`, (body) => {
    const rows = body['nodes']
    const pageToken = body['pageToken']
    return {
      nodes: Array.isArray(rows)
        ? rows.flatMap((row) => {
          const entry = toEntry(row)
          return entry === null ? [] : [entry]
        })
        : [],
      hasMore: body['hasMore'] === true,
      pageToken: typeof pageToken === 'string' && pageToken !== '' ? pageToken : null,
    }
  })
}

/**
 * Pull a Drive folder token out of what an operator pasted.
 *
 * Feishu's own folder URL carries the token in its path
 * (`https://<tenant>.feishu.cn/drive/folder/<token>`), and an operator who has
 * the folder open in a browser has that URL and nothing else — so accepting it
 * is the difference between "point this project at the folder it already has"
 * and "create a second one". A bare token is accepted too, because the CLI's own
 * output prints them.
 * @param text - the pasted text.
 * @returns the token, or `''` when the text holds none.
 */
export function folderTokenFromInput(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return ''
  const inUrl = /\/folder\/([A-Za-z0-9_-]{1,128})/.exec(trimmed)
  if (inUrl !== null) return inUrl[1] ?? ''
  return /^[A-Za-z0-9_-]{1,128}$/.test(trimmed) ? trimmed : ''
}

/**
 * Create the project's folder inside this deployment's Feishu archive folder.
 *
 * Called after a project is created, as a side effect of its own, and from the
 * panel when a project has no folder yet. It never decides whether the project
 * exists, and its failure is reported rather than thrown at the caller.
 *
 * `name` is the PROJECT's name — what the operator typed into the New Project
 * form — and it becomes the folder's name. `path` travels too, so the host can
 * fall back to the directory's last segment when no name is given, and so the
 * host can RECORD the new folder onto the project, which is what lets the panel
 * find it later without reading the archive.
 *
 * The host CREATES here rather than looking first, so a project whose folder is
 * already there gets a second, same-named folder. That is this deployment's
 * decision, not an accident: see `createFolder` in `src/host/lark.ts`. The
 * panel's `readProjectFolder` is the looking half.
 * @param input - the project's directory and the project's name.
 * @returns the created folder, or a renderable error.
 */
export function createProjectFolder(input: {
  path: string
  name?: string | undefined
}): Promise<LarkResult<LarkFolder>> {
  const name = input.name?.trim() ?? ''
  return read('/folder', (body) => ({
    name: str(body, 'name'),
    folderToken: str(body, 'folderToken'),
    url: str(body, 'url'),
  }), {
    method: 'POST',
    // A blank name is omitted rather than sent empty: the host then derives it
    // from the path's last segment, which is exactly what a blank field means.
    body: JSON.stringify(name === '' ? { path: input.path } : { path: input.path, name }),
  })
}

/**
 * Use one folder for one project.
 *
 * This is the panel's answer to an ambiguous adoption, and the way an operator
 * points a project at a folder it already has. The host validates the token's
 * shape and records it; it does NOT verify that the folder exists, because the
 * listing that follows reports that in the panel's own words.
 * @param input - the project, the folder to use, and an optional link for it.
 * @returns the recorded folder, or a renderable error.
 */
export function attachProjectFolder(input: {
  path: string
  folderToken: string
  name?: string | undefined
  url?: string | undefined
}): Promise<LarkResult<LarkFolder>> {
  const name = input.name?.trim() ?? ''
  const url = input.url?.trim() ?? ''
  return read('/folder/attach', (body) => ({
    name: str(body, 'name'),
    folderToken: str(body, 'folderToken'),
    url: str(body, 'url'),
  }), {
    method: 'POST',
    body: JSON.stringify({
      path: input.path,
      folderToken: input.folderToken,
      ...(name === '' ? {} : { name }),
      ...(url === '' ? {} : { url }),
    }),
  })
}

/** One project's recorded facts, as the host stores them. */
export interface ProjectRecord {
  /** The project's name as it was last submitted. */
  readonly name: string
  /** The workspace directory: the record's key. */
  readonly path: string
  /** `new` | `existing` | `unsure`. */
  readonly background: string
  /** Chosen product card id; empty unless `background` is `existing`. */
  readonly productCardId: string
  /**
   * The project's folder in the Feishu archive, or `''` when none is recorded.
   *
   * The panel does not read this field directly — `readProjectFolder` answers
   * with the folder the host resolved — but it is part of the record the host
   * stores, and a caller that shows a project's stored facts sees the whole
   * record rather than a selection of it.
   */
  readonly larkFolderToken: string
  /** The folder's Feishu link, recorded beside its token. */
  readonly larkFolderUrl: string
  /** Epoch ms of the last write. */
  readonly updatedAt: number
}

/**
 * Read one project's record.
 *
 * `path` is the key, because it is the only identifier the browser has (see
 * `src/host/projects.ts` for why the path rather than a workspace id).
 * @param path - the project's workspace directory.
 * @returns the stored record (null when the project has none), or an error.
 */
export function readProjectRecord(path: string): Promise<LarkResult<ProjectRecord | null>> {
  const params = new URLSearchParams({ path })
  return read(`/project?${params.toString()}`, body => toRecord(body['project']))
}

/**
 * Read this deployment's product cards.
 *
 * Its own route rather than part of a project's record: the CREATE form needs the
 * catalogue before any project path exists.
 * @returns the catalogue, or a renderable error.
 */
export function readProductCards(): Promise<LarkResult<ProductCardResult>> {
  return read('/cards', (body): ProductCardResult => {
    const rows = body['cards']
    if (!Array.isArray(rows)) return { ok: true, cards: [] }
    const cards: ProductCard[] = []
    for (const row of rows) {
      const id = str(row, 'id')
      const name = str(row, 'name')
      if (id === '' || name === '') continue
      const detail = str(row, 'detail')
      cards.push(detail === '' ? { id, name } : { id, name, detail })
    }
    return { ok: true, cards }
  }).then((result): LarkResult<ProductCardResult> => result.ok
    // A malformed catalogue arrives as the route's error envelope; the form shows
    // that reason in place of the picker rather than an empty list.
    ? result
    : { ok: true, value: { ok: false, reason: 'failed', message: result.error.message } })
}

/**
 * Narrow one raw record.
 * @param raw - the wire record.
 * @returns the record, or null when there is none.
 */
function toRecord(raw: unknown): ProjectRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const updatedAt = (raw as Record<string, unknown>)['updatedAt']
  return {
    name: str(raw, 'name'),
    path: str(raw, 'path'),
    background: str(raw, 'background') || 'unsure',
    productCardId: str(raw, 'productCardId'),
    larkFolderToken: str(raw, 'larkFolderToken'),
    larkFolderUrl: str(raw, 'larkFolderUrl'),
    updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
  }
}

/**
 * Record one project's facts.
 *
 * The NAME is written here AND applied to the workspace by the caller: this
 * plugin's store is a sidecar (see `src/host/projects.ts`), so the registry
 * remains the authority for the title and this call keeps the copy in step. The
 * project's Feishu folder is NOT part of this call: the host keeps it, and the
 * record's own write path preserves it (see `ProjectStore.put`).
 * @param input - the fields to store.
 * @returns the stored record, or a renderable error.
 */
export function writeProjectRecord(input: {
  path: string
  name: string
  background: string
  productCardId: string
}): Promise<LarkResult<ProjectRecord | null>> {
  return read('/project', body => toRecord(body['project']), {
    method: 'POST',
    body: JSON.stringify(input),
  })
}
