/**
 * The account drawer's Plugins modal: what this deployment actually loaded,
 * presented the way Settings → Plugins presents it.
 *
 * ## Why a modal of our own, and why it looks like THAT page
 *
 * Settings → Plugins is a registered `settings.section` entry owned by
 * `ui-settings-plugins`, and embedding it is not available: `renderSlot` is bound
 * to the entry that DECLARES a slot — `ui-renderer`'s `boundRenderSlot` throws
 * `SlotOwnershipError` for any key outside that entry's own `children` — and
 * `settings.section` belongs to `ui-settings-general`'s `sidebar.settings`
 * registration, while one slot key takes exactly one declarer (`ui-slots`
 * rejects a second with `slot "…" is already declared`). The settings panel's
 * open state and active section are likewise `useState` inside `SettingsRoot`, so
 * there is no "open Settings on the Plugins page" verb either.
 *
 * What IS reachable is the read underneath that page: the host's
 * `pluginInventory` Remote, the single source of truth for both surfaces, so this
 * modal and the settings page cannot disagree about what is loaded. Everything
 * above that read is therefore a faithful REPRODUCTION of the page's
 * presentation — heading, intro, search, the two-column card grid, the phase dot,
 * the 已启用/已停用 tag, and the per-card detail disclosure — rather than a second
 * design for the same facts.
 *
 * Two things the page has and this modal deliberately does not:
 *
 * - **its tab bar** (配置 / 插件列表). The other tab is a container for cards that
 *   feature plugins register themselves; a one-tab bar would be noise, and an
 *   empty second tab would be a lie.
 * - **its own words.** The page's copy belongs to that package's dictionary, so
 *   the sentences here are written for this surface. Where the words must mean the
 *   same thing — the phase vocabulary, 已启用/已停用 — they are identical.
 *
 * The catalogue is read on MOUNT, and the modal only mounts it while it is open:
 * opening the modal is therefore the refresh, and a phase read after a plugin was
 * reloaded is never stale.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChevronDownOutline14, IconSearchOutline16, Input, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type { ShellProps } from './contract.ts'

/** Composed props: what the drawer hands the modal. */
export type PluginsDialogProps = Pick<ShellProps, 'listPlugins' | 't'> & {
  /** Whether the modal is showing. */
  open: boolean
  /** Close it: the header button, the mask, or Escape. */
  onClose: () => void
}

/** One inventory entry, as the host reports it. */
type Entry = PluginInventorySnapshot['entries'][number]

/** The root Fiber's phase, or null when the entry has no live root Fiber. */
type Phase = Entry['fiberPhase']

/**
 * Locale key of each phase's label. Every phase the DTO can carry is named: a
 * phase the host adds later reads as `unobserved`, which is wrong but visible
 * rather than silent (a missing key would throw in the dictionary's own lookup).
 */
const PHASE_KEYS: Record<Exclude<Phase, null>, 'plugin.phase.pending' | 'plugin.phase.loading' | 'plugin.phase.active' | 'plugin.phase.failed' | 'plugin.phase.unloading'> = {
  pending: 'plugin.phase.pending',
  loading: 'plugin.phase.loading',
  active: 'plugin.phase.active',
  failed: 'plugin.phase.failed',
  unloading: 'plugin.phase.unloading',
}

/** What the catalogue renders. */
type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; entries: readonly Entry[] }

/**
 * Compact one module specifier: the scope (if any) and the `cordis:` /
 * `cordis-plugin-` / `dsh-` prefixes are packaging noise in a card title.
 *
 * Deliberately the same three cosmetic rules the settings page applies, so the
 * same plugin reads the same in both places. It mirrors rather than imports them:
 * a client bundle may not import another plugin's values (see tsconfig's purity
 * gate), and these are three string edits, not a shared truth.
 * @param moduleName - the Loader entry's module specifier.
 * @returns the short name.
 */
export function moduleShortName(moduleName: string): string {
  const unscoped = moduleName.startsWith('@')
    ? moduleName.slice(moduleName.indexOf('/') + 1)
    : moduleName
  return unscoped
    .replace(/^cordis:/u, '')
    .replace(/^cordis-plugin-/u, '')
    .replace(/^dsh-(?:host-|client-)?/u, '')
}

/**
 * Whether one entry matches the local query: the module specifier or the Loader
 * entry id, case-insensitively — the same two fields the settings page matches on.
 * @param entry - the inventory entry.
 * @param normalizedQuery - the query, already trimmed and lower-cased.
 * @returns whether the card belongs in the filtered view.
 */
function matches(entry: Entry, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) return true
  return [entry.moduleName, entry.entryId]
    .some(value => value.toLocaleLowerCase().includes(normalizedQuery))
}

/**
 * One entry's card: the header button, and the detail disclosure under it.
 * @param props - the entry, whether it is expanded, the toggler, and `t`.
 * @returns the card.
 */
function Card({ entry, open, onToggle, t }: {
  entry: Entry
  open: boolean
  onToggle: () => void
  t: PluginsDialogProps['t']
}): ReactNode {
  const phase = entry.fiberPhase
  const phaseLabel = phase === null ? t('plugin.phase.unobserved') : t(PHASE_KEYS[phase])
  const configuration = entry.enabled ? t('plugin.enabled') : t('plugin.disabled')
  return (
    <li data-wui="pluginCard" data-open={open || undefined} data-enabled={entry.enabled ? 'true' : 'false'}>
      <button
        type="button"
        data-wui="pluginCardBody"
        aria-expanded={open}
        // The accessible name carries everything the row shows plus the phase in
        // words, because the dot's own label is not part of the button's text.
        aria-label={entry.enabled
          ? `${moduleShortName(entry.moduleName)}, ${phaseLabel}, ${configuration}`
          : `${moduleShortName(entry.moduleName)}, ${configuration}`}
        onClick={onToggle}
      >
        <strong data-wui="pluginCardTitle" title={entry.moduleName}>
          {moduleShortName(entry.moduleName)}
        </strong>
        <span data-wui="pluginCardTrailing">
          {/* The dot is the verdict at a glance, and it is omitted for a disabled
              entry on purpose: such an entry has no live Fiber to report, and a
              grey dot beside a "disabled" tag would read as a third state rather
              than as "not applicable". */}
          {entry.enabled && (
            <span data-wui="pluginDot" data-phase={phase ?? 'unobserved'} role="img" aria-label={phaseLabel} />
          )}
          <span data-wui="pluginTag" data-enabled={entry.enabled ? 'true' : 'false'}>{configuration}</span>
          <span data-wui="pluginChevron" aria-hidden="true"><IconChevronDownOutline14 size={12} /></span>
        </span>
      </button>
      {open && (
        <div data-wui="pluginCardDetails">
          <code data-wui="pluginEntryId">{entry.entryId}</code>
          <dl data-wui="pluginFacts">
            <div>
              <dt>{t('plugin.configuration')}</dt>
              <dd>{configuration}</dd>
            </div>
            {entry.enabled && (
              <div>
                <dt>{t('plugin.cordis')}</dt>
                <dd>{phaseLabel}</dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </li>
  )
}

/**
 * The catalogue: the search row, the count, and the cards.
 *
 * Split out of {@link PluginsDialog} because `Modal` renders nothing while it is
 * closed — so this subtree mounts per open and its read is the refresh.
 * @param props - the inventory reader and the translator.
 * @returns the catalogue.
 */
function Catalogue({ listPlugins, t }: Pick<ShellProps, 'listPlugins' | 't'>): ReactNode {
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // Cancelled on unmount: closing the modal is the reader saying "not now", and
    // a late answer must not resurrect the catalogue.
    let live = true
    setState({ status: 'loading' })
    void listPlugins().then(
      (snapshot) => { if (live) setState({ status: 'ready', entries: snapshot.entries }) },
      (reason: unknown) => {
        if (!live) return
        setState({ status: 'error', message: reason instanceof Error ? reason.message : String(reason) })
      },
    )
    return () => { live = false }
  }, [listPlugins, attempt])

  const normalized = query.trim().toLocaleLowerCase()
  const shown = state.status === 'ready'
    ? state.entries.filter(entry => matches(entry, normalized))
    : []

  if (state.status === 'loading') return <p data-wui="pluginNote">{t('plugin.loading')}</p>
  if (state.status === 'error') {
    return (
      <div data-wui="pluginFailure" role="status">
        <p>{t('plugin.error', { message: state.message })}</p>
        <button type="button" onClick={() => { setAttempt(value => value + 1) }}>{t('plugin.retry')}</button>
      </div>
    )
  }

  return (
    <>
      <div data-wui="pluginSearch">
        <span data-wui="pluginSearchField">
          <Input
            icon={<IconSearchOutline16 size={16} />}
            value={query}
            placeholder={t('plugin.search')}
            aria-label={t('plugin.search')}
            onChange={(event) => { setQuery(event.target.value) }}
          />
        </span>
      </div>

      <div data-wui="pluginCatalogHeading">
        <h3>{t('plugin.catalog')}</h3>
        <span data-plugin-count={shown.length}>{shown.length}</span>
      </div>

      {state.entries.length === 0 && <p data-wui="pluginNote">{t('plugin.empty')}</p>}
      {state.entries.length > 0 && shown.length === 0 && <p data-wui="pluginNote">{t('plugin.noMatch')}</p>}
      {shown.length > 0 && (
        <ul data-wui="pluginCards">
          {shown.map(entry => (
            <Card
              key={entry.entryId}
              entry={entry}
              open={expanded === entry.entryId}
              onToggle={() => { setExpanded(current => current === entry.entryId ? undefined : entry.entryId) }}
              t={t}
            />
          ))}
        </ul>
      )}
    </>
  )
}

/**
 * Render the Plugins modal.
 * @param props - whether it is open, how to close it, the reader and `t`.
 * @returns the modal (nothing while closed).
 */
export function PluginsDialog({ open, onClose, listPlugins, t }: PluginsDialogProps): ReactNode {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('plugin.title')}
      description={t('plugin.intro')}
      closeLabel={t('plugin.close')}
      // The shared card is 380px wide, which is right for a one-field prompt and
      // far too narrow for a two-column card grid. As in NewProjectDialog, the
      // widening rule in styles.ts addresses the card structurally (the modal
      // containing this tree) rather than by its hashed CSS-module class.
      className="dsh-web-ui-plugins"
    >
      <div data-wui="pluginsDialog">
        <Catalogue listPlugins={listPlugins} t={t} />
      </div>
    </Modal>
  )
}
