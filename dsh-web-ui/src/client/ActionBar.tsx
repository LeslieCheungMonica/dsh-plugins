/**
 * The frame's action row: ONE horizontal strip of controls at the conversation
 * header's right, above its hairline.
 *
 * It is ONE registration into `shell.overlay` (a root-scope, additive,
 * click-through list seat), and that single-ness is the design:
 *
 * - **One place, both states.** The row is in the frame, not in the session
 *   header, so it does not come and go with the header's chrome. A blank
 *   session's hero renders the header as `display: none` — the state a brand-new
 *   project opens in — and a control that lived in the header would vanish
 *   exactly there.
 * - **No shared state to lose.** With one registration there is no second
 *   trigger to keep in sync, so the drawer's open flag is ordinary component
 *   state. (An earlier two-trigger version needed a hand-rolled observable,
 *   because the slot core refuses one store handle under two scopes — see the
 *   README.)
 * - **One row, several owners.** The row also renders the `shell.action` seat it
 *   declares, so peer plugins put their own controls in the same strip instead of
 *   floating a second bar beside it. That is the only way to get a real row:
 *   two independently positioned fixed bars would each need the other's width.
 *   `my-sider`'s two panel toggles arrive that way. This plugin's own controls
 *   come first, so the strip reads left to right as "the frame's control, then
 *   the panels".
 *
 * ## Where the row sits
 *
 * Immediately above the conversation header's hairline — the 1px line under the
 * header's title and tab rows, measured at y=74 at the frame's own header height.
 * The row's own bottom lands at 66px, which keeps all of it, and not just most of
 * it, on the reader's side of that line. Both offsets are custom properties:
 * `--dsh-web-ui-bar-top` / `--dsh-web-ui-bar-right` move the row, and
 * `--dsh-web-ui-bar-shift` is space RESERVED to its right — `my-sider` writes it
 * while its docked panel is open, so a panel that covers the corner pushes the
 * whole row clear instead of burying Git under it.
 *
 * ## What is in the row, and what is not
 *
 * The row carries the **Git** control. Two others were built and are currently
 * OFF, at the operator's request:
 *
 * - a **right-panel** control for the frame's `details` column — its machinery is
 *   gone with it: it was a dozen lines, and the column belongs to
 *   `ui-conversation`, which opens it when a tool call is clicked;
 * - a **terminal** control for the bottom command bar — its implementation is
 *   INTACT and still type-checked (`TerminalBar.tsx`, `termapi.ts`,
 *   `src/host/term.ts`, `src/host/term-routes.ts`), but nothing imports
 *   `TerminalBar` (so it is not in the bundle at all) and the host registers its
 *   routes only when this plugin's row sets `terminal.enabled: true`.
 *
 * Bringing it back is two edits: set that flag, then add a `BarButton` below
 * (the shape is five lines) and mount `<TerminalBar>` beside `<GitPanel>`. The
 * row is laid out, not positioned, so a third control simply makes it wider.
 *
 * @module dsh-web-ui/client/ActionBar
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { IconBranchOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {
  SessionId, SessionListState, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { NS } from './contract.ts'
import { GitPanel } from './GitPanel.tsx'

/** Composed props: the global seat kit, the row's child seat, and the translator. */
export type ActionBarProps =
  & PropsRuntime<'shell.overlay'>
  & PropsRenderSlots<'shell.action'>
  & PropsLocale<typeof NS>

/**
 * Resolve the repository directory of a session.
 *
 * DSH has no host-side "active workspace", so the directory comes from the
 * workspace whose account lists the session. A session no workspace accounts for
 * has no directory to inspect — a real state (an ungrouped session), not an
 * error — so the Git control is disabled with the reason on its tooltip rather
 * than opening a drawer that can only apologise.
 * @param useWorkspaces - the seat's workspace-list hook.
 * @param sessionId - the session to resolve; undefined when there is none.
 * @returns the absolute project path, or undefined.
 */
function useRepoDir(
  useWorkspaces: (selector: (state: WorkspaceListState) => unknown) => unknown,
  sessionId: SessionId | undefined,
): string | undefined {
  const workspaces = useWorkspaces(state => state.items) as readonly WorkspaceView[]
  return useMemo(
    () => (sessionId === undefined
      ? undefined
      : workspaces.find(workspace => workspace.sessionIds.includes(sessionId))?.path),
    [sessionId, workspaces],
  )
}

/** One control in the bar. */
function BarButton({ label, title, disabled, active, onClick, children }: {
  label: string
  /** Tooltip copy; also the accessible name. */
  title: string
  disabled: boolean
  active: boolean
  onClick: () => void
  children: ReactNode
}): ReactNode {
  return (
    <Tooltip label={title} delayMs={400}>
      <button
        type="button"
        data-wui="actionButton"
        aria-label={title}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
        <span data-wui="actionButtonLabel">{label}</span>
      </button>
    </Tooltip>
  )
}

/**
 * Render the frame's action bar.
 * @param props - the global kit, the row's child seat, and the translator.
 * @returns the row and, while it is open, the git drawer.
 */
export function ActionBar({ useSessions, useWorkspaces, renderSlot, t }: ActionBarProps): ReactNode {
  const [gitOpen, setGitOpen] = useState(false)
  const current = useSessions(state => (state as SessionListState).current) as SessionId | undefined
  const dir = useRepoDir(useWorkspaces, current)

  return (
    <>
      <div data-wui="actionBar" role="toolbar" aria-label={t('bar.aria')} aria-orientation="horizontal">
        <BarButton
          label={t('git.title')}
          title={dir === undefined ? t('git.empty.project') : t('git.open')}
          disabled={dir === undefined}
          active={gitOpen}
          onClick={() => { setGitOpen(open => !open) }}
        >
          <IconBranchOutline16 size={14} />
        </BarButton>
        {/* The peers' half of the strip. Rendered after this plugin's own control
            so the row reads left to right as "the frame's control, then the
            panels" whatever order the two plugins happened to activate in. */}
        {renderSlot('shell.action', {})}
      </div>
      {gitOpen && dir !== undefined && <GitPanel dir={dir} t={t} onClose={() => { setGitOpen(false) }} />}
    </>
  )
}
