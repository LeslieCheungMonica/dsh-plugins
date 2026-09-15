/**
 * One-field prompt dialog: rename a session, rename a project.
 *
 * Kept as its own component because both the column header and the session list
 * need an inline text commit, and the alternative — window.prompt — is not
 * available in a WKWebView, which is exactly what the desktop shell embeds.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Render a text prompt.
 * @param props - copy, initial value, and the commit callback.
 * @returns the dialog element.
 */
export function TextPromptDialog({ open, title, label, initialValue, confirmLabel, cancelLabel, busy, onSubmit, onClose }: {
  open: boolean
  title: string
  /** Placeholder and aria label of the field. */
  label: string
  initialValue: string
  confirmLabel: string
  cancelLabel: string
  busy: boolean
  onSubmit: (value: string) => void
  onClose: () => void
}): ReactNode {
  const [value, setValue] = useState(initialValue)

  // Re-seed on open: the dialog stays mounted between uses, so a stale draft
  // from the previous target would otherwise be committed to the next one.
  useEffect(() => {
    if (open) setValue(initialValue)
  }, [initialValue, open])

  const trimmed = value.trim()

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={cancelLabel}
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>{cancelLabel}</Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || trimmed === ''}
            onClick={() => { onSubmit(trimmed) }}
          >
            {confirmLabel}
          </Button>
        </>
      )}
    >
      <Input
        autoFocus
        value={value}
        placeholder={label}
        aria-label={label}
        onChange={(event) => { setValue(event.target.value) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && trimmed !== '') onSubmit(trimmed)
        }}
      />
    </Modal>
  )
}
