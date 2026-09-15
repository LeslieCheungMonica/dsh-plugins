/**
 * The host half of the bottom command panel: run one command line, keep its
 * output, and let the browser read it back by offset.
 *
 * ## This surface runs what the operator types, on purpose
 *
 * Everywhere else in this plugin the browser's input is a URL or a span of
 * bytes. Here it is a command LINE, and evaluating it — quoting, pipes, globs,
 * `&&` — is the feature. So it goes to a login shell, and the consequences are
 * handled rather than wished away:
 *
 * 1. **It runs under a resolved file policy, and says which one.** The argv goes
 *    through `ctx.sandbox.confine` with the policy `ctx.sandboxPolicy` resolves,
 *    whose workspace boundary is the directory the command runs in. The default
 *    is `auto`: resolve for a SESSIONLESS call, which yields the deployment's
 *    configured mode — the deployment default and NOT the running session's own
 *    override, because a command typed into this panel belongs to no agent
 *    session. `config.shell.mode` pins the mode instead; `danger-full-access`
 *    skips confinement, which is what that word means in the seam's vocabulary.
 *    The mode a run actually executed under is reported on every run and shown
 *    in the panel, because confinement the operator cannot see is confinement
 *    that turns a write failure into a mystery.
 * 2. **It runs in a directory the caller named**, which must be absolute and
 *    must exist.
 * 3. **It is bounded.** A command that outlives its budget is terminated, and
 *    its output is capped; the browser is told both facts rather than being
 *    handed a truncated stream that looks complete.
 *
 * ## Output is a window with absolute offsets
 *
 * A run's output lives in one bounded ring. `bytes` counts every byte ever
 * produced, so an offset stays meaningful after the host has dropped the front
 * of the buffer: a poll whose `from` predates the window is answered from the
 * window's start and marked `truncated`, which is the honest answer ("you
 * missed some") instead of a silent gap. Text is decoded per stream through
 * `setEncoding('utf8')`, so a multi-byte character split across two chunks is
 * not mangled, and stdout and stderr are merged in ARRIVAL order — the only
 * ordering two separate pipes can honestly offer.
 *
 * @module my-sider/host/shell
 */
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { SandboxExecutionPolicy, SandboxMode, SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { ShellPoll, ShellRun, WireErrorCode, WireResponse } from '../shared/wire.ts'
import type { ShellOptions } from './options.ts'

/** The subset of the sandbox-policy service this module needs. */
export interface SandboxPolicyResolver {
  /**
   * Resolve the policy for one capability call.
   * @param request - an optional approved mode override.
   * @returns the resolved policy.
   */
  resolve: (request?: { mode?: SandboxMode }) => SandboxExecutionPolicy
}

/** What the command service needs from its host. */
export interface ShellDeps {
  /** The process seam: the only way this module starts anything. */
  readonly subprocess: SubprocessRuntime
  /** The confinement seam. */
  readonly sandbox: SandboxProvider
  /** The policy seam. */
  readonly sandboxPolicy: SandboxPolicyResolver
}

/** The command panel's host face. */
export interface ShellService {
  /**
   * Start one command.
   * @param dir - the absolute directory to run in.
   * @param command - the command line.
   * @returns the new run, or a failure naming what was wrong with the request.
   */
  start(dir: string, command: string): Promise<WireResponse<ShellRun>>
  /**
   * Read a run's output after an offset.
   * @param id - the run id.
   * @param from - the offset the caller already holds.
   * @returns the run and the text that followed.
   */
  poll(id: string, from: number): WireResponse<ShellPoll>
  /**
   * Stop one running command.
   * @param id - the run id.
   * @returns the run's state after the request was issued.
   */
  kill(id: string): WireResponse<ShellRun>
  /**
   * Every run this instance still holds, newest first.
   * @returns the run list.
   */
  list(): WireResponse<readonly ShellRun[]>
  /** Terminate every running command (the plugin's disposal hook). */
  dispose(): void
}

/** One live run, with the state the wire never sees. */
interface RunRecord {
  readonly id: string
  readonly command: string
  readonly dir: string
  readonly startedAt: number
  /** The retained tail of the output, as text. */
  buffer: string
  /** Absolute byte count ever produced. */
  bytes: number
  running: boolean
  exitCode: number | null
  signal: string | null
  finishedAt: number | null
  timedOut: boolean
  /** The policy this run actually executed under, resolved at start. */
  sandboxMode: SandboxMode
  /** The only termination verb the subprocess seam offers. */
  terminate: (() => void) | null
  /** Clears the run's own timeout. */
  clearTimer: (() => void) | null
}

/**
 * Build one failure value.
 * @param code - the stable machine code.
 * @param message - the human sentence.
 * @returns the failure arm of a response.
 */
function fail(code: WireErrorCode, message: string): { ok: false; error: { code: WireErrorCode; message: string } } {
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
 * Build the command panel's host service.
 *
 * State is per instance, never module-level: a module-level registry would be a
 * disguised singleton surviving a plugin reload, and a reloaded plugin that
 * inherited the previous process's run ids would be lying about what it holds.
 * @param deps - the three host seams this surface drives.
 * @param options - the deployment's decisions.
 * @returns the service.
 */
export function createShellService(deps: ShellDeps, options: ShellOptions): ShellService {
  /** Every run this instance holds. */
  const runs = new Map<string, RunRecord>()
  /** Monotonic id source; also the run's ordinal for display. */
  let sequence = 0

  /**
   * Project one record onto the wire shape.
   * @param run - the record.
   * @returns the wire view.
   */
  const view = (run: RunRecord): ShellRun => {
    const end = run.finishedAt ?? Date.now()
    return {
      id: run.id,
      command: run.command,
      dir: run.dir,
      startedAt: new Date(run.startedAt).toISOString(),
      running: run.running,
      exitCode: run.exitCode,
      signal: run.signal,
      durationMs: Math.max(0, end - run.startedAt),
      bytes: run.bytes,
      truncated: Buffer.byteLength(run.buffer) < run.bytes,
      timedOut: run.timedOut,
      sandboxMode: run.sandboxMode,
    }
  }

  /** Drop the oldest settled runs until the registry is inside its budget. */
  const prune = (): void => {
    const settled = [...runs.values()].filter(run => !run.running)
    // Never evict a running command: its id must stay answerable, or the panel
    // would lose the one entry it can still kill.
    while (runs.size > options.history && settled.length > 0) {
      const oldest = settled.shift()
      if (oldest !== undefined) runs.delete(oldest.id)
    }
  }

  /**
   * Append decoded text, keeping only the retained tail.
   * @param run - the record to grow.
   * @param chunk - freshly decoded text.
   */
  const append = (run: RunRecord, chunk: string): void => {
    if (chunk === '') return
    run.buffer += chunk
    run.bytes += Buffer.byteLength(chunk)
    const limit = options.bufferBytes
    if (Buffer.byteLength(run.buffer) <= limit) return
    // Cut from the FRONT on a character boundary: a retained window that began
    // mid-codepoint would render as a replacement character for ever.
    const buffer = Buffer.from(run.buffer)
    let cut = buffer.length - limit
    while (cut < buffer.length && (buffer[cut] ?? 0) >= 0x80 && (buffer[cut] ?? 0) < 0xc0) cut += 1
    run.buffer = buffer.subarray(cut).toString('utf8')
  }

  /**
   * Settle one run: publish its outcome and release its timers.
   * @param run - the record.
   * @param outcome - the exit facts, or null when the process never started.
   * @param error - the spawn failure, when there was one.
   */
  const settle = (run: RunRecord, outcome: { exitCode: number | null; signal: string | null } | null, error?: unknown): void => {
    if (error !== undefined) {
      append(run, `\n[my-sider] the process could not be started: ${String(error)}\n`)
    }
    run.running = false
    run.exitCode = outcome?.exitCode ?? null
    run.signal = outcome?.signal ?? null
    run.finishedAt = Date.now()
    run.terminate = null
    run.clearTimer?.()
    run.clearTimer = null
    prune()
  }

  return {
    async start(dir, command) {
      const trimmed = command.trim()
      if (trimmed === '') return fail('no-command', 'the command is empty')
      if (trimmed.length > 8_192) return fail('bad-request', 'the command is unreasonably long')
      if (!isAbsolute(dir)) return fail('bad-request', `"${dir}" is not an absolute path`)
      try {
        const info = await stat(dir)
        if (!info.isDirectory()) return fail('no-directory', `"${dir}" is not a directory`)
      } catch {
        return fail('no-directory', `"${dir}" does not exist on the host`)
      }

      // A shell is the point of this surface (see the module doc). `-l` picks up
      // the operator's login PATH so the panel behaves like their terminal.
      const shellPath = await deps.subprocess.resolveExecutable(options.shell)
      const argv = [shellPath, '-lc', trimmed]

      // The policy is resolved before anything is spawned: if the runner
      // refuses, nothing runs at all — and this module must not invent an
      // unconfined passthrough the seam deliberately does not offer.
      const resolved = deps.sandboxPolicy.resolve(options.mode === 'auto' ? {} : { mode: options.mode })
      let toSpawn: readonly string[] = argv
      if (resolved.mode !== 'danger-full-access') {
        try {
          toSpawn = deps.sandbox.confine(argv, {
            mode: resolved.mode,
            // The operator's boundary is the directory they are working in,
            // which is what a session's own cwd would be for an agent command.
            workspaceRoot: dir,
          }).argv
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          return fail('sandbox-refused', `the sandbox would not wrap this command: ${reason}`)
        }
      }

      sequence += 1
      const id = `shell-${String(sequence)}`
      const record: RunRecord = {
        id,
        command: trimmed,
        dir,
        startedAt: Date.now(),
        buffer: '',
        bytes: 0,
        running: true,
        exitCode: null,
        signal: null,
        finishedAt: null,
        timedOut: false,
        sandboxMode: resolved.mode,
        terminate: null,
        clearTimer: null,
      }

      try {
        const handle = deps.subprocess.spawn({
          argv: toSpawn,
          cwd: dir,
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
          graceMs: 5_000,
        })
        record.terminate = () => { handle.terminate() }
        const timer = setTimeout(() => {
          record.timedOut = true
          handle.terminate()
        }, options.timeoutMs)
        record.clearTimer = () => { clearTimeout(timer) }

        // Both pipes feed ONE buffer, in arrival order — the only ordering two
        // separate pipes can honestly offer, and the shape a terminal shows.
        for (const stream of [handle.stdout, handle.stderr]) {
          stream?.setEncoding('utf8')
          stream?.on('data', (chunk: string) => { append(record, chunk) })
        }
        void handle.done.then(
          outcome => { settle(record, { exitCode: outcome.exitCode, signal: outcome.signal ?? null }) },
          (error: unknown) => { settle(record, null, error) },
        )
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return fail('spawn-failed', `the command could not be started: ${reason}`)
      }

      runs.set(id, record)
      prune()
      return pass(view(record))
    },

    poll(id, from) {
      const run = runs.get(id)
      if (run === undefined) {
        return fail('unknown-run', `no run "${id}" — it was never started, or the host has forgotten it`)
      }
      const requested = Number.isFinite(from) && from > 0 ? Math.trunc(from) : 0
      // The retained window starts where `bytes` leaves off going backwards.
      const windowStart = run.bytes - Buffer.byteLength(run.buffer)
      const start = Math.max(requested, windowStart)
      // Every offset this surface hands out is a character boundary (an append
      // is always whole decoded text, and the window's own cut is adjusted to
      // one), so slicing bytes here cannot split a character.
      const text = start <= windowStart
        ? run.buffer
        : Buffer.from(run.buffer).subarray(start - windowStart).toString('utf8')
      return pass({ run: view(run), output: text, from: start, next: run.bytes })
    },

    kill(id) {
      const run = runs.get(id)
      if (run === undefined) {
        return fail('unknown-run', `no run "${id}" — it was never started, or the host has forgotten it`)
      }
      // Idempotent and safe on an already-gone tree, so no state check here:
      // asking to stop something that stopped itself is not an error.
      run.terminate?.()
      return pass(view(run))
    },

    list() {
      const items = [...runs.values()].sort((left, right) => right.startedAt - left.startedAt)
      return pass(items.map(view))
    },

    dispose() {
      for (const run of runs.values()) {
        run.clearTimer?.()
        run.terminate?.()
      }
      runs.clear()
    },
  }
}
