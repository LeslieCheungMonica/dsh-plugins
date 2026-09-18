/**
 * The UI-primitives stub for the New Project form harness.
 *
 * The real package's node build imports CSS modules, which Node cannot load, so
 * the harness answers it from this module exactly as `smoke-git.mjs` answers it
 * from its own module table. The components below are real React elements with
 * the props the form uses: a modal that honours `open`, a real `<input>` carrying
 * its value and change handler, and a button that reports its own click.
 *
 * Everything here is deliberately thin. The point of the harness is the FORM's
 * own behaviour — which row exists for which answer, what the draft holds, what
 * the submission sends — and none of that is a property of the primitives.
 *
 * The icon list is GENERATED (see `tsdown.mjs`) from the real package's own type
 * declarations, because a bundler resolves named imports statically: a stub that
 * answered icons through a Proxy would fail the build the moment the form
 * imported one, and a hand-kept list would drift silently. Regenerating means a
 * newly used icon is always exportable, and the harness never needs an edit.
 */
import { createElement as h, useEffect } from 'react'

/** A control that renders a real element of the given tag. */
const asTag = (tag, name) => function Stub(props) {
  const { children, ...rest } = props ?? {}
  return h(tag, { 'data-stub': name, ...rest }, children)
}

/**
 * A modal that renders nothing while closed, like the real one.
 *
 * Title and description are rendered because they are COPY the form changes with
 * its mode (adding a project vs editing one), and copy is half of what this
 * harness exists to check — a stub that dropped them would make the two modes
 * indistinguishable to the test.
 *
 * Escape is implemented because the real primitive implements it, and the account
 * drawer's behaviour under Escape is asserted: its own listener stands down while
 * a modal is up, so the modal has to be the thing that closes.
 */
export const Modal = ({ open, onClose, title, description, className, children, footer }) => {
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open, onClose])
  return open
    ? h('div', {
      'data-stub': 'Modal',
      // The real primitive's own ARIA contract, kept here because the account
      // drawer asserts a PAGE-level rule against it: Escape stands down while any
      // [role="dialog"] is up, so a stub without the role would let the drawer
      // close under a modal and the test would pass on a lie.
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': title,
      ...(className === undefined ? {} : { className }),
    },
    h('h2', { 'data-stub': 'ModalTitle' }, title),
    description === undefined ? null : h('p', { 'data-stub': 'ModalDescription' }, description),
    children,
    footer)
    : null
}

/** A tooltip is decoration: the harness renders its child and nothing else. */
export const Tooltip = ({ children }) => h('div', { 'data-stub': 'Tooltip' }, children)

/**
 * Outside-pointer dismissal, as a real document listener.
 *
 * The account dock's drawer uses this, and "a click anywhere else closes the
 * drawer" is one of the behaviours the account harness checks — so this stub
 * keeps the real semantics (pointerdown, outside the root, only while open)
 * rather than degrading to a no-op.
 */
export const useDismissOnOutsidePointer = (root, open, setOpen) => {
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (event.target instanceof Node && !(root.current?.contains(event.target) ?? false)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => { document.removeEventListener('pointerdown', onDown) }
  }, [root, open, setOpen])
}

export const Button = asTag('button', 'Button')

/**
 * Anchored placement, as a fixed position at the origin.
 *
 * The real primitive measures the anchor and the panel and keeps the panel inside
 * the viewport; jsdom lays nothing out, so it would measure zeros and return the
 * same thing anyway. What matters to the stage tag is that a position is
 * RETURNED: its panel is portaled to the page body and only becomes focusable
 * once it is placed (`position === null` means "laid out but hidden", see
 * StageTag.tsx), so a stub that always answered `null` would freeze the panel in
 * the state the tag has before it can be driven.
 */
export const useAnchoredPosition = () => ({ position: 'fixed', left: 0, top: 0 })

/**
 * A real `<input>` carrying its value and change handler.
 *
 * `icon` is DROPPED rather than forwarded: the real primitive renders a glyph
 * inside a wrapper, and forwarding the element to a DOM node would leak
 * `icon="[object Object]"` onto the markup. The icon is decoration; the value and
 * the handler are what a harness drives.
 */
export const Input = ({ icon, ...rest }) => h('input', { 'data-stub': 'Input', ...rest })

/* ICONS: generated — see the module comment above. */
