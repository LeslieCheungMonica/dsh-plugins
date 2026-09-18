/**
 * One question, asked by every input this plugin listens to for Enter: **is this
 * keydown the input method's or the operator's?**
 *
 * A composing IME commits its text on Enter, and its keydown reaches the page's
 * handler first. Reading that Enter as the panel's own verb goes wrong twice over:
 *
 * 1. `preventDefault` cancels the commit, so the operator presses Enter and NOTHING
 *    happens — the text never arrives in the field, and neither does a command. The
 *    only way out is to click away and start over, which reads as a dead panel.
 * 2. When a commit does land first, the handler acts on whatever half-composed string
 *    was on screen. A composition arrives with spaces between its letters, so the
 *    host received `p w d`, `l s` and `k s` as commands — Chinese-input-method
 *    spellings of `pwd` and `ls`, each answered with `command not found`.
 *
 * Every key is the input method's while a composition is open, not just Enter:
 * arrows walk the candidate list and Escape dismisses it. So the guard is asked
 * FIRST, before the key is looked at at all, and the committed text arrives through
 * `change` — the next Enter is the operator's.
 *
 * `keyCode 229` is the same signal for engines that report a composition keydown
 * without setting `isComposing`.
 *
 * @module my-sider/client/inputmethod
 */

/**
 * Whether a keydown belongs to the input method rather than to the page.
 * @param event - the keydown a field received.
 * @returns true when the input method owns this key, and the handler must stand aside.
 */
export function fromInputMethod(event: React.KeyboardEvent<HTMLInputElement>): boolean {
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
}
