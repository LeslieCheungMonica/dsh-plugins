/**
 * The git button in the session header's right-hand utilities, and the drawer it
 * opens.
 *
 * The seat is `conversation.session.header.utilities` — the right-aligned
 * utility group the shipped conversation header renders beside the title. It is
 * an ADDITIVE list seat, so this plugin adds a control without taking anything
 * over: the shipped session-log button stays exactly where it was, and this one
 * sits beside it.
 *
 * The repository is resolved from the CURRENT session's project: DSH has no
 * host-side "active workspace", so the directory comes from the workspace whose
 * account lists this session. With no project resolved there is nothing to
 * inspect, and the button stays disabled with the reason on its tooltip rather
 * than opening a drawer that can only say "no directory".
 *
 * @module dsh-web-ui/client/GitAction
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { IconBranchOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { NS } from './contract.ts'
import { GitPanel } from './GitPanel.tsx'

/** Full props of the session-header git action. */
export type GitActionProps =
  & PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof NS>

/**
 * Render the git header button and, while it is open, the drawer.
 * @param props - the session kit plus the namespace translator.
 * @returns the header control and its portal-mounted drawer.
 */
export function GitAction({ sessionId, useWorkspaces, t }: GitActionProps): ReactNode {
  const [open, setOpen] = useState(false)
  const workspaces = useWorkspaces(state => state.items)

  // The current session's project: the workspace whose account lists it. A
  // session that is not accounted under any workspace has no directory to
  // inspect, which is a real state (an ungrouped session) and not an error.
  const dir = useMemo((): string | undefined =>
    workspaces.find(workspace => workspace.sessionIds.includes(sessionId))?.path,
  [sessionId, workspaces])

  const label = dir === undefined ? t('git.empty.project') : t('git.open')

  return (
    <>
      <Tooltip label={label} delayMs={400}>
        <button
          type="button"
          data-wui="gitHeaderButton"
          aria-label={label}
          aria-expanded={open}
          aria-disabled={dir === undefined || undefined}
          disabled={dir === undefined}
          onClick={() => { setOpen(value => !value) }}
        >
          <IconBranchOutline16 size={14} />
          <span data-wui="gitHeaderLabel">{t('git.title')}</span>
        </button>
      </Tooltip>
      {open && dir !== undefined && (
        <GitPanel dir={dir} t={t} onClose={() => { setOpen(false) }} />
      )}
    </>
  )
}
