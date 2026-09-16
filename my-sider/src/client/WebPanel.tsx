/**
 * The sidebar: a dock on the right edge whose every tab opens a web address.
 *
 * ## Two ways to load a page, and why both exist
 *
 * A tab is shown in an `<iframe>`, which is the only way a browser can display
 * another site inside this page. There are exactly two ways to fill that frame,
 * and neither is a superset of the other:
 *
 * - **Direct** (`src` = the address itself). The browser loads the site as a
 *   first-class origin: its cookies, its login state, and its scripts all
 *   behave. The cost is that framing is the SITE's decision — a page sending
 *   `X-Frame-Options: DENY` or a `frame-ancestors` directive stays blank, and no
 *   amount of client code can override that.
 * - **Relay** (`src` = the host's `/my-sider/url/fetch` route). The DSH host
 *   fetches the document and serves it back, so framing bans no longer apply —
 *   at the price of anonymity (the host sends no cookies) and of scripts that
 *   navigate by absolute URL or call APIs the relayed origin cannot satisfy.
 *
 * The panel therefore probes the address through the host BEFORE trusting the
 * frame, and when the site turns out to forbid framing it says so and offers the
 * other mode, instead of leaving the operator with a white rectangle and no
 * explanation. The probe is a hint, not a verdict — it is the host's view of the
 * site, and the browser's may differ — so its notices are advisory and the frame
 * is always rendered anyway.
 *
 * ## What is persisted, and where
 *
 * The tab list (addresses and modes) lives in `localStorage`, as do the width and
 * the open flag — but the LATTER two are written by the launcher, which owns this
 * panel's geometry and persists it while the panel is mounted. Nothing is
 * persisted on the host: a relayed document is not cached, and a direct tab is the
 * browser's own business.
 *
 * @module my-sider/client/WebPanel
 */
import { createPortal } from 'react-dom'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChevronLeftOutline14, IconChevronRightOutline14, IconCloseOutline16, IconGlobeOutline14,
  IconLinkOutline16, IconPlusOutline16, IconRefreshOutline14, IconRightUpOutline16,
  IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RelayProbe } from '../shared/wire.ts'
import { probeUrl, relaySrc } from './api.ts'
import type { WebSidebarRequest } from './sidebar.ts'
import type { NS } from './contract.ts'

/** The persisted tab list key. */
const TABS_KEY = 'my-sider.web.tabs'

/** The panel's default width and the bounds a drag may reach, in px. */
export const DEFAULT_WIDTH = 460
export const MIN_WIDTH = 280
/**
 * How much viewport the sidebar must leave to the frame, in px. A sidebar that
 * could be dragged over the whole conversation would hide the app it docks into.
 */
export const MAX_WIDTH_SLACK = 220

/** How a tab loads its address. */
export type LoadMode = 'direct' | 'relay'

/** One tab: an address, how it loads, and the operator's own back/forward trail. */
interface Tab {
  /** Stable identity; also the iframe's React key. */
  readonly id: string
  /** The address currently loaded. Empty for a tab that has not been given one. */
  readonly url: string
  /** How this tab loads its address. */
  readonly mode: LoadMode
  /**
   * The addresses this tab has shown, in order. The frame cannot be asked where
   * it has been (in direct mode it is a different origin, and in relay mode its
   * history belongs to the relayed document), so the operator's own address
   * entries are the trail back and forward.
   */
  readonly trail: readonly string[]
  /** Index into {@link Tab.trail}. */
  readonly at: number
}

/** A monotonically increasing id source for tabs created in this session. */
let tabCounter = 0

/**
 * Build one tab.
 * @param url - the address to load, or the empty string for a blank tab.
 * @param mode - how to load it.
 * @returns the tab.
 */
function newTab(url: string, mode: LoadMode): Tab {
  tabCounter += 1
  return { id: `tab-${String(tabCounter)}`, url, mode, trail: url === '' ? [] : [url], at: url === '' ? -1 : 0 }
}

/**
 * Read the persisted tabs.
 * @returns the tab list, or a single blank tab.
 */
function readTabs(): readonly Tab[] {
  try {
    const raw = window.localStorage.getItem(TABS_KEY)
    if (raw === null) return [newTab('', 'direct')]
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return [newTab('', 'direct')]
    const tabs = parsed.flatMap((entry): Tab[] => {
      if (typeof entry !== 'object' || entry === null) return []
      const record = entry as Record<string, unknown>
      const url = typeof record['url'] === 'string' ? record['url'] : ''
      const mode: LoadMode = record['mode'] === 'relay' ? 'relay' : 'direct'
      return [newTab(url, mode)]
    })
    // An empty list is a real state the operator can reach by closing every tab;
    // on reload it is friendlier to come back to one blank tab than to a panel
    // with no way to type an address.
    return tabs.length === 0 ? [newTab('', 'direct')] : tabs
  } catch {
    // A blocked or corrupt localStorage is not a reason to lose the panel.
    return [newTab('', 'direct')]
  }
}

/**
 * Turn what an operator typed into an absolute URL.
 *
 * Bare hosts are the norm in this panel (`localhost:5173`, `docs.internal`), so
 * the scheme is inferred: anything that looks like a local address gets `http`,
 * everything else `https`. A string with a scheme is validated instead of
 * guessed at.
 * @param raw - the typed text.
 * @returns the absolute URL, or undefined when the text is not usable.
 */
export function normalizeAddress(raw: string): string | undefined {
  const text = raw.trim()
  if (text === '') return undefined
  const explicit = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)
  if (explicit !== null) {
    const scheme = (explicit[1] ?? '').toLowerCase()
    if (scheme !== 'http' && scheme !== 'https') return undefined
    try {
      return new URL(text).href
    } catch {
      return undefined
    }
  }
  // A scheme-less input that carries a port or a loopback/IPv4 host is a local
  // service far more often than it is a public domain; HTTPS there would fail
  // with a handshake error that looks like a network problem.
  const local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(text)
    || /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)/.test(text)
    || /:\d+(\/|$)/.test(text)
  const guess = `${local ? 'http' : 'https'}://${text}`
  try {
    return new URL(guess).href
  } catch {
    return undefined
  }
}

/**
 * A short, stable label for a tab: the host, plus the last path segment when the
 * address has one.
 * @param url - the tab's address.
 * @param untitled - the label for a blank tab.
 * @returns the label.
 */
function labelOf(url: string, untitled: string): string {
  if (url === '') return untitled
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter(part => part !== '')
    const last = segments[segments.length - 1]
    return last === undefined ? parsed.host : `${parsed.host}/${decodeURIComponent(last)}`
  } catch {
    return url
  }
}

/** Props of the sidebar. */
export interface WebPanelProps {
  /** The plugin's translator. */
  readonly t: TranslateNS<typeof NS>
  /** The persisted width in px. */
  readonly width: number
  /** Height reserved at the bottom for the command panel, in px (0 when closed). */
  readonly bottom: number
  /**
   * An address another plugin asked this sidebar to show, or null. Each request
   * carries its own id, so the panel re-acts even when the address repeats.
   */
  readonly openRequest: WebSidebarRequest | null
  /** Report a new width from a drag. */
  readonly onWidth: (width: number) => void
  /** Close the sidebar. */
  readonly onClose: () => void
}

/**
 * Render the web sidebar.
 * @param props - the translator, geometry, and the close action.
 * @returns the portal-mounted panel.
 */
export function WebPanel({ t, width, bottom, openRequest, onWidth, onClose }: WebPanelProps): ReactNode {
  const [tabs, setTabs] = useState<readonly Tab[]>(readTabs)
  // Deliberately empty: `activeId` only ever carries an explicit choice, and the
  // render below falls back to the first tab — which is what makes a stale id
  // (after closing a tab, or after a reload) a non-event instead of a blank panel.
  const [activeId, setActiveId] = useState<string>('')
  const [draft, setDraft] = useState('')
  const [probe, setProbe] = useState<{ url: string; value: RelayProbe } | null>(null)
  /** Bumped to re-mount an iframe, which is the only way to re-navigate it. */
  const [nonce, setNonce] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const widthRef = useRef(width)
  widthRef.current = width

  const active = tabs.find(tab => tab.id === activeId) ?? tabs[0] ?? null
  const activeUrl = active?.url ?? ''

  // The address bar shows the active tab's address, and follows it when the
  // operator switches tabs.
  useEffect(() => { setDraft(activeUrl) }, [activeUrl, activeId])

  // Persist the tab list; a reload comes back to the same workspace.
  useEffect(() => {
    try {
      window.localStorage.setItem(TABS_KEY, JSON.stringify(tabs.map(tab => ({ url: tab.url, mode: tab.mode }))))
    } catch {
      // A blocked localStorage is not a reason to lose the tabs.
    }
  }, [tabs])

  // Probe the active address through the host. The answer paints a notice, never
  // a verdict: the frame is rendered either way.
  useEffect(() => {
    if (activeUrl === '') { setProbe(null); return }
    let cancelled = false
    void (async () => {
      const answer = await probeUrl(activeUrl)
      if (cancelled) return
      if (!answer.ok) { setProbe(null); return }
      setProbe({ url: activeUrl, value: answer.data })
    })()
    return () => { cancelled = true }
  }, [activeUrl, nonce])

  /**
   * Replace one tab, by id.
   * @param id - the tab to replace.
   * @param next - the replacement.
   */
  const put = useCallback((id: string, next: Tab): void => {
    setTabs(previous => previous.map(tab => (tab.id === id ? next : tab)))
  }, [])

  /**
   * Show an address in one tab.
   * @param id - the tab.
   * @param url - the absolute address.
   * @param push - true to extend the trail, false to move along it.
   */
  const navigate = useCallback((id: string, url: string, push: boolean): void => {
    setTabs(previous => previous.map((tab) => {
      if (tab.id !== id) return tab
      if (!push) return { ...tab, url }
      // Navigating from the middle of the trail drops what came after it, which
      // is what every browser's back/forward does.
      const trail = [...tab.trail.slice(0, tab.at + 1), url]
      return { ...tab, url, trail, at: trail.length - 1 }
    }))
  }, [])

  /**
   * Move one tab along its own trail.
   * @param tab - the tab.
   * @param step - -1 for back, 1 for forward.
   */
  const step = (tab: Tab, step: -1 | 1): void => {
    const at = tab.at + step
    const url = tab.trail[at]
    if (url === undefined) return
    put(tab.id, { ...tab, at, url })
  }

  /**
   * Submit whatever is in the address bar for the active tab.
   */
  const submit = useCallback((): void => {
    if (active === null) return
    const url = normalizeAddress(draft)
    if (url === undefined) {
      setError(t('web.invalid'))
      return
    }
    setError(null)
    navigate(active.id, url, true)
  }, [active, draft, navigate, t])

  /**
   * Add a tab and focus the address bar for it.
   */
  const addTab = useCallback((): void => {
    const tab = newTab('', 'direct')
    setTabs(previous => [...previous, tab])
    setActiveId(tab.id)
    setError(null)
  }, [])

  // A URL another plugin asked for. It REUSES a tab already showing that address
  // rather than piling up a second one: clicking the same document twice is one
  // intention, and the reader's back trail in that tab is worth keeping. The
  // effect keys on the request id (not the URL) so a repeat still re-focuses, and
  // reads `tabs` from this render's closure — it runs in the commit that a new
  // request caused, so that value is current by construction.
  useEffect(() => {
    if (openRequest === null) return
    const existing = tabs.find(tab => tab.url === openRequest.url)
    if (existing !== undefined) {
      setActiveId(existing.id)
      setError(null)
      return
    }
    // Direct loading on purpose: the caller is a link to a site the READER is
    // signed in to (a Feishu document), and only a same-site frame carries their
    // session. The relay fetches anonymously by design, so it could only ever
    // show that site's login page.
    const tab = newTab(openRequest.url, 'direct')
    setTabs(previous => [...previous, tab])
    setActiveId(tab.id)
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the request, see above
  }, [openRequest])

  /**
   * Close one tab, keeping at least one alive.
   * @param id - the tab to close.
   */
  const closeTab = useCallback((id: string): void => {
    setTabs((previous) => {
      const next = previous.filter(tab => tab.id !== id)
      if (next.length === 0) return [newTab('', 'direct')]
      return next
    })
    setActiveId((current) => {
      if (current !== id) return current
      const remaining = tabs.filter(tab => tab.id !== id)
      return remaining[0]?.id ?? ''
    })
  }, [tabs])

  /**
   * Flip the active tab between direct and relay loading, keeping the address.
   */
  const toggleMode = useCallback((): void => {
    if (active === null) return
    const mode: LoadMode = active.mode === 'direct' ? 'relay' : 'direct'
    put(active.id, { ...active, mode })
    setNonce(value => value + 1)
  }, [active, put])

  /**
   * Resize the panel from a drag on its left edge.
   * @param event - the pointer-down that started the gesture.
   */
  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const handle = event.currentTarget
    const originX = event.clientX
    const base = widthRef.current
    handle.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent): void => {
      const max = Math.max(MIN_WIDTH, window.innerWidth - MAX_WIDTH_SLACK)
      onWidth(Math.min(max, Math.max(MIN_WIDTH, base + (originX - moveEvent.clientX))))
    }
    const end = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
  }

  const frameSrc = useMemo(() => {
    if (active === null || active.url === '') return null
    return active.mode === 'relay' ? relaySrc(active.url) : active.url
  }, [active])

  // Direct tabs keep their own origin and login state; relayed tabs run on an
  // OPAQUE origin (no `allow-same-origin`), which is what stops a relayed page
  // from reaching this GUI's DOM, storage, or API through the origin they share.
  const sandbox = active?.mode === 'relay'
    ? 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads'
    : 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-same-origin'

  const blocked = probe !== null && probe.url === activeUrl && probe.value.frameBlocked && active?.mode === 'direct'
  const unreachable = probe !== null && probe.url === activeUrl && probe.value.unreachable

  const panel = (
    <section
      data-ms="webPanel"
      style={{ width, bottom }}
      aria-label={t('web.title')}
    >
      <div
        data-ms="webResize"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('web.resize')}
        onPointerDown={startResize}
      />

      <div data-ms="webTabs" role="tablist" aria-label={t('web.title')}>
        {tabs.map(tab => (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            data-ms="webTab"
            aria-selected={tab.id === active?.id}
            data-active={tab.id === active?.id || undefined}
            title={tab.url === '' ? t('web.tab.untitled') : tab.url}
            onClick={() => { setActiveId(tab.id) }}
            onKeyDown={(event) => { if (event.key === 'Enter') setActiveId(tab.id) }}
          >
            <IconGlobeOutline14 size={12} />
            <span data-ms="webTabTitle">{labelOf(tab.url, t('web.tab.untitled'))}</span>
            <button
              type="button"
              data-ms="webTabClose"
              aria-label={t('web.tab.close', { title: labelOf(tab.url, t('web.tab.untitled')) })}
              onClick={(event) => { event.stopPropagation(); closeTab(tab.id) }}
            >
              <IconCloseOutline16 size={11} />
            </button>
          </div>
        ))}
        <button type="button" data-ms="iconButton" aria-label={t('web.newTab')} title={t('web.newTab')} onClick={addTab}>
          <IconPlusOutline16 size={13} />
        </button>
        <span data-ms="spacer" />
        <button type="button" data-ms="iconButton" aria-label={t('web.close')} title={t('web.close')} onClick={onClose}>
          <IconCloseOutline16 size={14} />
        </button>
      </div>

      <div data-ms="webToolbar">
        <button
          type="button"
          data-ms="iconButton"
          aria-label={t('web.back')}
          title={t('web.back')}
          disabled={active === null || active.at <= 0}
          onClick={() => { if (active !== null) step(active, -1) }}
        >
          <IconChevronLeftOutline14 size={13} />
        </button>
        <button
          type="button"
          data-ms="iconButton"
          aria-label={t('web.forward')}
          title={t('web.forward')}
          disabled={active === null || active.at >= active.trail.length - 1}
          onClick={() => { if (active !== null) step(active, 1) }}
        >
          <IconChevronRightOutline14 size={13} />
        </button>
        <button
          type="button"
          data-ms="iconButton"
          aria-label={t('web.reload')}
          title={t('web.reload')}
          disabled={activeUrl === ''}
          onClick={() => { setNonce(value => value + 1) }}
        >
          <IconRefreshOutline14 size={13} />
        </button>
        <input
          data-ms="webAddress"
          value={draft}
          placeholder={t('web.address.placeholder')}
          aria-label={t('web.address.placeholder')}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => { setDraft(event.target.value); setError(null) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setDraft(activeUrl)
              setError(null)
            }
          }}
        />
        <button type="button" data-ms="iconButton" aria-label={t('web.go')} title={t('web.go')} onClick={submit}>
          <IconLinkOutline16 size={13} />
        </button>
        <button
          type="button"
          data-ms="modeButton"
          data-mode={active?.mode ?? 'direct'}
          aria-label={t('web.mode')}
          title={active?.mode === 'relay' ? t('web.mode.relay.hint') : t('web.mode.direct.hint')}
          onClick={toggleMode}
        >
          <IconGlobeOutline14 size={11} />
          {active?.mode === 'relay' ? t('web.mode.relay') : t('web.mode.direct')}
        </button>
        <button
          type="button"
          data-ms="iconButton"
          aria-label={t('web.external')}
          title={t('web.external')}
          disabled={activeUrl === ''}
          onClick={() => { window.open(activeUrl, '_blank', 'noopener,noreferrer') }}
        >
          <IconRightUpOutline16 size={13} />
        </button>
      </div>

      {error !== null && (
        <div data-ms="notice" data-tone="error" role="status">
          <IconWarningOutline16 size={13} />
          <span>{error}</span>
        </div>
      )}

      {error === null && blocked && (
        <div data-ms="notice" role="status">
          <IconWarningOutline16 size={13} />
          <span>{t('web.blocked')}</span>
          <button type="button" onClick={toggleMode}>{t('web.blocked.switch')}</button>
        </div>
      )}

      {error === null && !blocked && unreachable && probe !== null && (
        <div data-ms="notice" role="status">
          <IconWarningOutline16 size={13} />
          <span>{t('web.unreachable', { reason: probe.value.reason ?? '' })}</span>
        </div>
      )}

      <div data-ms="webBody">
        {frameSrc === null
          ? (
            <div data-ms="webEmpty">
              <IconGlobeOutline14 size={22} />
              <span>{t('web.empty')}</span>
              <span>{t('web.empty.hint')}</span>
            </div>
          )
          : (
            <iframe
              /* The key carries the address, the mode, and the reload counter: an
                 iframe cannot be asked to navigate, so a new frame IS the
                 navigation. */
              key={`${active?.id ?? ''}:${active?.mode ?? 'direct'}:${activeUrl}:${String(nonce)}`}
              data-ms="webFrame"
              src={frameSrc}
              sandbox={sandbox}
              referrerPolicy="no-referrer"
              title={labelOf(activeUrl, t('web.title'))}
            />
          )}
      </div>
    </section>
  )

  return createPortal(panel, document.body)
}
