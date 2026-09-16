/**
 * This plugin's left column.
 *
 * It occupies the frame-owned `sidebar` slot and declares the five seats the
 * shipped shell used to declare, so the shipped region occupants land here:
 * the workspace browser (`sidebar.workspaces`, including its own rail icons and
 * its directory flow), the settings shell (`sidebar.settings`), the brand seats,
 * and the additive footer actions. It declares two more of its own — the
 * bottom-left account dock and the rows inside that dock's drawer — because the
 * account controls live in this corner now instead of the frame's top-right
 * corner (see AccountDock.tsx). This component owns only what is genuinely
 * its own — the column's geometry, its header, and the project row that sits
 * directly above the New Session button. The header's brand row is one of those
 * owned facts: the mark seat and the name seat are still rendered as slots, but
 * their FALLBACKS are this deployment's (the AsiaInfo mark and `ForgeX`), so a
 * deployment that registers its own occupant still wins over the rebrand.
 *
 * Collapse mirrors the shipped shell's contract: the column keeps its frozen
 * expanded layout while the frame animates the track, and the rail layout only
 * applies once that transition settles, so nothing reflows mid-slide. The
 * owner props (`collapsed`, `width`) come from the frame's own concession
 * solve; the rail is never a second layout decision made here.
 */
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import {
  IconNewChatOutline16, IconPanelLeftOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import { AsiaInfoMark } from './AsiaInfoMark.tsx'
import { AccountDock } from './AccountDock.tsx'
import type { ShellProps } from './contract.ts'
import { BrowseFoldersDialog } from './BrowseFoldersDialog.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { LarkDocsPanel } from './LarkDocsPanel.tsx'
import { NewProjectDialog } from './NewProjectDialog.tsx'
import { ProjectErrorStrip, ProjectFolderStrip, ProjectFolderToast, ProjectRow } from './ProjectRow.tsx'
import { StageTag } from './StageTag.tsx'
import { NO_PROJECT_SCOPE } from './stage.ts'
import { useProjectFlow } from './projectFlow.ts'
import { useProjectScope } from './project.ts'

/** Wide-content unmount delay; matches the 150ms wide-content fade-out. */
const COLLAPSE_SETTLE_MS = 150

/**
 * Where the split between the two halves of the browsing region starts, as the
 * percentage of the region the SESSION list gets. The reader can drag it, and
 * the value is persisted, so the shape a reader settled on survives a reload.
 */
const DEFAULT_SPLIT = 50

/** Storage key of the persisted split. */
const SPLIT_KEY = 'dsh-web-ui.split'

/** The drag's bounds: neither half may be squeezed out of reach. */
const MIN_SPLIT = 20
const MAX_SPLIT = 80

/**
 * Read the persisted split.
 * @returns the stored percentage, or the default when there is none.
 */
function readSplit(): number {
  try {
    const stored = window.localStorage.getItem(SPLIT_KEY)
    if (stored === null) return DEFAULT_SPLIT
    const value = Number.parseFloat(stored)
    if (!Number.isFinite(value)) return DEFAULT_SPLIT
    return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, value))
  } catch {
    // A blocked localStorage (private mode, a locked-down browser) is not a
    // reason to lose the panel.
    return DEFAULT_SPLIT
  }
}

/**
 * The product name this deployment ships under: the `sidebar.brand.name` seat's
 * fallback. A rebrand is a mark plus a name, and only the DEFAULTS move here —
 * the seat keeps its occupant protocol, so a registration against
 * `sidebar.brand.name` still wins over this string.
 */
const BRAND_NAME = 'ForgeX'

/**
 * Render the project-first sidebar column.
 * @param props - composed slot props (frame column state + child render shares
 * + this plugin's injected face + the typed `t` seat).
 * @returns the column element tree.
 */
export function Shell(props: ShellProps): ReactNode {
  const {
    collapsed, width, renderSlot, t,
    useSessions, useWorkspaces, useStore, actions,
    startSession, toggleSidebar, listDirectory, createDirectory,
    selectProject, renameWorkspace, deleteWorkspace, listPlugins, listMarketSkills,
    listInstalledSkills, installMarketSkill, openInSidebar,
  } = props

  // Wide content stays mounted while the collapse animates, unmounts at
  // settle, and remounts right away on expand (the shipped shell's timing, so
  // the two shells are interchangeable behind the frame).
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (!collapsed) { setSettled(false); return }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed])
  const wide = !collapsed || !settled
  const rail = !wide

  // Freeze the column at its expanded width while the content fades out, so the
  // sliding track clips it instead of reflowing it mid-slide.
  const lastWideWidth = useRef(width)
  if (!collapsed) lastWideWidth.current = width
  // Rail-in only animates a live collapse; a refresh straight into the
  // collapsed state renders the rail statically.
  const everWide = useRef(!collapsed)
  if (!collapsed) everWide.current = true

  // The selected project is one fact shared with the session list below: the
  // dropdown writes it, the list reads it, and both follow the current session
  // when it moves (see project.ts).
  const scope = useProjectScope({ useWorkspaces, useSessions, useStore, select: selectProject })
  const { workspaces, selectedId, selected } = scope
  const currentId: WorkspaceId | undefined = selectedId

  const flow = useProjectFlow(props, t)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [projectBusy, setProjectBusy] = useState(false)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // The browsing region is split in two: sessions above, Feishu documents
  // below. The split is this column's own layout fact, so it lives here and not
  // in either occupant; the drag writes it through the region element's rect,
  // which keeps the two halves correct whatever the column's width is.
  const regionRef = useRef<HTMLDivElement | null>(null)
  const splitRef = useRef(DEFAULT_SPLIT)
  const [split, setSplit] = useState(DEFAULT_SPLIT)
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    const stored = readSplit()
    splitRef.current = stored
    setSplit(stored)
  }, [])
  const persistSplit = (value: number): void => {
    try {
      window.localStorage.setItem(SPLIT_KEY, String(value))
    } catch {
      // Persistence is a convenience: a locked-down browser keeps the drag
      // working for this session and simply forgets it afterwards.
    }
  }
  const splitAt = (clientY: number): void => {
    const region = regionRef.current
    if (region === null) return
    const rect = region.getBoundingClientRect()
    if (rect.height <= 0) return
    const ratio = ((clientY - rect.top) / rect.height) * 100
    const clamped = Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, ratio))
    // The ref carries the live value to pointer-up: the drag's own re-renders
    // must not be what decides the value the reader finally gets.
    splitRef.current = clamped
    setSplit(clamped)
  }
  const onSplitterDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
    splitAt(event.clientY)
  }
  const onSplitterMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    splitAt(event.clientY)
  }
  const onSplitterUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    setDragging(false)
    persistSplit(splitRef.current)
  }

  return (
    <div
      data-wui="column"
      data-rail={rail || undefined}
      data-fading={(collapsed && wide) || undefined}
      data-rail-in={(rail && everWide.current) || undefined}
      style={wide ? { width: collapsed ? lastWideWidth.current : width } : undefined}
    >
      <div data-wui="header" data-wui-rail-in="true">
        {!rail && (
          <span data-wui="brand" data-wui-wide="true">
            <span data-wui="brandMark" aria-hidden="true">
              {renderSlot('sidebar.brand.mark', { size: 24 }, { fallback: <AsiaInfoMark size={24} /> })}
            </span>
            <span data-wui="brandName">
              {renderSlot('sidebar.brand.name', {}, { fallback: BRAND_NAME })}
            </span>
          </span>
        )}
        <Tooltip label={collapsed ? t('toggle.open') : t('toggle.collapse')} delayMs={500}>
          <button
            type="button"
            data-wui="iconButton"
            aria-label={collapsed ? t('toggle.open') : t('toggle.collapse')}
            onClick={() => { toggleSidebar() }}
          >
            {rail && (
              <span data-wui="brandMark" aria-hidden="true">
                {renderSlot('sidebar.brand.mark', { size: 24 }, { fallback: <AsiaInfoMark size={24} /> })}
              </span>
            )}
            {!rail && <IconPanelLeftOutline16 size={16} />}
          </button>
        </Tooltip>
      </div>

      <ProjectRow
        workspaces={workspaces}
        currentId={currentId}
        rail={rail}
        busy={flow.busy}
        onSelect={(workspaceId) => { selectProject(workspaceId) }}
        onEditProject={() => {
          if (selected !== undefined) {
            flow.editProject({ workspaceId: selected.workspaceId, path: selected.path, title: selected.title })
          }
        }}
        onDeleteProject={() => {
          setDeleteError(null)
          setDeleteOpen(true)
        }}
        onNewProject={flow.newProject}
        t={t}
      />

      <ProjectErrorStrip flow={flow} t={t} />
      <ProjectFolderStrip flow={flow} t={t} />
      {/* The creation success is a system banner, not a row here: it renders
          through a body portal, so the column's layout never moves for it. */}
      <ProjectFolderToast flow={flow} t={t} />
      {projectError !== null && (
        <div data-wui="error" role="status">
          <span data-wui="errorText">{projectError}</span>
        </div>
      )}

      {/* The FDE stage tag, directly above the New Session button it belongs
          to: the stage describes the project this column is scoped to, and the
          button is what starts its next piece of work. The project's PATH
          travels with it because a gated transition is checked against the
          project's Feishu folder, and the host resolves that folder from the
          path (see StageTag.tsx). */}
      <StageTag
        scopeKey={currentId === undefined ? NO_PROJECT_SCOPE : String(currentId)}
        scopePath={selected?.path}
        scopeLabel={selected?.title}
        rail={rail}
        openInSidebar={openInSidebar}
        t={t}
      />

      <Tooltip label={t('session.new.hint', { project: selected?.title ?? t('project.none') })} delayMs={500} disabled={wide}>
        <button
          type="button"
          data-wui="newSession"
          data-wui-rail-in="true"
          aria-label={t('session.new.label')}
          aria-busy={flow.busy || undefined}
          onClick={() => { startSession(currentId) }}
        >
          <IconNewChatOutline16 size={wide ? 15 : 18} />
          {wide && <span data-wui="newSessionLabel">{t('session.new')}</span>}
        </button>
      </Tooltip>

      {/* The browsing region keeps the shipped occupant: this column hands it
          the same two facts the shipped shell did. Below it the column adds the
          one thing it owns — the Feishu document panel — so the shipped session
          browser stays exactly where a reader expects it. In the rail there is
          no room for two halves: the region is the session browser's alone. */}
      <div data-wui="region" data-wui-rail-in="true" ref={regionRef}>
        <div
          data-wui="regionTop"
          style={rail ? undefined : { flexGrow: split, flexBasis: 0 }}
        >
          {renderSlot('sidebar.workspaces', {
            wide,
            expandSidebar: () => { if (collapsed) toggleSidebar() },
          })}
        </div>
        {!rail && (
          <>
            <div
              data-wui="splitter"
              data-dragging={dragging || undefined}
              role="separator"
              aria-orientation="horizontal"
              aria-label={t('lark.title')}
              title={t('lark.title')}
              onPointerDown={onSplitterDown}
              onPointerMove={onSplitterMove}
              onPointerUp={onSplitterUp}
              onPointerCancel={onSplitterUp}
              onDoubleClick={() => {
                splitRef.current = DEFAULT_SPLIT
                setSplit(DEFAULT_SPLIT)
                persistSplit(DEFAULT_SPLIT)
              }}
            />
            <div
              data-wui="regionBottom"
              style={{ flexGrow: 100 - split, flexBasis: 0 }}
            >
              {/* The panel is about ONE project: the selected one, whose Feishu
                  folder it shows. The two fields it needs — the path that keys
                  the record, and the title its folder is named after — travel
                  from the scope this column already resolved. */}
              <LarkDocsPanel
                t={t}
                project={selected === undefined
                  ? undefined
                  : { path: selected.path, title: selected.title }}
                openInSidebar={openInSidebar}
              />
            </div>
          </>
        )}
      </div>

      <div data-wui="foot">
        {renderSlot('sidebar.footer.action', { wide })}
        {/* The account dock owns the column's bottom-left corner, and the
            Settings trigger it used to sit beside now renders INSIDE the dock's
            drawer (see AccountDock.tsx). The seat is unchanged — only its
            position in this tree moved. */}
        <AccountDock
          wide={wide}
          expandSidebar={() => { if (collapsed) toggleSidebar() }}
          // The skills modal scans the PROJECT's skill roots too, so the dock needs
          // the project this column is scoped to. It is the same fact the session
          // list and the Feishu panel already read from the scope above.
          projectPath={selected?.path}
          renderSlot={renderSlot}
          useSessions={useSessions}
          listPlugins={listPlugins}
          listMarketSkills={listMarketSkills}
          listInstalledSkills={listInstalledSkills}
          installMarketSkill={installMarketSkill}
          t={t}
        />
      </div>

      {/* The New Project form. It sits ABOVE the folder browser in this tree
          because choosing a folder hands the page to that browser: the flow
          closes the form for the round trip and reopens it with the draft
          intact, so the two dialogs are never up at the same time (one modal
          layer, two surfaces). */}
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
        listDirectory={listDirectory}
        createDirectory={createDirectory}
        onPicked={flow.adoptPath}
        onClose={flow.closeBrowser}
      />
      <ConfirmDialog
        open={deleteOpen}
        title={t('project.delete.title')}
        message={t('project.delete.message', { name: selected?.title ?? '' })}
        confirmLabel={t('project.delete.confirm')}
        cancelLabel={t('picker.cancel')}
        busy={projectBusy}
        onConfirm={() => {
          if (selected === undefined) { setDeleteOpen(false); return }
          setProjectBusy(true)
          setDeleteError(null)
          void deleteWorkspace(selected.workspaceId).then(
            () => { setDeleteOpen(false) },
            (reason: unknown) => {
              setDeleteError(reason instanceof Error ? reason.message : String(reason))
            },
          ).finally(() => { setProjectBusy(false) })
        }}
        onClose={() => { setDeleteOpen(false) }}
      />
      {deleteError !== null && (
        <div data-wui="error" role="status">
          <span data-wui="errorText">{deleteError}</span>
        </div>
      )}
    </div>
  )
}
