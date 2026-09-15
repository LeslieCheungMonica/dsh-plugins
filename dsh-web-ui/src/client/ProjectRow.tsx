/**
 * The project row: a project dropdown plus the New Project action, and the
 * flow behind the action.
 *
 * "Project" is this plugin's name for a DSH workspace: a host-registered
 * directory (`WorkspaceView`) whose sessions share its path. There is no
 * host-side "active workspace", so the project this column shows is DERIVED —
 * the workspace that owns the current session, falling back to the most
 * recently active one. Selecting a project therefore means opening (or
 * reusing) a session inside it, which is exactly what the shipped New Session
 * flow does.
 */
import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChevronDownOutline14, IconEditOutline16, IconFolderClose16, IconFolderOpen16,
  IconProjectAddOutline16, IconTrashOutline16, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import { NS, type ShellInjected } from './contract.ts'

/** The translator seat this plugin's copy arrives through. */
type T = TranslateNS<typeof NS>

/** The New Project flow's observable state and entry points. */
export interface ProjectFlow {
  /** A chooser, a directory read, or a create call is in flight. */
  readonly busy: boolean
  /** Last failure message, cleared on the next attempt. */
  readonly error: string | null
  /** True while the in-app folder browser stands in for a missing native chooser. */
  readonly browserOpen: boolean
  /** Start the flow: native chooser first, in-app browser when it is unavailable. */
  readonly newProject: () => void
  /** Open the in-app browser directly (the menu's own affordance). */
  readonly browse: () => void
  /** Dismiss the in-app browser without adopting anything. */
  readonly closeBrowser: () => void
  /** Adopt one absolute path: register it as a project, then open a session in it. */
  readonly adoptPath: (path: string) => void
  /** Dismiss the failure strip. */
  readonly dismissError: () => void
}

/**
 * Message text of an unknown throw, preferring the error's own message.
 * @param reason - the caught value.
 * @returns display text.
 */
function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * Drive the New Project flow over the runtime's public workspace services.
 *
 * The host's directory capability is a boot-time choice (`native` on a local
 * macOS session, `browse` over SSH or LAN): `pickDirectory()` throws
 * `directory-picker-unavailable` when no native chooser exists, so the flow
 * falls back to the in-app browser over `listDirectory`/`createDirectory`
 * instead of leaving the button dead.
 *
 * @param injected - this plugin's runtime face (from the slot registration).
 * @param t - namespace-bound translate.
 * @returns the flow state and its entry points.
 */
export function useProjectFlow(injected: ShellInjected, t: T): ProjectFlow {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [browserOpen, setBrowserOpen] = useState(false)
  const { createWorkspace, pickDirectory, startSession } = injected

  const adoptPath = useCallback((path: string): void => {
    setError(null)
    setBusy(true)
    void (async () => {
      try {
        const workspace = await createWorkspace({ path })
        setBrowserOpen(false)
        startSession(workspace.workspaceId)
      } catch (reason) {
        setError(messageOf(reason))
      } finally {
        setBusy(false)
      }
    })()
  }, [createWorkspace, startSession])

  const newProject = useCallback((): void => {
    setError(null)
    setBusy(true)
    void (async () => {
      try {
        const path = await pickDirectory()
        // Null is the operator's cancel: silent, and no project is created.
        if (path === null) return
        setBusy(false)
        adoptPath(path)
      } catch {
        // No native chooser on this host — browse in the page instead.
        setBrowserOpen(true)
      } finally {
        setBusy(false)
      }
    })()
  }, [adoptPath, pickDirectory])

  return {
    busy,
    error,
    browserOpen,
    newProject,
    browse: useCallback(() => { setBrowserOpen(true) }, []),
    closeBrowser: useCallback(() => { setBrowserOpen(false) }, []),
    adoptPath,
    dismissError: useCallback(() => { setError(null) }, []),
  }
}

/**
 * Render the failure strip of the New Project flow.
 * @param props - the flow plus the copy seat.
 * @returns the strip, or null while there is nothing to report.
 */
export function ProjectErrorStrip({ flow, t }: { flow: ProjectFlow; t: T }): ReactNode {
  if (flow.error === null) return null
  return (
    <div data-wui="error" role="status">
      <span data-wui="errorText">{`${t('project.failed')}: ${flow.error}`}</span>
      <button
        type="button"
        data-wui="iconButton"
        aria-label={t('error.dismiss')}
        onClick={flow.dismissError}
      >
        ×
      </button>
    </div>
  )
}

/** One dropdown row's label: the project title over its dimmed path. */
function projectCell(workspace: WorkspaceView): ReactNode {
  return (
    <span data-wui="menuCell">
      <span data-wui="menuTitle">{workspace.title}</span>
      <span data-wui="menuPath">{workspace.path}</span>
    </span>
  )
}

/**
 * Render the project dropdown and the New Project button as one row.
 * @param props - projects, the derived current one, and the two actions.
 * @returns the row element.
 */
export function ProjectRow({ workspaces, currentId, rail, busy, onSelect, onNewProject, onBrowse, onRenameProject, onDeleteProject, t }: {
  workspaces: readonly WorkspaceView[]
  currentId: WorkspaceId | undefined
  rail: boolean
  busy: boolean
  /** Scope the column to a project. Selecting does NOT start a session. */
  onSelect: (workspaceId: WorkspaceId) => void
  onNewProject: () => void
  onBrowse: () => void
  /** Act on the SELECTED project; absent in the degraded brand-row mode, where the shipped browser owns both dialogs. */
  onRenameProject?: (() => void) | undefined
  onDeleteProject?: (() => void) | undefined
  t: T
}): ReactNode {
  const [open, setOpen] = useState(false)
  const current = currentId === undefined ? undefined : workspaces.find(w => w.workspaceId === currentId)

  const items = useMemo((): MenuEntry[] => [
    ...workspaces.map((workspace): MenuEntry => ({
      id: workspace.workspaceId,
      label: projectCell(workspace),
      icon: <IconFolderOpen16 size={16} />,
    })),
    ...(workspaces.length === 0
      ? [{ type: 'label', id: '__empty', text: t('project.menu.empty') } satisfies MenuEntry]
      : []),
    { type: 'separator', id: '__sep' },
    {
      id: '__new',
      label: t('project.menu.new'),
      icon: <IconProjectAddOutline16 size={16} />,
    },
    // The in-app browser is also a first-class route, not only the fallback for
    // a host whose native chooser is missing.
    {
      id: '__browse',
      label: t('project.menu.browse'),
      icon: <IconFolderClose16 size={16} />,
    },
    // Actions on the SELECTED project. They are rows of their own — not a
    // submenu on each project row — because a MenuItem carrying a submenu opens
    // its children instead of reporting the click, which would leave project
    // rows impossible to select.
    ...(current === undefined
      ? []
      : [
        { type: 'separator', id: '__sep2' } satisfies MenuEntry,
        ...(onRenameProject === undefined ? [] : [{
          id: '__rename',
          label: t('rename.project.menu'),
          icon: <IconEditOutline16 size={16} />,
        } satisfies MenuEntry]),
        ...(onDeleteProject === undefined ? [] : [{
          id: '__delete',
          label: t('project.delete.menu'),
          icon: <IconTrashOutline16 size={16} />,
          danger: true,
        } satisfies MenuEntry]),
      ]),
  ], [current, onDeleteProject, onRenameProject, t, workspaces])

  return (
    <div data-wui="projectRow" data-wui-rail-in="true">
      <Menu
        open={open}
        anchor={(
          <button
            type="button"
            data-wui="projectTrigger"
            aria-label={`${t('project.label')}: ${current?.title ?? t('project.none')}`}
            aria-haspopup="menu"
            aria-expanded={open}
            title={current?.path ?? t('project.hint')}
            onClick={() => { setOpen(v => !v) }}
          >
            <span data-wui="projectIcon" aria-hidden="true"><IconFolderOpen16 size={16} /></span>
            {!rail && (
              <span data-wui="projectTitle" data-empty={current === undefined || undefined}>
                {current?.title ?? t('project.none')}
              </span>
            )}
            {!rail && (
              <span data-wui="projectChevron" aria-hidden="true"><IconChevronDownOutline14 size={14} /></span>
            )}
          </button>
        )}
        items={items}
        {...(currentId !== undefined ? { selectedId: currentId } : {})}
        onSelect={(id) => {
          setOpen(false)
          if (id === '__new') { onNewProject(); return }
          if (id === '__browse') { onBrowse(); return }
          if (id === '__rename') { onRenameProject?.(); return }
          if (id === '__delete') { onDeleteProject?.(); return }
          onSelect(id as WorkspaceId)
        }}
        onClose={() => { setOpen(false) }}
        portal
        side={rail ? 'right' : 'bottom'}
      />
      <button
        type="button"
        data-wui="iconButton"
        data-wui-accent="true"
        aria-label={t('project.new.label')}
        title={t('project.new.label')}
        disabled={busy}
        onClick={onNewProject}
      >
        <IconProjectAddOutline16 size={16} />
      </button>
    </div>
  )
}
