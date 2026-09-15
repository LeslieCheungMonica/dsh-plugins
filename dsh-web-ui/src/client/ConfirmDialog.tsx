/**
 * Destructive-action confirmation.
 *
 * Deleting a project is not undoable from this column, so the destructive row in
 * the project menu opens this dialog instead of acting directly. The button that
 * confirms is a primary (not a danger-styled) button on purpose: the dialog's
 * text carries the warning, and a red button in a two-choice dialog reads as the
 * default action.
 */
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Render a confirmation dialog.
 * @param props - copy, the action, and the two exits.
 * @returns the dialog element.
 */
export function ConfirmDialog({ open, title, message, confirmLabel, cancelLabel, busy, onConfirm, onClose }: {
  open: boolean
  title: string
  /** Body copy; a plain sentence is enough. */
  message: string
  confirmLabel: string
  cancelLabel: string
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}): ReactNode {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={cancelLabel}
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>{cancelLabel}</Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      )}
    >
      <p data-wui="confirmBody">{message}</p>
    </Modal>
  )
}
