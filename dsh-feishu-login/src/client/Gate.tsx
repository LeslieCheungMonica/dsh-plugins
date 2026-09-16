/**
 * The gate view, and the account controls that replaced its corner chip.
 *
 * Four exports, one job each:
 *
 * - **{@link Gate}** is the frame-wide occupant of `shell.overlay`. It renders
 *   exactly one of two things, and the quiet one matters: nothing while the
 *   answer is unknown or the host says the gate is not armed (a plugin that
 *   cannot authenticate anybody must not draw on top of a working app), and a
 *   blocking gate when this tab is not signed in — an opaque, full-viewport card
 *   that swallows pointer events, plus an immediate navigation to the login
 *   page. This is the third layer: the server already refused the document and
 *   the pre-boot script already bounced the load, so reaching here means the
 *   session died *while the tab was open* (or the hint cookie was forged, which
 *   this re-check is precisely what catches).
 * - **{@link AccountTrigger}** and **{@link AccountMenu}** are the identity and
 *   the sign-out action, rendered into the sidebar column's own account seats.
 *   They used to be one capsule in the frame's top-right corner; the corner is
 *   the frame's and the account is a once-a-day control, so the corner is where
 *   the session verb now lives with Settings instead (see `dsh-web-ui`'s
 *   AccountDock.tsx). The chip is split — identity above, action in the drawer —
 *   because that drawer is what the reader opens to reach both.
 * - **{@link HeaderChip}** is the FALLBACK: the old header capsule, registered
 *   only while the sidebar seats have not appeared, so a deployment that ships no
 *   `dsh-web-ui` still has somewhere to sign out from.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type {
  AccountMenuProps, AccountTriggerProps, GateProps, HeaderChipProps, SessionUser,
} from './contract.ts'

/** How often an open tab re-checks its session (ms). */
const POLL_INTERVAL_MS = 120_000

/**
 * Keep a signed-in tab's session honest: a periodic re-probe plus one on the
 * tab becoming visible, both mounted only while signed in.
 * @param kind - the current snapshot's kind.
 * @param refresh - re-probe the host.
 */
function useSessionWatch(kind: 'unknown' | 'off' | 'in' | 'out', refresh: () => void): void {
  useEffect(() => {
    if (kind !== 'in') return
    const timer = globalThis.setInterval(refresh, POLL_INTERVAL_MS)
    const onVisible = (): void => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      globalThis.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [kind, refresh])
}

/**
 * The blocking gate. It has no dismiss affordance on purpose: leaving the
 * application UI reachable behind an overlay is not a gate.
 * @param props - the login target and the locale seat.
 * @returns the overlay.
 */
function BlockingGate({ loginUrl, t }: { loginUrl: string; t: GateProps['t'] }): ReactNode {
  const target = `${loginUrl}?next=${encodeURIComponent(
    globalThis.location.pathname + globalThis.location.search + globalThis.location.hash,
  )}`
  useEffect(() => {
    // The overlay is a courtesy: the navigation is what actually re-gates.
    globalThis.location.replace(target)
  }, [target])
  return (
    <div data-dshfl="gate" role="alertdialog" aria-modal="true" aria-label={t('gate.expired.title')}>
      <div className="dshfl-card">
        <div className="dshfl-spinner" />
        <h2>{t('gate.expired.title')}</h2>
        <p>{t('gate.expired.message')}</p>
        <a className="dshfl-action" href={target}>{t('gate.action')}</a>
      </div>
    </div>
  )
}

/**
 * The signed-out half of a click: run the sign-out, and report a refusal in
 * place rather than throwing it at a page that has nowhere to show it.
 * @param onLogout - the face's sign-out verb.
 * @returns the busy flag, the failed flag, and the click handler.
 */
function useLogout(onLogout: () => Promise<void>): {
  busy: boolean
  failed: boolean
  click: () => void
} {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const click = useCallback(() => {
    setBusy(true)
    setFailed(false)
    // A successful sign-out navigates, so `busy` is only ever cleared by a
    // failure — and the failure is shown where the reader clicked.
    void onLogout().catch(() => { setBusy(false); setFailed(true) })
  }, [onLogout])
  return { busy, failed, click }
}

/** The avatar, or the name's initial when Feishu returned no image. */
function Avatar({ user }: { user: SessionUser }): ReactNode {
  if (user.avatarUrl === undefined) {
    return <span className="dshfl-initial" aria-hidden="true">{user.name.trim().slice(0, 1).toUpperCase()}</span>
  }
  return <img className="dshfl-avatar" src={user.avatarUrl} alt="" referrerPolicy="no-referrer" />
}

/**
 * Render the gate entry.
 *
 * The snapshot arrives through `useSyncExternalStore` over the face's store, so
 * a probe result never depends on where in the tree this entry was mounted.
 * @param props - {@link GateProps}: injected face + locale seat.
 * @returns the blocking gate, or null.
 */
export function Gate(props: GateProps): ReactNode {
  const { store, refresh, t } = props
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  useSessionWatch(state.kind, refresh)
  if (state.kind === 'out') return <BlockingGate loginUrl={state.loginUrl} t={t} />
  return null
}

/**
 * The sidebar account row's identity: who this tab is signed in as.
 *
 * In the rail the row is the avatar alone (the column is 56px wide and the name
 * would be a clipped stub); wide, the name follows it. The expiry and the
 * product name are a tooltip, not a second line: this row shares the foot with
 * the settings row and has to stay one line high.
 * @param props - {@link AccountTriggerProps}: the column share, the face, `t`.
 * @returns the identity content, or a neutral placeholder while resolving.
 */
export function AccountTrigger(props: AccountTriggerProps): ReactNode {
  const { wide, store, refresh, t } = props
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  useSessionWatch(state.kind, refresh)

  // Unknown (first paint) and unarmed both render this placeholder rather than
  // nothing: the row is the drawer's only trigger, so it must exist before the
  // probe answers — and it must not claim an identity it has not confirmed.
  if (state.kind !== 'in') {
    return wide
      ? <span data-dshfl="accountPending">{t('chip.resolving')}</span>
      : <span className="dshfl-initial" aria-hidden="true">·</span>
  }

  const { user } = state
  const title = `${t('chip.signedInAs', { name: user.name })} · ${t('chip.expiresAt', {
    time: new Date(user.expiresAt * 1000).toLocaleString(),
  })}`
  return (
    <span data-dshfl="account" title={title}>
      <Avatar user={user} />
      {wide && <span className="dshfl-name">{user.name}</span>}
    </span>
  )
}

/**
 * The sign-out row inside the sidebar's account drawer.
 *
 * It does NOT close the drawer first, and that is the deliberate part: the
 * reader clicked a row and must see the answer to that click. A successful
 * sign-out navigates away; a refused one says so on the row itself, which is
 * only visible while the drawer stays open.
 * @param props - {@link AccountMenuProps}: the face and `t`.
 * @returns the row, or null while not signed in.
 */
export function AccountMenu(props: AccountMenuProps): ReactNode {
  const { store, logout, t } = props
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const { busy, failed, click } = useLogout(logout)

  if (state.kind !== 'in') return null
  return (
    <button
      type="button"
      data-wui="drawerRow"
      data-dshfl="signOut"
      disabled={busy}
      onClick={click}
    >
      <span data-wui="drawerRowIcon" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M6.6 2.4H3.4C2.85 2.4 2.4 2.85 2.4 3.4v9.2c0 .55.45 1 1 1h3.2M6.6 2.4v11.2M10.4 5.6 13 8l-2.6 2.4M13 8H6.4"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span data-wui="drawerRowLabel">
        {failed ? t('chip.failed') : busy ? t('chip.loggingOut') : t('chip.logout')}
      </span>
    </button>
  )
}

/**
 * The session-header entry: the signed-in capsule, in its ORIGINAL corner.
 *
 * This is the fallback home, registered only while the sidebar column has not
 * offered the account seats (see index.tsx). It exists for the deployment that
 * installs this plugin without `dsh-web-ui`: without it, that page would have no
 * way to sign out at all.
 * @param props - {@link HeaderChipProps}: the face and `t`.
 * @returns the capsule, or null while signed out (the overlay gate owns that).
 */
export function HeaderChip(props: HeaderChipProps): ReactNode {
  const { config, store, refresh, logout, t } = props
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const { busy, failed, click } = useLogout(logout)
  useSessionWatch(state.kind, refresh)

  if (state.kind !== 'in' || !config.accountChip) return null
  const { user } = state
  const expiry = new Date(user.expiresAt * 1000).toLocaleString()
  return (
    <div data-dshfl="chipHeader" title={`${t('chip.signedInAs', { name: user.name })} · ${t('chip.expiresAt', { time: expiry })}`}>
      <Avatar user={user} />
      <span className="dshfl-name">
        {failed ? t('chip.failed') : busy ? t('chip.loggingOut') : `${config.brandName} · ${user.name}`}
      </span>
      <button type="button" onClick={click} disabled={busy}>{t('chip.logout')}</button>
    </div>
  )
}
