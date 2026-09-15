/**
 * The bottom command bar: run a command line in the current project, watch its
 * output, stop it, and keep the last few runs around.
 *
 * It is a **command bar, not a terminal emulator**: one command at a time, no
 * pty, no full-screen curses programs, no interactive prompt. That scope is
 * deliberate, and the UI states it rather than pretending otherwise — the input
 * is a command LINE, and the header shows the sandbox mode the commands actually
 * run under.
 *
 * Four behaviours carry the component:
 *
 * 1. **The reader owns its offset.** Every poll sends the byte offset already
 *    rendered and appends what followed. A reload, a remount, or a slow frame
 *    therefore resumes exactly where it was, and the host is never asked to
 *    remember which browser saw what. When the host has had to drop the front of
 *    a run's buffer it answers from a LATER offset than it was asked for, and
 *    the panel prints a gap line there instead of pretending the output is whole.
 * 2. **The poll loop re-arms from the answer, not from render state.** `runs`
 *    in a closure would be one render stale and would stop the loop while a
 *    command was still producing output, so liveness comes back on the poll's
 *    own reply; the only React dependency that restarts the loop is which run is
 *    selected.
 * 3. **Output follows the tail only while the operator is at the tail.**
 *    Scrolling up to read something stops the follow and reveals a jump-to-end
 *    control. Auto-scrolling away from what someone is reading is the single
 *    most annoying thing a log pane can do.
 * 4. **Stopping is explicit and idempotent** — and safe on a command that
 *    already exited, because the host's kill is.
 *
 * The panel is rendered through a portal onto `document.body`: it is fixed to
 * the bottom of the viewport, and the frame's grid tracks animate, so it must
 * not live inside them.
 *
 * @module dsh-web-ui/client/TerminalBar
 */
import { createPortal } from 'react-dom'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChevronDownOutline14, IconCloseOutline16, IconPauseOutline16,
  IconPlayOutline16, IconTrashOutline16, IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { TermRun } from '../shared/termwire.ts'
import type { NS } from './contract.ts'
import { killRun, listRuns, pollRun, startRun } from './termapi.ts'

/** How often a running command is polled, in milliseconds. */
const POLL_MS = 400

/** How many command lines the input remembers for ArrowUp. */
const HISTORY_LIMIT = 50

/** The persisted panel height, and the bounds a drag may reach. */
const HEIGHT_KEY = 'dsh-web-ui.terminal.height'
const DEFAULT_HEIGHT = 260
const MIN_HEIGHT = 120
const MAX_HEIGHT = 900

/** How close to the bottom still counts as "at the tail", in pixels. */
const TAIL_SLACK = 24

/**
 * Read the persisted panel height.
 * @returns the stored height, or the default.
 */
function readHeight(): number {
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

/** Props of the command bar. */
export interface TerminalBarProps {
  /** The plugin's translator. */
  readonly t: TranslateNS<typeof NS>
  /** The directory commands run in: the current session's project. */
  readonly dir: string
  /** Close the bar. */
  readonly onClose: () => void
}

/**
 * Render one run's status as a short label.
 * @param run - the run.
 * @param t - the translator.
 * @returns the label.
 */
function statusOf(run: TermRun, t: TranslateNS<typeof NS>): string {
  if (run.running) return t('term.status.running')
  if (run.timedOut) return t('term.status.timeout')
  if (run.exitCode === 0) return t('term.status.ok')
  if (run.signal !== null) return t('term.status.signalled', { signal: run.signal })
  return t('term.status.failed', { code: String(run.exitCode ?? '?') })
}

/**
 * Render the bottom command bar.
 * @param props - the translator, the directory, and the close action.
 * @returns the portal-mounted panel.
 */
export function TerminalBar({ t, dir, onClose }: TerminalBarProps): ReactNode {
  const [runs, setRuns] = useState<readonly TermRun[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [output, setOutput] = useState('')
  const [command, setCommand] = useState('')
  const [typed, setTyped] = useState<readonly string[]>([])
  const [recallAt, setRecallAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [height, setHeight] = useState(readHeight)
  const [following, setFollowing] = useState(true)

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
  const readOnce = useCallback(async (): Promise<TermRun | null> => {
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
    // A `from` past what was asked for is the host saying it dropped those
    // bytes. Saying so where the gap is beats a silently short log.
    const gap = from > asked ? `${t('term.gap', { bytes: from - asked })}\n` : ''
    setOutput(previous => previous + gap + chunk)
    return run
  }, [t])

  // One poll loop for the whole panel. It re-arms from the ANSWER's liveness, so
  // a stale closure can never stop it early; the only dependency that restarts
  // it is which run is selected.
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
  const select = useCallback((run: TermRun): void => {
    target.current = run.id
    offset.current = 0
    setSelected(run.id)
    setOutput('')
    setError(null)
    setFollowing(true)
  }, [])

  // Seed from the host: the runs it still holds, newest first. This is what
  // makes the panel survive a reload with its history intact.
  useEffect(() => {
    void (async () => {
      const answer = await listRuns()
      if (!answer.ok) {
        setError(answer.error.message)
        return
      }
      setRuns(answer.data)
      const newest = answer.data[0]
      if (newest !== undefined) select(newest)
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
    // Echo the command into the pane, so a run's output reads as a session
    // rather than as a mystery: this buffer is one run, and this is its prompt.
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
    const baseHeight = heightRef.current
    handle.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent): void => {
      setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, baseHeight + (originY - moveEvent.clientY))))
    }
    const end = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      try {
        // The ref, not the captured `height`: the state has moved since the
        // gesture began, and persisting the start value would forget the drag.
        window.localStorage.setItem(HEIGHT_KEY, String(heightRef.current))
      } catch {
        // A blocked localStorage is not a reason to lose the resize.
      }
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
  }

  const panel = (
    <section data-wui="termPanel" style={{ height }} aria-label={t('term.title')}>
      <div
        data-wui="termResize"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('term.resize')}
        onPointerDown={startResize}
      />
      <header data-wui="termHead">
        <span data-wui="termTitle">{t('term.title')}</span>
        <span data-wui="termDir" title={dir}>{dir}</span>
        {current !== null && (
          <span
            data-wui="termChip"
            data-tone={current.running ? 'running' : current.exitCode === 0 ? 'ok' : 'failed'}
          >
            {statusOf(current, t)}
          </span>
        )}
        {current?.truncated === true && (
          <span data-wui="termChip" data-tone="warn" title={t('term.truncated.hint')}>{t('term.truncated')}</span>
        )}
        <span data-wui="termChip" data-tone="muted" title={t('term.mode.hint')}>
          {t('term.mode', { mode: current?.sandboxMode ?? '—' })}
        </span>
        <span data-wui="termSpacer" />
        {current?.running === true && (
          <button type="button" data-wui="termButton" data-tone="danger" onClick={() => { void stop() }}>
            <IconPauseOutline16 size={12} />
            {t('term.stop')}
          </button>
        )}
        <button
          type="button"
          data-wui="termButton"
          disabled={output === ''}
          onClick={() => { setOutput('') }}
        >
          <IconTrashOutline16 size={12} />
          {t('term.clear')}
        </button>
        <button type="button" data-wui="iconButton" aria-label={t('term.close')} onClick={onClose}>
          <IconCloseOutline16 size={14} />
        </button>
      </header>

      {runs.length > 0 && (
        <div data-wui="termRuns" role="tablist" aria-label={t('term.runs')}>
          {runs.map(run => (
            <button
              key={run.id}
              type="button"
              role="tab"
              data-wui="termRun"
              aria-selected={run.id === selected}
              data-active={run.id === selected || undefined}
              title={`${run.command} · ${statusOf(run, t)}`}
              onClick={() => { select(run) }}
            >
              <span
                data-wui="termRunDot"
                data-tone={run.running ? 'running' : run.exitCode === 0 ? 'ok' : 'failed'}
                aria-hidden="true"
              />
              <span data-wui="termRunText">{run.command}</span>
            </button>
          ))}
        </div>
      )}

      <div
        data-wui="termPane"
        ref={pane}
        onScroll={(event) => {
          const element = event.currentTarget
          setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < TAIL_SLACK)
        }}
      >
        {error !== null && (
          <div data-wui="termError" role="status">
            <IconWarningOutline16 size={14} />
            <span>{error}</span>
          </div>
        )}
        {output === '' && error === null && (
          <div data-wui="termNote">
            {current === null ? t('term.empty') : current.running ? t('term.waiting') : t('term.noOutput')}
          </div>
        )}
        {output !== '' && <pre data-wui="termOut">{output}</pre>}
      </div>

      {!following && (
        <button
          type="button"
          data-wui="termJump"
          onClick={() => {
            const element = pane.current
            if (element !== null) element.scrollTop = element.scrollHeight
            setFollowing(true)
          }}
        >
          <IconChevronDownOutline14 size={12} />
          {t('term.jump')}
        </button>
      )}

      <div data-wui="termInputRow">
        <span data-wui="termPrompt" aria-hidden="true">$</span>
        <input
          data-wui="termInput"
          value={command}
          placeholder={t('term.placeholder')}
          aria-label={t('term.placeholder')}
          spellCheck={false}
          autoComplete="off"
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
          data-wui="termRunButton"
          disabled={command.trim() === ''}
          onClick={() => { void submit() }}
        >
          <IconPlayOutline16 size={12} />
          {t('term.run')}
        </button>
      </div>
    </section>
  )

  return createPortal(panel, document.body)
}
