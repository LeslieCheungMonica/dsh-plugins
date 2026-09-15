/**
 * The panel's read face over the host's Feishu routes and the project record.
 *
 * This module is deliberately dumb: it fetches three paths, validates only the
 * shape it depends on, and turns every outcome into either a value or a
 * *renderable* error. It holds no state and knows nothing about the tree the
 * component builds from these answers.
 *
 * Two failure modes deserve their own handling rather than a generic throw:
 *
 * - The route answers HTML. That is the SPA fallback, which means the host half
 *   is not mounted (the plugin was rebuilt but the process was not restarted, or
 *   the webserver is not composed at all). "No answer" and "answered a page" are
 *   different operator problems, so they are different messages.
 * - The route answers `{ ok: false }`. The host already phrased that for a
 *   human (a missing CLI, an expired login), so the message is passed through.
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

/** One wiki space. */
export interface LarkSpace {
  /** Space id, or `my_library` for the personal knowledge base. */
  readonly spaceId: string
  /** Space name; empty when Feishu did not report one. */
  readonly name: string
  /** `my_library` | `team` | … */
  readonly spaceType: string
  /** `private` | `public` | … */
  readonly visibility: string
}

/** One wiki node. */
export interface LarkNode {
  /** Node token: the identity used to expand it and to build its URL. */
  readonly nodeToken: string
  /** Underlying document token. */
  readonly objToken: string
  /** `docx` | `sheet` | `bitable` | `slides` | `mindnote` | `file` | … */
  readonly objType: string
  /** `origin` | `shortcut`. */
  readonly nodeType: string
  /** Title; empty for a handful of nodes Feishu reports without one. */
  readonly title: string
  /** Whether this node has children — whether it behaves as a directory. */
  readonly hasChild: boolean
}

/** One page of a node level. */
export interface LarkLevel {
  /** The nodes of this page. */
  readonly nodes: readonly LarkNode[]
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
  /** The personal knowledge base; null when it did not resolve. */
  readonly space: LarkSpace | null
}

/** A failure the panel can render. */
export interface LarkError {
  /** Machine-readable kind (`cli-missing`, `not-logged-in`, `unreachable`, …). */
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
 * The personal knowledge base. Feishu exposes it as the per-user alias
 * `my_library` rather than a numeric space id, and never returns it from the
 * space list — so this is also the panel's default view.
 */
export const PERSONAL_SPACE_ID = 'my_library'

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
 * Normalize a node record, dropping anything without a token.
 * @param raw - the wire record.
 * @returns the node, or null.
 */
function toNode(raw: unknown): LarkNode | null {
  const nodeToken = str(raw, 'nodeToken')
  if (nodeToken === '') return null
  return {
    nodeToken,
    objToken: str(raw, 'objToken'),
    objType: str(raw, 'objType'),
    nodeType: str(raw, 'nodeType'),
    title: str(raw, 'title'),
    hasChild: typeof raw === 'object' && raw !== null && (raw as Record<string, unknown>)['hasChild'] === true,
  }
}

/**
 * Normalize a space record, dropping anything without an id.
 * @param raw - the wire record.
 * @returns the space, or null.
 */
function toSpace(raw: unknown): LarkSpace | null {
  const spaceId = str(raw, 'spaceId')
  if (spaceId === '') return null
  return {
    spaceId,
    name: str(raw, 'name'),
    spaceType: str(raw, 'spaceType'),
    visibility: str(raw, 'visibility'),
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
 * Read the signed-in user and the personal knowledge base.
 * @param refresh - whether to bypass the host's cache.
 * @returns the header facts or a renderable error.
 */
export function readLarkState(refresh = false): Promise<LarkResult<LarkState>> {
  return read(`/state${refresh ? '?refresh=1' : ''}`, (body) => ({
    loggedIn: body['loggedIn'] === true,
    user: toSpaceUser(body['user']),
    space: toSpace(body['space']),
  }))
}

/**
 * Normalize the wire user record.
 * @param raw - the wire record.
 * @returns the user, or null when nobody is signed in.
 */
function toSpaceUser(raw: unknown): LarkUser | null {
  if (typeof raw !== 'object' || raw === null) return null
  return {
    name: str(raw, 'name'),
    enName: str(raw, 'enName'),
    openId: str(raw, 'openId'),
    avatarUrl: str(raw, 'avatarUrl'),
  }
}

/**
 * Read the readable wiki spaces, personal knowledge base first.
 * @param refresh - whether to bypass the host's cache.
 * @returns the roster or a renderable error.
 */
export function readLarkSpaces(refresh = false): Promise<LarkResult<readonly LarkSpace[]>> {
  return read(`/spaces${refresh ? '?refresh=1' : ''}`, (body) => {
    const rows = body['spaces']
    if (!Array.isArray(rows)) return []
    return rows.flatMap((row) => {
      const space = toSpace(row)
      return space === null ? [] : [space]
    })
  })
}

/**
 * Read one level of wiki nodes.
 * @param input - the space, the parent node (absent for the root), and a page token.
 * @returns the level or a renderable error.
 */
export function readLarkNodes(input: {
  spaceId: string
  parentNodeToken?: string | undefined
  pageToken?: string | undefined
}): Promise<LarkResult<LarkLevel>> {
  const params = new URLSearchParams({ space: input.spaceId })
  if (input.parentNodeToken !== undefined) params.set('parent', input.parentNodeToken)
  if (input.pageToken !== undefined) params.set('pageToken', input.pageToken)
  return read(`/nodes?${params.toString()}`, (body) => {
    const rows = body['nodes']
    const pageToken = body['pageToken']
    return {
      nodes: Array.isArray(rows)
        ? rows.flatMap((row) => {
          const node = toNode(row)
          return node === null ? [] : [node]
        })
        : [],
      hasMore: body['hasMore'] === true,
      pageToken: typeof pageToken === 'string' && pageToken !== '' ? pageToken : null,
    }
  })
}

/** Feishu host of a wiki link: the brand-less form redirects to the tenant. */
const FEISHU_ORIGIN = 'https://feishu.cn'

/**
 * Build the shareable URL of a wiki node.
 * @param node - the node to link.
 * @returns the URL a browser can open (the user's own tenant resolves it).
 */
export function wikiUrl(node: LarkNode): string {
  return `${FEISHU_ORIGIN}/wiki/${node.nodeToken}`
}

/** The folder the host created for a project. */
export interface ProjectFolderResult {
  /** The folder's name — the project's name, as the archive shows it. */
  readonly name: string
  /** The new folder's token, usable for uploads and links. */
  readonly folderToken: string
  /** Shareable URL; empty when Feishu reported none. */
  readonly url: string
}

/**
 * Create the project's folder inside this deployment's Feishu folder.
 *
 * Called after a project is created, as a side effect of its own: it never
 * decides whether the project exists, and its failure is reported rather than
 * thrown at the project flow.
 *
 * `name` is the PROJECT's name — what the operator typed into the New Project
 * form — and it becomes the folder's name. `path` travels too, so the host can
 * fall back to the directory's last segment when no name is given; the host
 * validates `name` as a name (a plain segment, never a path) and owns the parent
 * folder, so this call cannot address a folder outside the archive.
 *
 * The host CREATES here rather than looking first, so a project whose folder is
 * already there gets a second, same-named folder. That is this deployment's
 * decision, not an accident: see `createFolder` in `src/host/lark.ts`.
 * @param input - the project's directory and the project's name.
 * @returns the created folder, or a renderable error.
 */
export function createProjectFolder(input: {
  path: string
  name?: string | undefined
}): Promise<LarkResult<ProjectFolderResult>> {
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
    updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
  }
}

/**
 * Record one project's facts.
 *
 * The NAME is written here AND applied to the workspace by the caller: this
 * plugin's store is a sidecar (see `src/host/projects.ts`), so the registry
 * remains the authority for the title and this call keeps the copy in step.
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
