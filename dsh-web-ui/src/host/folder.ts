/**
 * Which Feishu folder belongs to one project — the one question two route
 * families ask, answered in one place.
 *
 * The Feishu document panel asks it to show a tree, and the FDE stage gate asks
 * it to know WHICH folder to check for a stage's outputs. Both must get the same
 * answer: two resolvers would be two adoption policies, and adoption WRITES to
 * the project's record, so a second policy would let the two surfaces adopt two
 * different folders for one project.
 *
 * The policy itself, in one paragraph: the RECORD is the authority when it holds
 * a token, because that token is the folder this project's creation actually
 * produced — it is not re-derived, not compared by name, and not affected by a
 * later rename in Feishu. With no token recorded, the archive is read once and
 * searched for folders whose name IS the project's name; exactly one match is
 * ADOPTED (written to the record, so the lookup happens once per project rather
 * than on every open), while zero and several are reported as states rather than
 * guessed at.
 *
 * The read needs `space:document:retrieve` on the `lark-cli` login, which is the
 * same scope the panel's listing needs. A login that cannot list cannot adopt
 * either, and the failure travels as a typed outcome so each route can render it
 * in its own words.
 *
 * @module dsh-web-ui/host/folder
 */
import { feishuUrl, type LarkEntry, type LarkFolder, type LarkOutcome } from './lark.ts'
import type { LarkCli } from './lark.ts'
import type { ProjectStore } from './projects.ts'

/** How a project's folder was found. */
export type FolderSource = 'record' | 'adopted' | 'missing' | 'ambiguous'

/** The answer: which folder, found how, and what else could have been it. */
export interface FolderResolution {
  /** Where the answer came from. */
  readonly source: FolderSource
  /** The name the caller asked about — the project's name as the sidebar shows it. */
  readonly name: string
  /** The folder, absent for `missing` and `ambiguous`. */
  readonly folder: LarkFolder | undefined
  /** Same-named folders the archive holds, for an ambiguous answer to offer. */
  readonly candidates: readonly LarkFolder[]
}

/** What a resolution needs, and what it may write. */
export interface FolderResolverInput {
  /** The Feishu adapter (one per host: its call queue is what serializes token refreshes). */
  readonly cli: LarkCli
  /** This plugin's project records — where an adopted folder is written. */
  readonly projects: ProjectStore
  /** The archive folder one subfolder per project lives in. */
  readonly parentToken: string
  /** How many candidates an ambiguous answer offers. */
  readonly maxCandidates: number
  /** One line when a folder is adopted, so the log says where a token came from. */
  readonly log: (message: string) => void
}

/** The resolver the routes share. */
export interface FolderResolver {
  /**
   * Resolve one project's folder.
   * @param input - the project's path, the name to search for, and whether to drop caches.
   * @returns the resolution, or a typed Feishu failure.
   */
  readonly resolve: (input: {
    path: string
    name: string
    refresh: boolean
  }) => Promise<LarkOutcome<FolderResolution>>
}

/**
 * Build the resolver.
 * @param input - the adapter, the record store, the archive token, and the knobs.
 * @returns the resolver the panel's route and the gate's route both use.
 */
export function createFolderResolver(input: FolderResolverInput): FolderResolver {
  const { cli, projects, parentToken, maxCandidates, log } = input

  const resolve: FolderResolver['resolve'] = async ({ path, name, refresh }) => {
    if (refresh) cli.invalidate()
    const record = await projects.get(path)
    const recorded = record?.larkFolderToken ?? ''
    if (recorded !== '') {
      return {
        ok: true,
        value: {
          source: 'record',
          name,
          folder: {
            name: record?.name ?? name,
            folderToken: recorded,
            url: (record?.larkFolderUrl ?? '') === '' ? feishuUrl('folder', recorded) : (record?.larkFolderUrl ?? ''),
          },
          candidates: [],
        },
      }
    }

    const listed = await cli.children({ folderToken: parentToken })
    if (!listed.ok) return listed
    const candidates = listed.value
      .filter((entry: LarkEntry) => entry.expandToken !== '' && entry.name === name)
      .map((entry: LarkEntry): LarkFolder => ({ name: entry.name, folderToken: entry.expandToken, url: entry.url }))

    if (candidates.length === 1) {
      const found = candidates[0] as LarkFolder
      const stored = await projects.setLarkFolder({ path, name, folderToken: found.folderToken, url: found.url })
      log(`adopted the existing Feishu folder \`${found.name}\` for ${stored.path}`)
      return { ok: true, value: { source: 'adopted', name, folder: found, candidates: [] } }
    }

    return {
      ok: true,
      value: {
        source: candidates.length === 0 ? 'missing' : 'ambiguous',
        name,
        folder: undefined,
        candidates: candidates.slice(0, maxCandidates),
      },
    }
  }

  return { resolve }
}
