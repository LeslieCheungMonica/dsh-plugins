/**
 * The host half of the bottom command bar: run one command line, keep its
 * output, and let the browser read it back by offset.
 *
 * ## This surface runs what the operator types, on purpose
 *
 * Everywhere else in this plugin the browser's input becomes an ARGV ELEMENT and
 * a shell is never involved. Here that would be pointless: a command bar exists
 * to evaluate a command line, quoting, pipes, globs and all. So the command is
 * handed to `bash -lc` — and the consequences are handled rather than wished
 * away:
 *
 * 1. **It runs under a resolved file policy, and says which one.** The argv goes
 *    through `ctx.sandbox.confine` with the policy `ctx.sandboxPolicy` resolves,
 *    whose workspace boundary is the directory the command runs in. The default
 *    is `auto`: resolve for a SESSIONLESS call, which yields the deployment's
 *    configured mode — note that this is the deployment default and NOT the
 *    running session's own override, because a command typed into this bar
 *    belongs to no agent session. `config.terminal.mode` pins the mode instead
 *    (`read-only` / `workspace-write` / `danger-full-access`); the last one skips
 *    confinement, which is what that word means in the seam's vocabulary. The
 *    mode a run actually executed under is reported on every run and shown in
 *    the bar, because confinement the operator cannot see is confinement that
 *    turns a write failure into a mystery.
 * 2. **It runs in the operator's own project**, never in a directory the caller
 *    cannot name: the path is absolute and must exist.
 * 3. **It is bounded.** A command that outlives its budget is terminated, and
 *    its output is capped; the browser is told both facts rather than being
 *    handed a truncated stream that looks complete.
 *
 * ## Output is a window with absolute offsets
 *
 * A run's output lives in one bounded ring. `bytes` counts every byte ever
 * produced, so an offset is meaningful even after the host has dropped the front
 * of the buffer: a poll whose `from` predates the window is answered from the
 * window's start and marked `truncated`, which is the honest answer ("you missed
 * some") instead of a silent gap or a reshuffled buffer. Bytes are decoded per
 * stream through a `StringDecoder`, so a multi-byte character split across two
 * chunks is not mangled, and stdout and stderr are merged in ARRIVAL order —
 * the only ordering two separate pipes can honestly offer.
 *
 * @module dsh-web-ui/host/term
 */
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { SandboxExecutionPolicy, SandboxMode, SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  TermError, TermErrorCode, TermPoll, TermResponse, TermRun,
} from '../shared/termwire.ts'

/** The subset of the sandbox-policy service this module needs. */
export interface SandboxPolicyResolver {
  /**
   * Resolve the policy for one capability call.
   * @param request - an optional approved mode override.
   * @returns the resolved policy.
   */
  resolve: (request?: { mode?: SandboxMode }) => SandboxExecutionPolicy
}

/** What the terminal service needs from its host. */
export interface TerminalDeps {
  /** The process seam: the only way this module starts anything. */
  readonly subprocess: SubprocessRuntime
  /** The confinement seam. */
  readonly sandbox: SandboxProvider
  /** The policy seam. */
  readonly sandboxPolicy: SandboxPolicyResolver
}

/** The deployment's decisions about this surface, from the plugin row. */
export interface TerminalOptions {
  /**
   * Whether the command bar exists at all. False by default: this surface runs
   * what an operator types, so it is opted into rather than assumed, and a
   * deployment that is not using it has no command-execution route registered.
   */
  readonly enabled: boolean
  /**
   * File-effect policy for operator commands. `auto` follows whatever the
   * deployment resolves for a sessionless call — the default, and the only
   * choice that cannot surprise by disagreeing with the rest of the deployment.
   */
  readonly mode: SandboxMode | 'auto'
  /** How long one command may run before it is terminated, in milliseconds. */
  readonly timeoutMs: number
  /** How much output is retained per run, in bytes. */
  readonly bufferBytes: number
  /** The shell that evaluates the command line. */
  readonly shell: string
  /** How many settled runs the host remembers. */
  readonly history: number
}

/** The command bar's host face. */
export interface TerminalService {
  /**
   * Start one command.
   * @param dir - the absolute directory to run in.
   * @param command - the command line.
   * @returns the new run, or a failure naming what was wrong with the request.
   */
  start(dir: string, command: string): Promise<TermResponse<TermRun>>
  /**
   * Read a run's output after an offset.
   * @param id - the run id.
   * @param from - the offset the caller already holds.
   * @returns the run and the bytes that followed.
   */
  poll(id: string, from: number): TermResponse<TermPoll>
  /**
   * Stop one running command.
   * @param id - the run id.
   * @returns the run's state after the request was issued.
   */
  kill(id: string): TermResponse<TermRun>
  /**
   * Every run this instance still holds, newest first.
   * @returns the run list.
   */
  list(): TermResponse<readonly TermRun[]>
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
function fail(code: TermErrorCode, message: string): { ok: false; error: TermError } {
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
 * Read the plugin row's options, or throw naming the offending field.
 *
 * Hand-validated rather than schema-validated: this plugin carries no runtime
 * dependencies, and `@deepseek-ai/schemastery` is not one of the modules the
 * shell makes available to a client bundle. The effect is the same — a bad
 * value fails loudly at boot with the field named, instead of being silently
 * ignored and discovered as odd behaviour later.
 * @param raw - the row's `config.terminal`, as loaded.
 * @returns the validated options.
 */
export function readTerminalOptions(raw: unknown): TerminalOptions {
  const defaults: TerminalOptions = {
    enabled: false,
    // Follow the deployment's own policy: a sessionless resolve yields the
    // deployment's configured mode.
    mode: 'auto',
    timeoutMs: 15 * 60_000,
    bufferBytes: 256 * 1024,
    shell: '/bin/bash',
    history: 20,
  }
  if (raw === undefined || raw === null) return defaults
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-web-ui: config.terminal must be an object')
  }
  const record = raw as Record<string, unknown>
  const modes: readonly (SandboxMode | 'auto')[] = ['auto', 'read-only', 'workspace-write', 'danger-full-access']
  const mode = record['mode'] ?? defaults.mode
  if (typeof mode !== 'string' || !modes.includes(mode as SandboxMode | 'auto')) {
    throw new Error(`dsh-web-ui: config.terminal.mode must be one of ${modes.join(', ')}`)
  }
  const number = (key: 'timeoutMs' | 'bufferBytes' | 'history', fallback: number): number => {
    const value = record[key] ?? fallback
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`dsh-web-ui: config.terminal.${key} must be a positive number`)
    }
    return Math.trunc(value)
  }
  const shell = record['shell'] ?? defaults.shell
  if (typeof shell !== 'string' || shell === '') {
    throw new Error('dsh-web-ui: config.terminal.shell must be a non-empty string')
  }
  const enabled = record['enabled'] ?? defaults.enabled
  if (typeof enabled !== 'boolean') {
    throw new Error('dsh-web-ui: config.terminal.enabled must be a boolean')
  }
  return {
    enabled,
    mode: mode as SandboxMode | 'auto',
    timeoutMs: number('timeoutMs', defaults.timeoutMs),
    bufferBytes: number('bufferBytes', defaults.bufferBytes),
    shell,
    history: number('history', defaults.history),
  }
}

/**
 * Build the command bar's host service.
 *
 * State is per instance, never module-level: a module-level registry would be a
 * disguised singleton surviving a plugin reload, and a reloaded plugin that
 * inherited the previous process's run ids would be lying about what it holds.
 * @param deps - the three host seams this surface drives.
 * @param options - the deployment's decisions.
 * @returns the service.
 */
export function createTerminalService(deps: TerminalDeps, options: TerminalOptions): TerminalService {
  /** Every run this instance holds, oldest first. */
  const runs = new Map<string, RunRecord>()
  /** Monotonic id source; also the run's ordinal for display. */
  let sequence = 0

  /** Project one record onto the wire shape. */
  const view = (run: RunRecord): TermRun => {
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
      truncated: run.buffer.length < run.bytes,
      timedOut: run.timedOut,
      sandboxMode: run.sandboxMode,
    }
  }

  /** Drop the oldest settled runs until the registry is inside its budget. */
  const prune = (): void => {
    const settled = [...runs.values()].filter(run => !run.running)
    // Never evict a running command: its id must stay answerable, or the bar
    // would lose the one entry it can still kill.
    while (runs.size > options.history && settled.length > 0) {
      const oldest = settled.shift()
      if (oldest !== undefined) runs.delete(oldest.id)
    }
  }

  /** Append decoded text, keeping only the retained tail. */
  const append = (run: RunRecord, text: string): void => {
    if (text === '') return
    run.buffer += text
    run.bytes += Buffer.byteLength(text)
    const limit = options.bufferBytes
    if (Buffer.byteLength(run.buffer) <= limit) return
    // Cut from the FRONT on a character boundary: a retained window that began
    // mid-codepoint would render as a replacement character for ever.
    const buffer = Buffer.from(run.buffer)
    let cut = buffer.length - limit
    while (cut < buffer.length && (buffer[cut] ?? 0) >= 0x80 && (buffer[cut] ?? 0) < 0xc0) cut += 1
    run.buffer = buffer.subarray(cut).toString('utf8')
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
      // the operator's login PATH so the bar behaves like their terminal.
      const shellPath = await deps.subprocess.resolveExecutable(options.shell)
      const argv = [shellPath, '-lc', trimmed]

      // The policy is resolved before anything is spawned: if the runner
      // refuses, nothing runs at all — the seam forbids a silent unconfined
      // passthrough, and this module must not invent one.
      const resolved = deps.sandboxPolicy.resolve(options.mode === 'auto' ? {} : { mode: options.mode })
      let toSpawn: readonly string[] = argv
      if (resolved.mode !== 'danger-full-access') {
        try {
          toSpawn = deps.sandbox.confine(argv, {
            ...resolved,
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
      const id = `term-${String(sequence)}`
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
        void handle.done.then((outcome) => {
          record.running = false
          record.exitCode = outcome.exitCode
          record.signal = outcome.signal ?? null
          record.finishedAt = Date.now()
          record.terminate = null
          record.clearTimer?.()
          record.clearTimer = null
          prune()
        }, (error: unknown) => {
          append(record, `\n[dsh-web-ui] the process could not be started: ${String(error)}\n`)
          record.running = false
          record.exitCode = null
          record.signal = null
          record.finishedAt = Date.now()
          record.terminate = null
          record.clearTimer?.()
          record.clearTimer = null
          prune()
        })
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
      if (run === undefined) return fail('unknown-run', `no run "${id}" — it was never started, or the host has forgotten it`)
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
      if (run === undefined) return fail('unknown-run', `no run "${id}" — it was never started, or the host has forgotten it`)
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
