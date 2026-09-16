/**
 * The wire contract of the skill marketplace: how the browser half asks what
 * SkillHub publishes, and every shape it reads back.
 *
 * Shared by TYPE on both sides of the carrier and by VALUE for the one route
 * path, the two fixed query parameters, and the token convention both halves
 * must describe the same way. It stays deliberately inert — types and strings,
 * no `node:*` and no `fetch` — because the host half is the only side allowed to
 * hold a credential.
 *
 * ## Why the two parameters are constants here, not arguments
 *
 * The deployment's marketplace is ONE question — "which FDE skills exist" — so
 * `packageType=SKILL` and `label=FDE` are not knobs a caller passes, they are
 * what this route means. Letting the browser choose them would turn a
 * single-purpose read into a general-purpose proxy into SkillHub, which is a
 * capability nobody asked for and a much larger surface to defend. They live in
 * this module rather than in the host handler so the client can render "what
 * this list is" from the same fact the request is built from.
 *
 * Everything else in the documented query — `q`, `department`,
 * `businessCategory`, `namespace`, `assetOwnership`, and `limit` itself — is
 * deliberately NOT sent, so the server's own defaults apply. That is why a
 * marketplace read can contain the reader's own PRIVATE assets as well as the
 * PUBLIC ones: see {@link SkillMarketItem.assetOwnership}.
 *
 * ## Why the answer is never a refusal
 *
 * A SkillHub error, an expired Feishu session, and an unreachable internal host
 * are all *content* this modal renders where the reader is looking, exactly like
 * every Feishu-backed route in this plugin: HTTP 200 with `ok: false` and a code
 * from {@link SkillFailure}. A 500 stays reserved for a genuine bug here, which
 * the browser reports generically. The `unreachable` code is not theoretical —
 * `acp.asiainfo-sec.com` does not resolve outside the company network, so a
 * deployment off the VPN hits it on every open.
 *
 * @module dsh-web-ui/shared/skillswire
 */

/** Path prefix of every route the marketplace owns. */
export const SKILLS_ROUTE_PREFIX = '/dsh-web-ui/skills'

/**
 * The catalogue read: *which FDE skills does SkillHub publish*.
 *
 * A GET, because browsing changes nothing. The family's other two routes differ
 * on exactly that axis: {@link SKILLS_INSTALL_PATH} WRITES (it unpacks a package
 * onto this machine, so it is a POST with a body), and
 * {@link SKILLS_INSTALLED_PATH} reads this host rather than SkillHub.
 *
 * ## Its one parameter, and why it is allowed
 *
 * `?q=` is the reader's search term. It is the only thing the browser may put in
 * this request, and the reason it does not break the rule that the CALLER does not
 * decide what is searched is that a term can only NARROW within the frame below:
 * {@link MARKET_PACKAGE_TYPE} and {@link MARKET_LABEL} are host-side constants and
 * stay on the request whatever the term says, so a term cannot name an identity,
 * ask for a different asset type, or reach assets this deployment does not
 * catalogue. It is also why the term is passed through rather than interpreted:
 * SkillHub decides what matches, and it matches asset METADATA (display name,
 * summary) rather than the contents of a package.
 */
export const SKILLS_MARKET_PATH = `${SKILLS_ROUTE_PREFIX}/market`

/**
 * Installing one marketplace skill: `POST` with `{ namespace, slug }`.
 *
 * A POST rather than a GET because it WRITES — it downloads a package and unpacks
 * it into this host's skill directory — and a body rather than a query because the
 * two fields are identifiers of a thing to create, not filters on a read.
 */
export const SKILLS_INSTALL_PATH = `${SKILLS_ROUTE_PREFIX}/install`

/**
 * What is installed on this host: `GET`, optionally with `?project=<path>`.
 *
 * The project is a PATH rather than an id because a skill root IS a path
 * (`<project>/.dsh/skills`), and because this plugin's column already resolves the
 * selected project's directory. It widens what is LISTED and nothing else: the
 * route never writes, and it reads only the roots {@link INSTALLED_ROOTS} names.
 */
export const SKILLS_INSTALLED_PATH = `${SKILLS_ROUTE_PREFIX}/installed`

/**
 * The provenance file the installer writes into every directory it creates.
 *
 * The marketplace's card has to know what is already installed, and the directory
 * name cannot answer that: a package's `SKILL.md` names the skill
 * `test-design-case-generator` while the marketplace calls the same asset
 * `命名空间测试` in namespace `ywaqtest`, slug `jcbfai7e`. Without a record, 已安装
 * would be lost on every reload — or worse, guessed from a name that never
 * matches.
 *
 * It lives INSIDE the skill's own directory rather than in one shared registry
 * file, so deleting the directory deletes the record: no state to orphan, and no
 * shared file for a half-finished install to corrupt.
 */
export const SKILL_SOURCE_FILE = '.dsh-web-ui-source.json'

/** Suffix appended to the reader's Feishu handle to form their SkillHub token. */
export const SKILL_TOKEN_SUFFIX = '-skillhub'

/**
 * Asset type this marketplace searches: skills, as opposed to a spec, an app, a
 * knowledge base, or an MCP server. The documented values are
 * `SKILL / SPEC / APP / KNOWLEDGE / MCP`.
 */
export const MARKET_PACKAGE_TYPE = 'SKILL'

/** The label this marketplace searches: the FDE delivery flow's own skills. */
export const MARKET_LABEL = 'FDE'

/**
 * Longest search term this deployment accepts, for the market's `?q=`.
 *
 * Shared with the browser so the input and the route agree: the field refuses to
 * grow past it, and the route refuses a term past it (a hand-made request is not
 * something the input can prevent). Well under any URL limit, and far longer than
 * any real skill name.
 */
export const SKILL_QUERY_MAX_LENGTH = 100

/**
 * Which audience an asset belongs to, as SkillHub words it.
 *
 * `PRIVATE` is why the modal names the identity it read as: because
 * `assetOwnership` is not sent, a marketplace answer can include the reader's
 * OWN private assets, and a list that mixes them with public ones without
 * saying so is a list the reader cannot reason about.
 */
export type AssetOwnership = 'PUBLIC' | 'PRIVATE'

/** One published skill, as the search answer carries it. */
export interface SkillMarketItem {
  /** The namespace the skill is published under. */
  readonly namespace: string
  /** The skill's unique identifier within its namespace. */
  readonly slug: string
  /**
   * The display name the asset centre shows. This is the CARD TITLE: `slug` is
   * a packaging identifier (`order-center-rework`), not a name a reader reads.
   */
  readonly displayName: string
  /** The one-line introduction — `summary` in the wire, the card's body here. */
  readonly summary: string
  /** The latest published version, e.g. `1.2.0`. */
  readonly latestVersion: string
  /** Whether this asset is public or belongs to one person. */
  readonly assetOwnership: AssetOwnership
}

/** A successful marketplace read. */
export interface SkillMarketSnapshot {
  /** The matches, in the server's order. */
  readonly items: readonly SkillMarketItem[]
  /** How many matched in total, which can exceed {@link items} (`limit` applies). */
  readonly total: number
  /**
   * The account SkillHub says the token belongs to (`/auth/whoami`'s `email`).
   *
   * It travels with the answer so the modal can name the identity the list was
   * read as — the same reason {@link SkillMarketItem.assetOwnership} is on every
   * item. It is NOT a second source of identity: the host has already proved the
   * caller's session, and a mismatch here is reported by comparing the two, not
   * by trusting this field.
   */
  readonly verifiedEmail: string
}

/** One marketplace skill to install. */
export interface SkillInstallRequest {
  /** The namespace the skill is published under, exactly as the search returned it. */
  readonly namespace: string
  /** The skill's slug within that namespace. */
  readonly slug: string
}

/** What an install wrote, and where. */
export interface SkillInstallResult {
  /** The installed skill's loader-valid name — also its directory name. */
  readonly name: string
  /** Absolute path of the directory that was created. */
  readonly directory: string
  /** How many files were unpacked (the provenance file is not counted). */
  readonly files: number
  /** How many bytes those files hold. */
  readonly bytes: number
  /** The version the package declared, when its frontmatter carried one. */
  readonly version: string | undefined
}

/**
 * Which of this host's skill roots an installed skill was found in.
 *
 * The five names are the loader's own, so a reader comparing this list with the
 * loader's behaviour is comparing the same words. {@link InstalledSkillRoot}
 * describes which of them this modal shows and how they are split.
 */
export type InstalledSkillSource =
  | 'user-dsh'
  | 'user-agents'
  | 'project-dsh'
  | 'project-agents'
  | 'bundled'

/**
 * The scope a skill is filed under in the modal.
 *
 * `personal` is the reader's own: the directory the marketplace INSTALLS into, so
 * every skill this plugin put on the machine lands there and nowhere else.
 * `public` is everything the deployment or the project brought — the shared
 * agents root, the project's two roots, and the bundled root — none of which this
 * plugin writes to.
 */
export type InstalledSkillScope = 'personal' | 'public'

/** One skill found on disk. */
export interface InstalledSkill {
  /** The name its `SKILL.md` declares, which is also how the loader keys it. */
  readonly name: string
  /** The one-sentence description from the same frontmatter. */
  readonly description: string
  /** The frontmatter's own version, when it declares one. */
  readonly version: string | undefined
  /** Which root it was found in. */
  readonly source: InstalledSkillSource
  /** Which block of the modal it belongs in. */
  readonly scope: InstalledSkillScope
  /**
   * Where the marketplace says it came from, when this plugin installed it.
   *
   * Read from the provenance file ({@link SKILL_SOURCE_FILE}) inside the skill's
   * directory, so it survives a reload and disappears with the directory. A skill
   * a human copied in by hand has none, and that is the whole difference between
   * "installed from the marketplace" and "put here".
   */
  readonly market: InstalledSkillMarketSource | undefined
}

/** The marketplace origin the installer records inside a directory it created. */
export interface InstalledSkillMarketSource {
  /** The SkillHub namespace it came from. */
  readonly namespace: string
  /** The SkillHub slug it came from. */
  readonly slug: string
  /** The version that was installed. */
  readonly version: string
  /** When it was installed, ISO 8601. */
  readonly installedAt: string
}

/** Everything installed on this host, split the way the modal shows it. */
export interface InstalledSkillSnapshot {
  /** The reader's own skills: the marketplace's install target, and nothing else. */
  readonly personal: readonly InstalledSkill[]
  /** Everything the deployment, the project, or a bundled root provides. */
  readonly shared: readonly InstalledSkill[]
  /**
   * The roots that were scanned, in the loader's own rank order.
   *
   * It travels with the answer because "no skills" and "no directories" are
   * different states, and because a reader who installed something needs to see
   * WHICH directory this host looks in.
   */
  readonly roots: readonly InstalledSkillRoot[]
}

/** One directory this host scanned for skills. */
export interface InstalledSkillRoot {
  /** The root's kind, in the loader's vocabulary. */
  readonly source: InstalledSkillSource
  /** The directory, absolute. */
  readonly path: string
  /** Whether the directory exists right now. */
  readonly exists: boolean
  /** How many skills were listed from it, before shadowing was applied. */
  readonly count: number
}

/**
 * One directory this host scans for skills, as a base plus a relative path.
 *
 * The bases are resolved on the host (`$DSH_HOME`/`~/.dsh`, `$DSH_AGENTS_HOME`/
 * `~/.agents`, the calling project, `$DSH_BUNDLED_SKILL_DIR`), because they are
 * environment facts the browser cannot see — the same division the market read
 * makes between what is fixed and what is known.
 */
export interface InstalledRootSpec {
  /** The root's kind, in the loader's own vocabulary. */
  readonly source: InstalledSkillSource
  /** Which base directory the root hangs off. */
  readonly base: 'dshHome' | 'agentsHome' | 'project' | 'bundled'
  /** The path under that base (empty for the bundled root, which IS the base). */
  readonly relative: string
  /** Which block of the modal skills found here belong in. */
  readonly scope: InstalledSkillScope
}

/**
 * The skill roots this plugin reads, in the loader's rank order.
 *
 * It mirrors `@deepseek-ai/dsh-skill-filesystem`'s own root list — project roots
 * first, then the user's, then the bundled one — so what this modal lists is what
 * the loader loads, in the order the loader would resolve a name collision. The
 * list is shared with the browser only so the modal can SAY which directories it
 * looked in; the resolving happens on the host.
 *
 * `personal` is exactly one root, and that is the point: `~/.dsh/skills` is where
 * the marketplace installs, so it is the only place a skill can come from and be
 * the reader's own. Everything else belongs to the deployment or the project.
 */
export const INSTALLED_ROOTS: readonly InstalledRootSpec[] = [
  { source: 'project-dsh', base: 'project', relative: '.dsh/skills', scope: 'public' },
  { source: 'project-agents', base: 'project', relative: '.agents/skills', scope: 'public' },
  { source: 'user-dsh', base: 'dshHome', relative: 'skills', scope: 'personal' },
  { source: 'user-agents', base: 'agentsHome', relative: 'skills', scope: 'public' },
  { source: 'bundled', base: 'bundled', relative: '', scope: 'public' },
]

/**
 * Why a marketplace read produced no list.
 *
 * Every code names a different action for the reader, which is the only reason
 * to have more than one. That rule is why {@link SkillFailure} carries
 * `host-unmounted`: it is the one failure whose fix is NOT about the network,
 * and reporting it as an unreachable provider sends the reader to check a VPN
 * for a problem a restart would have fixed.
 */
export type SkillFailure =
  /** No Feishu session on this browser: the caller is not signed in. */
  | 'no-session'
  /**
   * Signed in, but the login carries no email address, so no token can be
   * derived. A real state: the email needs its own Feishu scope.
   */
  | 'no-email'
  /** The token was derived but SkillHub refused it: not provisioned, or wrong. */
  | 'unauthorized'
  /** The host cannot reach SkillHub at all: DNS, proxy, VPN, or a refused socket. */
  | 'unreachable'
  /** SkillHub answered a non-2xx status, or an envelope with a non-zero `code`. */
  | 'http-error'
  /** SkillHub answered something this host could not read as its JSON envelope. */
  | 'unreadable'
  /** The package arrived, but holds an entry this host refuses to unpack. */
  | 'unsafe-archive'
  /** The download is not a readable ZIP (corrupt, truncated, Zip64, split). */
  | 'archive-invalid'
  /** The archive is readable and safe, but past one of the size caps. */
  | 'archive-too-large'
  /** A skill of this name is already installed; nothing was written. */
  | 'already-installed'
  /** The package has no `SKILL.md` the loader would accept (see skillmd.ts). */
  | 'not-a-skill'
  /** The download route answered without a redirect, so there is no package. */
  | 'no-archive'
  /** Writing the unpacked files failed (a full disk, a permission, a race). */
  | 'install-failed'
  /** The request named a namespace/slug this route will not put in a URL. */
  | 'bad-request'
  /**
   * This plugin's OWN host did not answer this route.
   *
   * The only code the BROWSER produces rather than the host, and it covers the
   * two ways that happens: the DSH process is gone (`fetch` rejects), or it is
   * running a bundle from before this route existed and answers the SPA's
   * `index.html` for a path it does not know. Both fixes are the same — rebuild,
   * restart `dsh web` — and neither is a network problem, which is exactly what
   * the sentence for it has to say.
   */
  | 'host-unmounted'

/** A domain failure, already phrased for a human. */
export interface SkillError {
  /** Stable machine code; the modal switches on it to pick the right sentence. */
  readonly code: SkillFailure
  /** One sentence, in SkillHub's own words where SkillHub spoke. */
  readonly message: string
}

/**
 * The marketplace's result type: a list, or a typed reason there is none.
 *
 * Deliberately the same shape as `gitwire.ts`'s response — `ok`/`data`/`error`
 * with a coded error — because this is the same kind of module: a shared wire
 * contract whose two halves must not drift.
 */
export type SkillResponse<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: SkillError }

/**
 * Derive one reader's SkillHub token from their Feishu email address.
 *
 * The convention is `<email local part> + '-skillhub'` — `li.yh9@asiainfo-sec.com`
 * becomes `li.yh9-skillhub`. It is a NAME, not a secret: the token is created and
 * revoked in SkillHub's own settings, and this function only spells the
 * convention once so the host that sends it and any future surface that displays
 * it cannot disagree.
 *
 * Deliberately NOT built from `/auth/whoami`'s `handle`. That field is the
 * service's own account id and is a UUID (`usr_25db76d2-…` for the very account
 * this convention is written for), so the two are different identifiers that
 * happen to sound alike; the token comes from the EMAIL, and `handle` is only
 * ever read back as a label.
 *
 * Case is preserved rather than folded: the local part of an address is
 * case-sensitive by RFC 5321, and lower-casing it would silently produce a
 * *different* token for a mailbox that is not the same mailbox.
 * @param email - the address from the verified login session.
 * @returns the handle, or undefined when the address has no local part to use.
 */
export function skillHandle(email: string): string | undefined {
  const at = email.indexOf('@')
  const handle = (at === -1 ? email : email.slice(0, at)).trim()
  return handle === '' ? undefined : handle
}

/**
 * Build the bearer token for one reader.
 *
 * The parameter is named `email` rather than `handle` on purpose: naming it
 * `handle` would invite exactly the confusion the note above warns about.
 * @param email - the address from the verified login session.
 * @returns the token, or undefined when none can be derived.
 */
export function skillToken(email: string): string | undefined {
  const handle = skillHandle(email)
  return handle === undefined ? undefined : `${handle}${SKILL_TOKEN_SUFFIX}`
}
