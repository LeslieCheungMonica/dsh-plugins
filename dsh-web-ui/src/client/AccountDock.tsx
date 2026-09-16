/**
 * The account dock: the column's bottom-left corner, and the drawer it opens.
 *
 * ## What moved here, and why it is a seat rather than a copy
 *
 * The signed-in identity and the sign-out control used to live in the frame's
 * top-right corner — a header capsule while a Session was open, a fixed corner
 * capsule when none was (`dsh-feishu-login`'s two entries). That corner is
 * crowded with the frame's own controls and is the one place a reader looks
 * last; the account is a once-a-day control, so it belongs with Settings at the
 * foot of the column instead.
 *
 * The identity itself is NOT re-implemented here. It arrives as an occupant of
 * `sidebar.account` (declared by this plugin's `sidebar` entry, filled by
 * whichever plugin owns the account). This component owns what the corner is
 * about: the row, its chevron, the drawer, and the drawer's own two rows. Sign
 * out arrives the same way, as a row registered into `sidebar.account.menu` —
 * so the plugin that holds the session verb keeps holding it.
 *
 * ## The drawer
 *
 * It opens UPWARD from the row and holds three things in a fixed order: Usage
 * (this plugin's, expanding in place), Settings (the shipped `sidebar.settings`
 * occupant, unchanged — its trigger button is simply rendered here instead of in
 * the foot, and it still opens its own modal), then whatever rows the account
 * plugin contributes.
 *
 * Rendering the shipped Settings trigger inside the drawer rather than
 * re-implementing it is what keeps the settings panel reachable without this
 * plugin learning anything about it: `ui-settings`' trigger owns its own modal
 * state, so a row that IS that trigger opens the panel by existing. Its own
 * stylesheet sizes it as a sidebar-foot row; styles.ts re-sizes it into the
 * drawer's row rhythm, and no rule of this plugin's reaches further than that.
 *
 * ## The rail
 *
 * The column clips its overflow (`[data-wui='column'] { overflow: hidden }`), so
 * a drawer cannot float outside a 56px rail. In the rail the row is the avatar
 * alone and activating it EXPANDS the column and opens the drawer in the same
 * gesture — the only way a reader at 56px reaches the same three rows.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChevronUpOutline14, IconDataOutline16, IconPersonalizationOutline16,
  IconSkillOutline16, IconUserOutline16, Tooltip, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ShellProps } from './contract.ts'
import { PluginsDialog } from './PluginsDialog.tsx'
import { UsagePanel } from './UsagePanel.tsx'

/**
 * Composed props: the shares this dock takes from the column it lives in, plus
 * the column state it renders against. Narrowed from {@link ShellProps} rather
 * than restated, so the two cannot drift, and narrowed at all so this component
 * does not formally require the column's whole business face (starting Sessions,
 * picking folders) that it never calls.
 */
export type AccountDockProps =
  & Pick<ShellProps, 'renderSlot' | 'useSessions' | 'listPlugins' | 't'>
  & {
    /** Whether the column renders wide content (false = 56px rail). */
    wide: boolean
    /**
     * Expand the column. The rail's account control needs it: at 56px there is no
     * width for a drawer, and this column clips its own overflow.
     */
    expandSidebar: () => void
  }

/**
 * The product name the row falls back to when no identity plugin answers the
 * `sidebar.account` seat. A deployment without one still gets the drawer (Usage
 * and Settings are this plugin's own), which is why the fallback is a name
 * rather than nothing at all: a nameless row would read as a broken control.
 */
const FALLBACK_BRAND = 'ForgeX'

/**
 * What the two not-yet-built rows do when clicked: nothing.
 *
 * It is a named constant rather than an inline `() => {}` so the intent is
 * greppable — one symbol says "this gesture is a placeholder" and disappears with
 * the surfaces it stands for, instead of a dozen silently empty arrows that read
 * like a dropped handler.
 */
const PLACEHOLDER_CLICK = (): void => {}

/**
 * A product-card glyph, drawn here rather than taken from the shipped icon set.
 *
 * The set has no card: the closest readings are "a chart" (`IconDataOutline16`,
 * already used by the row above) and "a list" (`IconListPenOutline16`), and a row
 * about product CARDS should not be labelled with either. A rounded rectangle
 * with a short rule under its top-left corner is the whole idea, so it is four
 * lines of path — the same call `dsh-feishu-login` makes for its sign-out row.
 * @param props - the square edge in px, matching `IconProps`.
 * @returns the glyph.
 */
function ProductCardGlyph({ size }: { size: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="1.9" y="3.4" width="12.2" height="9.2" rx="2"
        stroke="currentColor" strokeWidth="1.3"
      />
      <path d="M4.4 6.4h3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Render the account row, with its drawer above it.
 * @param props - the column's shares, the drawer seats, and the translator.
 * @returns the dock element tree.
 */
export function AccountDock(props: AccountDockProps): ReactNode {
  const { wide, expandSidebar, renderSlot, useSessions, listPlugins, t } = props
  const [open, setOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [pluginsOpen, setPluginsOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // A pointerdown anywhere else closes the drawer — the same rule every other
  // trigger-owned popover in this composition follows. Suspended while the
  // Plugins modal is up: that modal portals to the page body, so every click in
  // it is "outside" this root, and letting it close the drawer would mean closing
  // the modal also drops the reader out of the corner they opened it from.
  useDismissOnOutsidePointer(rootRef, open && wide && !pluginsOpen, setOpen)

  useEffect(() => {
    // One gesture dismisses ONE surface. Two modals can sit above this drawer —
    // this plugin's own Plugins modal, and the shipped settings panel that the
    // Settings row opens — and both listen for Escape on the document. Those
    // listeners were registered after this one, so this handler runs first, while
    // the modal is still up: standing down on a live `[role="dialog"]` is what
    // keeps Escape from closing the drawer out from under the surface the reader
    // was actually dismissing. It is a property of the page, not of either modal,
    // so it needs to know nothing about who opened one.
    if (!open || !wide) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (document.querySelector('[role="dialog"]') !== null) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open, wide])

  // The rail has no width to open a drawer in: expanding the column IS how the
  // same rows are reached from there. The drawer therefore only ever SHOWS wide,
  // and `open` survives the expand, so the reader lands on an open drawer.
  const drawn = open && wide

  const identity = renderSlot(
    'sidebar.account',
    { wide },
    {
      fallback: (
        <span data-wui="accountFallback">
          <IconUserOutline16 size={wide ? 15 : 18} />
          {wide && <span data-wui="accountFallbackName">{FALLBACK_BRAND}</span>}
        </span>
      ),
    },
  )

  return (
    <div data-wui="account" ref={rootRef}>
      {/* The drawer is always MOUNTED and merely hidden — `data-open` is what
          shows it. This is not a micro-optimisation to avoid a remount: the
          shipped Settings shell lives in here, and that shell is also what
          renders the ONBOARDING surface (`settings.onboarding` → a body-portaled
          welcome dialog). Unmounting it while the drawer is shut would mean the
          welcome never appears on a fresh deployment, and re-mounting it on
          every toggle would reset the settings shell's own state. styles.ts owns
          the closed/open presentation. */}
      <div data-wui="accountDrawer" data-open={drawn || undefined} role="group" aria-label={t('account.menu')}>
        {/* Both disclosures are the same shape on purpose: a row that expands in
            place, above the divider, so the two ACTION rows below never move.
            Usage first because it is about the work in front of the reader; the
            plugin inventory second, because it is about the deployment. */}
        <button
          type="button"
          data-wui="drawerRow"
          aria-expanded={usageOpen}
          onClick={() => { setUsageOpen(value => !value) }}
        >
          <span data-wui="drawerRowIcon" aria-hidden="true"><IconDataOutline16 size={16} /></span>
          <span data-wui="drawerRowLabel">{t('usage.title')}</span>
          <span data-wui="drawerRowChevron" data-open={usageOpen || undefined} aria-hidden="true">
            <IconChevronUpOutline14 size={14} />
          </span>
        </button>
        {usageOpen && (
          <div data-wui="drawerBody">
            <UsagePanel t={t} useSessions={useSessions} />
          </div>
        )}

        <button
          type="button"
          data-wui="drawerRow"
          aria-haspopup="dialog"
          aria-expanded={pluginsOpen}
          onClick={() => { setPluginsOpen(true) }}
        >
          <span data-wui="drawerRowIcon" aria-hidden="true">
            <IconPersonalizationOutline16 size={16} />
          </span>
          <span data-wui="drawerRowLabel">{t('plugin.title')}</span>
        </button>

        {/* Two ENTRY POINTS whose surfaces are not built yet. The rows are here so
            the drawer's final shape can be seen and reviewed, and the click is
            deliberately inert ({@link PLACEHOLDER_CLICK}). Each carries a tooltip
            saying so, because a control that silently does nothing reads as a bug
            — and that tooltip is the one thing to delete when the surface lands. */}
        <button
          type="button"
          data-wui="drawerRow"
          data-placeholder="true"
          title={t('drawer.placeholder')}
          onClick={PLACEHOLDER_CLICK}
        >
          <span data-wui="drawerRowIcon" aria-hidden="true"><IconSkillOutline16 size={16} /></span>
          <span data-wui="drawerRowLabel">{t('skill.title')}</span>
        </button>

        <button
          type="button"
          data-wui="drawerRow"
          data-placeholder="true"
          title={t('drawer.placeholder')}
          onClick={PLACEHOLDER_CLICK}
        >
          <span data-wui="drawerRowIcon" aria-hidden="true"><ProductCardGlyph size={16} /></span>
          <span data-wui="drawerRowLabel">{t('productCard.title')}</span>
        </button>

        <div data-wui="drawerDivider" role="separator" />

        {/* The shipped Settings trigger, in the drawer instead of the foot.
            `wide: true` is not the column's state: the drawer only exists wide,
            and the trigger's rail variant is a 36px circle that would have to be
            unpicked to be a row again — so it is not asked for. */}
        {renderSlot('sidebar.settings', { wide: true })}

        {renderSlot('sidebar.account.menu', {})}
      </div>

      <Tooltip
        label={t('account.open')}
        delayMs={500}
        disabled={wide || drawn}
      >
        <button
          type="button"
          data-wui="accountRow"
          aria-haspopup="true"
          aria-expanded={drawn}
          aria-label={t('account.aria')}
          onClick={() => {
            if (!wide) {
              expandSidebar()
              setOpen(true)
              return
            }
            setOpen(value => !value)
          }}
        >
          <span data-wui="accountIdentity">{identity}</span>
          {wide && (
            <span data-wui="accountChevron" data-open={drawn || undefined} aria-hidden="true">
              <IconChevronUpOutline14 size={14} />
            </span>
          )}
        </button>
      </Tooltip>

      {/* The Plugins modal. Rendered BESIDE the drawer rather than inside it, and
          that is load-bearing: it portals to the page body, so the column's own
          clipping cannot cut it, and keeping it out of the drawer's dismiss scope
          is what lets the drawer stay open behind it — the same courtesy the
          shipped settings modal gets from the row below. */}
      <PluginsDialog
        open={pluginsOpen}
        onClose={() => { setPluginsOpen(false) }}
        listPlugins={listPlugins}
        t={t}
      />
    </div>
  )
}
