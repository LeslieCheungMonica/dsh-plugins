/**
 * The project form: what a project IS — asked when it is created, and asked
 * again when it is edited.
 *
 * The old flow opened the host's directory chooser directly, which answered one
 * question — where does this project live. This dialog asks the other two, in
 * one place:
 *
 *   1. the project's NAME (a workspace's own title, distinct from its folder:
 *      the folder is where the code is, the name is what the column shows);
 *   2. its WORKSPACE DIRECTORY, still through the host's chooser — with the
 *      in-app browser as the fallback for a host that has none;
 *   3. its PRODUCT BACKGROUND: a brand-new product, an existing one, or not yet
 *      decided. Only "an existing one" asks which product card, and that extra
 *      row is the only consumer of `productCards.ts`.
 *
 * The dialog is CONTROLLED: the draft lives in the flow (`projectFlow.ts`), not
 * here, because choosing a folder hands the page over to the browser dialog and
 * closes this one — a draft owned by this component would be discarded by that
 * round trip and the operator would lose everything they had typed. The card
 * catalogue arrives as a PROP for the same reason: the flow reads it with the
 * project's record in one request (see `readProjectInfo`), so the dialog never
 * fetches and this component stays a rendering of what it is handed.
 *
 * ## Two modes
 *
 * `mode` is `create` when the form is adding a project and `edit` when it is
 * changing one, and the difference is deliberately small: the copy changes, and
 * the workspace DIRECTORY becomes read-only. It is read-only because a workspace
 * is identified by its path — sessions belong to it — so "changing the folder"
 * would not edit a project, it would move it and orphan its history. An operator
 * who wants a different directory adds a project for it.
 *
 * The card carries the `dsh-web-ui-new-project` class as well as its `data-wui`
 * tree: the tests address the form as a WHOLE (its own copy, the row that only
 * appears for one answer), and `data-wui` marks are per-element, not per-dialog.
 * The stylesheet widens the card through that class — see the rule in
 * `styles.ts` for why it asks for "the modal containing this form" instead of
 * naming the modal's own (hashed, not ours) class.
 */
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconFolderOpen16, Input, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './contract.ts'
import type { ProductCardResult } from './productCards.ts'

/** The translator seat this plugin's copy arrives through. */
type T = TranslateNS<typeof NS>

/** What the operator says this project is. */
export type ProductBackground = 'new' | 'existing' | 'unsure'

/**
 * The three answers, in the order the radio group renders them. Labels are
 * dictionary keys rather than strings so the option list, the radio row, and any
 * future summary of a submitted answer all read one source.
 */
export const BACKGROUND_OPTIONS: readonly {
  value: ProductBackground
  /** Dictionary key of the option's label (literal, so `t()` is typed). */
  label: 'form.background.new' | 'form.background.existing' | 'form.background.unsure'
}[] = [
  { value: 'new', label: 'form.background.new' },
  { value: 'existing', label: 'form.background.existing' },
  { value: 'unsure', label: 'form.background.unsure' },
]

/** The draft the dialog edits; owned by the flow. */
export interface NewProjectDraft {
  /** Project name (the workspace title). */
  readonly name: string
  /** Absolute workspace directory; empty until one is chosen. */
  readonly path: string
  /** What the operator said this project is. */
  readonly background: ProductBackground
  /** Chosen product card id; only meaningful for `existing`. */
  readonly productCardId: string
}

/** One labelled line of the form. */
function Field({ label, hint, children }: {
  label: string
  hint?: string | undefined
  children: ReactNode
}): ReactNode {
  return (
    <div data-wui="formField">
      <span data-wui="formLabel">{label}</span>
      {children}
      {hint !== undefined && hint !== '' && <span data-wui="formHint">{hint}</span>}
    </div>
  )
}

/**
 * Render the New Project dialog.
 * @param props - openness, the draft and its writers, the two actions, copy.
 * @returns the dialog element (null while closed).
 */
export function NewProjectDialog({ open, mode, draft, cards, onChange, onChooseFolder, busy, pickError, onSubmit, onClose, t }: {
  open: boolean
  /** Adding a project, or changing one that exists. */
  mode: 'create' | 'edit'
  draft: NewProjectDraft
  /**
   * The catalogue the flow read with this project's record.
   *
   * `null` while that read is still in flight (or failed at the transport
   * level), which the card row renders as "reading…" rather than as an empty
   * list the operator might believe.
   */
  cards: ProductCardResult | null
  /** Merge one or more draft fields; the flow owns the draft. */
  onChange: (patch: Partial<NewProjectDraft>) => void
  /** Open the host's chooser, falling back to the in-app browser. */
  onChooseFolder: () => void
  busy: boolean
  /** Last folder-choice failure, owned by the flow. */
  pickError: string | null
  onSubmit: () => void
  onClose: () => void
  t: T
}): ReactNode {
  const formRef = useRef<HTMLDivElement | null>(null)
  const editing = mode === 'edit'

  // The card pulls the keyboard, which is what makes a multi-field dialog
  // keyboard-only traversable; the mask is inert.
  useEffect(() => {
    if (open) formRef.current?.focus()
  }, [open])

  const name = draft.name.trim()
  const path = draft.path.trim()
  const wantsCards = draft.background === 'existing'
  const ready = name !== '' && path !== '' && !busy
  // Only the "existing" answer makes the card mandatory: the other two have no
  // card to name, and blocking them on one would trap the operator.
  const cardsReady = !wantsCards || draft.productCardId !== ''

  const submit = (): void => {
    if (ready && cardsReady) onSubmit()
  }

  const cardOptions: readonly { id: string; name: string; detail?: string | undefined }[]
    = cards !== null && cards.ok ? cards.cards : []
  // A card that was recorded but is no longer offered stays SELECTABLE: dropping
  // it would silently rewrite the project's own record on the next save.
  const missingCard = draft.productCardId !== ''
    && cardOptions.every(card => card.id !== draft.productCardId)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? t('form.edit.title') : t('form.title')}
      description={editing ? t('form.edit.description') : t('form.description')}
      closeLabel={t('picker.cancel')}
      className="dsh-web-ui-new-project"
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('picker.cancel')}</Button>
          <Button variant="primary" size="sm" disabled={!ready || !cardsReady} onClick={submit}>
            {editing ? t('form.edit.submit') : t('form.submit')}
          </Button>
        </>
      )}
    >
      <div
        data-wui="form"
        ref={formRef}
        // The card is a dialog, so the whole form is one tab stop that then
        // hands the keyboard to its own fields. This is the container's tabIndex,
        // not an input's autofocus, because the form is a SEQUENCE: landing on
        // the name field is right, and landing on the card makes the sequence
        // start where the eye does.
        tabIndex={-1}
      >
        <Field label={t('form.name')}>
          <Input
            // No autoFocus: the CARD takes the focus when it opens (see the
            // effect above), and two rules competing for the same caret would
            // make the winner an accident of render order.
            value={draft.name}
            placeholder={t('form.name.placeholder')}
            aria-label={t('form.name')}
            disabled={busy}
            onChange={(event) => { onChange({ name: event.target.value }) }}
            onKeyDown={(event) => { if (event.key === 'Enter') submit() }}
          />
        </Field>

        <Field
          label={t('form.path')}
          hint={editing ? t('form.edit.path.hint') : t('form.path.hint')}
        >
          <div data-wui="formPathRow">
            <span
              data-wui="formPath"
              data-empty={path === '' ? 'true' : undefined}
              data-locked={editing ? 'true' : undefined}
              title={path}
            >
              {path === '' ? t('form.path.none') : path}
            </span>
            {!editing && (
              <Button
                variant="outline"
                size="sm"
                icon={<IconFolderOpen16 size={16} />}
                disabled={busy}
                onClick={onChooseFolder}
              >
                {t('form.path.choose')}
              </Button>
            )}
          </div>
        </Field>

        {pickError !== null && (
          <div data-wui="formError" role="status">{`${t('form.path.failed')}: ${pickError}`}</div>
        )}

        <fieldset data-wui="formFieldset">
          <legend data-wui="formLabel">{t('form.background')}</legend>
          <div data-wui="formRadios" role="radiogroup" aria-label={t('form.background')}>
            {BACKGROUND_OPTIONS.map(option => (
              <label key={option.value} data-wui="formRadio" data-checked={draft.background === option.value ? 'true' : undefined}>
                <input
                  type="radio"
                  name="dsh-web-ui-project-background"
                  value={option.value}
                  checked={draft.background === option.value}
                  disabled={busy}
                  onChange={() => { onChange({ background: option.value }) }}
                />
                <span data-wui="formRadioLabel">{t(option.label)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {/* The conditional row: asked only of a project that continues an
            existing product. */}
        {wantsCards && (
          <Field label={t('form.productCard')} hint={t('form.productCard.hint')}>
            {cards === null && (
              <div data-wui="formCardNote">
                <span data-wui="formCardNoteText">{t('form.productCard.loading')}</span>
              </div>
            )}
            {cards !== null && !cards.ok && (
              <div data-wui="formCardNote" data-tone="error">
                <span data-wui="formCardNoteText">
                  {`${t('form.productCard.failed')}${cards.message === '' ? '' : `: ${cards.message}`}`}
                </span>
              </div>
            )}
            {cards !== null && cards.ok && cardOptions.length === 0 && (
              <div data-wui="formCardNote">
                <span data-wui="formCardNoteText">{t('form.productCard.empty')}</span>
              </div>
            )}
            {cards !== null && cards.ok && (cardOptions.length > 0 || missingCard) && (
              <select
                data-wui="formSelect"
                aria-label={t('form.productCard')}
                disabled={busy}
                value={draft.productCardId}
                onChange={(event) => { onChange({ productCardId: event.target.value }) }}
              >
                <option value="">{t('form.productCard.placeholder')}</option>
                {missingCard && (
                  <option value={draft.productCardId}>
                    {t('form.productCard.missing', { id: draft.productCardId })}
                  </option>
                )}
                {cardOptions.map(card => (
                  <option key={card.id} value={card.id}>
                    {card.detail === undefined || card.detail === '' ? card.name : `${card.name} — ${card.detail}`}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
      </div>
    </Modal>
  )
}
