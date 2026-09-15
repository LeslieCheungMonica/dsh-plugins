/**
 * The bottom panel: type a bash command line, watch it run, stop it, and keep the
 * last few runs around.
 *
 * It is a **command panel, not a terminal emulator**: one command line at a time,
 * no pty, no full-screen curses programs, no interactive prompt. That scope is
 * deliberate and stated in the UI rather than pretended away — the input is a
 * command LINE, and the header shows the directory and the file policy the
 * command actually runs under.
 *
 * Four behaviours carry the component:
 *
 * 1. **The reader owns its offset.** Every poll sends the byte offset already
 *    rendered and appends what followed. A reload, a remount, or a slow frame
 *    therefore resumes exactly where it was, and the host is never asked to
 *    remember which browser saw what. When the host has had to drop the front of
 *    a run's buffer it answers from a LATER offset than it was asked for, and the
 *    panel prints a gap line there instead of pretending the output is whole.
 * 2. **The poll loop re-arms from the answer, not from render state.** `runs` in
 *    a closure would be one render stale and would stop the loop while a command
 *    was still producing output, so liveness comes back on the poll's own reply;
 *    the only React dependency that restarts the loop is which run is selected.
 * 3. **Output follows the tail only while the operator is at the tail.** Scrolling
 *    up to read something stops the follow and reveals a jump-to-end control.
 *    Auto-scrolling away from what someone is reading is the single most annoying
 *    thing a log pane can do.
 * 4. **Stopping is explicit and idempotent** — and safe on a command that already
 *    exited, because the host's kill is.
 *
 * The panel is rendered through a portal onto `document.body`: it is fixed to the
 * bottom of the viewport, and the frame's grid tracks animate, so it must not live
 * inside them.
 *
 * @module my-sider/client/ShellPanel
 */
import { createPortal } from 'react-dom'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChevronDownOutline14, IconCloseOutline16, IconPauseOutline16,
  IconPlayOutline16, IconRefreshOutline14, IconTrashOutline16, IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ShellRun } from '../shared/wire.ts'
import { killRun, listRuns, pollRun, readContext, startRun } from './api.ts'
import type { NS } from './contract.ts'

/** How often a running command is polled, in milliseconds. */
const POLL_MS = 400

/** How many command lines the input remembers for ArrowUp. */
const HISTORY_LIMIT = 50

/** The persisted panel height, and the bounds a drag may reach. */
export const HEIGHT_KEY = 'my-sider.shell.height'
export const DEFAULT_HEIGHT = 300
export const MIN_HEIGHT = 120
export const MAX_HEIGHT = 900

/** The persisted working-directory override. */
const DIR_KEY = 'my-sider.shell.dir'

/** How close to the bottom still counts as "at the tail", in pixels. */
const TAIL_SLACK = 24

/**
 * Read the persisted panel height.
 *
 * It lives here, beside the key and the bounds it is clamped to, and the launcher
 * calls it: the panel does not persist its own geometry, because a panel that
 * unmounts on close would then have to write before it goes, and a drag that ends
 * after an unmount would be lost.
 * @returns the stored height, or the default.
 */
export function readHeight(): number {
  try {
    const stored = window.localStorage.getItem(HEIGHT_KEY)
    if (stored === null) return DEFAULT_HEIGHT
    const value = Number.parseFloat(stored)
    if (!Number.isFinite(value)) return DEFAULT_HEIGHT
    return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, value))
  } catch {
    // A blocked localStorage is not a reason to lose the panel.
    return DEFAULT_HEIGHT
  }
}

/**
 * Read the persisted working-directory override.
 * @returns the override, or the empty string when there is none.
 */
function readDirOverride(): string {
  try {
    return window.localStorage.getItem(DIR_KEY) ?? ''
  } catch {
    return ''
  }
}

/**
 * Render one run's status as a short label.
 * @param run - the run.
 * @param t - the translator.
 * @returns the label.
 */
function statusOf(run: ShellRun, t: TranslateNS<typeof NS>): string {
  if (run.running) return t('shell.status.running')
  if (run.timedOut) return t('shell.status.timeout')
  if (run.exitCode === 0) return t('shell.status.ok')
  if (run.signal !== null) return t('shell.status.signalled', { signal: run.signal })
  return t('shell.status.failed', { code: String(run.exitCode ?? '?') })
}

/** Props of the bottom command panel. */
export interface ShellPanelProps {
  /** The plugin's translator. */
  readonly t: TranslateNS<typeof NS>
  /** The persisted panel height in px. */
  readonly height: number
  /** The directory the current session's project lives in, when it has one. */
  readonly sessionDir: string | undefined
  /** Report a new height from a drag. */
  readonly onHeight: (height: number) => void
  /** Close the panel. */
  readonly onClose: () => void
}

/**
 * Render the bottom command panel.
 * @param props - the translator, geometry, the session's directory, and the close action.
 * @returns the portal-mounted panel.
 */
export function ShellPanel({ t, height, sessionDir, onHeight, onClose }: ShellPanelProps): ReactNode {
  const [runs, setRuns] = useState<readonly ShellRun[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [output, setOutput] = useState('')
  const [command, setCommand] = useState('')
  const [typed, setTyped] = useState<readonly string[]>([])
  const [recallAt, setRecallAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [following, setFollowing] = useState(true)
  /** The host's own fallback directory, read once on mount. */
  const [hostDir, setHostDir] = useState('')
  /** False once the host reports the command panel switched off in its config. */
  const [enabled, setEnabled] = useState(true)
  const [override, setOverride] = useState(readDirOverride)

  // The directory a command runs in: the operator's explicit choice, else the
  // current session's project, else the directory the host was started in.
  const dir = override !== '' ? override : (sessionDir ?? hostDir)

  // The reader's position, held in refs: the poll loop writes these far more
  // often than the panel should re-render, and a closure over state would be a
  // render behind every time.
  const offset = useRef(0)
  const target = useRef<string | null>(null)
  const pane = useRef<HTMLDivElement | null>(null)
  const heightRef = useRef(height)
  heightRef.current = height

  const current = runs.find(run => run.id === selected) ?? null

  /**
   * Read everything the target run has produced since the held offset.
   * @returns the run's fresh state, or null when nothing is selected.
   */
  const readOnce = useCallback(async (): Promise<ShellRun | null> => {
    const id = target.current
    if (id === null) return null
    const asked = offset.current
    const answer = await pollRun(id, asked)
    // The selection may have moved while this read was open; its answer belongs
    // to a run nobody is looking at any more.
    if (target.current !== id) return null
    if (!answer.ok) {
      setError(answer.error.message)
      return null
    }
    const { run, output: chunk, from, next } = answer.data
    setError(null)
    offset.current = next
    setRuns(previous => previous.map(entry => (entry.id === run.id ? run : entry)))
    if (chunk === '' && from <= asked) return run
    // A `from` past what was asked for is the host saying it dropped those bytes.
    // Saying so where the gap is beats a silently short log.
    const gap = from > asked ? `${t('shell.gap', { bytes: from - asked })}\n` : ''
    setOutput(previous => previous + gap + chunk)
    return run
  }, [t])

  // One poll loop for the whole panel. It re-arms from the ANSWER's liveness, so a
  // stale closure can never stop it early; the only dependency that restarts it is
  // which run is selected.
  useEffect(() => {
    if (selected === null) return
    let cancelled = false
    let timer: number | undefined
    const tick = async (): Promise<void> => {
      const run = await readOnce()
      if (cancelled || run === null) return
      if (run.running) timer = window.setTimeout(() => { void tick() }, POLL_MS)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [readOnce, selected])

  /**
   * Point the reader at one run and load its retained output from the start.
   * @param run - the run to show.
   */
  const select = useCallback((run: ShellRun): void => {
    target.current = run.id
    offset.current = 0
    setSelected(run.id)
    setOutput('')
    setError(null)
    setFollowing(true)
  }, [])

  // Seed from the host: its context (fallback directory, whether this surface is
  // on) and the runs it still holds, newest first. This is what makes the panel
  // survive a reload with its history intact.
  //
  // Both reads are asynchronous, and the operator can already be typing by the
  // time they answer — the panel is usable from its first paint. So the seed
  // MERGES rather than replaces (a late answer must not drop the run the operator
  // just started, nor the output now arriving for it) and only selects a run when
  // nothing is selected yet.
  useEffect(() => {
    void (async () => {
      const context = await readContext()
      if (!context.ok) {
        setError(t('shell.notMounted'))
      } else {
        setHostDir(context.data.dir)
        setEnabled(context.data.enabled)
        if (!context.data.enabled) setError(t('shell.disabled'))
      }
      const answer = await listRuns()
      if (!answer.ok) {
        setError(previous => previous ?? answer.error.message)
        return
      }
      setRuns((previous) => {
        const known = new Map(answer.data.map(run => [run.id, run]))
        // The panel's own list wins for ids it already holds: it is the fresher
        // copy, because the poll loop keeps updating it.
        for (const run of previous) known.set(run.id, run)
        return [...known.values()].sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
      })
      if (target.current === null) {
        const newest = answer.data[0]
        if (newest !== undefined) select(newest)
      }
    })()
    // Once, on mount: the list is maintained afterwards by the runs this panel
    // starts and by each poll's own update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Follow the tail only while the operator is at the tail.
  useEffect(() => {
    const element = pane.current
    if (element === null || !following) return
    element.scrollTop = element.scrollHeight
  }, [output, following])

  /**
   * Persist a working-directory change.
   * @param value - the new directory text.
   */
  const changeDir = (value: string): void => {
    setOverride(value)
    try {
      if (value === '') window.localStorage.removeItem(DIR_KEY)
      else window.localStorage.setItem(DIR_KEY, value)
    } catch {
      // A blocked localStorage is not a reason to lose the change.
    }
  }

  /**
   * Run the typed command line.
   */
  const submit = useCallback(async (): Promise<void> => {
    const line = command.trim()
    if (line === '') return
    setError(null)
    const answer = await startRun(dir, line)
    if (!answer.ok) {
      setError(answer.error.message)
      return
    }
    setCommand('')
    setTyped(previous => [line, ...previous].slice(0, HISTORY_LIMIT))
    setRecallAt(null)
    setRuns(previous => [answer.data, ...previous])
    select(answer.data)
    // Echo the command into the pane, so a run's output reads as a session rather
    // than as a mystery: this buffer is one run, and this is its prompt.
    setOutput(`$ ${line}\n`)
  }, [command, dir, select])

  /**
   * Stop the selected run.
   */
  const stop = useCallback(async (): Promise<void> => {
    const id = target.current
    if (id === null) return
    const answer = await killRun(id)
    if (!answer.ok) {
      setError(answer.error.message)
      return
    }
    setRuns(previous => previous.map(run => (run.id === answer.data.id ? answer.data : run)))
  }, [])

  /**
   * Recall a previously typed line.
   * @param direction - -1 for older, 1 for newer.
   */
  const recall = (direction: -1 | 1): void => {
    if (typed.length === 0) return
    if (recallAt === null) {
      if (direction === 1) return
      setRecallAt(0)
      setCommand(typed[0] ?? '')
      return
    }
    const next = recallAt + direction
    if (next < 0 || next >= typed.length) {
      setRecallAt(null)
      setCommand('')
      return
    }
    setRecallAt(next)
    setCommand(typed[next] ?? '')
  }

  /**
   * Resize the panel from a drag on its top edge.
   * @param event - the pointer-down that started the gesture.
   */
  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const handle = event.currentTarget
    const originY = event.clientY
    const base = heightRef.current
    handle.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent): void => {
      onHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, base + (originY - moveEvent.clientY))))
    }
    const end = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
  }

  const panel = (
    <section data-ms="shellPanel" style={{ height }} aria-label={t('shell.title')}>
      <div
        data-ms="shellResize"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('shell.resize')}
        onPointerDown={startResize}
      />
      <header data-ms="head">
        <span data-ms="title">{t('shell.title')}</span>
        <input
          data-ms="shellDir"
          value={override}
          placeholder={sessionDir ?? hostDir}
          aria-label={t('shell.dir')}
          title={t('shell.dir.hint')}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => { changeDir(event.target.value) }}
        />
        {override !== '' && (
          <button
            type="button"
            data-ms="iconButton"
            aria-label={t('shell.dir.reset')}
            title={t('shell.dir.reset')}
            onClick={() => { changeDir('') }}
          >
            <IconRefreshOutline14 size={13} />
          </button>
        )}
        {current !== null && (
          <span
            data-ms="chip"
            data-tone={current.running ? 'running' : current.exitCode === 0 ? 'ok' : 'failed'}
          >
            {statusOf(current, t)}
          </span>
        )}
        {current?.truncated === true && (
          <span data-ms="chip" data-tone="warn" title={t('shell.truncated.hint')}>{t('shell.truncated')}</span>
        )}
        <span data-ms="chip" data-tone="muted" title={t('shell.mode.hint')}>
          {t('shell.mode', { mode: current?.sandboxMode ?? '—' })}
        </span>
        <span data-ms="spacer" />
        {current?.running === true && (
          <button type="button" data-ms="panelButton" data-tone="danger" onClick={() => { void stop() }}>
            <IconPauseOutline16 size={12} />
            {t('shell.stop')}
          </button>
        )}
        <button
          type="button"
          data-ms="panelButton"
          disabled={output === ''}
          onClick={() => { setOutput('') }}
        >
          <IconTrashOutline16 size={12} />
          {t('shell.clear')}
        </button>
        <button type="button" data-ms="iconButton" aria-label={t('shell.close')} title={t('shell.close')} onClick={onClose}>
          <IconCloseOutline16 size={14} />
        </button>
      </header>

      {runs.length > 0 && (
        <div data-ms="shellRuns" role="tablist" aria-label={t('shell.runs')}>
          {runs.map(run => (
            <button
              key={run.id}
              type="button"
              role="tab"
              data-ms="shellRun"
              aria-selected={run.id === selected}
              data-active={run.id === selected || undefined}
              title={`${run.command} · ${statusOf(run, t)}`}
              onClick={() => { select(run) }}
            >
              <span
                data-ms="shellRunDot"
                data-tone={run.running ? 'running' : run.exitCode === 0 ? 'ok' : 'failed'}
                aria-hidden="true"
              />
              <span data-ms="shellRunText">{run.command}</span>
            </button>
          ))}
        </div>
      )}

      <div
        data-ms="shellPane"
        ref={pane}
        onScroll={(event) => {
          const element = event.currentTarget
          setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < TAIL_SLACK)
        }}
      >
        {error !== null && (
          <div data-ms="shellError" role="status">
            <IconWarningOutline16 size={14} />
            <span>{error}</span>
          </div>
        )}
        {output === '' && (
          <div data-ms="shellNote">
            {current === null ? t('shell.empty') : current.running ? t('shell.waiting') : t('shell.noOutput')}
          </div>
        )}
        {output !== '' && <pre data-ms="shellOut">{output}</pre>}
      </div>

      {!following && output !== '' && (
        <button
          type="button"
          data-ms="shellJump"
          onClick={() => {
            const element = pane.current
            if (element !== null) element.scrollTop = element.scrollHeight
            setFollowing(true)
          }}
        >
          <IconChevronDownOutline14 size={12} />
          {t('shell.jump')}
        </button>
      )}

      <div data-ms="shellInputRow">
        <span data-ms="shellPrompt" aria-hidden="true">$</span>
        <input
          data-ms="shellInput"
          value={command}
          placeholder={t('shell.placeholder')}
          aria-label={t('shell.placeholder')}
          title={t('shell.recall.hint')}
          spellCheck={false}
          autoComplete="off"
          disabled={!enabled}
          onChange={(event) => { setCommand(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submit()
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              recall(-1)
            } else if (event.key === 'ArrowDown') {
              event.preventDefault()
              recall(1)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            }
          }}
        />
        <button
          type="button"
          data-ms="shellRunButton"
          disabled={!enabled || command.trim() === ''}
          onClick={() => { void submit() }}
        >
          <IconPlayOutline16 size={12} />
          {t('shell.run')}
        </button>
      </div>
    </section>
  )

  return createPortal(panel, document.body)
}
