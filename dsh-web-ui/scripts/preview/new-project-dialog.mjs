/**
 * Render the New Project form to a standalone HTML file, for LOOKING at it.
 *
 * This is not a test and asserts nothing. It exists because the running GUI sits
 * behind a QR login, so the only way to check the dialog's SPACING — a 520px card
 * holding a path line and a chip row — is to render the same markup with the same
 * stylesheet somewhere a screenshot can be taken.
 *
 * What is real: the plugin's own stylesheet (`STYLES`, imported from source), the
 * shipped theme's tokens (`design-platform.css` from the checkout), and the
 * markup, which is copied from the current `NewProjectDialog`. What is an
 * approximation: the shared modal, input, and button rules, which live in CSS
 * modules Node cannot import, so the rules in `PRIMITIVE_CSS` below are
 * hand-mirrored from them — good enough to judge layout, not a conformance test.
 *
 * Usage: node scripts/preview/new-project-dialog.mjs [out.html]
 *        then open it, or screenshot it headless.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { STYLES } from '../../src/client/styles.ts'

const out = process.argv[2] ?? new URL('./new-project-dialog.html', import.meta.url).pathname

/** The shipped token sheet: both themes, straight from the checkout. */
const TOKENS = readFileSync(new URL(
  '../../../../deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css',
  import.meta.url,
), 'utf8')

/**
 * Hand-mirrored rules for the primitives the dialog renders with. See the module
 * comment: these are for looking at, not for conformance.
 */
const PRIMITIVE_CSS = `
.dsw-modal-root { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; }
.dsw-mask { position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1); }
.dsw-dialog {
  position: relative; display: flex; flex-direction: column; gap: 20px;
  width: min(380px, 100%); padding: 0 0 24px; overflow: hidden;
  border: 1px solid var(--dsw-alias-border-inverted); border-radius: 24px;
  background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-shadow-lv3);
}
.dsw-content { display: flex; flex-direction: column; width: 100%; }
.dsw-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 22px 14px 12px 24px; }
.dsw-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dsw-close { width: 28px; height: 28px; border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); }
.dsw-description { margin: 0; padding: 0 24px; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
.dsw-body { display: flex; flex-direction: column; min-width: 0; margin-top: 20px; padding: 0 24px; }
.dsw-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 0 24px; }
.dsw-input-wrap { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.dsw-input-wrap input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
.dsw-input-wrap input::placeholder { color: var(--dsw-alias-label-dimmed); }
.dsw-button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 28px; padding: 0 10px; border: none; border-radius: 14px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); background: transparent; }
.dsw-button.primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dsw-button.outline { border: 1px solid var(--dsw-alias-border-l2); padding: 0 9px; }
.dsw-icon { display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; }
body.dsw-preview { margin: 0; background: var(--dsw-alias-bg-base); font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
`

/**
 * The dialog's markup, in the state to look at: a filled form on the answer that
 * reveals the product-card row.
 * @returns the modal tree.
 */
function Preview() {
  const radio = (label, checked) => h('label', {
    'data-wui': 'formRadio',
    ...(checked ? { 'data-checked': 'true' } : {}),
  },
  h('input', { type: 'radio', name: 'background', defaultChecked: checked }),
  h('span', { 'data-wui': 'formRadioLabel' }, label))

  return h('div', { className: 'dsw-modal-root' },
    h('div', { className: 'dsw-mask' }),
    h('div', { className: 'dsw-dialog dsh-web-ui-new-project' },
      h('div', { className: 'dsw-content' },
        h('div', { className: 'dsw-header' },
          h('h2', { className: 'dsw-title' }, '添加项目'),
          h('button', { className: 'dsw-close', type: 'button' }, '×')),
        h('p', { className: 'dsw-description' }, '填写项目名称、选择本地目录作为工作空间，并说明这个项目属于哪种产品背景。'),
        h('div', { className: 'dsw-body' },
          h('div', { 'data-wui': 'form' },
            h('div', { 'data-wui': 'formField' },
              h('span', { 'data-wui': 'formLabel' }, '项目名称'),
              h('span', { className: 'dsw-input-wrap' },
                h('input', { defaultValue: '订单中心重构', placeholder: '例如：订单中心重构' }))),
            h('div', { 'data-wui': 'formField' },
              h('span', { 'data-wui': 'formLabel' }, '工作空间目录'),
              h('div', { 'data-wui': 'formPathRow' },
                h('span', { 'data-wui': 'formPath', title: '/Users/liyanhui/vscodeProjects/demos/order-centre' },
                  '/Users/liyanhui/vscodeProjects/demos/order-centre'),
                h('button', { className: 'dsw-button outline', type: 'button' },
                  h('span', { className: 'dsw-icon' }, '📁'), '选择本地目录')),
              h('span', { 'data-wui': 'formHint' }, '该本地目录会成为 DSH 的工作空间（workspace），会话都在这个目录里运行。')),
            h('fieldset', { 'data-wui': 'formFieldset' },
              h('legend', { 'data-wui': 'formLabel' }, '产品背景'),
              h('div', { 'data-wui': 'formRadios', role: 'radiogroup' },
                radio('新项目', false), radio('已有产品', true), radio('不确定', false))),
            h('div', { 'data-wui': 'formField' },
              h('span', { 'data-wui': 'formLabel' }, '产品卡'),
              h('div', { 'data-wui': 'formCardNote' },
                h('span', { 'data-wui': 'formCardNoteText' },
                  '产品卡数据源尚未接入，暂时无法选择；后续会在这里展示可选的产品卡。')),
              h('span', { 'data-wui': 'formHint' }, '选择这个项目归属的产品卡。'))))),
      h('div', { className: 'dsw-footer' },
        h('button', { className: 'dsw-button', type: 'button' }, '取消'),
        h('button', { className: 'dsw-button primary', type: 'button' }, '创建项目'))))
}

writeFileSync(out, `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>New Project form — visual preview</title>
<style>
/* Body-level tokens: the theme declares them on body, and this page has one. */
${TOKENS}
${PRIMITIVE_CSS}
${STYLES}
</style>
</head>
<body class="dsw-preview">
${renderToStaticMarkup(h(Preview))}
</body>
</html>
`)
console.log(`preview written: ${out}`)
