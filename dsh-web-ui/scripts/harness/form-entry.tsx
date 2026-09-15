/**
 * Harness entry for the New Project form (`new-project-form.mjs`).
 *
 * The harness drives the REAL form and the REAL flow — this module is only the
 * glue that mounts them: the flow, so the draft under test is the production one,
 * and the dialog, so the conditional row under test is the production one. The
 * UI primitives arrive as a stub through the bundle's alias (see `tsdown.mjs`).
 *
 * The flow is exposed on `globalThis` because it is a HOOK: the test cannot call
 * it, so it reaches the flow the way the sibling harness (`folder-flow.mjs`)
 * does — render the component and read what the hook published. It is written in
 * `createElement` calls rather than JSX so this file stays a plain module the
 * harness bundler needs no extra option for.
 */
import type { ReactNode } from 'react'
import { createElement as h, useReducer, useRef } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NewProjectDialog } from '../../src/client/NewProjectDialog.tsx'
import type { ShellInjected } from '../../src/client/contract.ts'
import { NS } from '../../src/client/contract.ts'
import { useProjectFlow } from '../../src/client/projectFlow.ts'

/** The translator seat this plugin's copy arrives through. */
type T = TranslateNS<typeof NS>

/**
 * Mount the dialog over the real flow.
 * @param props - the fake host face and the translate seat.
 * @returns the dialog element.
 */
export function NewProjectFormHarness({ injected, t }: {
  injected: ShellInjected
  t: T
}): ReactNode {
  // The flow is a hook, so a re-render is how its state reaches the dialog; this
  // counter exists only so the test can force one after mutating through a
  // reference the render cycle did not hand it.
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const flow = useProjectFlow(injected, t)
  const latest = useRef(flow)
  latest.current = flow
  const globals = globalThis as unknown as { flow?: unknown; bump?: () => void }
  globals.flow = flow
  globals.bump = () => { bump() }

  return h(NewProjectDialog, {
    open: flow.formOpen,
    mode: flow.formMode,
    draft: flow.draft,
    cards: flow.cards,
    onChange: flow.updateDraft,
    onChooseFolder: flow.pickWorkspaceFolder,
    busy: flow.busy,
    pickError: flow.pickError,
    onSubmit: flow.formMode === 'edit' ? flow.submitProjectEdit : flow.submitNewProject,
    onClose: flow.closeForm,
    t,
  })
}
