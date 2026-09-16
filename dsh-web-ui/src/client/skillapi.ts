/**
 * The modal's read face over the host's marketplace route.
 *
 * Deliberately dumb, like `gitapi.ts`: it builds one URL, validates only the
 * envelope, and turns every outcome into either a value or a *renderable*
 * failure. It holds no state, no identity, and no token — the host derives the
 * token from the session cookie, and the browser never sees one. That is not a
 * detail of this module; it is why the route exists at all.
 *
 * It sends NOTHING of its own. No email, no query, no body: the two search
 * parameters are constants of what this deployment's marketplace means, and the
 * caller's identity travels as the cookie the browser already holds. A client
 * that could name the identity would be able to read somebody else's assets.
 *
 * The three failure modes are the ones `gitapi.ts` distinguishes, for the same
 * reasons: the SPA fallback answering HTML means the host half is not mounted
 * (rebuilt but not restarted), a rejected `fetch` means the GUI's own host is
 * gone, and `{ ok: false }` is the host's own sentence — which for this route is
 * the ordinary case, since an expired session, a refused token and an
 * unreachable internal host are all states a reader can be looking at.
 *
 * @module dsh-web-ui/client/skillapi
 */
import {
  SKILLS_INSTALL_PATH, SKILLS_INSTALLED_PATH, SKILLS_MARKET_PATH, SKILL_QUERY_MAX_LENGTH,
} from '../shared/skillswire.ts'
import type {
  AssetOwnership, InstalledSkill, InstalledSkillMarketSource, InstalledSkillRoot, InstalledSkillSnapshot,
  SkillError, SkillInstallRequest, SkillInstallResult, SkillMarketItem, SkillMarketSnapshot, SkillResponse,
} from '../shared/skillswire.ts'

/**
 * Build a failure value this module raises on its own (a transport-level
 * problem, as opposed to a domain answer the host phrased).
 * @param code - the machine code.
 * @param message - the human sentence.
 * @returns the failure arm of a response.
 */
function transportFail(code: SkillError['code'], message: string): { ok: false; error: SkillError } {
  return { ok: false, error: { code, message } }
}

/**
 * Read one object field as a string.
 * @param value - the container.
 * @param key - the field.
 * @returns the string, or '' when it is absent or not a string.
 */
function str(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  return typeof field === 'string' ? field : ''
}

/**
 * Map one wire item, defensively: the host is this plugin's own code, but a
 * field it dropped must degrade one card rather than fail the whole list.
 * @param raw - one element of `data.items`.
 * @returns the item.
 */
function toItem(raw: unknown): SkillMarketItem {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const slug = str(record, 'slug')
  const displayName = str(record, 'displayName')
  const ownership = str(record, 'assetOwnership')
  return {
    namespace: str(record, 'namespace'),
    slug,
    displayName: displayName === '' ? slug : displayName,
    summary: str(record, 'summary'),
    latestVersion: str(record, 'latestVersion'),
    assetOwnership: (ownership === 'PRIVATE' ? 'PRIVATE' : 'PUBLIC') as AssetOwnership,
  }
}

/**
 * Read the marketplace.
 *
 * A thrown `Error` would lose the machine code the modal switches on, so every
 * outcome is a {@link SkillResponse} — including the two transport failures this
 * module phrases itself, which are given codes from the same vocabulary so the
 * caller has exactly one thing to handle.
 * @returns the snapshot, or a coded failure.
 */
/**
 * Read one route's envelope.
 *
 * All three marketplace routes answer the same shape — `{ ok: true, data }` or
 * `{ ok: false, error }` — so the unwrapping lives here once, and each call below
 * is only about what it SENDS and how it maps what comes back.
 * @param url - the path plus query.
 * @param init - the request init; omitted for a plain GET.
 * @returns the envelope's data, or a coded failure.
 */
async function request(url: string, init?: RequestInit): Promise<SkillResponse<unknown>> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return transportFail('host-unmounted', `could not reach the DSH host: ${reason}`)
  }

  const text = await response.text()
  // The SPA fallback answers index.html for any unknown path. That is not a
  // network problem and must not be explained as one: it means this plugin's
  // HOST half does not know this route — the process is running a bundle from
  // before it existed — and the fix is a rebuild and a restart. Reporting it as
  // an unreachable provider sent a reader to check their VPN for a stale
  // process once already.
  if (text.trimStart().startsWith('<')) {
    return transportFail(
      'host-unmounted',
      'the DSH host answered a page instead of JSON — its host half is not mounted (rebuilt but not restarted?)',
    )
  }
  let body: unknown
  try {
    body = JSON.parse(text) as unknown
  } catch {
    return transportFail('unreadable', 'the DSH host answered something that is not JSON')
  }

  if (typeof body !== 'object' || body === null) {
    return transportFail('unreadable', 'the DSH host answered an empty envelope')
  }
  const envelope = body as Record<string, unknown>
  if (envelope['ok'] !== true) {
    const error = envelope['error']
    if (typeof error === 'object' && error !== null) {
      const record = error as Record<string, unknown>
      const code = str(record, 'code')
      const message = str(record, 'message')
      return { ok: false, error: { code: code as SkillError['code'], message } }
    }
    return transportFail('unreadable', 'the DSH host refused the read without saying why')
  }
  const data = envelope['data']
  if (typeof data !== 'object' || data === null) {
    return transportFail('unreadable', 'the DSH host answered no marketplace data')
  }
  return { ok: true, data }
}

/**
 * Read the marketplace, optionally narrowed by a search term.
 *
 * The term goes as `?q=`, which SkillHub matches against asset METADATA — not
 * against the contents of a package — and the two parameters that define this
 * deployment's catalogue stay host-side. An empty or blank term is not sent at
 * all: "no term" and "a term that happens to be empty" are the same request, and
 * only one of them needs saying.
 * @param term - the reader's search term.
 * @returns the snapshot, or a coded failure.
 */
export async function searchMarketSkills(term?: string): Promise<SkillResponse<SkillMarketSnapshot>> {
  const trimmed = (term ?? '').trim()
  // Capped here as well as on the route, so an over-long term is a sentence rather
  // than a round trip whose answer the reader would have to decode.
  if (trimmed.length > SKILL_QUERY_MAX_LENGTH) {
    return transportFail('bad-request', `search terms are limited to ${String(SKILL_QUERY_MAX_LENGTH)} characters`)
  }
  const query = trimmed === '' ? '' : `?q=${encodeURIComponent(trimmed)}`
  const answer = await request(`${SKILLS_MARKET_PATH}${query}`, { headers: { accept: 'application/json' } })
  if (!answer.ok) return answer
  const record = answer.data as Record<string, unknown>
  const rawItems = record['items']
  const items = Array.isArray(rawItems) ? rawItems.map(toItem) : []
  const total = record['total']
  return {
    ok: true,
    data: {
      items,
      total: typeof total === 'number' && Number.isFinite(total) ? total : items.length,
      verifiedEmail: str(record, 'verifiedEmail'),
    },
  }
}

/**
 * Read what is installed on this host.
 * @param projectPath - the selected project's directory, when there is one.
 * @returns the snapshot, or a coded failure.
 */
export async function listInstalledSkills(projectPath?: string): Promise<SkillResponse<InstalledSkillSnapshot>> {
  const query = projectPath === undefined || projectPath === ''
    ? ''
    : `?project=${encodeURIComponent(projectPath)}`
  const answer = await request(`${SKILLS_INSTALLED_PATH}${query}`, { headers: { accept: 'application/json' } })
  if (!answer.ok) return answer
  const record = answer.data as Record<string, unknown>
  const list = (key: string): InstalledSkill[] =>
    (Array.isArray(record[key]) ? record[key] as unknown[] : []).map(toInstalled)
  const roots: InstalledSkillRoot[] = (Array.isArray(record['roots']) ? record['roots'] as unknown[] : [])
    .map((raw): InstalledSkillRoot => {
      const entry = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
      return {
        source: str(entry, 'source') as InstalledSkillRoot['source'],
        path: str(entry, 'path'),
        exists: entry['exists'] === true,
        count: typeof entry['count'] === 'number' ? entry['count'] : 0,
      }
    })
  return { ok: true, data: { personal: list('personal'), shared: list('shared'), roots } }
}

/**
 * Install one marketplace skill.
 *
 * The one POST in this module, and the one call whose failure is EXPECTED in
 * ordinary use: `already-installed` is what a second click on an installed skill
 * answers, and it is rendered as a state rather than as an error.
 * @param install - the namespace and slug to install.
 * @returns where it landed, or a coded failure.
 */
export async function installMarketSkill(install: SkillInstallRequest): Promise<SkillResponse<SkillInstallResult>> {
  const answer = await request(SKILLS_INSTALL_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ namespace: install.namespace, slug: install.slug }),
  })
  if (!answer.ok) return answer
  const record = answer.data as Record<string, unknown>
  const name = str(record, 'name')
  if (name === '') return transportFail('unreadable', 'the DSH host reported an install without a name')
  const version = str(record, 'version')
  return {
    ok: true,
    data: {
      name,
      directory: str(record, 'directory'),
      files: typeof record['files'] === 'number' ? record['files'] : 0,
      bytes: typeof record['bytes'] === 'number' ? record['bytes'] : 0,
      version: version === '' ? undefined : version,
    },
  }
}

/**
 * Map one installed skill.
 * @param raw - one element of `personal` or `shared`.
 * @returns the skill.
 */
function toInstalled(raw: unknown): InstalledSkill {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const version = str(record, 'version')
  return {
    name: str(record, 'name'),
    description: str(record, 'description'),
    version: version === '' ? undefined : version,
    source: str(record, 'source') as InstalledSkill['source'],
    scope: str(record, 'scope') === 'personal' ? 'personal' : 'public',
    market: toMarketSource(record['market']),
  }
}

/**
 * Map one recorded marketplace origin.
 * @param raw - the `market` field.
 * @returns the origin, or undefined when the skill was not installed from SkillHub.
 */
function toMarketSource(raw: unknown): InstalledSkillMarketSource | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const namespace = str(record, 'namespace')
  const slug = str(record, 'slug')
  if (namespace === '' || slug === '') return undefined
  return { namespace, slug, version: str(record, 'version'), installedAt: str(record, 'installedAt') }
}
