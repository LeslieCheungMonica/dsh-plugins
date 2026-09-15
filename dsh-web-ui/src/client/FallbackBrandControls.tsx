/**
 * Degraded contribution: the project row in the SHIPPED shell's brand row.
 *
 * This plugin's normal path takes the `sidebar` slot over, which requires the
 * `ui-sidebar` row to be disabled (one occupant per slot, one declarer per
 * child key). When that row is still mounted — a deployment that installed this
 * plugin without its patch layer — occupying `sidebar` is impossible, and
 * leaving the column empty would strand the operator with no navigation at all.
 * So the plugin falls back to shadowing the brand-name seat instead: the same
 * project dropdown and New Project button, one row above the shipped New
 * Session button, with everything else in the shipped shell untouched.
 *
 * The seat renders INSIDE the shipped brand `<button>`, which is itself a New
 * Session shortcut, so this subtree stops click and key activation from
 * bubbling into it.
 */
import type { ReactNode } from 'react'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { FallbackProps } from './contract.ts'
import { BrowseFoldersDialog } from './BrowseFoldersDialog.tsx'
import { NewProjectDialog } from './NewProjectDialog.tsx'
import { ProjectErrorStrip, ProjectFolderStrip, ProjectFolderToast, ProjectRow } from './ProjectRow.tsx'
import { useProjectFlow } from './projectFlow.ts'

/** Stop an activation event at this subtree's boundary. */
function consume(event: { stopPropagation: () => void }): void {
  event.stopPropagation()
}

/**
 * Render the project row into the shipped sidebar's brand-name seat.
 * @param props - composed slot props for the `sidebar.brand.name` registration.
 * @returns the controls plus their dialogs.
 */
export function FallbackBrandControls(props: FallbackProps): ReactNode {
  const { t, startSession, useSessions, useWorkspaces } = props
  const workspaces = useWorkspaces(s => s.items)
  const recentWorkspaceId = useWorkspaces(s => s.recentWorkspaceId)
  const currentSessionId = useSessions(s => s.current)
  const owning = currentSessionId === undefined
    ? undefined
    : workspaces.find(workspace => workspace.sessionIds.includes(currentSessionId))?.workspaceId
  const currentId: WorkspaceId | undefined = owning ?? recentWorkspaceId
  const selected = currentId === undefined ? undefined : workspaces.find(w => w.workspaceId === currentId)
  const flow = useProjectFlow(props, t)

  return (
    <span
      data-wui="brandRowFallback"
      onClick={consume}
      onPointerDown={consume}
      onKeyDown={consume}
    >
      <ProjectRow
        workspaces={workspaces}
        currentId={currentId}
        rail={false}
        busy={flow.busy}
        onSelect={(workspaceId) => { startSession(workspaceId) }}
        onNewProject={flow.newProject}
        onEditProject={() => {
          if (selected !== undefined) {
            flow.editProject({ workspaceId: selected.workspaceId, path: selected.path, title: selected.title })
          }
        }}
        t={t}
      />
      <ProjectErrorStrip flow={flow} t={t} />
      <ProjectFolderStrip flow={flow} t={t} />
      <ProjectFolderToast flow={flow} t={t} />
      {/* The same two dialogs the full column renders, in the same order and for
          the same reason: the New Project action is the FORM here too, and its
          folder field is what opens the browser. A degraded path that offered a
          bare folder chooser would be a second, divergent New Project flow. */}
      <NewProjectDialog
        open={flow.formOpen}
        mode={flow.formMode}
        draft={flow.draft}
        cards={flow.cards}
        onChange={flow.updateDraft}
        onChooseFolder={flow.pickWorkspaceFolder}
        busy={flow.busy}
        pickError={flow.pickError}
        onSubmit={flow.formMode === 'edit' ? flow.submitProjectEdit : flow.submitNewProject}
        onClose={flow.closeForm}
        t={t}
      />
      <BrowseFoldersDialog
        open={flow.browserOpen}
        t={t}
        listDirectory={props.listDirectory}
        createDirectory={props.createDirectory}
        onPicked={flow.adoptPath}
        onClose={flow.closeBrowser}
      />
    </span>
  )
}
