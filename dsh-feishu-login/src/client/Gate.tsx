/**
 * The gate view: the frame-wide occupant of `shell.overlay`.
 *
 * It renders exactly one of three things, and the two that matter are the
 * quiet ones:
 *
 * - **nothing** while the answer is unknown, or when the host says the gate is
 *   not armed. A plugin that cannot authenticate anybody must not draw on top
 *   of a working app.
 * - **a blocking gate** when the host says this tab is not signed in — an
 *   opaque, full-viewport card that swallows pointer events, plus an immediate
 *   navigation to the login page. This is the third layer: the server already
 *   refused the document and the pre-boot script already bounced the load, so
 *   reaching here means the session died *while the tab was open* (or the hint
 *   cookie was forged, which this re-check is precisely what catches).
 * - **a small identity chip** when signed in, so "who is this tab, and how do I
 *   leave" has an answer somewhere on the page.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { GateProps, HeaderChipProps, SessionUser } from './contract.ts'

/** How often an open tab re-checks its session (ms). */
const POLL_INTERVAL_MS = 120_000

/**
 * The blocking gate. It has no dismiss affordance on purpose: leaving the
 * application UI reachable behind an overlay is not a gate.
 * @param props - the injected face and the locale seat.
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
 * The signed-in chip: identity, expiry tooltip, and the one action that ends
 * the session on the host before landing on the login page.
 * @param props - the injected face and the locale seat.
 * @returns the chip.
 */
function AccountChip({ user, brandName, onLogout, t, variant }: {
  user: SessionUser
  brandName: string
  onLogout: () => Promise<void>
  t: GateProps['t']
  /** Which home this instance renders in (the two differ only in placement). */
  variant: 'overlay' | 'header'
}): ReactNode {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const click = useCallback(() => {
    setBusy(true)
    setFailed(false)
    void onLogout().catch(() => { setBusy(false); setFailed(true) })
  }, [onLogout])
  const expiry = new Date(user.expiresAt * 1000).toLocaleString()
  const initial = user.name.trim().slice(0, 1).toUpperCase()
  return (
    <div data-dshfl={variant === 'header' ? 'chipHeader' : 'chip'} title={`${t('chip.signedInAs', { name: user.name })} · ${t('chip.expiresAt', { time: expiry })}`}>
      {user.avatarUrl === undefined
        ? <span className="dshfl-initial" aria-hidden="true">{initial}</span>
        : <img className="dshfl-avatar" src={user.avatarUrl} alt="" referrerPolicy="no-referrer" />}
      <span className="dshfl-name">
        {failed ? t('chip.failed') : busy ? t('chip.loggingOut') : `${brandName} · ${user.name}`}
      </span>
      <button type="button" onClick={click} disabled={busy}>{t('chip.logout')}</button>
    </div>
  )
}

/**
 * Render the gate entry.
 *
 * The snapshot arrives through `useSyncExternalStore` over the face's store, so
 * a probe result never depends on where in the tree this entry was mounted.
 * @param props - {@link GateProps}: injected face + locale seat.
 * @returns the overlay, the chip, or null.
 */
export function Gate(props: GateProps): ReactNode {
  const { config, store, refresh, logout, t, useSessions } = props
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  // Which home the chip uses is a property of the frame, not of the account.
  // The header row is the chip's natural place (see {@link HeaderChip}), and the
  // header hides itself while the Session is blank — so "no current Session, or
  // a blank one" is the state that has no header to sit in, and the same
  // `blank` flag ui-layout reads to decide whether the details column has a
  // Session. In the one state the two predicates disagree (blank Session, but a
  // non-blank composer phase), both entries render the same capsule in the same
  // corner, which reads as a single chip rather than as a duplicate.
  const headerAbsent = useSessions((snapshot) => {
    const current = snapshot.current
    return current === undefined || snapshot.byId[current]?.blank === true
  })

  useEffect(() => {
    if (state.kind !== 'in') return
    const timer = globalThis.setInterval(refresh, POLL_INTERVAL_MS)
    const onVisible = (): void => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      globalThis.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [state.kind, refresh])

  if (state.kind === 'out') return <BlockingGate loginUrl={state.loginUrl} t={t} />
  if (state.kind === 'in' && config.accountChip && headerAbsent) {
    // With a session open the header entry renders the chip instead; this
    // fallback exists precisely for the state that has no header at all.
    return <AccountChip user={state.user} brandName={config.brandName} onLogout={logout} t={t} variant="overlay" />
  }
  return null
}

/**
 * The session-header entry: the signed-in chip, in the header's utilities row.
 *
 * This is where the chip lives whenever a session is open — in the flow, right
 * where the shipped Session-log button used to be, so nothing overlaps the
 * frame's own corner controls. {@link Gate} covers the other case.
 * @param props - {@link HeaderChipProps}: injected face + locale seat.
 * @returns the chip, or null while signed out (the overlay gate owns that).
 */
export function HeaderChip(props: HeaderChipProps): ReactNode {
  const { config, store, refresh, logout, t } = props
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)

  useEffect(() => {
    if (state.kind !== 'in') return
    const timer = globalThis.setInterval(refresh, POLL_INTERVAL_MS)
    const onVisible = (): void => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      globalThis.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [state.kind, refresh])

  if (state.kind !== 'in' || !config.accountChip) return null
  return <AccountChip user={state.user} brandName={config.brandName} onLogout={logout} t={t} variant="header" />
}
