/**
 * The bottom panel, shaped like the terminal it stands in for: one continuous
 * scrollback with a live prompt at its foot.
 *
 * It is a **command panel, not a terminal emulator** — one command line at a time,
 * no pty, no full-screen curses programs, no interactive prompt — and that scope is
 * stated rather than pretended away: the header shows the directory and the file
 * policy each command actually ran under. But the PRESENTATION is the terminal's,
 * because a separate "input box + Run button" asks the operator to translate
 * between two places: commands are typed where they are read, after the prompt,
 * and the answer appears under them.
 *
 * Five behaviours carry the component:
 *
 * 1. **The reader owns its offset.** Every poll sends the byte offset already
 *    rendered and appends what followed. A reload, a remount, or a slow frame
 *    therefore resumes exactly where it was, and the host is never asked to
 *    remember which browser saw what. When the host has had to drop the front of
 *    a run's buffer it answers from a LATER offset than it was asked for, and the
 *    transcript prints a gap line there instead of pretending the output is whole.
 * 2. **One transcript, in the order it happened.** Every run the host still holds
 *    is drawn as its own block — the command that was typed, then its output — and
 *    the blocks are ordered oldest first, so the panel reads top to bottom like a
 *    session. Nothing is re-ordered to put "the interesting one" first: an operator
 *    who ran a command two commands ago finds it where they left it.
 * 3. **The prompt is the input.** The last line of the transcript is the prompt
 *    itself (`…/project $`), and the caret sits in it as the panel opens. Commands
 *    run on Enter; there is no second control to find.
 * 4. **Commands are serialized, because the panel cannot queue them.** There is no
 *    pty behind this: a second command started while the first runs would interleave
 *    two live streams in one transcript. So the prompt is disabled for the duration
 *    of a run and says so, and liveness comes back when the run settles.
 * 5. **Output follows the tail only while the operator is at the tail.** Scrolling
 *    up to read something stops the follow and reveals a jump-to-end control.
 *    Auto-scrolling away from what someone is reading is the single most annoying
 *    thing a log pane can do.
 *
 * ## Where it runs, said out loud
 *
 * The panel opens IN the current session's project: the directory field carries that
 * path as its own value rather than as a grey placeholder, and the prompt repeats it,
 * so "where does this command land?" is answered before anything is typed. Editing
 * the DIRECTORY is the deliberate act (an override, resettable), not a prerequisite.
 *
 * The panel is rendered through a portal onto `document.body`: it is fixed to the
 * bottom of the viewport, and the frame's grid tracks animate, so it must not live
 * inside them. It does not float OVER the page either — the launcher publishes the
 * panel's height and the plugin's stylesheet takes it out of the mount node, which
 * is what makes this a split rather than a cover.
 *
 * @module my-sider/client/ShellPanel
 */
import { createPortal } from 'react-dom'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChevronDownOutline14, IconCloseOutline16, IconPauseOutline16,
  IconRefreshOutline14, IconTrashOutline16, IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ShellRun } from '../shared/wire.ts'
import { killRun, listRuns, pollRun, readContext, startRun } from './api.ts'
import { fromInputMethod } from './inputmethod.ts'
import type { NS } from './contract.ts'

/** How often a running command is polled, in milliseconds. */
const POLL_MS = 400

/** How many command lines the prompt remembers for ArrowUp. */
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
 * How much of the directory the prompt shows: its last two segments.
 *
 * A prompt is a place-marker, not a path listing — the full path is in the
 * directory field, one line up, and in the prompt's own `title`. Two segments
 * (`…/dsh-plugins/my-sider`) fit beside the command line at any depth, where the
 * full path would push the caret's room off the row.
 */
const PROMPT_SEGMENTS = 2

/**
 * Shorten a directory to its last {@link PROMPT_SEGMENTS} segments.
 * @param dir - the absolute directory.
 * @returns the tail, with a leading ellipsis when anything was dropped.
 */
export function promptDir(dir: string): string {
  const segments = dir.split('/').filter(segment => segment !== '')
  if (segments.length <= PROMPT_SEGMENTS) return dir
  return `…/${segments.slice(-PROMPT_SEGMENTS).join('/')}`
}

/**
 * The attribute the panel sets on `<html>` while its top edge is being dragged.
 *
 * The reserve this plugin takes from the mount node is eased when the panel opens
 * and closes, but a drag writes it at pointer cadence — easing that would detach
 * the page from the handle. The stylesheet reads this attribute to turn the
 * transition off, the same way the frame's own columns do.
 */
const DRAGGING_ATTRIBUTE = 'data-ms-dragging'

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

/**
 * Render a run's duration the way a shell reports it.
 * @param ms - wall-clock milliseconds.
 * @returns `840ms`, or `2.4s` once it is worth saying in seconds.
 */
function formatDuration(ms: number): string {
  return ms < 1000 ? `${String(Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** The tone of a settled run's status line, keyed to how it ended. */
function toneOf(run: ShellRun): string {
  if (run.running) return 'running'
  return run.exitCode === 0 && !run.timedOut ? 'ok' : 'failed'
}

/**
 * How many empty prompt lines the panel keeps.
 *
 * They are this browser's own (the host has no record of a line that ran nothing), so
 * they live in this component's state and a reload forgets them — which is also what a
 * terminal does when you reconnect. The cap only stops a mashed Enter key from growing
 * the list without bound.
 */
const BLANK_LIMIT = 200

/** One line of the transcript: a command that ran, or a prompt line that ran nothing. */
interface TranscriptLine {
  /** Stable React key. */
  readonly key: string
  /** Where the line sorts: when it happened. */
  readonly at: number
  /** The run this line reports, or null for an empty prompt line. */
  readonly run: ShellRun | null
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
  /** Every run the panel knows, newest first (the host's own order). */
  const [runs, setRuns] = useState<readonly ShellRun[]>([])
  /** What has been rendered of each run's output, by run id. */
  const [chunks, setChunks] = useState<Readonly<Record<string, string>>>({})
  const [command, setCommand] = useState('')
  /** Empty prompt lines, in the order they were pressed (see {@link BLANK_LIMIT}). */
  const [blankLines, setBlankLines] = useState<readonly { id: number; at: number }[]>([])
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
  // current session's project, else the directory the host was started in. The
  // default is also what the field compares an edit against (see `changeDir`), so
  // it is named rather than inlined.
  const fallbackDir = sessionDir ?? hostDir
  const dir = override !== '' ? override : fallbackDir

  // The reader's positions, held in refs: the poll loop writes these far more
  // often than the panel should re-render, and a closure over state would be a
  // render behind every time. One entry per run, because the transcript reads from
  // whichever run is live and keeps the others where they stopped.
  const offsets = useRef(new Map<string, number>())
  /** The runs whose entries `clear` took off the screen (see `clear`). */
  const cleared = useRef(new Set<string>())
  const pane = useRef<HTMLDivElement | null>(null)
  const commandLine = useRef<HTMLInputElement | null>(null)
  /** Identity of empty prompt lines, so two in the same millisecond stay distinct. */
  const blankSeq = useRef(0)
  const heightRef = useRef(height)
  heightRef.current = height

  // At most one command runs at a time (see the module note): the newest live run
  // is the one the prompt waits for, and the one worth polling.
  const live = runs.find(run => run.running) ?? null
  const newest = runs[0] ?? null
  /** What the header and the pane report about the session's progress. */
  const current = live ?? newest
  // `enabled` is the host's switch; a live run is this panel's own reason to keep
  // the prompt shut, and the reason is stated in the prompt's own placeholder.
  const busy = live !== null

  /**
   * Append one poll answer to a run's entry.
   * @param id - the run the answer belongs to.
   * @param asked - the offset the read was issued from.
   * @param answer - the run's fresh state, its new text, and where it starts.
   */
  const absorb = useCallback((id: string, asked: number, answer: { run: ShellRun; output: string; from: number; next: number }): void => {
    const { run, output: chunk, from, next } = answer
    offsets.current.set(id, next)
    setRuns(previous => previous.map(entry => (entry.id === id ? run : entry)))
    if (chunk === '' && from <= asked) return
    // A `from` past what was asked for is the host saying it dropped those bytes.
    // Saying so where the gap is beats a silently short log.
    const gap = from > asked ? `${t('shell.gap', { bytes: from - asked })}\n` : ''
    setChunks(previous => ({ ...previous, [id]: (previous[id] ?? '') + gap + chunk }))
  }, [t])

  /**
   * Read one run's output since the offset the panel holds for it.
   * @param id - the run to read.
   * @returns the run's fresh state, or null when the read failed.
   */
  const readOnce = useCallback(async (id: string): Promise<ShellRun | null> => {
    const asked = offsets.current.get(id) ?? 0
    const answer = await pollRun(id, asked)
    if (!answer.ok) {
      setError(answer.error.message)
      return null
    }
    setError(null)
    absorb(id, asked, answer.data)
    return answer.data.run
  }, [absorb])

  // One poll loop for the panel, watching the live run. It re-arms from the
  // ANSWER's liveness rather than from render state, so a stale closure can never
  // stop it while a command is still producing output.
  useEffect(() => {
    if (live === null) return
    const id = live.id
    let cancelled = false
    let timer: number | undefined
    const tick = async (): Promise<void> => {
      const run = await readOnce(id)
      if (cancelled || run === null) return
      if (run.running) timer = window.setTimeout(() => { void tick() }, POLL_MS)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [live, readOnce])

  // Seed from the host: its context (fallback directory, whether this surface is
  // on) and the runs it still holds — then read each of those runs' retained output
  // from its start, oldest first, so the transcript is whole and in order when the
  // panel opens rather than growing as the operator pokes at it.
  //
  // Both reads are asynchronous, and the operator can already be typing by the time
  // they answer — the prompt is live from the first paint. So the seed MERGES
  // rather than replaces (a late answer must not drop the run the operator just
  // started, nor the output now arriving for it), and a run the panel already read
  // from is left alone.
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
      // Oldest first: the transcript reads in the order the commands were run, and
      // the live run (if the host still has one) is drained up to now before the
      // poll loop takes over from the offset this leaves behind.
      for (const run of [...answer.data].reverse()) {
        if (offsets.current.has(run.id)) continue
        await readOnce(run.id)
      }
    })()
    // Once, on mount: the list is maintained afterwards by the runs this panel
    // starts and by each poll's own update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Follow the tail only while the operator is at the tail. An empty prompt line moves
  // the tail too, so it counts as new content here.
  useEffect(() => {
    const element = pane.current
    if (element === null || !following) return
    element.scrollTop = element.scrollHeight
  }, [chunks, blankLines, following])

  // The panel is opened by a click, and the next thing wanted is a command: take
  // the caret on mount, so opening and typing are one gesture. A panel the host has
  // switched off has nothing to type into, so its disabled prompt keeps the
  // keyboard.
  useEffect(() => {
    if (enabled) commandLine.current?.focus()
  }, [enabled])

  /**
   * Persist a working-directory change.
   *
   * Text equal to the directory a command would ALREADY use with no override is
   * not an override — it is the default, and storing it would pin a path the
   * current session is free to move away from. Comparing against the DEFAULT (not
   * the effective value) also keeps an edit that lands on the current override
   * from silently dropping it.
   * @param value - the new directory text.
   */
  const changeDir = (value: string): void => {
    const next = value === fallbackDir ? '' : value
    setOverride(next)
    try {
      if (next === '') window.localStorage.removeItem(DIR_KEY)
      else window.localStorage.setItem(DIR_KEY, next)
    } catch {
      // A blocked localStorage is not a reason to lose the change.
    }
  }

  /**
   * Take the line the operator just ended, the way Enter does in a shell.
   *
   * A line with nothing to run is still a line: a shell reprints its prompt and waits,
   * which is the only acknowledgement an empty Enter can honestly give — silence looks
   * exactly like a panel that never heard the key. So an empty (or whitespace-only)
   * line leaves a prompt line behind and starts nothing; a real line runs.
   */
  const submit = useCallback(async (): Promise<void> => {
    // The prompt is disabled while a run is live or the host has switched the panel
    // off, so no Enter reaches here in those states; the guard is for the paths that
    // do not come from the keyboard.
    if (busy || !enabled) return
    const line = command.trim()
    if (line === '') {
      blankSeq.current += 1
      const blank = { id: blankSeq.current, at: Date.now() }
      setBlankLines(previous => [...previous, blank].slice(-BLANK_LIMIT))
      setCommand('')
      setFollowing(true)
      return
    }
    setError(null)
    const answer = await startRun(dir, line)
    if (!answer.ok) {
      setError(answer.error.message)
      return
    }
    setCommand('')
    setTyped(previous => [line, ...previous].slice(0, HISTORY_LIMIT))
    setRecallAt(null)
    // The run's own record carries the command line, so the transcript's `$ line`
    // is drawn from it rather than stored beside it (see the render below).
    offsets.current.set(answer.data.id, 0)
    setRuns(previous => [answer.data, ...previous])
    setFollowing(true)
  }, [busy, command, dir, enabled])

  /**
   * Stop the live run.
   */
  const stop = useCallback(async (): Promise<void> => {
    if (live === null) return
    const answer = await killRun(live.id)
    if (!answer.ok) {
      setError(answer.error.message)
      return
    }
    setRuns(previous => previous.map(run => (run.id === answer.data.id ? answer.data : run)))
  }, [live])

  /**
   * Empty the screen, the way `clear` does in a shell: the finished commands come
   * off the transcript, and a command still running keeps its place and keeps
   * printing — the panel is a view of the host's runs, not their owner, so their
   * output is not thrown away, only taken off this screen (and a reload brings the
   * host's own history back).
   */
  const clear = (): void => {
    for (const run of runs) if (!run.running) cleared.current.add(run.id)
    setChunks({})
    setBlankLines([])
    // The live run keeps its echo line but starts over visually: re-anchoring its
    // read offset at what it has already produced is what stops the dropped text
    // from being re-read on the next poll.
    if (live !== null) offsets.current.set(live.id, live.bytes)
  }

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
    const html = document.documentElement
    handle.setPointerCapture(event.pointerId)
    // The reserve follows this drag in real time; the stylesheet eases it on open
    // and close, and this attribute is what suspends the easing for the gesture.
    html.setAttribute(DRAGGING_ATTRIBUTE, '')
    const move = (moveEvent: PointerEvent): void => {
      onHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, base + (originY - moveEvent.clientY))))
    }
    const end = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      html.removeAttribute(DRAGGING_ATTRIBUTE)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
  }

  // The transcript, oldest first — the order things actually happened. Runs arrive from
  // the host with the moment they started; empty prompt lines are this browser's own
  // and carry the moment Enter was pressed, so the two interleave where they belong
  // rather than collecting at one end.
  const transcript = useMemo(() => {
    const lines: TranscriptLine[] = []
    for (const run of runs) {
      if (cleared.current.has(run.id)) continue
      lines.push({ key: run.id, at: Date.parse(run.startedAt), run })
    }
    for (const blank of blankLines) {
      lines.push({ key: `blank-${String(blank.id)}`, at: blank.at, run: null })
    }
    return lines.sort((left, right) => left.at - right.at)
  }, [runs, blankLines])

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
          value={override !== '' ? override : dir}
          placeholder={t('shell.dir')}
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
          <span data-ms="chip" data-tone={toneOf(current)}>{statusOf(current, t)}</span>
        )}
        {current?.truncated === true && (
          <span data-ms="chip" data-tone="warn" title={t('shell.truncated.hint')}>{t('shell.truncated')}</span>
        )}
        <span data-ms="chip" data-tone="muted" title={t('shell.mode.hint')}>
          {t('shell.mode', { mode: current?.sandboxMode ?? '—' })}
        </span>
        <span data-ms="spacer" />
        {busy && (
          <button type="button" data-ms="panelButton" data-tone="danger" onClick={() => { void stop() }}>
            <IconPauseOutline16 size={12} />
            {t('shell.stop')}
          </button>
        )}
        <button
          type="button"
          data-ms="panelButton"
          disabled={transcript.length === 0}
          onClick={clear}
        >
          <IconTrashOutline16 size={12} />
          {t('shell.clear')}
        </button>
        <button type="button" data-ms="iconButton" aria-label={t('shell.close')} title={t('shell.close')} onClick={onClose}>
          <IconCloseOutline16 size={14} />
        </button>
      </header>

      <div
        data-ms="shellPane"
        ref={pane}
        role="log"
        aria-label={t('shell.title')}
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

        {transcript.map(line => (line.run === null ? (
          /* A line with nothing on it: the prompt the operator ended, reprinted where
             they ended it. Decorative — it carries no command and no output, and the
             prompt field below is already the thing that takes the next one. */
          <div key={line.key} data-ms="shellBlank" aria-hidden="true">
            <span data-ms="shellEchoMark">$</span>
          </div>
        ) : (
          <div key={line.key} data-ms="shellEntry" data-run={line.run.id}>
            {/* The echo comes from the run's own record, so a command the host
                still remembers reads the same whether this panel started it or
                found it after a reload. The space after the mark is REAL text, not
                a layout gap: `$ cmd` is what a shell prints, and what a copy of
                the line should give back. */}
            <div data-ms="shellEcho">
              <span data-ms="shellEchoMark" aria-hidden="true">$</span>{' '}
              <span data-ms="shellEchoText">{line.run.command}</span>
            </div>
            {(chunks[line.run.id] ?? '') !== '' && <pre data-ms="shellOut">{chunks[line.run.id]}</pre>}
            {!line.run.running && (
              <div data-ms="shellStatus" data-tone={toneOf(line.run)}>
                {statusOf(line.run, t)} · {formatDuration(line.run.durationMs)}
              </div>
            )}
          </div>
        )))}

        {/* The prompt IS the input: the last line of the transcript, where the next
            command is typed, with nothing else to click. */}
        <div data-ms="shellPromptLine">
          <span data-ms="shellPrompt" title={dir} aria-hidden="true">
            <span data-ms="shellPromptDir">{promptDir(dir)}</span>
            <span data-ms="shellPromptMark">$</span>
          </span>
          <input
            data-ms="shellInput"
            ref={commandLine}
            value={command}
            placeholder={busy ? t('shell.waiting') : t('shell.placeholder')}
            aria-label={t('shell.placeholder')}
            title={busy ? t('shell.waiting') : t('shell.recall.hint')}
            spellCheck={false}
            autoComplete="off"
            disabled={!enabled || busy}
            onChange={(event) => { setCommand(event.target.value) }}
            onKeyDown={(event) => {
              // The input method's own keys are the input method's to handle (see
              // fromInputMethod): an Enter mid-composition must commit, not run.
              if (fromInputMethod(event)) return
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
        </div>
      </div>

      {!following && transcript.length > 0 && (
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
    </section>
  )

  return createPortal(panel, document.body)
}
