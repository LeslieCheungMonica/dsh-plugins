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
import { createElement as h } from 'react'

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
 */
export const Modal = ({ open, title, description, className, children, footer }) => (open
  ? h('div', { 'data-stub': 'Modal', ...(className === undefined ? {} : { className }) },
    h('h2', { 'data-stub': 'ModalTitle' }, title),
    description === undefined ? null : h('p', { 'data-stub': 'ModalDescription' }, description),
    children,
    footer)
  : null)

/** A tooltip is decoration: the harness renders its child and nothing else. */
export const Tooltip = ({ children }) => h('div', { 'data-stub': 'Tooltip' }, children)

export const Button = asTag('button', 'Button')
export const Input = props => h('input', { 'data-stub': 'Input', ...props })

/* ICONS: generated — see the module comment above. */
