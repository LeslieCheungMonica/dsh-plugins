/**
 * Offline harness for picking a project in the column's dropdown.
 *
 * The dropdown used to scope the SESSION LIST and nothing else: the main
 * conversation pane kept showing whatever session was open, so switching from
 * project A to project B left B's list beside A's conversation. The fix is that
 * a pick which actually CHANGES the project also opens that project's session
 * (DSH's `startSession`, i.e. the project's blank session, reused when it already
 * has one).
 *
 * Three properties are worth pinning down offline, because each fails quietly:
 *
 * 1. **A change starts a session, in that project.** The id handed to the two
 *    sinks is the PICKED one, not the previous project or the stored scope — a
 *    mix-up here opens a session in the project the operator just left.
 * 2. **A pick of the project already scoped to starts nothing.** Clicking the
 *    current project in the menu is not a move, and leaving the conversation for
 *    a blank one on a mis-click is the failure this rule exists to prevent. The
 *    list is still scoped (the select sink always runs), so the row stays a
 *    scope control rather than becoming an inert one.
 * 3. **The select sink runs FIRST.** The list switches on the click; the session
 *    open resolves asynchronously behind it. Reversing them would leave the
 *    column showing the old project's sessions while the new project's session
 *    loads.
 *
 * The sinks are recorded rather than mocked: the point is the CALLS this
 * decision makes, and the loop it exists to avoid lives one level up (the
 * selection writer `selectProject` is also used by the column's
 * follow-the-current-session effect, so `pickProject` calling `startSession`
 * directly — never from inside that writer — is what keeps opening a session in
 * another project from minting a second one).
 *
 * Usage: pnpm harness:project-pick   (builds the bundle first, then runs this)
 */
const { pickProject } = await import('./out/project-pick.js')

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

/**
 * A pair of sinks that record the calls made against them, in order.
 * @returns the sinks and the call log as `select:<id>` / `startSession:<id>`.
 */
function recorder() {
  const calls = []
  return {
    calls,
    sinks: {
      select: (id) => { calls.push(`select:${id}`) },
      startSession: (id) => { calls.push(`startSession:${id}`) },
    },
  }
}

// 1. The project CHANGES: the list is scoped to the picked project and that
//    project's session opens, in that order, once each.
const moved = recorder()
pickProject('b', 'a', moved.sinks)
check('picking another project scopes the list to it and opens its session there',
  moved.calls.join(' | ') === 'select:b | startSession:b', moved.calls.join(' | '))

// 2. A pick of the CURRENT project is not a move: the list is re-scoped (the
//    click stays a click) and the conversation is left alone.
const same = recorder()
pickProject('a', 'a', same.sinks)
check('picking the project already scoped to starts no session',
  same.calls.join(' | ') === 'select:a', same.calls.join(' | '))

// 3. No project scoped yet (an empty registry, or a stored id that no longer
//    resolves): the first pick is a move like any other.
const first = recorder()
pickProject('a', undefined, first.sinks)
check('with no project scoped yet, the first pick opens its session',
  first.calls.join(' | ') === 'select:a | startSession:a', first.calls.join(' | '))

// 4. Order and target are properties of the DECISION, not of one branch: on
//    every changing pick the select sink runs first and both sinks carry the
//    picked project.
const changing = [['b', 'a'], ['a', undefined], ['workspace-7', 'workspace-3']]
  .map(([picked, current]) => {
    const log = recorder()
    pickProject(picked, current, log.sinks)
    return { picked, log }
  })
check('the list is scoped before the session opens, for the picked project, on every changing pick',
  changing.every(({ picked, log }) => log.calls.length === 2
    && log.calls[0] === `select:${picked}`
    && log.calls[1] === `startSession:${picked}`),
  changing.map(({ log }) => log.calls.join(' | ')).join(' ; '))

let failed = 0
for (const entry of results) {
  if (!entry.ok) failed += 1
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name}${entry.detail === '' ? '' : `\n      ${entry.detail}`}`)
}
console.log(failed === 0 ? `\n${String(results.length)} checks passed` : `\n${String(failed)} of ${String(results.length)} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
