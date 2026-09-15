/**
 * One-field prompt dialog: rename a session, rename a project.
 *
 * Kept as its own component because both the column header and the session list
 * need an inline text commit, and the alternative — window.prompt — is not
 * available in a WKWebView, which is exactly what the desktop shell embeds.
 *
 * An OPTIONAL second field exists for the one git dialog that genuinely has two
 * inputs (a new branch's name and its start point). It is off unless a caller
 * passes `second`, so the single-field dialogs this plugin already renders keep
 * their exact behaviour and their one-keystroke commit.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

/** The optional second field of a prompt. */
export interface PromptSecondField {
  /** Placeholder and aria label of the second field. */
  readonly label: string
  /** Value the field starts with. */
  readonly initialValue: string
  /** Whether the field's content is required to submit. */
  readonly required?: boolean
}

/**
 * Render a text prompt.
 * @param props - copy, initial value, and the commit callback.
 * @returns the dialog element.
 */
export function TextPromptDialog({ open, title, label, initialValue, second, confirmLabel, cancelLabel, busy, onSubmit, onClose }: {
  open: boolean
  title: string
  /** Placeholder and aria label of the field. */
  label: string
  initialValue: string
  /** The optional second field; the dialog stays one-field without it. */
  second?: PromptSecondField
  confirmLabel: string
  cancelLabel: string
  busy: boolean
  onSubmit: (value: string, second: string) => void
  onClose: () => void
}): ReactNode {
  const [value, setValue] = useState(initialValue)
  const [extra, setExtra] = useState(second?.initialValue ?? '')

  // Re-seed on open: the dialog stays mounted between uses, so a stale draft
  // from the previous target would otherwise be committed to the next one.
  useEffect(() => {
    if (open) {
      setValue(initialValue)
      setExtra(second?.initialValue ?? '')
    }
  }, [initialValue, open, second])

  const trimmed = value.trim()
  const extraTrimmed = extra.trim()
  const ready = trimmed !== '' && (second?.required !== true || extraTrimmed !== '')

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
            disabled={busy || !ready}
            onClick={() => { onSubmit(trimmed, extraTrimmed) }}
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
          if (event.key === 'Enter' && ready) onSubmit(trimmed, extraTrimmed)
        }}
      />
      {second !== undefined && (
        <Input
          value={extra}
          placeholder={second.label}
          aria-label={second.label}
          onChange={(event) => { setExtra(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && ready) onSubmit(trimmed, extraTrimmed)
          }}
        />
      )}
    </Modal>
  )
}
