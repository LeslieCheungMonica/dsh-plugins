/**
 * The project row: a project dropdown, the New Project action, and what the
 * row's flow reports — a failure strip in the column, a success as a system
 * banner.
 *
 * "Project" is this plugin's name for a DSH workspace: a host-registered
 * directory (`WorkspaceView`) whose sessions share its path. There is no
 * host-side "active workspace", so the project this column shows is DERIVED —
 * the workspace that owns the current session, falling back to the most
 * recently active one. Selecting a project therefore means opening (or
 * reusing) a session inside it, which is exactly what the shipped New Session
 * flow does.
 *
 * The flow itself — the form, the workspace call, and the Feishu folder it
 * creates — is `projectFlow.ts`; this module renders it and owns the copy.
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconEditOutline16, IconFolderOpen16,
  IconProjectAddOutline16, IconTrashOutline16, Menu, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import { NS } from './contract.ts'
import type { ProjectFlow } from './projectFlow.ts'

/** The translator seat this plugin's copy arrives through. */
type T = TranslateNS<typeof NS>

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

/**
 * Announce that the project's Feishu folder was created.
 *
 * A SYSTEM banner, not a row of the column: the column exists to navigate, and a
 * success is something the operator reads once rather than state they have to
 * dismiss — as a strip it would also push the session list down for four seconds
 * on every project creation. This is the shell's own transient banner (top
 * center, rendered through a body portal, hold-then-fade), the same surface the
 * shipped UI uses for its notices.
 *
 * A FAILURE deliberately does not come here: it carries a fix (a permission, a
 * login, the network), so it stays in the column until the operator dismisses it.
 * @param props - the flow plus the copy seat.
 * @returns the banner, or null while no notice is pending.
 */
export function ProjectFolderToast({ flow, t }: { flow: ProjectFlow; t: T }): ReactNode {
  const notice = flow.systemNotice
  if (notice === null) return null
  return (
    <Toast
      // Keying by the per-show sequence restarts the hold-then-fade cycle when
      // the SAME sentence is announced again — which is what creating a second
      // project with an equal name does.
      key={notice.seq}
      text={notice.text}
      icon={<IconCheckOutline16 />}
      onDone={flow.dismissSystemNotice}
    />
  )
}

/**
 * Render a Feishu-folder failure in the column, where its fix can stay visible.
 * @param props - the flow plus the copy seat.
 * @returns the strip, or null while the flow has nothing to report.
 */
export function ProjectFolderStrip({ flow, t }: { flow: ProjectFlow; t: T }): ReactNode {
  const notice = flow.folderNotice
  if (notice === null) return null
  return (
    <div data-wui="folderNotice" data-tone={notice.tone} role="alert">
      <span data-wui="folderNoticeText">{notice.text}</span>
      <button
        type="button"
        data-wui="iconButton"
        aria-label={t('feishu.folder.dismiss')}
        onClick={flow.dismissFolderNotice}
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
export function ProjectRow({ workspaces, currentId, rail, busy, onSelect, onNewProject, onEditProject, onDeleteProject, t }: {
  workspaces: readonly WorkspaceView[]
  currentId: WorkspaceId | undefined
  rail: boolean
  busy: boolean
  /** Scope the column to a project. Selecting does NOT start a session. */
  onSelect: (workspaceId: WorkspaceId) => void
  onNewProject: () => void
  /**
   * Act on the SELECTED project; absent in the degraded brand-row mode, where the
   * shipped browser owns it.
   *
   * There is no separate "rename" row any more: the name is one of the fields the
   * edit form changes, so a second dialog that changes only that field would be a
   * smaller version of the same thing.
   */
  onEditProject?: (() => void) | undefined
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
    // Actions on the SELECTED project. They are rows of their own — not a
    // submenu on each project row — because a MenuItem carrying a submenu opens
    // its children instead of reporting the click, which would leave project
    // rows impossible to select.
    ...(current === undefined
      ? []
      : [
        { type: 'separator', id: '__sep2' } satisfies MenuEntry,
        ...(onEditProject === undefined ? [] : [{
          id: '__edit',
          label: t('project.edit.menu'),
          icon: <IconEditOutline16 size={16} />,
        } satisfies MenuEntry]),
        ...(onDeleteProject === undefined ? [] : [{
          id: '__delete',
          label: t('project.delete.menu'),
          icon: <IconTrashOutline16 size={16} />,
          danger: true,
        } satisfies MenuEntry]),
      ]),
  ], [current, onDeleteProject, onEditProject, t, workspaces])

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
          if (id === '__edit') { onEditProject?.(); return }
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
