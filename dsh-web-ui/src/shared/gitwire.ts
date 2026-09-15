/**
 * The wire contract of the git panel: every fact the browser half sends and
 * every shape it reads back, in one module with no runtime dependencies.
 *
 * It is shared by TYPE on both sides of the carrier but shared by VALUE only for
 * the route paths, which are a two-ended literal: a typo on either end would be
 * a 404 that looks like a broken plugin rather than a compile error. Because the
 * host half spawns processes and the browser half must never see `node:*`, this
 * module stays deliberately inert — types plus four strings.
 *
 * Two conventions carry the whole surface:
 *
 * - **Every read is a `GET` under one prefix, every mutation is one `POST`.**
 *   The panel asks seven questions and issues one kind of change, so the route
 *   table stays inspectable instead of dissolving into a prefix route.
 * - **A domain failure is `{ ok: false }` with HTTP 200.** "This directory is
 *   not a git repository" and "the merge conflicted" are *content* the panel
 *   renders, not transport failures; a 500 stays reserved for a genuine bug in
 *   this plugin, and the browser reports it generically.
 *
 * @module dsh-web-ui/shared/gitwire
 */

/** Path prefix of every route the git panel owns. */
export const GIT_ROUTE_PREFIX = '/dsh-web-ui/git'

/** Repository, HEAD, working-tree counts, remotes — the drawer's opening read. */
export const GIT_OVERVIEW_PATH = `${GIT_ROUTE_PREFIX}/overview`

/** Every local and remote branch, with tracking state. */
export const GIT_BRANCHES_PATH = `${GIT_ROUTE_PREFIX}/branches`

/** One page of commit history. */
export const GIT_LOG_PATH = `${GIT_ROUTE_PREFIX}/log`

/** One commit: its metadata plus its patch and per-file stats. */
export const GIT_COMMIT_PATH = `${GIT_ROUTE_PREFIX}/commit`

/** Working-tree changes, stash list, and the current operation in flight. */
export const GIT_CHANGES_PATH = `${GIT_ROUTE_PREFIX}/changes`

/** The unified diff of one path (working tree or index, or against a ref). */
export const GIT_DIFF_PATH = `${GIT_ROUTE_PREFIX}/diff`

/** This plugin's own journal of git commands it has run. */
export const GIT_RECORDS_PATH = `${GIT_ROUTE_PREFIX}/records`

/** The single mutation route; the action name selects the command. */
export const GIT_ACTION_PATH = `${GIT_ROUTE_PREFIX}/action`

/** How the browser reads every route: a result, never a thrown transport error. */
export type GitResponse<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: GitError }

/** A domain failure, already phrased for a human. */
export interface GitError {
  /**
   * Stable machine code. The panel switches on it to pick the right follow-up
   * hint (`git-missing` needs an install, `no-upstream` needs a push -u), so a
   * message rewrite never silently changes the UI's advice.
   */
  readonly code: GitErrorCode
  /** One sentence, in git's own words where git spoke. */
  readonly message: string
}

/** Every failure this surface distinguishes. */
export type GitErrorCode =
  /** The `git` binary is not on the host's PATH. */
  | 'git-missing'
  /** The requested directory exists but is not inside a work tree. */
  | 'not-a-repo'
  /** The directory does not exist, or is not a directory. */
  | 'no-directory'
  /** A parameter was absent or malformed. */
  | 'bad-request'
  /** An action name this plugin does not implement. */
  | 'unknown-action'
  /** The command ran and failed; git's stderr carries the reason. */
  | 'git-failed'
  /** The command outlived its budget and was killed. */
  | 'timeout'
  /** A bug in this plugin. */
  | 'internal'

/** The repository the panel is looking at. */
export interface GitRepo {
  /** The directory the panel was asked about, verbatim. */
  readonly path: string
  /** The work tree root (`rev-parse --show-toplevel`). */
  readonly root: string
  /** The display name: the root's basename. */
  readonly name: string
  /** Absolute git directory, shown in the header's tooltip. */
  readonly gitDir: string
  /** True while the repository has no commit yet (an unborn HEAD). */
  readonly unborn: boolean
  /** True during a merge, rebase, cherry-pick, revert, or bisect. */
  readonly operation: GitOperation | null
}

/** An in-progress multi-step git operation, read from the git directory. */
export type GitOperation =
  | 'merge'
  | 'rebase'
  | 'cherry-pick'
  | 'revert'
  | 'bisect'

/** Where HEAD points. */
export interface GitHead {
  /** The branch name, or null when HEAD is detached. */
  readonly branch: string | null
  /** True when HEAD holds a commit rather than a branch. */
  readonly detached: boolean
  /** Full object id of HEAD's commit; empty while unborn. */
  readonly sha: string
  /** Abbreviated object id; empty while unborn. */
  readonly shortSha: string
  /** First line of HEAD's commit message. */
  readonly subject: string
  /** Configured upstream (`origin/main`), or null when there is none. */
  readonly upstream: string | null
  /** Commits HEAD has that its upstream does not. */
  readonly ahead: number
  /** Commits the upstream has that HEAD does not. */
  readonly behind: number
  /** True while HEAD is unborn: the branch exists in name only, with no commit. */
  readonly unborn: boolean
}

/** Working-tree change counts, by bucket. */
export interface GitCounts {
  /** Added to the index. */
  readonly staged: number
  /** Tracked and modified in the working tree. */
  readonly modified: number
  /** Not tracked at all. */
  readonly untracked: number
  /** Files with unmerged (conflicted) entries. */
  readonly conflicted: number
  /** Deleted from the index or the working tree. */
  readonly deleted: number
}

/** One configured remote. */
export interface GitRemote {
  /** Remote name, e.g. `origin`. */
  readonly name: string
  /** Fetch URL; empty for a remote configured with only a push URL. */
  readonly url: string
}

/** The drawer's opening read. */
export interface GitOverview {
  /** The repository identity. */
  readonly repo: GitRepo
  /** Where HEAD points. */
  readonly head: GitHead
  /** Change counts by bucket. */
  readonly counts: GitCounts
  /** Every configured remote. */
  readonly remotes: readonly GitRemote[]
  /** Number of stash entries. */
  readonly stashCount: number
  /** Number of tags. */
  readonly tagCount: number
}

/** One branch, local or remote-tracking. */
export interface GitBranch {
  /** Short name: `main` locally, `origin/main` for a remote-tracking ref. */
  readonly name: string
  /** Full ref name (`refs/heads/main`). */
  readonly ref: string
  /** Whether this is a local branch or a remote-tracking ref. */
  readonly kind: 'local' | 'remote'
  /** True for the branch HEAD is on. */
  readonly current: boolean
  /** Full object id of the tip commit. */
  readonly sha: string
  /** Abbreviated object id. */
  readonly shortSha: string
  /** First line of the tip commit's message. */
  readonly subject: string
  /** Tip commit's author name. */
  readonly author: string
  /** Tip commit's committer date, ISO-8601. */
  readonly date: string
  /** Configured upstream for a local branch; null for a remote-tracking ref. */
  readonly upstream: string | null
  /** Commits this branch has that its upstream does not. */
  readonly ahead: number
  /** Commits the upstream has that this branch does not. */
  readonly behind: number
  /** True when an upstream is configured but no longer exists. */
  readonly gone: boolean
}

/** The branch roster, split so the panel need not re-filter. */
export interface GitBranchList {
  /** Local branches, current first, then most recent tip. */
  readonly local: readonly GitBranch[]
  /** Remote-tracking refs, with each remote's HEAD symbolic ref removed. */
  readonly remote: readonly GitBranch[]
}

/** One commit, as the history list shows it. */
export interface GitCommit {
  /** Full object id. */
  readonly sha: string
  /** Abbreviated object id. */
  readonly shortSha: string
  /** Parent object ids; empty for a root commit, two or more for a merge. */
  readonly parents: readonly string[]
  /** First line of the message. */
  readonly subject: string
  /** Author name. */
  readonly author: string
  /** Author email. */
  readonly email: string
  /** Author date, ISO-8601. */
  readonly date: string
  /** Decoration names (`HEAD`, `main`, `origin/main`, `tag: v1`). */
  readonly refs: readonly string[]
}

/** One commit with its patch attached (the history tab's expanded row). */
export interface GitCommitDetail {
  /** The commit itself. */
  readonly commit: GitCommit
  /** Per-file change counts, in git's `--numstat` order. */
  readonly files: readonly GitCommitFile[]
  /** The full unified diff, capped by the host. */
  readonly patch: string
  /** True when the patch was cut short by that cap. */
  readonly truncated: boolean
}

/** One file touched by a commit. */
export interface GitCommitFile {
  /** Repository-relative path (the newer path, for a rename). */
  readonly path: string
  /** Lines added; null for a binary file. */
  readonly additions: number | null
  /** Lines removed; null for a binary file. */
  readonly deletions: number | null
}

/**
 * One changed path in the working tree.
 *
 * A path can be dirty on BOTH sides of the index — staged as one thing and then
 * edited again — so the two facts are two flags rather than one bucket, and the
 * panel renders the path in whichever sections it belongs to (exactly as a
 * mature source-control UI does). `index`/`worktree` keep git's own letters for
 * the status chip; `.` means "no change on this side".
 */
export interface GitFileChange {
  /** Repository-relative path. */
  readonly path: string
  /** Previous path, for a rename or copy; null otherwise. */
  readonly from: string | null
  /** The index-vs-HEAD status letter (`M`, `A`, `D`, `R`, `.`, …). */
  readonly index: string
  /** The working-tree-vs-index status letter; `.` when that side is clean. */
  readonly worktree: string
  /** True when the index differs from HEAD. */
  readonly staged: boolean
  /** True when the working tree differs from the index. */
  readonly unstaged: boolean
  /** True when git does not track the path at all. */
  readonly untracked: boolean
  /** True when the path carries unmerged entries. */
  readonly conflicted: boolean
}

/** One stash entry. */
export interface GitStash {
  /** The entry's positional reference (`stash@{0}`). */
  readonly ref: string
  /** Its index within the stack; 0 is the newest. */
  readonly index: number
  /** The branch it was created on. */
  readonly branch: string
  /** The message recorded with it. */
  readonly message: string
  /** Creation date, ISO-8601. */
  readonly date: string
}

/** The changes read: what is dirty, what is stashed, and what is running. */
export interface GitChanges {
  /** Every changed path, in `git status` order. */
  readonly files: readonly GitFileChange[]
  /** The stash stack, newest first. */
  readonly stashes: readonly GitStash[]
  /** The action currently running in this repository, if any. */
  readonly running: string | null
}

/** One unified diff. */
export interface GitDiff {
  /** The patch text, capped by the host. */
  readonly patch: string
  /** True when the cap cut it short. */
  readonly truncated: boolean
}

/** One entry of this plugin's own journal. */
export interface GitRecord {
  /** Monotonic id, unique within the host process. */
  readonly id: number
  /** When the command was issued, ISO-8601. */
  readonly at: string
  /** The work tree the command ran in. */
  readonly dir: string
  /** The action name the browser asked for. */
  readonly action: GitAction
  /** The command as a reader would type it (`git checkout main`). */
  readonly command: string
  /** True when git exited zero. */
  readonly ok: boolean
  /** git's exit status. */
  readonly code: number
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number
  /** git's combined output, tail-capped; empty when it said nothing. */
  readonly output: string
}

/** The journal read, newest first. */
export interface GitRecordList {
  /** Records for this repository, newest first. */
  readonly records: readonly GitRecord[]
  /** How many records the host holds for this repository in total. */
  readonly total: number
}

/** Every mutation this panel can perform. */
export type GitAction =
  /**
   * Create a repository in a directory that has none.
   *
   * The one action that works BOTH before and after a repository exists, which
   * is why it is the one action whose directory is not resolved to a work tree
   * first — see the host's `act`.
   */
  | 'init'
  /** Point a new remote at a URL. */
  | 'remote-add'
  /** Change an existing remote's URL. */
  | 'remote-set-url'
  /** Rename a remote. */
  | 'remote-rename'
  /** Forget a remote. */
  | 'remote-remove'
  /** Switch HEAD to an existing local branch or commit. */
  | 'checkout'
  /** Create a branch at a start point, optionally switching to it. */
  | 'create-branch'
  /** Rename a local branch. */
  | 'rename-branch'
  /** Delete a local branch. */
  | 'delete-branch'
  /** Merge a ref into the current branch. */
  | 'merge'
  /** Rebase the current branch onto a ref. */
  | 'rebase'
  /** Apply one commit onto the current branch. */
  | 'cherry-pick'
  /** Move the current branch to a ref, keeping, unstaging, or discarding changes. */
  | 'reset'
  /** Download objects and refs from a remote. */
  | 'fetch'
  /** Fetch and integrate a remote branch into the current one. */
  | 'pull'
  /** Send the current branch's commits to a remote. */
  | 'push'
  /** Send one named local branch to a remote. */
  | 'push-branch'
  /** Add paths to the index. */
  | 'stage'
  /** Remove paths from the index, keeping their working-tree content. */
  | 'unstage'
  /** Restore tracked paths to their indexed content, discarding edits. */
  | 'discard'
  /** Remove untracked paths from the working tree. */
  | 'clean'
  /** Record the index as a commit. */
  | 'commit'
  /** Amend the previous commit. */
  | 'amend'
  /** Stash the working-tree changes. */
  | 'stash-save'
  /** Apply a stash and drop it on success. */
  | 'stash-pop'
  /** Apply a stash, keeping it. */
  | 'stash-apply'
  /** Delete a stash entry. */
  | 'stash-drop'
  /** Create a tag. */
  | 'tag-create'
  /** Delete a tag. */
  | 'tag-delete'
  /** Abort the in-progress merge, rebase, cherry-pick, or revert. */
  | 'abort'

/** One mutation request: the directory, the action, and its arguments. */
export interface GitActionRequest {
  /** Absolute path of the directory (any directory inside the work tree). */
  readonly dir: string
  /** Which mutation to perform. */
  readonly action: GitAction
  /**
   * Action arguments. Kept as one loosely-typed bag so the route stays a single
   * endpoint: each action reads exactly the keys it needs, and the executor
   * validates each one before it reaches argv.
   */
  readonly args?: GitActionArgs
}

/** The argument bag, union-typed per field so an action cannot invent a shape. */
export interface GitActionArgs {
  /** A branch, tag, commit, or remote ref to act on. */
  readonly ref?: string
  /** A branch name to create or delete. */
  readonly name?: string
  /** A remote's URL. */
  readonly url?: string
  /** The current name, for a rename. */
  readonly from?: string
  /** The new name, for a rename. */
  readonly to?: string
  /** A start point for a new branch; defaults to HEAD. */
  readonly startPoint?: string
  /** Switch to a new branch as it is created. */
  readonly checkout?: boolean
  /** Force a delete, a push, or a clean. */
  readonly force?: boolean
  /** Disallow a fast-forward merge, recording a merge commit. */
  readonly noFf?: boolean
  /** Rebase instead of merging, for a pull. */
  readonly rebase?: boolean
  /** Prune deleted remote-tracking refs, for a fetch. */
  readonly prune?: boolean
  /** Set the local branch's upstream when pushing. */
  readonly setUpstream?: boolean
  /** Remote name; the caller's default (`origin`) applies when absent. */
  readonly remote?: string
  /**
   * A branch name. For `init` it is the INITIAL branch (`git init -b`), which
   * is the same field because it is the same fact: the branch this action
   * concerns. For `push`/`pull` it is the remote branch.
   */
  readonly branch?: string
  /** Paths, repository-relative, for the index and working-tree actions. */
  readonly files?: readonly string[]
  /** The commit message. */
  readonly message?: string
  /** Stage tracked modifications before committing. */
  readonly all?: boolean
  /** Keep the commit message and authorship of the amended commit. */
  readonly noEdit?: boolean
  /** Include untracked files in a stash or a clean. */
  readonly includeUntracked?: boolean
  /** Stash index; 0 is the newest entry. */
  readonly index?: number
  /** `soft`, `mixed`, or `hard`, for a reset. */
  readonly mode?: string
  /** Mark an annotated tag with this message. */
  readonly annotation?: string
  /** Also push tags. */
  readonly tags?: boolean
}

/** The result of one mutation. */
export interface GitActionResult {
  /** The action that ran. */
  readonly action: GitAction
  /** The command as a reader would type it. */
  readonly command: string
  /** True when git exited zero. */
  readonly ok: boolean
  /** git's combined output; empty when it said nothing. */
  readonly output: string
}

/** The body of a `?path=` / `?dir=` parameter, as the browser sends it. */
export interface GitDirectoryQuery {
  /** Absolute path of the directory to inspect. */
  readonly dir: string
}
