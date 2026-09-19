/**
 * The New Project flow: the state machine behind the project row's "+" action
 * and its two strips.
 *
 * It lives in its own module — not inside the component that renders it — for
 * two reasons. It is the one place in this plugin where a *side effect the
 * operator cannot see* happens (a folder appears in Feishu), so it is worth
 * being able to pin down on its own; and it holds no JSX, so a test can drive it
 * without materializing the primitive library the row renders with.
 *
 * The flow's shape, in order:
 *
 * 1. Open the New Project form (`NewProjectDialog`), which is where the
 *    operator answers what the project IS: its name, its workspace directory,
 *    and its product background. The DIRECTION of the old flow is the one thing
 *    that changed: it used to open the host's directory chooser directly, so a
 *    folder was all a project could be described by. The draft lives HERE, and
 *    not in the dialog, because choosing a folder hands the page to the browser
 *    dialog and closes the form — a draft owned by the form would be discarded
 *    by that round trip.
 * 2. Choose the directory: `pickDirectory` first (the host's native chooser),
 *    falling back to this plugin's in-app browser when the host has none. That
 *    fallback is what produces the draft's `path`, so it never opens the form's
 *    question twice.
 * 3. Register the path as a project (`createWorkspace` — idempotent by path),
 *    apply the operator's name, and open a session in it. From here the project
 *    is REAL, whatever happens next.
 * 4. Ask the host to guarantee the project's folder in this deployment's Feishu
 *    folder. This one is NOT awaited: it runs in the background and reports
 *    itself in a strip, because a Feishu outage must cost the operator a notice,
 *    never their project.
 */
import { useCallback, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ShellInjected } from './contract.ts'
import { NS } from './contract.ts'
import { createProjectFolder, readProductCards, readProjectRecord, writeProjectRecord } from './larkapi.ts'
import type { LarkError } from './larkapi.ts'
import type { ProductCardResult } from './productCards.ts'
import type { NewProjectDraft, ProductBackground } from './NewProjectDialog.tsx'

/** The translator seat this plugin's copy arrives through. */
type T = TranslateNS<typeof NS>

/**
 * One line the Feishu-folder side effect reported, ready to render.
 *
 * Failures only. A creation that worked is announced through
 * {@link SystemNotice} instead of through a strip: the column is a navigation
 * surface, and "this went fine" does not deserve a row of it that the operator
 * then has to dismiss.
 */
export interface FolderNotice {
  /** The sentence to show: already translated, names included. */
  readonly text: string
  /** `ok` for a folder that is there, `warn` for anything the operator must act on. */
  readonly tone: 'ok' | 'warn'
}

/**
 * A transient system banner to show, keyed by a per-show sequence.
 *
 * The sequence is what lets a REPEATED message re-announce itself: the banner
 * restarts its hold-then-fade cycle when it is remounted, so the owner keys it by
 * something that changes per show — an identical string would reuse a faded
 * banner and show nothing.
 */
export interface SystemNotice {
  /** Monotonic per-show counter, used as the banner's React key. */
  readonly seq: number
  /** The sentence to show, already translated. */
  readonly text: string
}

/** What the form hands the flow when the operator confirms it. */
export interface NewProjectInput {
  /** The workspace directory the project lives in (absolute). */
  readonly path: string
  /** The project name: becomes the workspace's title. */
  readonly name: string
  /** What the operator said this project is. */
  readonly background: ProductBackground
  /** Chosen product card id, present only for the `existing` answer. */
  readonly productCardId?: string
}

/**
 * A project's name before the form is opened: the empty draft the "+" action
 * starts from. Exported so a test (and the flow's own reset) share one shape.
 */
export const EMPTY_DRAFT: NewProjectDraft = {
  name: '',
  path: '',
  background: 'new',
  productCardId: '',
}

/** The New Project flow's observable state and entry points. */
export interface ProjectFlow {
  /** A chooser, a directory read, or a create call is in flight. */
  readonly busy: boolean
  /** Last failure message, cleared on the next attempt. */
  readonly error: string | null
  /** True while the in-app folder browser stands in for a missing native chooser. */
  readonly browserOpen: boolean
  /** True while the project form is up. */
  readonly formOpen: boolean
  /** Whether that form is adding a project or changing one that exists. */
  readonly formMode: 'create' | 'edit'
  /** The form's draft, owned here so the folder round trip cannot drop it. */
  readonly draft: NewProjectDraft
  /**
   * The product-card catalogue the form offers, as read for this opening.
   *
   * `null` while the read is in flight (or when it failed at the transport
   * level), which the card row renders as "reading…" rather than as an empty
   * list the operator might believe.
   */
  readonly cards: ProductCardResult | null
  /**
   * A failure of the folder CHOICE, rendered inside the form.
   *
   * Not a second error surface: the strip above the session list is about the
   * PROJECT (registration, Feishu), and a chooser that failed leaves no project
   * to report on — the form is still open and this is the field that failed.
   * A host with no native chooser is not one of these: that answer opens the
   * in-app browser instead.
   */
  readonly pickError: string | null
  /**
   * A Feishu-folder FAILURE to render in the column; null when there is none.
   *
   * Only failures land here (see {@link FolderNotice}): a successful creation is
   * a system notice, not a row of the sidebar.
   */
  readonly folderNotice: FolderNotice | null
  /**
   * The system banner to show, or null when none is pending.
   *
   * A creation success travels here instead of into `folderNotice`: it is
   * information the operator reads once ("the folder exists"), not state they
   * have to dismiss, so it takes the shell's transient banner and leaves the
   * column's layout alone.
   */
  readonly systemNotice: SystemNotice | null
  /** Start the flow: open the form, empty. */
  readonly newProject: () => void
  /** Merge draft fields. */
  readonly updateDraft: (patch: Partial<NewProjectDraft>) => void
  /** Choose the draft's workspace directory: native chooser, then in-app browser. */
  readonly pickWorkspaceFolder: () => void
  /** Dismiss the form without creating anything. */
  readonly closeForm: () => void
  /** Commit the form: register the project under the drafted name, then open a session in it. */
  readonly submitNewProject: () => void
  /**
   * Open the form on an EXISTING project: prefill from its record and save over
   * it. The workspace registry's title wins over the record's copy when the two
   * disagree — the registry is the authority (see `src/host/projects.ts`).
   */
  readonly editProject: (project: { workspaceId: WorkspaceId; path: string; title: string }) => void
  /** Save the edit form: rename the workspace, then write the record. */
  readonly submitProjectEdit: () => void
  /** Open the in-app browser directly (the menu's own affordance). */
  readonly browse: () => void
  /** Dismiss the in-app browser without adopting anything. */
  readonly closeBrowser: () => void
  /** Adopt one absolute path: register it as a project, then open a session in it. */
  readonly adoptPath: (path: string) => void
  /** Dismiss the failure strip. */
  readonly dismissError: () => void
  /** Dismiss the Feishu-folder failure strip. */
  readonly dismissFolderNotice: () => void
  /** Dismiss the system banner (the banner itself calls this when it fades). */
  readonly dismissSystemNotice: () => void
}

/**
 * Narrow a stored background to the form's three answers.
 *
 * The host validates this on the way in, so an unknown value here means the
 * document was edited by hand; the form's own "not decided yet" is the safe
 * reading of that, because it constrains no other field.
 * @param value - the stored value.
 * @returns the background to prefill.
 */
function asBackground(value: string): ProductBackground {
  return value === 'new' || value === 'existing' ? value : 'unsure'
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
 * Last segment of an absolute host path: the name the host itself derives for a
 * workspace created from that path (`intentName` in the runtime's workspace
 * manager), so the form's name field can offer it as a default.
 * @param path - absolute directory path.
 * @returns the segment, or the unchanged path when it has none.
 */
function baseNameOf(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split('/').filter(part => part.length > 0)
  return parts[parts.length - 1] ?? path
}

/**
 * The fix for one Feishu failure, in the operator's own words.
 *
 * The codes are the host adapter's own vocabulary (`src/host/lark.ts`), and each
 * one names a different fix: a re-login with a scope, a permission request, a
 * terminal login, a network, or an install. It is exported because two surfaces
 * render these failures — the New Project flow's strip and the folder panel's
 * error block — and an operator who learns what `scope-missing` means in one of
 * them should not have to learn it again in the other.
 * @param error - the failure the host reported.
 * @param t - namespace-bound translate.
 * @returns the hint, or null when this code has no specific fix.
 */
export function feishuFailureHint(error: LarkError, t: T): string | null {
  const scope = /scope\(s\):\s*([A-Za-z0-9_.:]+)/.exec(error.message)?.[1]
  switch (error.code) {
    case 'scope-missing':
      return t('feishu.hint.scope', { scope: scope ?? 'space:document:retrieve' })
    case 'forbidden':
      return t('feishu.hint.forbidden')
    case 'not-logged-in':
      return t('feishu.hint.login')
    case 'identity-mismatch':
      return t('feishu.hint.identity')
    case 'cli-missing':
      return t('feishu.hint.missing')
    case 'cli-network':
    case 'cli-timeout':
      return t('feishu.hint.network')
    default:
      return null
  }
}

/**
 * Turn one Feishu failure into a line an operator can act on.
 *
 * The adapter's own message is appended to rather than replaced by the hint: the
 * point of the hint is to make that detail actionable, not to hide it.
 * @param error - the failure the host reported.
 * @param t - namespace-bound translate.
 * @returns the sentence to show.
 */
export function folderFailureText(error: LarkError, t: T): string {
  const hint = feishuFailureHint(error, t)
  const head = `${t('feishu.folder.failed')}: ${error.message}`
  return hint === null ? head : `${head} ${hint}`
}


/**
 * Drive the New Project flow over the runtime's public workspace services.
 *
 * The host's directory capability is a boot-time choice (`native` on a local
 * macOS session, `browse` over SSH or LAN): `pickDirectory()` throws
 * `directory-picker-unavailable` when no native chooser exists, so the flow
 * falls back to the in-app browser over `listDirectory`/`createDirectory`
 * instead of leaving the form's folder field unusable.
 *
 * @param injected - this plugin's runtime face (from the slot registration).
 * @param t - namespace-bound translate.
 * @returns the flow state and its entry points.
 */
export function useProjectFlow(injected: ShellInjected, t: T): ProjectFlow {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  /**
   * Whether the browser currently up was opened to answer the form's folder
   * field. The page has ONE modal layer, so the two surfaces trade places:
   * cancelling the browser has to know whether it owes the form a return trip,
   * and inferring that from the draft would confuse "the operator typed a name"
   * with "the form is behind this browser".
   */
  const [browseFromForm, setBrowseFromForm] = useState(false)
  const [draft, setDraft] = useState<NewProjectDraft>(EMPTY_DRAFT)
  const [pickError, setPickError] = useState<string | null>(null)
  const [folderNotice, setFolderNotice] = useState<FolderNotice | null>(null)
  const [systemNotice, setSystemNotice] = useState<SystemNotice | null>(null)
  const [formMode, setFormMode] = useState<'create' | 'edit'>('create')
  const [cards, setCards] = useState<ProductCardResult | null>(null)
  /**
   * The project the edit form is changing, when one is.
   *
   * It carries the workspace ID because the DOMAIN is split: this plugin records
   * the project's own fields on the host, while the TITLE lives in the workspace
   * registry and only the runtime can write it — so a save has to do both, and
   * this is the handle for the second half.
   */
  const [editTarget, setEditTarget] = useState<{ workspaceId: WorkspaceId; path: string; title: string } | null>(null)
  const systemSeq = useRef(0)
  const { createWorkspace, pickDirectory, startSession, renameWorkspace } = injected

  /**
   * Announce something through the shell's transient banner.
   *
   * The counter is what makes a repeated sentence visible: the banner keys on it,
   * so announcing the same text twice in a row restarts the cycle rather than
   * leaving the previous (already faded) banner in place.
   * @param text - the sentence to show.
   */
  const announce = useCallback((text: string): void => {
    systemSeq.current += 1
    setSystemNotice({ seq: systemSeq.current, text })
  }, [])

  /**
   * Create the project's Feishu folder, in the background.
   *
   * Not awaited by the flow: the project and its session are already usable, so
   * a slow or unreachable Feishu must not hold the operator in a busy state. The
   * request is fired before the session opens so the two run concurrently.
   *
   * `name` is the project's name — the workspace's own title, which is what the
   * form asked for and what the sidebar shows — so the folder in Feishu and the
   * project in this column carry ONE name. It is deliberately not derived from
   * the path: the form's name field only SUGGESTS the directory's last segment,
   * and an operator who named their project `陕西代码模型` while pointing it at
   * `~/work/sx-model` means the project's name, not the directory's.
   *
   * The host does NOT check whether a folder of that name already exists — it
   * creates unconditionally (this deployment's decision; see `createFolder` in
   * `src/host/lark.ts`), so the only two outcomes here are "created" and a
   * failure. There is deliberately no "already existed, skipped" branch to
   * report, because nothing skips.
   *
   * Success is announced as a SYSTEM banner and failure as a strip in the
   * column: the column is for navigating, so it keeps only what the operator has
   * to act on.
   * @param project - the adopted project's directory and its name.
   */
  const syncFeishuFolder = useCallback((project: { path: string; name: string }): void => {
    setFolderNotice(null)
    void createProjectFolder({ path: project.path, name: project.name }).then((result) => {
      if (!result.ok) {
        setFolderNotice({ text: folderFailureText(result.error, t), tone: 'warn' })
        return
      }
      announce(t('feishu.folder.created', { name: result.value.name }))
    }, (reason: unknown) => {
      setFolderNotice({ text: `${t('feishu.folder.failed')}: ${messageOf(reason)}`, tone: 'warn' })
    })
  }, [announce, t])

  /**
   * Write one project's record on the host, without blocking the caller.
   *
   * A failure is announced rather than thrown: the record is the project's own
   * bookkeeping, and losing it must never roll back a project that exists. The
   * NAME is not written here for the edit path — the registry owns the title, and
   * `submitProjectEdit` writes both in the right order. See `writeProjectRecord`
   * for why the copy exists at all.
   * @param record - the fields to store.
   */
  const storeRecord = useCallback((record: {
    path: string
    name: string
    background: string
    productCardId: string
  }, quiet: boolean): void => {
    void writeProjectRecord(record).then((result) => {
      if (!result.ok && !quiet) {
        setFolderNotice({ text: `${t('project.record.failed')}: ${result.error.message}`, tone: 'warn' })
      }
    }, (reason: unknown) => {
      if (!quiet) setFolderNotice({ text: `${t('project.record.failed')}: ${messageOf(reason)}`, tone: 'warn' })
    })
  }, [t])

  /**
   * Open the form on an existing project.
   *
   * The registry's title wins over the record's copy, because the registry is
   * what the sidebar renders and what `workspace.rename` writes; the record only
   * supplies the two answers the registry has no field for. A project created
   * before this plugin kept records has none, and the form says so rather than
   * inventing an answer — `unsure` is the form's own "not decided yet".
   * @param project - the workspace to edit.
   */
  const editProject = useCallback((project: { workspaceId: WorkspaceId; path: string; title: string }): void => {
    setError(null)
    setPickError(null)
    setEditTarget(project)
    setFormMode('edit')
    setDraft({ name: project.title, path: project.path, background: 'unsure', productCardId: '' })
    setCards(null)
    setFormOpen(true)
    void readProductCards().then((result) => {
      if (result.ok) setCards(result.value)
    }, () => { /* The two answers that need no card stay usable. */ })
    void readProjectRecord(project.path).then((result) => {
      if (!result.ok) return
      const stored = result.value
      if (stored === null) return
      // The draft is merged rather than replaced: the operator may have started
      // typing while this read was in flight, and their answer is not stale data.
      setDraft(current => current.path === project.path
        ? {
          name: current.name === project.title ? project.title : current.name,
          path: project.path,
          background: asBackground(stored.background),
          productCardId: stored.productCardId,
        }
        : current)
    }, () => { /* The form stays usable: the record is an enrichment. */ })
  }, [])

  /**
   * Save the edit form: rename the workspace, then write the record.
   *
   * That order matters. A rename can fail (a conflict, a refused write) and it is
   * the half the operator SEES, so the record is only written once the title it
   * copies is real.
   */
  const submitProjectEdit = useCallback((): void => {
    if (editTarget === null) return
    const name = draft.name.trim()
    if (name === '') return
    setError(null)
    setBusy(true)
    void (async () => {
      try {
        if (name !== editTarget.title) await renameWorkspace(editTarget.workspaceId, name)
        storeRecord({
          path: editTarget.path,
          name,
          background: draft.background,
          productCardId: draft.background === 'existing' ? draft.productCardId : '',
        }, false)
        setFormOpen(false)
        setEditTarget(null)
        setFormMode('create')
        setDraft(EMPTY_DRAFT)
      } catch (reason) {
        setError(messageOf(reason))
      } finally {
        setBusy(false)
      }
    })()
  }, [draft.background, draft.name, draft.productCardId, editTarget, renameWorkspace, storeRecord])

  /**
   * Register one directory as a project and open a session in it.
   *
   * `input.name` is the project's name, and it decides three things at once: the
   * workspace's title, the folder created in Feishu, and what the sidebar shows —
   * one name, applied everywhere. The rename is skipped only when it would be a
   * no-op (the host titles a workspace after the path's last segment, which is
   * what the form suggests as the default), so a form left at its default costs
   * no extra round trip.
   *
   * `input.background` and `input.productCardId` are carried as far as this
   * function and no further: a DSH workspace holds a path and a title, and there
   * is no host field for "which product this is". They are on the payload so the
   * one place that will need them — a host route recording the project's
   * background next to the Feishu folder it creates — receives them from here
   * rather than having to ask the form again.
   * @param input - the directory, the project's name, and the product background.
   */
  const adopt = useCallback((input: NewProjectInput): void => {
    setError(null)
    setBusy(true)
    void (async () => {
      try {
        const workspace = await createWorkspace({ path: input.path })
        const title = input.name.trim()
        if (title !== '' && title !== workspace.title) {
          await renameWorkspace(workspace.workspaceId, title)
        }
        setFormOpen(false)
        setBrowserOpen(false)
        setDraft(EMPTY_DRAFT)
        // The project's own record: the answers the registry has no field for.
        // Written for a CREATE as well as for an edit, because an edit that
        // prefills from a record that was never written would silently drop the
        // operator's background answer.
        storeRecord({
          path: workspace.path,
          name: title === '' ? workspace.title : title,
          background: input.background,
          productCardId: input.background === 'existing' ? (input.productCardId ?? '') : '',
        }, true)
        // The folder is named after the PROJECT, so it takes the title the
        // workspace now carries — after the rename above, not before: the form's
        // name wins over the directory's, and the sidebar, the rename and the
        // Feishu folder therefore show one name.
        syncFeishuFolder({ path: workspace.path, name: title === '' ? workspace.title : title })
        startSession(workspace.workspaceId)
      } catch (reason) {
        setError(messageOf(reason))
      } finally {
        setBusy(false)
      }
    })()
  }, [createWorkspace, renameWorkspace, startSession, storeRecord, syncFeishuFolder])

  /**
   * The one place a directory is chosen: the host's native chooser first, the
   * in-app browser when the host answers that it has none.
   *
   * Both entry points — the form's Choose button and the project menu's "Browse
   * folders…" — end up here, so the two cannot drift into different fallbacks.
   * The browser is a MODAL of its own and the page has only one layer for them,
   * so opening it CLOSES the form; the form is put back with the draft intact
   * once the browser reports a path (see `adoptPath`), which is why the draft
   * lives in this hook rather than in the dialog.
   * @param then - what to do with the chosen path.
   */
  const pick = useCallback((then: (path: string) => void): void => {
    setPickError(null)
    setBusy(true)
    void (async () => {
      try {
        const path = await pickDirectory()
        // Null is the operator's cancel: silent, and nothing is adopted.
        if (path !== null) then(path)
      } catch (reason) {
        // No native chooser on this host — browse in the page instead. That is
        // NOT a failure: the operator still gets to choose a folder, so it is
        // reported nowhere but in the fact that the browser opens.
        void reason
        setFormOpen(false)
        setBrowseFromForm(true)
        setBrowserOpen(true)
      } finally {
        setBusy(false)
      }
    })()
  }, [pickDirectory])

  /**
   * Record a path chosen in the in-app browser, and put the form back.
   *
   * A path from the browser is one FIELD of the form, not a finished project:
   * the operator still owes a name and a product background, so this reopens the
   * dialog with the draft it had. The project menu's "Browse folders…" takes the
   * same route on purpose — the folder is one of the form's questions, and
   * answering it somewhere else would only move that question.
   * @param path - the absolute directory the browser reported.
   */
  const adoptPath = useCallback((path: string): void => {
    setDraft(current => ({
      ...current,
      path,
      // The host names a workspace after the folder's last segment, so that is
      // the name the operator would have had to type: offer it, and only into
      // an empty field — a name already typed is a decision, not a default.
      name: current.name === '' ? baseNameOf(path) : current.name,
    }))
    setBrowserOpen(false)
    setBrowseFromForm(false)
    setFormOpen(true)
  }, [])

  const newProject = useCallback((): void => {
    setError(null)
    setPickError(null)
    setEditTarget(null)
    setFormMode('create')
    setDraft(EMPTY_DRAFT)
    setCards(null)
    setFormOpen(true)
    // The card catalogue is deployment data, not a property of any one project,
    // so the create form reads it the same way the edit form does — through the
    // project route, which answers the catalogue with (or without) a record.
    void readProductCards().then((result) => {
      if (result.ok) setCards(result.value)
    }, () => { /* The two answers that need no card stay usable. */ })
  }, [])

  const pickWorkspaceFolder = useCallback((): void => {
    pick((path) => {
      setDraft(current => ({
        ...current,
        path,
        // Same default as the browser route: an empty name field takes the
        // folder's last segment, a typed one is left alone.
        name: current.name === '' ? baseNameOf(path) : current.name,
      }))
      setPickError(null)
    })
  }, [pick])

  return {
    busy,
    error,
    browserOpen,
    formOpen,
    draft,
    pickError,
    folderNotice,
    newProject,
    updateDraft: useCallback((patch: Partial<NewProjectDraft>) => {
      setDraft(current => ({ ...current, ...patch }))
    }, []),
    pickWorkspaceFolder,
    closeForm: useCallback(() => {
      setFormOpen(false)
      setPickError(null)
      setDraft(EMPTY_DRAFT)
    }, []),
    submitNewProject: useCallback(() => {
      const path = draft.path.trim()
      const name = draft.name.trim()
      if (path === '' || name === '') return
      adopt({
        path,
        name,
        background: draft.background,
        ...(draft.background === 'existing' && draft.productCardId !== ''
          ? { productCardId: draft.productCardId }
          : {}),
      })
    }, [adopt, draft]),
    systemNotice,
    formMode,
    cards,
    editProject,
    submitProjectEdit,
    browse: useCallback(() => {
      // The menu's own affordance: no form behind it, so closing the browser
      // ends the flow (unless a folder is picked, which DOES open the form — a
      // folder is one field of it, and there is nowhere else to put it).
      setFormOpen(false)
      setBrowseFromForm(false)
      setBrowserOpen(true)
    }, []),
    closeBrowser: useCallback(() => {
      setBrowserOpen(false)
      // A browser opened from the form answers BACK to it, with the draft the
      // form already holds; one opened from the menu simply closes, because it
      // was not standing in for a form field.
      if (browseFromForm) {
        setBrowseFromForm(false)
        setFormOpen(true)
      }
    }, [browseFromForm]),
    adoptPath,
    dismissError: useCallback(() => { setError(null) }, []),
    dismissFolderNotice: useCallback(() => { setFolderNotice(null) }, []),
    dismissSystemNotice: useCallback(() => { setSystemNotice(null) }, []),
  }
}
