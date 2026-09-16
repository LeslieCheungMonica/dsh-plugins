/**
 * The account drawer's Skills modal: what this deployment has installed, split by
 * scope, and the public marketplace underneath it.
 *
 * ## Why a modal of our own
 *
 * The same reason {@link PluginsDialog} is one. Skills have no shipped settings
 * surface to embed: `settings.section` belongs to another entry's registration, a
 * slot key takes exactly one declarer, and the settings shell owns its own open
 * state — so there is no "open Settings on the Skills page" verb to call. What
 * this modal presents is therefore this plugin's own, reached from the row that
 * already exists in the drawer (`AccountDock.tsx`).
 *
 * ## Two sections, not three tabs
 *
 * The modal answers two different questions, and they are not peers:
 *
 * 1. **已安装的技能** — what this deployment HAS. Its two scopes (公共 / 个人) are a
 *    subdivision of one set, which is why they are TABS inside the section: the
 *    heading names the set, the tab names the subset, and the count on the
 *    heading stays the whole set so it does not move when a tab is clicked.
 * 2. **技能市场** — what this deployment COULD install. That is not a third scope of
 *    the same set (nothing in it is installed), so making it a third tab would
 *    claim a symmetry that does not hold. It is a section below, and the divider
 *    is what says the two lists are read differently.
 *
 * The two sections have DIFFERENT data behind them, and that asymmetry is the
 * shape of this file:
 *
 * - the installed block is a **prop** (`skills`), because nothing on this machine
 *   can list what is installed yet — there is no local install state to read, so
 *   the caller hands in an empty list and the harness hands in a fixture;
 * - the marketplace is a **read** (`listMarketSkills`), because its data lives in
 *   SkillHub and only this plugin's host half may hold the token that reaches it.
 *
 * ## What is deliberately absent
 *
 * No search row (SkillHub's own `q` exists, but a deployment-wide catalogue of
 * FDE skills is short; a filter earns its place when the list is 180 rows, as the
 * plugins modal's is), and **no install or uninstall action** — installing
 * writes to this machine and would need its own route (`/skills/{ns}/{slug}/
 * download` is a 302 to a pre-signed ZIP), so a button before that route exists
 * would repeat exactly the problem the placeholder rows in the drawer had.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconSearchOutline16, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  InstalledSkill, InstalledSkillMarketSource, InstalledSkillSnapshot, InstalledSkillSource,
  SkillError, SkillInstallResult, SkillMarketItem, SkillMarketSnapshot,
} from '../shared/skillswire.ts'
import { SKILL_QUERY_MAX_LENGTH } from '../shared/skillswire.ts'
import type { ShellProps } from './contract.ts'

/**
 * Which audience a skill belongs to, in the INSTALLED block's terms.
 *
 * 公共 is the deployment's, 个人 is the reader's — the two tabs. The marketplace
 * does not use this type at all: SkillHub answers with its own `assetOwnership`
 * (`PUBLIC` / `PRIVATE`, see `shared/skillswire.ts`), and mapping the two
 * vocabularies onto each other before anything needs it would be inventing an
 * equivalence between "installed by the deployment" and "published publicly".
 */
export type SkillScope = 'public' | 'personal'

/** The installed block's tabs, in render order. */
const TABS: readonly SkillScope[] = ['public', 'personal']

/**
 * Composed props: what the drawer hands the modal.
 *
 * Both data sources are READS, and that is the shape of this file: the modal holds
 * no list it was handed. The marketplace read reaches SkillHub through this
 * plugin's host — which is where the token lives — the installed read reaches this
 * host's filesystem through the same host, which owns the roots, and the install
 * verb is the one method here that WRITES.
 */
export type SkillsDialogProps = Pick<
  ShellProps,
  't' | 'listMarketSkills' | 'listInstalledSkills' | 'installMarketSkill'
> & {
  /** Whether the modal is showing. */
  open: boolean
  /** Close it: the header button, the mask, or Escape. */
  onClose: () => void
}

/**
 * One skill's card: its name, the sentence under it, and optionally something it
 * can be asked to do.
 *
 * An installed card carries no action, because this plugin has no uninstall or
 * upgrade yet: a fact about the disk is not a control, and a button before those
 * routes exist would be a promise the modal cannot keep.
 *
 * `tag` means something different in each list — on a marketplace card it is 个人
 * for somebody's PRIVATE asset, and on an installed card it is the root the skill
 * was found in, or the version it arrived as.
 * @param props - the card's two strings, an optional tag, an optional action, and
 * the attribute naming which list it sits in.
 * @returns the card.
 */
function SkillCard({ name, description, meta, tag, attr, action }: {
  name: string
  description: string
  /**
   * The card's tertiary line: what the asset IS, when the description could not
   * say. Only the marketplace passes one — see {@link marketBody}.
   */
  meta?: string | undefined
  /** Absent for a card with nothing to label (an installed skill, or a PUBLIC one). */
  tag?: string | undefined
  attr: 'skillCard' | 'skillMarketCard'
  /**
   * What the card can be asked to DO, when it can be asked anything.
   *
   * Only the marketplace passes one: an installed skill is a fact about the disk
   * and this plugin has no uninstall or upgrade yet, so its cards stay inert.
   */
  action?: ReactNode
}): ReactNode {
  return (
    <li data-wui={attr}>
      <span data-wui="skillCardHead">
        {/* One line, ellipsised by the stylesheet — a name that wrapped moved the
            tag beside it and changed the card's height, which is what misaligned
            two cards in a row. The full name stays reachable here. */}
        <strong data-wui="skillName" title={name}>{name}</strong>
        {tag !== undefined && <span data-wui="skillTag">{tag}</span>}
      </span>
      {/* A skill may genuinely have no introduction, and an empty paragraph is
          a gap in the card rather than a fact — so the line is omitted. */}
      {description !== '' && <p data-wui="skillDescription">{description}</p>}
      {meta !== undefined && <span data-wui="skillMeta">{meta}</span>}
      {action !== undefined && <span data-wui="skillCardActions">{action}</span>}
    </li>
  )
}

/** What a read of this host's installed skills renders. */
type InstalledState =
  | { status: 'loading' }
  | { status: 'failed'; error: SkillError }
  | { status: 'ready'; snapshot: InstalledSkillSnapshot }

/** What the marketplace read renders. */
type MarketState =
  | { status: 'loading' }
  | { status: 'failed'; error: SkillError }
  | { status: 'ready'; snapshot: SkillMarketSnapshot }

/** One card's install, as the reader last saw it. */
type InstallState =
  | { status: 'busy' }
  | { status: 'done'; result: SkillInstallResult }
  | { status: 'failed'; error: SkillError }

/**
 * A marketplace item's key: the pair SkillHub identifies a skill by.
 * @param item - the item.
 * @returns the key, which is also what the installed scan matches on.
 */
function itemKey(item: SkillMarketItem): string {
  return `${item.namespace}/${item.slug}`
}

/**
 * The sentence for one failure.
 * @param error - the coded failure.
 * @param t - the translator.
 * @returns the sentence, with the host's own detail folded in.
 */
function failureText(error: SkillError, t: SkillsDialogProps['t']): string {
  return t(`skill.error.${error.code}`, { message: error.message })
}

/**
 * The modal's body: both reads, the tab, and the install actions.
 *
 * Split out of {@link SkillsDialog} because `Modal` renders nothing while it is
 * closed. That makes this component MOUNT PER OPEN — which is what makes opening
 * the modal the refresh for both lists, and what makes the active tab, the
 * in-flight installs and their failures per-open state rather than something a
 * reader has to reason about having left behind.
 *
 * The two reads are deliberately at ONE level here rather than one per section:
 * the marketplace needs the installed list to know which cards say 已安装, and the
 * installed list is what the marketplace's own action changes. One read, two
 * consumers, one refresh after an install.
 */
/** How long typing settles before the marketplace is asked. See {@link SkillsBody}. */
const SEARCH_DEBOUNCE_MS = 400

function SkillsBody({ projectPath, listMarketSkills, listInstalledSkills, installMarketSkill, t }: Omit<SkillsDialogProps, 'open' | 'onClose'> & { projectPath: string | undefined }): ReactNode {
  const [tab, setTab] = useState<SkillScope>('public')
  /**
   * The reader's search term: ONE box, two consumers.
   *
   * The installed block filters what it already has, instantly and locally, because
   * the scan returns everything there is. The marketplace cannot be filtered that
   * way: SkillHub answers a page (its own default `limit`, 20), so a local filter
   * would silently miss every match past the first page — the failure mode where a
   * reader types a skill's name, sees nothing, and concludes it does not exist. So
   * the market re-asks SkillHub with the term instead.
   */
  const [query, setQuery] = useState('')
  const [installed, setInstalled] = useState<InstalledState>({ status: 'loading' })
  const [installedAttempt, setInstalledAttempt] = useState(0)
  const [market, setMarket] = useState<MarketState>({ status: 'loading' })
  const [marketAttempt, setMarketAttempt] = useState(0)
  const [installs, setInstalls] = useState<Record<string, InstallState>>({})

  useEffect(() => {
    // Both reads are cancelled on unmount: closing the modal is the reader saying
    // "not now", and a late answer must not resurrect a list behind them.
    let live = true
    setInstalled({ status: 'loading' })
    void listInstalledSkills(projectPath).then(
      (answer) => {
        if (!live) return
        setInstalled(answer.ok ? { status: 'ready', snapshot: answer.data } : { status: 'failed', error: answer.error })
      },
      (reason: unknown) => {
        if (!live) return
        setInstalled({ status: 'failed', error: transportError(reason) })
      },
    )
    return () => { live = false }
  }, [listInstalledSkills, projectPath, installedAttempt])

  /**
   * Which market read is the current one.
   *
   * Typing produces overlapping reads, and answers do not arrive in order — so the
   * read that is allowed to render is decided by identity, not by arrival. Without
   * this, a slow answer for `命` would land after a fast answer for `命名空间` and
   * replace a narrow list with a wider one, which looks like the search undoing
   * itself.
   */
  const marketAttemptRef = useRef(0)
  /**
   * The term the last read was issued for.
   *
   * It decides whether a read WAITS, and the distinction is the reader's intent
   * rather than the mechanism: a read that happens because the TERM CHANGED is
   * typing, so it waits for the typing to settle — one request per settled query
   * instead of one per keystroke, since SkillHub's documented limit is 60 searches a
   * minute and a request per character would spend it on characters nobody asked
   * about. A read that happens for any OTHER reason — the modal opening, a retry
   * after a failure — was asked for outright, and is issued in the same tick.
   */
  const lastIssuedQuery = useRef<string | undefined>(undefined)

  useEffect(() => {
    const trimmed = query.trim()
    const attempt = marketAttemptRef.current + 1
    marketAttemptRef.current = attempt
    const delay = lastIssuedQuery.current !== undefined && lastIssuedQuery.current !== trimmed
      ? SEARCH_DEBOUNCE_MS
      : 0
    lastIssuedQuery.current = trimmed
    let live = true
    setMarket({ status: 'loading' })
    const read = (): void => {
      void listMarketSkills(trimmed === '' ? undefined : trimmed).then(
        (answer) => {
          if (!live || marketAttemptRef.current !== attempt) return
          setMarket(answer.ok ? { status: 'ready', snapshot: answer.data } : { status: 'failed', error: answer.error })
        },
        (reason: unknown) => {
          if (!live || marketAttemptRef.current !== attempt) return
          setMarket({ status: 'failed', error: transportError(reason) })
        },
      )
    }
    // No delay means no timer: the opening read is ASKED for in the same tick, which
    // keeps "open the modal" and "type in it" on the paths they each deserve.
    if (delay === 0) {
      read()
      return () => { live = false }
    }
    const timer = window.setTimeout(read, delay)
    return () => { live = false; window.clearTimeout(timer) }
  }, [listMarketSkills, marketAttempt, query])

  const installedSnapshot = installed.status === 'ready' ? installed.snapshot : undefined
  const marketSnapshot = market.status === 'ready' ? market.snapshot : undefined

  /**
   * The skill this marketplace item IS on this host, when it is installed here.
   *
   * The match is on namespace+slug — the same pair the installer records and the
   * same reason it records it: the marketplace calls this asset `命名空间测试` while
   * the package calls it `test-design-case-generator`, so a name match would never
   * find it.
   * @param item - one marketplace item.
   * @returns the installed skill, or undefined when this host does not have it.
   */
  const installedEntryFor = (item: SkillMarketItem): InstalledSkill | undefined => {
    if (installedSnapshot === undefined) return undefined
    return [...installedSnapshot.personal, ...installedSnapshot.shared].find(skill => {
      const record = skill.market
      return record !== undefined && record.namespace === item.namespace && record.slug === item.slug
    })
  }

  /** What the marketplace says about one item's install, if it says anything. */
  const recordFor = (item: SkillMarketItem): InstalledSkillMarketSource | undefined =>
    installedEntryFor(item)?.market

  /**
   * A marketplace card's description, and why it is not simply `summary`.
   *
   * SkillHub's `summary` is the only description field it has (its `/resolve`
   * carries version, fingerprint and a download URL; the ClawHub-compatible search
   * carries the same `summary`), and for some assets it is a COPY of the display
   * name — the two skills this deployment's `label=FDE` catalogue holds today are
   * exactly that. A line repeating the title is not a description; it reads as a
   * card with none, which is how this was reported.
   *
   * So the body is chosen in this order:
   *
   * 1. **the installed package's own `description`** — the real sentence, already
   *    on this machine (the scan read it), for an asset this host has installed.
   *    The package's `SKILL.md` MUST carry a description for the loader to accept
   *    it at all, so this is the authoritative text whenever it exists;
   * 2. **`summary`**, when it says something the title does not;
   * 3. nothing — and then {@link marketMeta} says what the asset is instead.
   * @param item - one marketplace item.
   * @returns the sentence, or '' when the card has none to show.
   */
  const marketBody = (item: SkillMarketItem): string => {
    const local = installedEntryFor(item)?.description ?? ''
    const chosen = local !== '' ? local : item.summary
    return chosen === item.displayName ? '' : chosen
  }

  /**
   * A marketplace card's identity line: which asset, and which version.
   *
   * It is what the card can say when its `summary` said nothing, and it is worth
   * having either way: the marketplace's display name is NOT the name the skill is
   * installed under, and the version is what an upgrade would compare.
   * @param item - one marketplace item.
   * @returns the line.
   */
  const marketMeta = (item: SkillMarketItem): string =>
    `${item.namespace}/${item.slug} · v${item.latestVersion}`

  /**
   * Install one item, then re-read the installed list.
   *
   * The re-read is not an optimisation to skip: the install succeeded on the HOST,
   * and the only authority on what is on disk is the scan. A local "done" flag
   * would show the reader a state the next reload disagrees with.
   */
  const install = (item: SkillMarketItem): void => {
    const key = itemKey(item)
    setInstalls(current => ({ ...current, [key]: { status: 'busy' } }))
    void installMarketSkill({ namespace: item.namespace, slug: item.slug }).then(
      (answer) => {
        setInstalls(current => ({
          ...current,
          [key]: answer.ok ? { status: 'done', result: answer.data } : { status: 'failed', error: answer.error },
        }))
        if (answer.ok) setInstalledAttempt(value => value + 1)
      },
      (reason: unknown) => {
        setInstalls(current => ({ ...current, [key]: { status: 'failed', error: transportError(reason) } }))
      },
    )
  }

  /**
   * A card's label, which means something different in each tab.
   *
   * In the SHARED tab it names the root the skill was found in — that is the only
   * thing that tells one shared skill from another. In the PERSONAL tab every card
   * is the user root by definition, so a root label would only repeat the tab's own
   * name, and what is worth saying instead is the marketplace version it arrived as.
   * @param skill - one scanned skill.
   * @param scope - which tab is showing.
   * @returns the tag, or undefined when the card has nothing to label.
   */
  const tagFor = (skill: InstalledSkill, scope: SkillScope): string | undefined => {
    if (scope === 'personal') {
      return skill.market === undefined || skill.market.version === '' ? undefined : `v${skill.market.version}`
    }
    return t(SOURCE_LABELS[skill.source])
  }
  const SOURCE_LABELS: Record<InstalledSkillSource, 'skill.tag.user' | 'skill.tag.agents' | 'skill.tag.project' | 'skill.tag.bundled'> = {
    'user-dsh': 'skill.tag.user',
    'user-agents': 'skill.tag.agents',
    'project-dsh': 'skill.tag.project',
    'project-agents': 'skill.tag.project',
    bundled: 'skill.tag.bundled',
  }

  /**
   * The installed tab's skills, narrowed by the local filter.
   *
   * Matched against the two strings the card already shows — its name and its
   * description — case-insensitively, which is the same rule the plugins modal's
   * filter follows. A skill whose description mentions the term is a match even when
   * its name does not, because that is where "what does it do" lives.
   */
  const needle = query.trim().toLocaleLowerCase()
  const matchesQuery = (skill: InstalledSkill): boolean =>
    needle === ''
    || skill.name.toLocaleLowerCase().includes(needle)
    || skill.description.toLocaleLowerCase().includes(needle)
  const allListed = installedSnapshot === undefined
    ? []
    : (tab === 'personal' ? installedSnapshot.personal : installedSnapshot.shared)
  const listed = allListed.filter(matchesQuery)

  return (
    <div data-wui="skillsDialog">
      {/* One box for both sections, and it is placed above them because it belongs to
          neither: the installed block filters what it has, the marketplace re-asks
          SkillHub, and the reader does not have to know which is which to find a
          skill by name. */}
      <div data-wui="skillSearch">
        <span data-wui="skillSearchField">
          <Input
            icon={<IconSearchOutline16 size={16} />}
            value={query}
            placeholder={t('skill.search')}
            aria-label={t('skill.search')}
            maxLength={SKILL_QUERY_MAX_LENGTH}
            onChange={(event) => { setQuery(event.target.value) }}
          />
        </span>
      </div>

      <section data-wui="skillInstalled">
        <div data-wui="skillInstalledHeading">
          <h3>{t('skill.installed')}</h3>
          {/* The WHOLE installed set, not the visible tab: the heading names the
              set and the tabs subdivide it, so a number that changed when a tab
              below it was clicked would read as the tab's own. A search term is the
              one thing that DOES move it — the count describes what the list is
              showing, and a search that matched nothing has to be distinguishable
              from a machine with nothing installed. It is absent until the scan
              answers, because there is nothing to count yet. */}
          {installedSnapshot !== undefined && (
            <span data-skill-count="installed">
              {needle === ''
                ? installedSnapshot.personal.length + installedSnapshot.shared.length
                : installedSnapshot.personal.filter(matchesQuery).length + installedSnapshot.shared.filter(matchesQuery).length}
            </span>
          )}
        </div>

        <nav data-wui="skillTabs" role="tablist" aria-label={t('skill.installed')}>
          {TABS.map(scope => (
            <button
              key={scope}
              type="button"
              role="tab"
              id={tabId(scope)}
              aria-controls={PANE_ID}
              aria-selected={tab === scope}
              data-wui="skillTab"
              data-active={tab === scope || undefined}
              onClick={() => { setTab(scope) }}
            >
              {t(`skill.scope.${scope}`)}
            </button>
          ))}
        </nav>

        {/* One pane, re-rendered per tab, rather than two panes hidden with
            `data-hidden` the way the Git drawer does it: nothing in here holds
            state a tab switch could lose, so keeping both mounted would buy
            memory and cost the ARIA pairing. Both tabs therefore point at the
            SAME pane id — there is one pane, and claiming two would name an
            element that never exists. `aria-labelledby` is what moves with the
            active tab. */}
        <div data-wui="skillPane" role="tabpanel" id={PANE_ID} aria-labelledby={tabId(tab)}>
          {installed.status === 'loading' && <p data-wui="skillNote">{t('skill.installed.loading')}</p>}
          {installed.status === 'failed' && (
            <div data-wui="skillFailure" role="status">
              <p>{failureText(installed.error, t)}</p>
              <button type="button" onClick={() => { setInstalledAttempt(value => value + 1) }}>{t('skill.retry')}</button>
            </div>
          )}
          {installedSnapshot !== undefined && listed.length === 0 && (
            // Two different facts, two different sentences: nothing of this scope is
            // installed, versus this scope has skills and the term matched none of
            // them. Sharing one sentence would tell a reader with a typo that their
            // machine is empty.
            <p data-wui="skillNote">
              {allListed.length === 0 ? t(`skill.empty.${tab}`) : t('skill.noMatch')}
            </p>
          )}
          {listed.length > 0 && (
            <ul data-wui="skillGrid">
              {listed.map(skill => (
                <SkillCard
                  key={`${skill.source}/${skill.name}`}
                  name={skill.name}
                  description={skill.description}
                  tag={tagFor(skill, tab)}
                  attr="skillCard"
                />
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Which directories the scan actually looked in. It is the answer to "I
          installed it, where did it go", and it distinguishes "no skills" from
          "no roots" — the two states a reader cannot tell apart from an empty
          list alone. */}
      {installedSnapshot !== undefined && installedSnapshot.roots.length > 0 && (
        <p data-wui="skillRoots">
          {t('skill.installed.roots', {
            n: installedSnapshot.roots.length,
            paths: installedSnapshot.roots.map(root => root.path).join(' · '),
          })}
        </p>
      )}

      <div data-wui="skillDivider" role="separator" />

      <section data-wui="skillMarket">
        <div data-wui="skillMarketHeading">
          <h3>{t('skill.market')}</h3>
          {/* The count is the SERVER's total, not the number of cards: `limit`
              defaults to 20 in SkillHub, and a heading that reported the returned
              slice as the total would understate the catalogue silently. It is
              absent while there is no answer to count. */}
          {marketSnapshot !== undefined && <span data-skill-count="market">{marketSnapshot.total}</span>}
        </div>

        {marketSnapshot !== undefined && marketSnapshot.verifiedEmail !== '' && (
          // Which account this list was read AS. It is not decoration: because the
          // search sends no `assetOwnership`, SkillHub answers with the public
          // assets AND the reader's own private ones, so the list can contain
          // things only this person can see — and a reader cannot reason about a
          // mixed list that does not say whose it is.
          <p data-wui="skillMarketIdentity">{t('skill.market.identity', { email: marketSnapshot.verifiedEmail })}</p>
        )}

        {market.status === 'loading' && (
          <p data-wui="skillMarketNote">
            {query.trim() === '' ? t('skill.market.loading') : t('skill.market.searching')}
          </p>
        )}

        {market.status === 'failed' && (
          <div data-wui="skillFailure" role="status">
            {/* The sentence is this plugin's and the detail is the host's: the
                code decides what the reader should DO (connect the VPN, ask for
                the account), and the host's message says what actually happened. */}
            <p>{failureText(market.error, t)}</p>
            <button type="button" onClick={() => { setMarketAttempt(value => value + 1) }}>{t('skill.retry')}</button>
          </div>
        )}

        {market.status === 'ready' && marketSnapshot !== undefined && marketSnapshot.items.length === 0 && (
          <p data-wui="skillMarketNote">
            {query.trim() === '' ? t('skill.empty.market') : t('skill.noMatch')}
          </p>
        )}

        {marketSnapshot !== undefined && marketSnapshot.items.length > 0 && (
          <ul data-wui="skillMarketGrid">
            {marketSnapshot.items.map(item => {
              const key = itemKey(item)
              const state = installs[key]
              const record = recordFor(item)
              return (
                <SkillCard
                  key={key}
                  name={item.displayName}
                  description={marketBody(item)}
                  meta={marketMeta(item)}
                  tag={item.assetOwnership === 'PRIVATE' ? t('skill.tag.personal') : undefined}
                  attr="skillMarketCard"
                  action={(
                    <InstallAction
                      name={item.displayName}
                      state={state}
                      installedVersion={record?.version}
                      busy={state?.status === 'busy'}
                      onInstall={() => { install(item) }}
                      t={t}
                    />
                  )}
                />
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

/**
 * One marketplace card's install control.
 *
 * Four states, and the order they are decided in matters: an install this session
 * performed is shown even before the re-read lands, because the reader just
 * watched it happen. Otherwise the scan decides — a skill installed a week ago and
 * a skill installed a minute ago are the same state to a reader.
 * @param props - the item's name, this card's install state, what the scan says,
 * and the gesture.
 * @returns the control.
 */
function InstallAction({ name, state, installedVersion, busy, onInstall, t }: {
  name: string
  state: InstallState | undefined
  installedVersion: string | undefined
  busy: boolean
  onInstall: () => void
  t: SkillsDialogProps['t']
}): ReactNode {
  const done = state?.status === 'done' || (state === undefined && installedVersion !== undefined)
  if (done) {
    // Not a disabled button: there is nothing to press. The host refuses to touch a
    // directory that exists, so this is a FACT about the disk rather than a
    // temporarily unavailable action.
    return <span data-wui="skillInstallDone">{t('skill.install.done')}</span>
  }
  if (busy) return <span data-wui="skillInstallBusy">{t('skill.install.busy')}</span>
  return (
    <>
      {state?.status === 'failed' && (
        <p data-wui="skillInstallError" role="status">{failureText(state.error, t)}</p>
      )}
      <button
        type="button"
        data-wui="skillInstallButton"
        aria-label={t('skill.install.aria', { name })}
        onClick={onInstall}
      >
        {state?.status === 'failed' ? t('skill.install.retry') : t('skill.install')}
      </button>
    </>
  )
}

/**
 * One transport failure of the GUI's own host, in the shared vocabulary.
 *
 * Only a rejected promise reaches here — every domain failure arrives as
 * `{ ok: false }` — and it is reported with the same code the api module uses for
 * "this plugin's host did not answer", so the reader has one set of sentences.
 * @param reason - the thrown value.
 * @returns the coded failure.
 */
function transportError(reason: unknown): SkillError {
  return { code: 'host-unmounted', message: reason instanceof Error ? reason.message : String(reason) }
}

/**
 * Render the Skills modal.
 *
 * The body is mounted per OPEN (`Modal` renders nothing while it is closed), which
 * is what makes opening the modal the refresh for both lists and what keeps the
 * active tab, the in-flight installs and their failures per-open — see
 * {@link SkillsBody}.
 * @param props - whether it is open, how to close it, the marketplace and
 * installed readers, the install verb, the selected project, and `t`.
 * @returns the modal (nothing while closed).
 */
export function SkillsDialog({ open, onClose, projectPath, listMarketSkills, listInstalledSkills, installMarketSkill, t }: SkillsDialogProps & { projectPath: string | undefined }): ReactNode {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('skill.title')}
      description={t('skill.intro')}
      closeLabel={t('skill.close')}
      // The shared card is 380px wide, which is right for a one-field prompt and
      // too narrow for a card grid. As in PluginsDialog, the widening rule in
      // styles.ts addresses the card structurally (the modal containing this
      // tree) rather than by its hashed CSS-module class.
      className="dsh-web-ui-skills"
    >
      <SkillsBody
        projectPath={projectPath}
        listMarketSkills={listMarketSkills}
        listInstalledSkills={listInstalledSkills}
        installMarketSkill={installMarketSkill}
        t={t}
      />
    </Modal>
  )
}

/**
 * The DOM id of the installed block's single pane, which both tabs control.
 *
 * Prefixed so it cannot collide with another plugin's ids on the same page.
 */
const PANE_ID = 'dsh-web-ui-skill-pane'

/**
 * The DOM id of one scope's tab.
 * @param scope - the scope.
 * @returns the id, prefixed as {@link PANE_ID} is.
 */
function tabId(scope: SkillScope): string {
  return `dsh-web-ui-skill-tab-${scope}`
}
