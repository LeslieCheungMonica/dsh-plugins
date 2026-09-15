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
 * The bar is pinned below the frame's account chip, and it moves left when the
 * sidebar opens so it stays clickable — the sidebar is docked to the right edge
 * and would otherwise cover it.
 *
 * @module my-sider/client/Launcher
 */
import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { IconCodeOutline16, IconGlobeOutline14, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId, SessionListState, WorkspaceListState, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type { LauncherProps } from './contract.ts'
import { DEFAULT_HEIGHT, MAX_HEIGHT, MIN_HEIGHT, ShellPanel, readHeight } from './ShellPanel.tsx'
import { DEFAULT_WIDTH, MAX_WIDTH_SLACK, MIN_WIDTH, WebPanel } from './WebPanel.tsx'

/** Persistence keys for the two open flags. */
const OPEN_WEB_KEY = 'my-sider.web.open'
const OPEN_SHELL_KEY = 'my-sider.shell.open'

/** Where the bar sits: below the frame's account chip and any peer control row. */
const BAR_TOP = 88

/** Distance from the viewport's right edge when nothing is docked under the bar. */
const BAR_RIGHT = 24

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
export function Launcher({ useSessions, useWorkspaces, t }: LauncherProps): ReactNode {
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

  return (
    <>
      <div
        data-ms="bar"
        role="toolbar"
        aria-label={t('launcher.aria')}
        aria-orientation="horizontal"
        style={{ top: BAR_TOP, right: webOpen ? webWidth + 16 : BAR_RIGHT }}
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
