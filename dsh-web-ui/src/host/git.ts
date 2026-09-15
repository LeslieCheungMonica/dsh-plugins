/**
 * The host half of this plugin's git panel: a typed, argv-only wrapper around
 * the real `git` binary.
 *
 * Four rules shape everything below, and each one is load-bearing:
 *
 * 1. **No shell, ever.** Every command is a `spawn('git', argv)` with an array
 *    built here, and every path is passed after `--`. The panel accepts a
 *    directory and branch names from a browser, so a shell string would be a
 *    remote-code-execution surface; an argv array is not.
 * 2. **Names are validated by git, not by this module.** A branch name goes
 *    through `git check-ref-format --branch` and a revision through
 *    `git rev-parse --verify`, because git's rules are the only correct ones —
 *    a hand-rolled regex here would refuse legal names and admit illegal ones.
 *    A leading `-` is refused everywhere, since that is how an argument becomes
 *    an option.
 * 3. **A domain failure is a value.** "Not a repository", "the merge
 *    conflicted", and "your branch is behind" are answers the panel renders,
 *    not exceptions; only a bug in this module throws.
 * 4. **Every mutation is journalled.** The panel's 操作记录 tab is this module's
 *    own ring of the commands it ran, so an operator can see what the button
 *    actually did — including the ones that failed, which is when it matters.
 *
 * Reads are cached for a moment (`CACHE_TTL_MS`): the drawer mounts, reads the
 * overview, then the branches, then the history, and a status call per tab is
 * pure waste on a large repository. A mutation invalidates the whole cache for
 * its directory, so a reader never sees the tree it just changed.
 *
 * @module dsh-web-ui/host/git
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import type {
  GitAction, GitActionArgs, GitActionRequest, GitActionResult, GitBranch,
  GitBranchList, GitChanges, GitCommit, GitCommitDetail, GitCommitFile,
  GitCounts, GitDiff, GitError, GitErrorCode, GitFileChange, GitHead,
  GitOperation, GitOverview, GitRecord, GitRecordList, GitRemote, GitRepo,
  GitResponse, GitStash,
} from '../shared/gitwire.ts'

/** Field separator this module splits on: an ASCII unit separator. */
const FS = '\u001f'

/** Record separator this module splits on: an ASCII record separator. */
const RS = '\u001e'

/**
 * The two commands that take a `--format` disagree on hex escapes, and the
 * difference is not cosmetic — with the wrong spelling git prints the escape
 * literally and every field of a record collapses into one:
 *
 * - `for-each-ref` expands `%xx` (so `%1f` is the unit separator);
 * - `log`/`show` expand `%xXX` (so `%x1f` is, and `%1f` is just `1f`).
 */
const REF_FS = '%1f'
const LOG_FS = '%x1f'
const LOG_RS = '%x1e'

/** Budget of a local, non-network command. */
const LOCAL_TIMEOUT_MS = 30_000

/** Budget of a command that talks to a remote. */
const REMOTE_TIMEOUT_MS = 180_000

/** Bytes of `git` output kept for a journal record (the tail, where errors are). */
const RECORD_OUTPUT_CAP = 4_096

/** Bytes of patch text kept for one diff read (the head, where diffs are read from). */
const PATCH_CAP = 400_000

/** How many journal records are kept per repository. */
const JOURNAL_LIMIT = 200

/** How long a read result is reused before the next read re-runs git. */
const CACHE_TTL_MS = 2_000

/** How many commits one `log` read may return. */
const LOG_LIMIT_MAX = 200

/** How many commits the panel asks for by default. */
const LOG_LIMIT_DEFAULT = 50

/** Actions that talk to a remote, and therefore earn the longer budget. */
const REMOTE_ACTIONS: ReadonlySet<GitAction> = new Set([
  'fetch', 'pull', 'push', 'push-branch',
])

/** The actions whose argv carries a ref that must resolve to a commit. */
const COMMIT_REF_ACTIONS: ReadonlySet<GitAction> = new Set([
  'checkout', 'merge', 'rebase', 'cherry-pick', 'reset',
])

/** One command's raw outcome. */
interface GitRun {
  /** The exit status; 1 when the process was killed or could not start. */
  readonly code: number
  /** Captured standard output. */
  readonly stdout: string
  /** Captured standard error. */
  readonly stderr: string
  /** True when the timeout fired and the process was killed. */
  readonly timedOut: boolean
  /** True when `git` itself could not be started (not on PATH). */
  readonly missing: boolean
}

/** A cached read, keyed by command line. */
interface CacheEntry {
  /** When the value was produced, in epoch milliseconds. */
  readonly at: number
  /** The parsed value. */
  readonly value: unknown
}

/** The panel's host face. Every method answers, and none throws. */
export interface GitService {
  /** The repository identity, HEAD, change counts, remotes, stash and tag counts. */
  overview(dir: string): Promise<GitResponse<GitOverview>>
  /** Every local and remote branch with tracking state. */
  branches(dir: string): Promise<GitResponse<GitBranchList>>
  /** One page of commit history. */
  log(dir: string, limit: number, ref: string | undefined): Promise<GitResponse<readonly GitCommit[]>>
  /** One commit with its patch and per-file stats. */
  commit(dir: string, sha: string): Promise<GitResponse<GitCommitDetail>>
  /** Working-tree changes, the stash stack, and the action in flight. */
  changes(dir: string): Promise<GitResponse<GitChanges>>
  /** The unified diff of one path. */
  diff(dir: string, file: string, staged: boolean, ref: string | undefined): Promise<GitResponse<GitDiff>>
  /** This plugin's journal for one repository. */
  records(dir: string): Promise<GitResponse<GitRecordList>>
  /** Run one mutation. */
  act(request: GitActionRequest): Promise<GitResponse<GitActionResult>>
}

/**
 * Build one failure value.
 * @param code - the stable machine code.
 * @param message - the human sentence.
 * @returns the failure arm of a response.
 */
function fail(code: GitErrorCode, message: string): { ok: false; error: GitError } {
  return { ok: false, error: { code, message } }
}

/**
 * Build one success value.
 * @param value - the payload.
 * @returns the success arm of a response.
 */
function pass<T>(value: T): { ok: true; data: T } {
  return { ok: true, data: value }
}

/**
 * Trim a trailing newline git prints after most commands.
 * @param text - the captured stream.
 * @returns the stream without its final newline.
 */
function chomp(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

/**
 * Collapse a command's stderr into one line for a message.
 * @param run - the finished command.
 * @returns git's own words, or a generic sentence when it said nothing.
 */
function reason(run: GitRun): string {
  const text = chomp(run.stderr).trim()
  if (text !== '') return text.split('\n').slice(-8).join('\n')
  const out = chomp(run.stdout).trim()
  return out !== '' ? out : `git exited with status ${String(run.code)}`
}

/**
 * Quote one argv element for display.
 * @param argument - the raw argument.
 * @returns the argument, quoted only when it needs it.
 */
function quote(argument: string): string {
  return /^[A-Za-z0-9_./@{}^~:+=,-]+$/.test(argument) ? argument : JSON.stringify(argument)
}

/**
 * Render one command the way a reader would type it.
 * @param args - the argv passed to git (without the leading `git`).
 * @returns the display string.
 */
function display(args: readonly string[]): string {
  return ['git', ...args].map(quote).join(' ')
}

/**
 * Keep the tail of a stream within a byte budget.
 * @param text - the stream.
 * @param cap - the budget in bytes.
 * @returns the tail, prefixed with an elision marker when it was cut.
 */
function tail(text: string, cap: number): string {
  if (Buffer.byteLength(text) <= cap) return text
  const buffer = Buffer.from(text)
  return `… (${String(buffer.length - cap)} bytes elided) …\n${buffer.subarray(buffer.length - cap).toString('utf8')}`
}

/**
 * Keep the head of a stream within a byte budget.
 * @param text - the stream.
 * @param cap - the budget in bytes.
 * @returns the head, suffixed with an elision marker when it was cut.
 */
function head(text: string, cap: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= cap) return { text, truncated: false }
  const buffer = Buffer.from(text)
  return { text: buffer.subarray(0, cap).toString('utf8'), truncated: true }
}

/**
 * Whether a string looks like something git could accept as a revision, before
 * git itself is asked. This is a *pre*-filter for the option-injection surface
 * (a leading `-`) and for characters no ref may contain; the authoritative
 * check is `git rev-parse --verify`.
 * @param ref - the candidate.
 * @returns true when the candidate is worth handing to git.
 */
function plausibleRef(ref: string): boolean {
  if (ref === '' || ref.startsWith('-')) return false
  if (/\s/.test(ref)) return false
  // `..` and the revision operators are legal inside a range but never inside a
  // single branch name; the actions here all take one name, so refuse them.
  return !/[\u0000-\u001f~^:?*[\\]/.test(ref)
}
/**
 * Parse one branch's `%(upstream:track)` decoration.
 * @param track - git's rendering, e.g. `[ahead 1, behind 2]`, `[gone]`, or ``.
 * @returns the ahead/behind counts and the gone flag.
 */
function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  if (track === '') return { ahead: 0, behind: 0, gone: false }
  if (track.includes('gone')) return { ahead: 0, behind: 0, gone: true }
  const ahead = /ahead (\d+)/.exec(track)
  const behind = /behind (\d+)/.exec(track)
  return {
    ahead: ahead === null ? 0 : Number(ahead[1]),
    behind: behind === null ? 0 : Number(behind[1]),
    gone: false,
  }
}

/**
 * Plain relative path of a porcelain field, dropping git's quoting.
 * @param path - the field as git printed it.
 * @returns the path without surrounding quotes.
 */
function unquote(path: string): string {
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
    return path.slice(1, -1).replace(/\\(.)/g, '$1')
  }
  return path
}

/**
 * Classify one porcelain-v2 XY pair.
 * @param xy - the two status letters.
 * @returns the change flags.
 */
function classify(xy: string): { staged: boolean; unstaged: boolean; conflicted: boolean } {
  const index = xy.charAt(0)
  const worktree = xy.charAt(1)
  return {
    staged: index !== '.' && index !== ' ',
    unstaged: worktree !== '.' && worktree !== ' ',
    // An unmerged pair is reported as `U`/`A`/`D` combinations; `u` records are
    // the authoritative signal, but the letters alone already mark conflict.
    conflicted: index === 'U' || worktree === 'U' || xy === 'AA' || xy === 'DD',
  }
}

/**
 * Parse `git status --porcelain=v2 --branch -z`.
 * @param raw - the NUL-separated output.
 * @returns HEAD's state and every changed path.
 */
function parseStatus(raw: string): { head: Omit<GitHead, 'subject'>; files: GitFileChange[] } {
  let branch: string | null = null
  let detached = false
  let sha = ''
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  let unborn = false
  const files: GitFileChange[] = []

  const tokens = raw.split('\u0000')
  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index]
    if (record === undefined || record === '') continue
    if (record.startsWith('# ')) {
      const [key, ...rest] = record.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') {
        if (value === '(initial)') unborn = true
        else sha = value
      } else if (key === 'branch.head') {
        if (value === '(detached)') detached = true
        else branch = value
      } else if (key === 'branch.upstream') {
        upstream = value
      } else if (key === 'branch.ab') {
        const match = /\+(\d+) -(\d+)/.exec(value)
        if (match !== null) {
          ahead = Number(match[1])
          behind = Number(match[2])
        }
      }
      continue
    }
    const kind = record.charAt(0)
    if (kind === '?') {
      files.push({
        path: unquote(record.slice(2)),
        from: null,
        index: '?',
        worktree: '?',
        staged: false,
        unstaged: false,
        untracked: true,
        conflicted: false,
      })
      continue
    }
    if (kind === '!') continue
    if (kind === '1') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const parts = record.split(' ')
      const xy = parts[1] ?? '..'
      const flags = classify(xy)
      files.push({
        path: unquote(parts.slice(8).join(' ')),
        from: null,
        index: xy.charAt(0),
        worktree: xy.charAt(1),
        ...flags,
        untracked: false,
      })
      continue
    }
    if (kind === '2') {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> \0 <origPath>
      const parts = record.split(' ')
      const xy = parts[1] ?? '..'
      const flags = classify(xy)
      // The original path is its own NUL field in `-z` mode: consume it so it is
      // never mistaken for the next record.
      index += 1
      files.push({
        path: unquote(parts.slice(9).join(' ')),
        from: unquote(tokens[index] ?? ''),
        index: xy.charAt(0),
        worktree: xy.charAt(1),
        ...flags,
        untracked: false,
      })
      continue
    }
    if (kind === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const parts = record.split(' ')
      const xy = parts[1] ?? 'UU'
      files.push({
        path: unquote(parts.slice(10).join(' ')),
        from: null,
        index: xy.charAt(0),
        worktree: xy.charAt(1),
        staged: true,
        unstaged: true,
        untracked: false,
        conflicted: true,
      })
    }
  }

  return {
    head: { branch, detached, sha, shortSha: sha.slice(0, 7), upstream, ahead, behind, unborn },
    files,
  }
}

/**
 * Parse `git for-each-ref` output into branch records.
 * @param raw - the newline-separated, FS-separated output.
 * @returns the local and remote branches.
 */
function parseBranches(raw: string): GitBranchList {
  const local: GitBranch[] = []
  const remote: GitBranch[] = []
  for (const line of chomp(raw).split('\n')) {
    if (line === '') continue
    const [ref = '', sha = '', shortSha = '', head = '', upstream = '', track = '', date = '', author = '', subject = ''] =
      line.split(FS)
    const isRemote = ref.startsWith('refs/remotes/')
    const name = isRemote ? ref.slice('refs/remotes/'.length) : ref.slice('refs/heads/'.length)
    // A remote's symbolic HEAD (`refs/remotes/origin/HEAD`) is a pointer to a
    // branch, not a branch: listing it would offer a checkout of "HEAD".
    if (name.endsWith('/HEAD')) continue
    const counts = parseTrack(track)
    // `%(upstream)` is a full refname; the panel shows the remote-tracking
    // spelling (`origin/main`), which is what an operator would type.
    const upstreamName = upstream === ''
      ? null
      : upstream.replace(/^refs\/remotes\//, '').replace(/^refs\/heads\//, '')
    const branch: GitBranch = {
      name,
      ref,
      kind: isRemote ? 'remote' : 'local',
      current: head === '*',
      sha,
      shortSha,
      subject,
      author,
      date,
      upstream: upstreamName,
      ahead: counts.ahead,
      behind: counts.behind,
      gone: counts.gone,
    }
    if (isRemote) remote.push(branch)
    else local.push(branch)
  }

  const byDate = (left: GitBranch, right: GitBranch): number => right.date.localeCompare(left.date)
  local.sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1
    return byDate(left, right)
  })
  remote.sort(byDate)
  return { local, remote }
}

/**
 * Parse the `git log` format this module asks for.
 * @param raw - the RS-separated output.
 * @returns the commits in the order git printed them.
 */
function parseLog(raw: string): GitCommit[] {
  const commits: GitCommit[] = []
  for (const record of raw.split(RS)) {
    const line = chomp(record)
    if (line.trim() === '') continue
    const [sha = '', shortSha = '', parents = '', author = '', email = '', date = '', refs = '', subject = ''] =
      line.split(FS)
    commits.push({
      sha,
      shortSha,
      parents: parents === '' ? [] : parents.split(' '),
      subject,
      author,
      email,
      date,
      refs: refs === '' ? [] : refs.split(', ').map(entry => entry.trim()).filter(entry => entry !== ''),
    })
  }
  return commits
}

/**
 * Parse `git show --numstat` output.
 * @param raw - the newline-separated output.
 * @returns one entry per touched path.
 */
function parseNumstat(raw: string): GitCommitFile[] {
  const files: GitCommitFile[] = []
  for (const line of chomp(raw).split('\n')) {
    if (line.trim() === '') continue
    const [added = '', removed = '', ...rest] = line.split('\t')
    const path = rest.join('\t')
    if (path === '') continue
    files.push({
      path,
      additions: added === '-' ? null : Number(added),
      deletions: removed === '-' ? null : Number(removed),
    })
  }
  return files
}

/**
 * Split a stash's `%gs` subject into its branch and its message.
 * @param subject - git's rendering, e.g. `WIP on main: 1a2b3c subject`.
 * @returns the branch and the recorded message.
 */
function parseStashSubject(subject: string): { branch: string; message: string } {
  const match = /^(?:WIP on|On) ([^:]+): ?(.*)$/.exec(subject)
  if (match === null) return { branch: '', message: subject }
  return { branch: match[1] ?? '', message: match[2] ?? '' }
}

/**
 * Parse `git stash list`.
 * @param raw - the newline-separated output.
 * @returns the stash stack, in git's order (newest first).
 */
function parseStashes(raw: string): GitStash[] {
  const stashes: GitStash[] = []
  for (const line of chomp(raw).split('\n')) {
    if (line === '') continue
    const [ref = '', subject = '', date = ''] = line.split(FS)
    const match = /stash@\{(\d+)\}/.exec(ref)
    const parsed = parseStashSubject(subject)
    stashes.push({
      ref,
      index: match === null ? 0 : Number(match[1]),
      branch: parsed.branch,
      message: parsed.message,
      date,
    })
  }
  return stashes
}

/**
 * Whether a string is usable as a remote URL.
 *
 * A URL travels as ONE argv element, so it can never become a second command —
 * but git itself gives one URL scheme a way to run one: `ext::` invokes an
 * arbitrary command as the transport. Whitespace is refused for the same reason
 * (`ext::sh -c …` needs it, and no real remote URL contains a literal space —
 * it would be percent-encoded). Everything else is left to git, whose own
 * rejection is a better error message than a regex written here.
 * @param url - the candidate.
 * @returns true when the candidate is worth handing to git.
 */
function plausibleRemoteUrl(url: string): boolean {
  if (url === '' || url.startsWith('-')) return false
  if (/\s/.test(url)) return false
  if (/[\u0000-\u001f\u007f]/.test(url)) return false
  return !url.startsWith('ext::')
}

/**
 * Confine a repository-relative path so it cannot address another tree.
 *
 * This is a cheap pre-filter, and it is NOT the security boundary: `git add --
 * ../../etc/passwd` is refused by git itself for being outside the repository.
 * The check exists so an obviously wrong path is answered with a sentence
 * rather than with git's own (correct, but noisier) fatal error.
 * @param path - the candidate.
 * @returns true when the path is usable as a repository-relative path.
 */
function plausiblePath(path: string): boolean {
  return path !== '' && !path.startsWith('/') && !path.startsWith('-') && !path.split('/').includes('..')
}

/**
 * Build the git service: a per-plugin instance holding the read cache, the
 * journal, and the set of actions currently in flight.
 *
 * Instance state — never module state — because a module-level handle would be
 * a disguised singleton surviving a plugin reload, and a reloaded panel that
 * inherited the previous process's journal would be lying about what *it* ran.
 * @returns the service.
 */
export function createGitService(): GitService {
  /** Parsed reads, keyed by `<root>\n<command>`. */
  const cache = new Map<string, CacheEntry>()
  /** The journal, keyed by work-tree root and kept newest-last. */
  const journal = new Map<string, GitRecord[]>()
  /** One entry per repository with a mutation in flight. */
  const running = new Map<string, string>()
  /** Monotonic journal id. */
  let sequence = 0

  /**
   * Run one command.
   * @param dir - the working directory.
   * @param args - argv after the binary.
   * @param timeoutMs - the budget.
   * @returns the raw outcome; never rejects.
   */
  const run = (dir: string, args: readonly string[], timeoutMs: number): Promise<GitRun> =>
    new Promise<GitRun>((resolve) => {
      const child = spawn('git', [
        // `-c` before the subcommand is where git accepts it, and the two
        // settings are what make the output parseable: one gives bytes rather
        // than localized words, the other stops git from quoting non-ASCII
        // paths into `"..."` escapes this module would have to unescape.
        '-c', 'core.quotepath=false',
        ...args,
      ], {
        cwd: dir,
        env: {
          ...process.env,
          // Never block on a credential prompt: a fetch without a token must
          // FAIL with git's own message rather than hold the request open until
          // the timeout kills it.
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_PAGER: 'cat',
          GIT_EDITOR: 'true',
          LC_ALL: 'C',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { stdout += chunk })
      child.stderr.on('data', (chunk: string) => { stderr += chunk })
      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        resolve({
          code: 1,
          stdout,
          stderr,
          timedOut,
          missing: error.code === 'ENOENT',
        })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code: code ?? 1, stdout, stderr, timedOut, missing: false })
      })
    })

  /**
   * Check that a path is an absolute directory this host can run git in.
   *
   * Split out of {@link resolveRepo} because `init` needs exactly this much and
   * no more: it is the one action whose directory is not a work tree yet — that
   * is the whole point of running it.
   * @param dir - the requested directory.
   * @returns the directory, or a failure value.
   */
  const resolveDirectory = async (dir: string): Promise<GitResponse<string>> => {
    if (dir.trim() === '') return fail('bad-request', 'no directory was given')
    if (!isAbsolute(dir)) return fail('bad-request', `"${dir}" is not an absolute path`)
    let info
    try {
      info = await stat(dir)
    } catch {
      return fail('no-directory', `"${dir}" does not exist on the host`)
    }
    if (!info.isDirectory()) return fail('no-directory', `"${dir}" is not a directory`)
    return pass(dir)
  }

  /**
   * Resolve a directory to its work-tree root, or answer why it cannot be one.
   * @param dir - the requested directory.
   * @returns the repository identity, or a failure value.
   */
  const resolveRepo = async (dir: string): Promise<GitResponse<GitRepo>> => {
    const checked = await resolveDirectory(dir)
    if (!checked.ok) return checked

    const top = await run(dir, ['rev-parse', '--show-toplevel'], LOCAL_TIMEOUT_MS)
    if (top.missing) return fail('git-missing', 'the `git` CLI is not on the host\'s PATH')
    if (top.code !== 0) {
      return fail('not-a-repo', `"${dir}" is not inside a git work tree (${reason(top).split('\n')[0] ?? ''})`)
    }
    const root = chomp(top.stdout).trim()
    const gitDirRun = await run(root, ['rev-parse', '--absolute-git-dir'], LOCAL_TIMEOUT_MS)
    const gitDir = gitDirRun.code === 0 ? chomp(gitDirRun.stdout).trim() : join(root, '.git')

    return pass({
      path: dir,
      root,
      name: basename(root),
      gitDir,
      // The unborn flag is decided by the status read (it is the only place the
      // `(initial)` oid appears); this field is only meaningful for `overview`.
      unborn: false,
      operation: detectOperation(gitDir),
    })
  }

  /**
   * Read one cached value, or produce and cache it.
   * @param root - the repository root, part of the cache key.
   * @param key - the command line, part of the cache key.
   * @param read - the producer.
   * @returns the value, from cache when it is still fresh.
   */
  const cached = async <T>(root: string, key: string, read: () => Promise<T>): Promise<T> => {
    const id = `${root}\n${key}`
    const hit = cache.get(id)
    const now = Date.now()
    if (hit !== undefined && now - hit.at < CACHE_TTL_MS) return hit.value as T
    const value = await read()
    cache.set(id, { at: now, value })
    return value
  }

  /**
   * Drop every cached read for one repository.
   * @param root - the repository root.
   */
  const invalidate = (root: string): void => {
    const prefix = `${root}\n`
    for (const key of [...cache.keys()]) {
      if (key.startsWith(prefix)) cache.delete(key)
    }
  }

  /**
   * Append one journal record.
   * @param root - the repository root.
   * @param action - the action name.
   * @param command - the display command.
   * @param result - git's outcome.
   * @param durationMs - the wall-clock duration.
   */
  const journalise = (
    root: string,
    action: GitAction,
    command: string,
    result: GitRun,
    durationMs: number,
  ): void => {
    sequence += 1
    const output = tail([result.stdout, result.stderr].filter(part => part.trim() !== '').join('\n').trim(), RECORD_OUTPUT_CAP)
    const list = journal.get(root) ?? []
    list.push({
      id: sequence,
      at: new Date().toISOString(),
      dir: root,
      action,
      command,
      ok: result.code === 0,
      code: result.code,
      durationMs,
      output,
    })
    // The ring is bounded: a long session in one repository must not grow the
    // host's heap by one record per button press.
    if (list.length > JOURNAL_LIMIT) list.splice(0, list.length - JOURNAL_LIMIT)
    journal.set(root, list)
  }

  return {
    async overview(dir) {
      const repo = await resolveRepo(dir)
      if (!repo.ok) return repo
      const root = repo.data.root

      return cached(root, 'overview', async (): Promise<GitResponse<GitOverview>> => {
        const status = await run(root, [
          'status', '--porcelain=v2', '--branch', '--untracked-files=normal', '-z',
        ], LOCAL_TIMEOUT_MS)
        if (status.code !== 0) return fail('git-failed', reason(status))

        const parsed = parseStatus(status.stdout)
        const counts: GitCounts = {
          staged: parsed.files.filter(file => file.staged && !file.conflicted).length,
          modified: parsed.files.filter(file => file.unstaged && !file.conflicted).length,
          untracked: parsed.files.filter(file => file.untracked).length,
          conflicted: parsed.files.filter(file => file.conflicted).length,
          deleted: parsed.files.filter(file => file.index === 'D' || file.worktree === 'D').length,
        }

        const subjectRun = parsed.head.unborn
          ? undefined
          : await run(root, ['log', '-1', '--format=%s', 'HEAD'], LOCAL_TIMEOUT_MS)
        const remoteRun = await run(root, ['remote', '-v'], LOCAL_TIMEOUT_MS)
        const remotes: GitRemote[] = []
        for (const line of chomp(remoteRun.stdout).split('\n')) {
          const match = /^(\S+)\t(\S+)(?:\s+\((\w+)\))?$/.exec(line)
          if (match === null) continue
          const name = match[1] ?? ''
          const url = match[2] ?? ''
          const seen = remotes.find(entry => entry.name === name)
          if (seen === undefined) remotes.push({ name, url })
          else if (seen.url === '') remotes[remotes.indexOf(seen)] = { name, url }
        }
        const stashRun = await run(root, ['stash', 'list', '--format=%gd'], LOCAL_TIMEOUT_MS)
        const tagRun = await run(root, ['tag', '--list'], LOCAL_TIMEOUT_MS)

        return pass({
          repo: { ...repo.data, unborn: parsed.head.unborn },
          head: {
            ...parsed.head,
            subject: subjectRun === undefined || subjectRun.code !== 0 ? '' : chomp(subjectRun.stdout),
          },
          counts,
          remotes,
          stashCount: chomp(stashRun.stdout).split('\n').filter(line => line !== '').length,
          tagCount: chomp(tagRun.stdout).split('\n').filter(line => line !== '').length,
        })
      })
    },

    async branches(dir) {
      const repo = await resolveRepo(dir)
      if (!repo.ok) return repo
      const root = repo.data.root

      return cached(root, 'branches', async (): Promise<GitResponse<GitBranchList>> => {
        const format = [
          '%(refname)', '%(objectname)', '%(objectname:short)', '%(HEAD)',
          '%(upstream)', '%(upstream:track)', '%(committerdate:iso-strict)',
          '%(authorname)', '%(contents:subject)',
        ].join(REF_FS)
        const result = await run(root, ['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/remotes'], LOCAL_TIMEOUT_MS)
        if (result.code !== 0) return fail('git-failed', reason(result))
        return pass(parseBranches(result.stdout))
      })
    },

    async log(dir, limit, ref) {
      const repo = await resolveRepo(dir)
      if (!repo.ok) return repo
      const root = repo.data.root
      if (ref !== undefined && !plausibleRef(ref)) return fail('bad-request', `"${ref}" is not usable as a revision`)
      const count = Math.min(LOG_LIMIT_MAX, Math.max(1, Math.trunc(limit) || LOG_LIMIT_DEFAULT))

      // A repository with no commit yet has an UNBORN HEAD, and `git log HEAD`
      // answers that with a fatal error about an ambiguous argument. "No commits
      // exist" is not a failure — it is an empty history, which is precisely
      // what a freshly initialized project has — so it is answered as one. An
      // EXPLICIT ref that does not resolve is still git's error to report.
      if (ref === undefined) {
        const head = await run(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], LOCAL_TIMEOUT_MS)
        if (head.code !== 0) return pass([])
      }

      return cached(root, `log ${String(count)} ${ref ?? 'HEAD'}`, async (): Promise<GitResponse<readonly GitCommit[]>> => {
        const format = ['%H', '%h', '%P', '%an', '%ae', '%aI', '%D', '%s'].join(LOG_FS)
        const result = await run(root, [
          'log', `--format=${format}${LOG_RS}`, `--max-count=${String(count)}`, '--date-order', ref ?? 'HEAD',
        ], LOCAL_TIMEOUT_MS)
        if (result.code !== 0) return fail('git-failed', reason(result))
        return pass(parseLog(result.stdout))
      })
    },

    async commit(dir, sha) {
      const repo = await resolveRepo(dir)
      if (!repo.ok) return repo
      const root = repo.data.root
      // A sha is not a name: accept only hex, so nothing here can become an
      // option or a revision expression.
      if (!/^[0-9a-fA-F]{4,64}$/.test(sha)) return fail('bad-request', `"${sha}" is not a commit id`)

      const meta = await run(root, [
        'log', '-1', `--format=${['%H', '%h', '%P', '%an', '%ae', '%aI', '%D', '%s'].join(LOG_FS)}`, sha,
      ], LOCAL_TIMEOUT_MS)
      if (meta.code !== 0) return fail('git-failed', reason(meta))
      const parsed = parseLog(chomp(meta.stdout))
      const found = parsed[0]
      if (found === undefined) return fail('git-failed', `commit ${sha} could not be read`)
      if (found.parents.length > 1) {
        // A merge has no single patch: `git show` prints a combined diff whose
        // per-file stats are meaningless without choosing a parent, so the
        // panel shows the metadata and an empty file list instead of a wrong one.
        return pass({ commit: found, files: [], patch: '', truncated: false })
      }

      const numstat = await run(root, ['show', '--no-color', '-M', '--format=', '--numstat', sha], LOCAL_TIMEOUT_MS)
      const patchRun = await run(root, ['show', '--no-color', '-M', '--format=', '--patch', sha], LOCAL_TIMEOUT_MS)
      const clipped = head(patchRun.stdout, PATCH_CAP)
      return pass({
        commit: found,
        files: numstat.code === 0 ? parseNumstat(numstat.stdout) : [],
        patch: clipped.text,
        truncated: clipped.truncated,
      })
    },

    async changes(dir) {
      const repo = await resolveRepo(dir)
      if (!repo.ok) return repo
      const root = repo.data.root

      return cached(root, 'changes', async (): Promise<GitResponse<GitChanges>> => {
        const status = await run(root, [
          'status', '--porcelain=v2', '--branch', '--untracked-files=normal', '-z',
        ], LOCAL_TIMEOUT_MS)
        if (status.code !== 0) return fail('git-failed', reason(status))
        // `stash list` is a `log` in disguise, so it takes the `%x` spelling too.
        const stashRun = await run(root, ['stash', 'list', '--format=%gd%x1f%gs%x1f%cI'], LOCAL_TIMEOUT_MS)
        return pass({
          files: parseStatus(status.stdout).files,
          stashes: stashRun.code === 0 ? parseStashes(stashRun.stdout) : [],
          running: running.get(root) ?? null,
        })
      })
    },

    async diff(dir, file, staged, ref) {
      const repo = await resolveRepo(dir)
      if (!repo.ok) return repo
      const root = repo.data.root
      if (!plausiblePath(file)) return fail('bad-request', `"${file}" is not a repository-relative path`)
      if (ref !== undefined && !plausibleRef(ref)) return fail('bad-request', `"${ref}" is not usable as a revision`)

      // Untracked paths have no diff to show: `git diff` reports nothing for
      // them, and the panel would render an empty box. Saying so is the honest
      // answer, and it is what the operator needs to know to stage it instead.
      const tracked = await run(root, ['ls-files', '--error-unmatch', '--', file], LOCAL_TIMEOUT_MS)
      if (tracked.code !== 0) {
        return fail('git-failed', `"${file}" is untracked — there is no diff yet; stage it to record a change`)
      }

      const args = ['diff', '--no-color', '-M', '--patch']
      if (staged) args.push('--cached')
      if (ref !== undefined) args.push(ref)
      args.push('--', file)
      const result = await run(root, args, LOCAL_TIMEOUT_MS)
      if (result.code !== 0) return fail('git-failed', reason(result))
      const clipped = head(result.stdout, PATCH_CAP)
      return pass({ patch: clipped.text, truncated: clipped.truncated })
    },

    async records(dir) {
      const repo = await resolveRepo(dir)
      // A directory that is not a repository can still have a journal: running
      // `init` on it is recorded, and losing that record the moment it succeeds
      // would hide the one command that explains the repository's existence.
      const all = repo.ok
        ? (journal.get(repo.data.root) ?? (journal.get(dir) ?? []))
        : (journal.get(dir) ?? [])
      if (!repo.ok && all.length === 0) return repo
      const records: GitRecord[] = []
      for (let index = all.length - 1; index >= 0; index -= 1) {
        const record = all[index]
        if (record !== undefined) records.push(record)
      }
      return pass({ records, total: all.length })
    },

    async act(request) {
      // `init` is the one action that RUNS in a directory which is not a work
      // tree yet — requiring one first would make it unusable exactly where it
      // is needed. It therefore needs only a real directory; every other action
      // needs a repository, and says so by name when there is none.
      let root: string
      let gitDir: string
      if (request.action === 'init') {
        const checked = await resolveDirectory(request.dir)
        if (!checked.ok) return checked
        root = checked.data
        gitDir = join(root, '.git')
      } else {
        const repo = await resolveRepo(request.dir)
        if (!repo.ok) return repo
        root = repo.data.root
        gitDir = repo.data.gitDir
      }
      const args = request.args ?? {}

      const built = await buildAction(root, gitDir, request.action, args)
      if (!built.ok) return built

      const timeout = REMOTE_ACTIONS.has(request.action) ? REMOTE_TIMEOUT_MS : LOCAL_TIMEOUT_MS
      const started = Date.now()
      running.set(root, request.action)
      let result: GitRun
      try {
        result = await run(root, built.args, timeout)
      } finally {
        running.delete(root)
      }
      const durationMs = Date.now() - started
      const command = display(built.args)

      // The journal is keyed by the CANONICAL work-tree root, because that is
      // what `records` resolves — and the two are not always the same string:
      // on macOS `/var` is a symlink to `/private/var`, so an `init` keyed by
      // the path the caller typed would be filed under a key nothing ever reads
      // back. For `init` the canonical root only exists AFTER the command ran,
      // which is why it is resolved here rather than above.
      let key = root
      if (request.action === 'init' && result.code === 0) {
        const created = await resolveRepo(root)
        if (created.ok) key = created.data.root
      }
      journalise(key, request.action, command, result, durationMs)
      if (key !== request.dir) {
        // The command was asked about a directory that is not (or was not yet) a
        // work tree: keep it readable under that path too, so the one command
        // that explains a repository's existence is never the one that is lost.
        journalise(request.dir, request.action, command, result, durationMs)
      }
      // A mutation invalidates every read for this repository: the panel must
      // never render the tree it just changed.
      invalidate(key)
      invalidate(request.dir)

      if (result.missing) return fail('git-missing', 'the `git` CLI is not on the host\'s PATH')
      const output = tail(
        [result.stdout, result.stderr].filter(part => part.trim() !== '').join('\n').trim(),
        RECORD_OUTPUT_CAP * 4,
      )
      if (result.timedOut) {
        return fail('timeout', `${command} did not finish within ${String(Math.round(timeout / 1000))}s and was killed`)
      }
      if (result.code !== 0) {
        // The command is reported as CONTENT: the panel shows git's own words
        // (a conflict, a rejected push, "no upstream") where the operator
        // pressed the button, not in a console.
        return pass({ action: request.action, command, ok: false, output: output === '' ? reason(result) : output })
      }
      return pass({ action: request.action, command, ok: true, output })
    },
  }
}

/**
 * Detect an in-progress multi-step operation from the git directory.
 * @param gitDir - the absolute git directory.
 * @returns the operation, or null when the tree is in a normal state.
 */
function detectOperation(gitDir: string): GitOperation | null {
  if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) return 'rebase'
  if (existsSync(join(gitDir, 'MERGE_HEAD'))) return 'merge'
  if (existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
  if (existsSync(join(gitDir, 'REVERT_HEAD'))) return 'revert'
  if (existsSync(join(gitDir, 'BISECT_LOG'))) return 'bisect'
  return null
}

/** One built mutation: the argv, or why it could not be built. */
type BuiltAction =
  | { readonly ok: true; readonly args: readonly string[] }
  | { readonly ok: false; readonly error: GitError }

/**
 * Build one mutation's argv, validating every name through git itself.
 *
 * The two validators are the point of this function. `check-ref-format
 * --branch` is git's own answer on whether a branch name is legal, and
 * `rev-parse --verify` is its answer on whether a revision resolves — both far
 * better than a regex written here, and both expressed as argv so nothing a
 * browser sends is ever interpreted twice.
 * @param root - the work-tree root, the cwd for the validators.
 * @param gitDir - the absolute git directory, where an in-flight operation is recorded.
 * @param action - the action to build.
 * @param args - the caller's argument bag.
 * @returns the argv or a failure value.
 */
async function buildAction(
  root: string,
  gitDir: string,
  action: GitAction,
  args: GitActionArgs,
): Promise<BuiltAction> {
  /** Validate one branch name through git. */
  const branchName = async (name: string | undefined, label: string): Promise<BuiltAction | string> => {
    if (name === undefined || name.trim() === '') return { ok: false, error: { code: 'bad-request', message: `${label} is required` } }
    if (name.startsWith('-')) return { ok: false, error: { code: 'bad-request', message: `${label} may not start with "-"` } }
    const check = await new Promise<number>((resolve) => {
      const child = spawn('git', ['check-ref-format', '--branch', name], { cwd: root, stdio: 'ignore' })
      child.on('error', () => { resolve(1) })
      child.on('close', code => { resolve(code ?? 1) })
    })
    if (check !== 0) return { ok: false, error: { code: 'bad-request', message: `"${name}" is not a valid branch name` } }
    return name
  }

  /** Validate one revision through git. */
  const revision = async (ref: string | undefined, label: string): Promise<BuiltAction | string> => {
    if (ref === undefined || ref === '') return { ok: false, error: { code: 'bad-request', message: `${label} is required` } }
    if (!plausibleRef(ref)) return { ok: false, error: { code: 'bad-request', message: `"${ref}" is not usable as a revision` } }
    const verify = await new Promise<number>((resolve) => {
      const child = spawn('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, stdio: 'ignore' })
      child.on('error', () => { resolve(1) })
      child.on('close', code => { resolve(code ?? 1) })
    })
    if (verify !== 0) return { ok: false, error: { code: 'bad-request', message: `"${ref}" does not resolve to a commit` } }
    return ref
  }

  /** Validate the file list of an index or working-tree action. */
  const paths = (files: readonly string[] | undefined):
  | { readonly ok: true; readonly files: readonly string[] }
  | { readonly ok: false; readonly error: GitError } => {
    if (files === undefined || files.length === 0) {
      return { ok: false, error: { code: 'bad-request', message: 'at least one path is required' } }
    }
    for (const file of files) {
      if (!plausiblePath(file)) {
        return { ok: false, error: { code: 'bad-request', message: `"${file}" is not a repository-relative path` } }
      }
    }
    return { ok: true, files }
  }

  switch (action) {
    case 'init': {
      // `-b` needs git >= 2.28; older binaries simply get no initial-branch flag
      // and their own default, which is a better outcome than refusing to init.
      const argv = ['init']
      if (args.branch !== undefined && args.branch !== '') {
        const name = await branchName(args.branch, 'the initial branch name')
        if (typeof name !== 'string') return name
        argv.push('-b', name)
      }
      return { ok: true, args: argv }
    }
    case 'remote-add':
    case 'remote-set-url':
    case 'remote-rename':
    case 'remote-remove': {
      const name = args.name ?? 'origin'
      if (name === '' || name.startsWith('-')) {
        return { ok: false, error: { code: 'bad-request', message: 'a remote name may not start with "-"' } }
      }
      if (name === '--') {
        return { ok: false, error: { code: 'bad-request', message: `"${name}" is not a usable remote name` } }
      }
      if (action === 'remote-remove') return { ok: true, args: ['remote', 'remove', name] }
      if (action === 'remote-rename') {
        const to = args.to ?? ''
        if (to === '' || to.startsWith('-')) {
          return { ok: false, error: { code: 'bad-request', message: 'a remote name may not start with "-"' } }
        }
        return { ok: true, args: ['remote', 'rename', name, to] }
      }
      const url = args.url ?? ''
      if (!plausibleRemoteUrl(url)) {
        return {
          ok: false,
          error: {
            code: 'bad-request',
            message: url === ''
              ? 'a remote URL is required'
              : `"${url}" is not usable as a remote URL`,
          },
        }
      }
      return action === 'remote-add'
        ? { ok: true, args: ['remote', 'add', name, url] }
        : { ok: true, args: ['remote', 'set-url', name, url] }
    }
    case 'checkout': {
      const ref = await revision(args.ref, 'the branch to switch to')
      if (typeof ref !== 'string') return ref
      return { ok: true, args: ['checkout', ref] }
    }
    case 'create-branch': {
      const name = await branchName(args.name, 'the new branch name')
      if (typeof name !== 'string') return name
      const start = args.startPoint === undefined || args.startPoint === ''
        ? null
        : await revision(args.startPoint, 'the start point')
      if (start !== null && typeof start !== 'string') return start
      const argv = args.checkout === false
        ? ['branch', name, ...(start === null ? [] : [start])]
        : ['checkout', '-b', name, ...(start === null ? [] : [start])]
      return { ok: true, args: argv }
    }
    case 'rename-branch': {
      const from = await branchName(args.from, 'the current branch name')
      if (typeof from !== 'string') return from
      const to = await branchName(args.to, 'the new branch name')
      if (typeof to !== 'string') return to
      return { ok: true, args: ['branch', '-m', from, to] }
    }
    case 'delete-branch': {
      const name = await branchName(args.name, 'the branch name')
      if (typeof name !== 'string') return name
      const current = await new Promise<string>((resolve) => {
        const child = spawn('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
        let out = ''
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => { out += chunk })
        child.on('error', () => { resolve('') })
        child.on('close', () => { resolve(chomp(out)) })
      })
      if (current === name) {
        return { ok: false, error: { code: 'bad-request', message: `"${name}" is the branch you are on — switch away before deleting it` } }
      }
      // `-d` refuses an unmerged branch and says why, which is exactly the
      // confirmation the operator wants; the panel asks separately before
      // passing `force`, so `-D` is only ever reached by an explicit choice.
      return { ok: true, args: ['branch', args.force === true ? '-D' : '-d', name] }
    }
    case 'merge': {
      const ref = await revision(args.ref, 'the branch to merge')
      if (typeof ref !== 'string') return ref
      return { ok: true, args: ['merge', ...(args.noFf === true ? ['--no-ff'] : []), ref] }
    }
    case 'rebase': {
      const ref = await revision(args.ref, 'the branch to rebase onto')
      if (typeof ref !== 'string') return ref
      return { ok: true, args: ['rebase', ref] }
    }
    case 'cherry-pick': {
      const ref = await revision(args.ref, 'the commit to apply')
      if (typeof ref !== 'string') return ref
      return { ok: true, args: ['cherry-pick', ref] }
    }
    case 'reset': {
      const ref = await revision(args.ref, 'the commit to reset to')
      if (typeof ref !== 'string') return ref
      const mode = args.mode ?? 'mixed'
      if (mode !== 'soft' && mode !== 'mixed' && mode !== 'hard') {
        return { ok: false, error: { code: 'bad-request', message: `"${mode}" is not a reset mode` } }
      }
      return { ok: true, args: ['reset', `--${mode}`, ref] }
    }
    case 'fetch': {
      const argv = ['fetch', '--prune']
      if (args.remote !== undefined && args.remote !== '') {
        if (!plausibleRef(args.remote)) return { ok: false, error: { code: 'bad-request', message: `"${args.remote}" is not a remote name` } }
        argv.push(args.remote)
      }
      return { ok: true, args: argv }
    }
    case 'pull': {
      const argv = ['pull', ...(args.rebase === true ? ['--rebase'] : [])]
      if (args.remote !== undefined && args.remote !== '') {
        if (!plausibleRef(args.remote)) return { ok: false, error: { code: 'bad-request', message: `"${args.remote}" is not a remote name` } }
        argv.push(args.remote)
        if (args.branch !== undefined && args.branch !== '') {
          if (!plausibleRef(args.branch)) return { ok: false, error: { code: 'bad-request', message: `"${args.branch}" is not a branch name` } }
          argv.push(args.branch)
        }
      }
      return { ok: true, args: argv }
    }
    case 'push': {
      const argv = ['push']
      if (args.force === true) argv.push('--force-with-lease')
      if (args.setUpstream === true) argv.push('--set-upstream')
      if (args.tags === true) argv.push('--tags')
      if (args.remote !== undefined && args.remote !== '') {
        if (!plausibleRef(args.remote)) return { ok: false, error: { code: 'bad-request', message: `"${args.remote}" is not a remote name` } }
        argv.push(args.remote)
        if (args.branch !== undefined && args.branch !== '') {
          if (!plausibleRef(args.branch)) return { ok: false, error: { code: 'bad-request', message: `"${args.branch}" is not a branch name` } }
          argv.push(args.branch)
        }
      }
      return { ok: true, args: argv }
    }
    case 'push-branch': {
      const name = await branchName(args.name, 'the branch to push')
      if (typeof name !== 'string') return name
      const argv = ['push']
      if (args.force === true) argv.push('--force-with-lease')
      argv.push(args.setUpstream === false ? (args.remote ?? 'origin') : '--set-upstream')
      if (args.setUpstream === false) argv.push(name)
      else argv.push(args.remote ?? 'origin', name)
      return { ok: true, args: argv }
    }
    case 'stage': {
      const list = paths(args.files)
      if (!list.ok) return list
      return { ok: true, args: ['add', '--', ...list.files] }
    }
    case 'unstage': {
      const list = paths(args.files)
      if (!list.ok) return list
      // `restore --staged` is the modern spelling and, unlike `reset HEAD --`,
      // it leaves the working-tree content untouched by construction.
      return { ok: true, args: ['restore', '--staged', '--', ...list.files] }
    }
    case 'discard': {
      const list = paths(args.files)
      if (!list.ok) return list
      return { ok: true, args: ['restore', '--worktree', '--', ...list.files] }
    }
    case 'clean': {
      const list = paths(args.files)
      if (!list.ok) return list
      // `-f` is required for `clean` to remove anything at all. `-d` is passed
      // only when the caller asked for it: a directory-shaped entry from
      // `git status` is then removed as a set of files, never as an unexamined
      // subtree the operator never saw.
      return { ok: true, args: ['clean', '-f', ...(args.includeUntracked === false ? [] : ['-d']), '--', ...list.files] }
    }
    case 'commit': {
      const message = args.message ?? ''
      if (message.trim() === '') return { ok: false, error: { code: 'bad-request', message: 'a commit message is required' } }
      const argv = ['commit', ...(args.all === true ? ['--all'] : []), '-m', message]
      return { ok: true, args: argv }
    }
    case 'amend': {
      const message = args.message ?? ''
      const argv = ['commit', '--amend']
      if (message.trim() === '') argv.push('--no-edit')
      else argv.push('-m', message)
      if (args.all === true) argv.push('--all')
      return { ok: true, args: argv }
    }
    case 'stash-save': {
      const argv = ['stash', 'push']
      if (args.includeUntracked !== false) argv.push('--include-untracked')
      const message = args.message ?? ''
      if (message.trim() !== '') argv.push('-m', message)
      return { ok: true, args: argv }
    }
    case 'stash-pop':
    case 'stash-apply':
    case 'stash-drop': {
      const index = Math.trunc(args.index ?? 0)
      if (index < 0) return { ok: false, error: { code: 'bad-request', message: 'a stash index cannot be negative' } }
      const verb = action === 'stash-pop' ? 'pop' : action === 'stash-apply' ? 'apply' : 'drop'
      return { ok: true, args: ['stash', verb, `stash@{${String(index)}}`] }
    }
    case 'tag-create': {
      if (args.name === undefined || args.name === '') return { ok: false, error: { code: 'bad-request', message: 'a tag name is required' } }
      if (args.name.startsWith('-')) return { ok: false, error: { code: 'bad-request', message: 'a tag name may not start with "-"' } }
      const check = await new Promise<number>((resolve) => {
        const child = spawn('git', ['check-ref-format', `refs/tags/${args.name ?? ''}`], { cwd: root, stdio: 'ignore' })
        child.on('error', () => { resolve(1) })
        child.on('close', code => { resolve(code ?? 1) })
      })
      if (check !== 0) return { ok: false, error: { code: 'bad-request', message: `"${args.name}" is not a valid tag name` } }
      const annotation = args.annotation ?? ''
      const argv = annotation.trim() === ''
        ? ['tag', args.name]
        : ['tag', '-a', '-m', annotation, args.name]
      if (args.ref !== undefined && args.ref !== '') {
        const ref = await revision(args.ref, 'the commit to tag')
        if (typeof ref !== 'string') return ref
        argv.push(ref)
      }
      return { ok: true, args: argv }
    }
    case 'tag-delete': {
      if (args.name === undefined || args.name === '' || args.name.startsWith('-')) {
        return { ok: false, error: { code: 'bad-request', message: 'a tag name is required' } }
      }
      return { ok: true, args: ['tag', '-d', args.name] }
    }
    case 'abort': {
      // The operation is read from the git directory again, at action time:
      // the panel may have asked a moment ago, when the state was different.
      const pending = detectOperation(gitDir)
      if (pending === 'merge') return { ok: true, args: ['merge', '--abort'] }
      if (pending === 'rebase') return { ok: true, args: ['rebase', '--abort'] }
      if (pending === 'cherry-pick') return { ok: true, args: ['cherry-pick', '--abort'] }
      if (pending === 'revert') return { ok: true, args: ['revert', '--abort'] }
      return { ok: false, error: { code: 'bad-request', message: 'there is no merge, rebase, cherry-pick, or revert to abort' } }
    }
    default: {
      const uncovered: never = action
      return { ok: false, error: { code: 'unknown-action', message: `unknown action "${String(uncovered)}"` } }
    }
  }
}
