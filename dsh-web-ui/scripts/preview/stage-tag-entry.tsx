/**
 * Preview entry: the REAL `StageTag`, mounted in a mock column.
 *
 * The tag, its markup, its stylesheet, the shipped icons, and the shipped
 * placement hook are all production code (the primitives specifier is aliased to
 * the checkout's source — see `primitives-shim.ts`). What is MOCK here is the
 * column AROUND the tag: a brand row, a project-row card, and the New Session
 * button. They are there because the tag's own geometry — a quiet row between
 * two cards, and a 36px square in the rail — only reads against the surface it
 * actually sits on.
 *
 * Two columns are mounted side by side so the expanded and rail layouts can be
 * compared in one look.
 */
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { StageTag } from '../../src/client/StageTag.tsx'
import { NS } from '../../src/client/contract.ts'
import { zh } from '../../src/client/locales.ts'

/** The translator seat the tag's copy arrives through. */
type T = TranslateNS<typeof NS>

/**
 * The REAL dictionary with `{name}` interpolation — the copy on screen is the
 * shipped copy, so a wrong or missing key is visible rather than guessed.
 * @param key - a dictionary key.
 * @param params - the interpolation values.
 * @returns the sentence, or the key itself when the dictionary has no entry.
 */
const t = ((key: string, params?: Record<string, unknown>): string => {
  let text = (zh as Record<string, string>)[key] ?? key
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.split(`{${name}}`).join(String(value))
  }
  return text
}) as T

/**
 * One column, reduced to the parts the tag's own rules are scoped by.
 * @param props - the layout, the scope key, and the project name.
 * @returns the column element.
 */
function Column({ wide, scopeKey, scopeLabel }: {
  wide: boolean
  scopeKey: string
  scopeLabel: string
}): ReactNode {
  return createElement('div', {
    'data-wui': 'column',
    ...(wide ? {} : { 'data-rail': 'true' }),
    style: { width: wide ? 256 : 56 },
  },
  createElement('div', { 'data-wui': 'header' },
    createElement('span', { 'data-wui': 'brand', 'data-wui-wide': 'true' },
      createElement('span', { 'data-wui': 'brandMark' }, '◈'),
      createElement('span', { 'data-wui': 'brandName' }, 'ForgeX')),
    createElement('span', { 'data-wui': 'iconButton' }, '▤')),
  createElement('div', { 'data-wui': 'projectRow' },
    createElement('span', { 'data-wui': 'projectTrigger' },
      createElement('span', { 'data-wui': 'projectIcon' }, '▣'),
      wide ? createElement('span', { 'data-wui': 'projectTitle' }, scopeLabel) : null,
      wide ? createElement('span', { 'data-wui': 'projectChevron' }, '⌄') : null),
    createElement('span', { 'data-wui': 'iconButton', 'data-wui-accent': 'true' }, '＋')),
  createElement(StageTag, {
    scopeKey,
    scopeLabel,
    rail: !wide,
    t,
  }),
  createElement('button', { 'data-wui': 'newSession', type: 'button' },
    wide ? createElement('span', { 'data-wui': 'newSessionLabel' }, t('session.new')) : '✎'))
}

/** The page: the two columns, and nothing else. */
function Preview(): ReactNode {
  return createElement('div', { 'data-wui': 'previewRow' },
    createElement(Column, { wide: true, scopeKey: 'demo-wide', scopeLabel: '订单中心重构' }),
    createElement(Column, { wide: false, scopeKey: 'demo-rail', scopeLabel: '订单中心重构' }))
}

const host = document.getElementById('root')
if (host === null) throw new Error('preview: #root is missing')
createRoot(host).render(createElement(Preview))
