/**
 * The launcher: the two controls that open this plugin's two panels, plus the
 * geometry both panels share.
 *
 * It is ONE registration into `shell.overlay` — the frame's additive,
 * root-scope, click-through floating layer — and that single-ness is the design:
 *
 * - **One owner for both panels' state.** Whether each panel is open, how wide
 *   the sidebar is, and how tall the command panel is all live here, so the two
 *   panels can be laid out as one tiling (the sidebar stops where the command
 *   panel begins) instead of two surfaces guessing at each other's geometry.
 * - **No shared state to lose.** With one registration the open flags are
 *   ordinary component state; there is no second trigger to keep in sync.
 * - **Additive by construction.** A fresh `id` in a list seat sits BESIDE
 *   whatever else occupies `shell.overlay` (a git control, a status pill) rather
 *   than replacing it, so installing this plugin cannot remove another plugin's
 *   chrome.
 *
 * The launcher renders into `dsh-web-ui`'s shared action strip when that plugin is
 * present (its `shell.action` seat), and pins its own bar when it is not — the
 * row the operator asked for is one line of controls at the conversation header's
 * right, and two plugins cannot each own half of one line by positioning
 * themselves independently. Either way the sidebar it opens is docked to the right
 * edge and would cover the controls, so space is reserved to their right while it
 * is open: in-row through the strip's `--dsh-web-ui-bar-shift`, alone through the
 * bar's own inline offset.
 *
 * @module my-sider/client/Launcher
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconCodeOutline16, IconGlobeOutline14, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId, SessionListState, WorkspaceListState, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type { LauncherProps } from './contract.ts'
import type { WebSidebarRequest } from './sidebar.ts'
import { DEFAULT_HEIGHT, MAX_HEIGHT, MIN_HEIGHT, ShellPanel, readHeight } from './ShellPanel.tsx'
import { DEFAULT_WIDTH, MAX_WIDTH_SLACK, MIN_WIDTH, WebPanel } from './WebPanel.tsx'

/** Persistence keys for the two open flags. */
const OPEN_WEB_KEY = 'my-sider.web.open'
const OPEN_SHELL_KEY = 'my-sider.shell.open'

/**
 * Where the pinned bar sits when this plugin has no shared strip to live in:
 * just above the conversation header's hairline (y=74 at the frame's own header
 * height), matching where `dsh-web-ui`'s row puts the same controls.
 */
const BAR_TOP = 40

/** Distance from the viewport's right edge when nothing is docked under the bar. */
const BAR_RIGHT = 24

/**
 * The custom property the shared strip honors as space reserved to its right.
 *
 * A cross-plugin CSS contract, and the only one here: the strip's right edge
 * belongs to the plugin that renders it, so a peer whose docked panel covers that
 * corner cannot move its own controls out of the way — it can only ask the whole
 * row to step aside. The name is `dsh-web-ui`'s, documented there beside the two
 * offsets a deployment already tunes.
 */
const BAR_SHIFT_PROPERTY = '--dsh-web-ui-bar-shift'

/**
 * Read one persisted flag.
 * @param key - the storage key.
 * @returns the stored flag, or false.
 */
function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1'
  } catch {
    // A blocked localStorage is not a reason to lose the panel.
    return false
  }
}

/**
 * Persist one flag.
 * @param key - the storage key.
 * @param value - the flag.
 */
function writeFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // A blocked localStorage is not a reason to lose the toggle.
  }
}

/**
 * Read the persisted sidebar width, clamped to what this viewport can hold.
 * @returns the width in px.
 */
function readWebWidth(): number {
  let stored = DEFAULT_WIDTH
  try {
    const raw = window.localStorage.getItem('my-sider.web.width')
    const value = raw === null ? Number.NaN : Number.parseFloat(raw)
    if (Number.isFinite(value)) stored = value
  } catch {
    // A blocked localStorage is not a reason to lose the panel.
  }
  const max = Math.max(MIN_WIDTH, window.innerWidth - MAX_WIDTH_SLACK)
  return Math.min(max, Math.max(MIN_WIDTH, stored))
}

/** One launcher control. */
function BarButton({ label, title, active, onClick, children }: {
  label: string
  /** Tooltip copy; also the accessible name. */
  title: string
  active: boolean
  onClick: () => void
  children: ReactNode
}): ReactNode {
  return (
    <Tooltip label={title} delayMs={400}>
      <button
        type="button"
        data-ms="barButton"
        aria-label={title}
        aria-pressed={active}
        onClick={onClick}
      >
        {children}
        <span data-ms="barButtonLabel">{label}</span>
      </button>
    </Tooltip>
  )
}

/**
 * Render the launcher bar and, while they are open, the two panels.
 * @param props - the frame's global session/workspace hooks and the translator.
 * @returns the bar and whichever panels are open.
 */
export function Launcher({ useSessions, useWorkspaces, inRow, requests, t }: LauncherProps): ReactNode {
  const [webOpen, setWebOpen] = useState(() => readFlag(OPEN_WEB_KEY))
  const [shellOpen, setShellOpen] = useState(() => readFlag(OPEN_SHELL_KEY))
  const [webWidth, setWebWidth] = useState(readWebWidth)
  const [shellHeight, setShellHeight] = useState(() => Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, readHeight())))

  const sessionId = useSessions(state => (state as SessionListState).current) as SessionId | undefined
  const workspaces = useWorkspaces(state => (state as WorkspaceListState).items) as readonly WorkspaceView[]

  // DSH has no host-side "active workspace", so the directory a command runs in
  // comes from the workspace whose account lists the current session. A session
  // no workspace accounts for (an ungrouped session, a brand-new one) has no
  // project directory — a real state, not an error — and the panel then falls
  // back to the directory the host was started in.
  const sessionDir = useMemo(
    () => (sessionId === undefined
      ? undefined
      : workspaces.find(workspace => workspace.sessionIds.includes(sessionId))?.path),
    [sessionId, workspaces],
  )

  /**
   * Toggle the sidebar and remember the choice.
   * @param next - the new state.
   */
  const persistWeb = useCallback((next: boolean): void => {
    setWebOpen(next)
    writeFlag(OPEN_WEB_KEY, next)
  }, [])

  /**
   * Toggle the command panel and remember the choice.
   * @param next - the new state.
   */
  const persistShell = useCallback((next: boolean): void => {
    setShellOpen(next)
    writeFlag(OPEN_SHELL_KEY, next)
  }, [])

  /**
   * Remember a dragged sidebar width.
   * @param value - the new width in px.
   */
  const resizeWeb = useCallback((value: number): void => {
    setWebWidth(value)
    try {
      window.localStorage.setItem('my-sider.web.width', String(Math.round(value)))
    } catch {
      // A blocked localStorage is not a reason to lose the resize.
    }
  }, [])

  /**
   * The most recent "open this in the sidebar" request from another plugin, or
   * null while there has been none. It is state rather than a ref because the
   * panel below has to re-act on it, and `id` is what makes two clicks on the
   * same URL two events.
   */
  const [request, setRequest] = useState<WebSidebarRequest | null>(null)
  /** The highest request id already handed to the panel. */
  const applied = useRef(0)

  /**
   * Remember a dragged command-panel height.
   * @param value - the new height in px.
   */
  const resizeShell = useCallback((value: number): void => {
    setShellHeight(value)
    try {
      window.localStorage.setItem('my-sider.shell.height', String(Math.round(value)))
    } catch {
      // A blocked localStorage is not a reason to lose the resize.
    }
  }, [])

  // Another plugin's document link: open the panel and hand the address to the
  // tabs below. `open()`'s boolean answer already told the caller whether a
  // launcher was listening, so a request that arrives here is one this mount
  // owns — the id guard only defends against a re-subscribe replaying one.
  useEffect(() => {
    return requests.subscribe((next) => {
      if (next.id <= applied.current) return
      applied.current = next.id
      setRequest(next)
      persistWeb(true)
    })
  }, [requests, persistWeb])

  // Inside the shared strip this plugin's controls cannot step aside on their
  // own: the strip is one unit and its right edge belongs to whichever plugin
  // rendered it. So the space is RESERVED instead — the open sidebar's width goes
  // into the property the row honors, and the whole row slides clear. Written on
  // `document.body` because the row is a sibling in the frame's overlay layer and
  // body is the nearest ancestor the two share. Alone, the bar keeps its own
  // inline offset and needs none of this.
  useEffect(() => {
    if (!inRow || !webOpen) return
    const body = document.body
    body.style.setProperty(BAR_SHIFT_PROPERTY, `${Math.round(webWidth) + 16}px`)
    return () => { body.style.removeProperty(BAR_SHIFT_PROPERTY) }
  }, [inRow, webOpen, webWidth])

  return (
    <>
      <div
        data-ms="bar"
        data-inline={inRow || undefined}
        // The shared strip is already a toolbar with its own accessible name, so
        // in-row this is a plain group of the strip's controls; alone, it is the
        // toolbar and has to say so itself.
        role={inRow ? undefined : 'toolbar'}
        aria-label={inRow ? undefined : t('launcher.aria')}
        aria-orientation={inRow ? undefined : 'horizontal'}
        style={inRow ? undefined : { top: BAR_TOP, right: webOpen ? webWidth + 16 : BAR_RIGHT }}
      >
        <BarButton
          label={t('launcher.web')}
          title={t('launcher.web.hint')}
          active={webOpen}
          onClick={() => { persistWeb(!webOpen) }}
        >
          <IconGlobeOutline14 size={12} />
        </BarButton>
        <BarButton
          label={t('launcher.shell')}
          title={t('launcher.shell.hint')}
          active={shellOpen}
          onClick={() => { persistShell(!shellOpen) }}
        >
          <IconCodeOutline16 size={12} />
        </BarButton>
      </div>

      {webOpen && (
        <WebPanel
          t={t}
          width={webWidth}
          bottom={shellOpen ? shellHeight : 0}
          openRequest={request}
          onWidth={resizeWeb}
          onClose={() => { persistWeb(false) }}
        />
      )}

      {shellOpen && (
        <ShellPanel
          t={t}
          height={shellHeight}
          sessionDir={sessionDir}
          onHeight={resizeShell}
          onClose={() => { persistShell(false) }}
        />
      )}
    </>
  )
}
