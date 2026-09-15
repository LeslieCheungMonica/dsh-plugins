/**
 * Measure the New Project form's preview in a real browser, and report it.
 *
 * The companion to `new-project-dialog.mjs`: that file renders the dialog to HTML
 * because the running GUI sits behind a QR login, and this file reads the numbers
 * back out of it, because a screenshot cannot be inspected by a script. It is the
 * layout half of the verification — the card's width, whether the long path line
 * actually overflows, and whether the styles this plugin injects are the ones the
 * browser applied.
 *
 * It renders the preview itself first, so it always measures the CURRENT form.
 *
 * Usage: node scripts/preview/measure-form.mjs
 * Requires: playwright + a Chrome binary, both resolved like the smoke tests do.
 */
import { execFileSync } from 'node:child_process'

const EXECUTABLE = process.env['CHROME']
const preview = new URL('./new-project-dialog.html', import.meta.url).pathname
// Regenerate the artifact first: measuring a stale preview is worse than useless.
execFileSync(process.execPath, [new URL('./new-project-dialog.mjs', import.meta.url).pathname], { stdio: 'inherit' })

const playwright = await import('playwright').catch(() => {
  console.error('measure-form: playwright is not resolvable from this package — see README, "Verifying".')
  process.exit(2)
})

const results = []
/**
 * Record one assertion.
 * @param name - what was checked.
 * @param ok - whether it held.
 * @param detail - what was observed.
 */
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

const browser = await playwright.chromium.launch(EXECUTABLE === undefined ? {} : { executablePath: EXECUTABLE })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const problems = []
page.on('pageerror', error => { problems.push(`pageerror: ${error.message}`) })
await page.goto(`file://${preview}`, { waitUntil: 'load' })

const m = await page.evaluate(() => {
  const px = (value) => Number.parseFloat(value)
  const card = document.querySelector('.dsh-web-ui-new-project')
  const form = document.querySelector('[data-wui="form"]')
  const path = document.querySelector('[data-wui="formPath"]')
  const pathRow = document.querySelector('[data-wui="formPathRow"]')
  const radio = document.querySelector('[data-wui="formRadio"]')
  const checkedRadio = document.querySelector('[data-wui="formRadio"][data-checked="true"]')
  const radios = document.querySelector('[data-wui="formRadios"]')
  const note = document.querySelector('[data-wui="formCardNote"]')
  const cardStyle = getComputedStyle(card)
  const radioStyle = getComputedStyle(checkedRadio)
  return {
    card: { width: px(cardStyle.width), max: cardStyle.maxWidth },
    formWidth: form.getBoundingClientRect().width,
    pathRow: { width: pathRow.getBoundingClientRect().width },
    path: {
      scrollWidth: path.scrollWidth,
      clientWidth: path.clientWidth,
      fontFamily: getComputedStyle(path).fontFamily,
    },
    radios: {
      count: document.querySelectorAll('[data-wui="formRadio"]').length,
      // Wrapped to more than one line? The card is meant to hold all three.
      height: radios.getBoundingClientRect().height,
      oneLine: radios.getBoundingClientRect().height < 40,
    },
    selectedRadio: {
      // The rule under test is the one that paints the ANSWER the operator
      // picked, so this has to read the checked chip — reading the first chip
      // would pass on an unstyled form.
      borderColor: radioStyle.borderTopColor,
      background: radioStyle.backgroundColor,
      accent: getComputedStyle(radio.querySelector('input')).accentColor,
    },
    note: { width: note.getBoundingClientRect().width, height: note.getBoundingClientRect().height },
    cardColor: { background: cardStyle.backgroundColor, radius: cardStyle.borderRadius },
    formGap: getComputedStyle(form).rowGap,
  }
})

check('the form is rendered at all', m.card.width > 0, JSON.stringify(m.card))
check('the card is widened past the shared modal default of 380px',
  m.card.width >= 500 && m.card.width <= 521, `card=${String(m.card.width)}px`)
check('the fields fill the card\'s content column, not the viewport',
  m.formWidth > 400 && m.formWidth < m.card.width, `form=${String(m.formWidth)}px card=${String(m.card.width)}px`)
check('the long path line is clipped rather than pushing the row wider',
  m.path.scrollWidth >= m.path.clientWidth && m.pathRow.width <= m.formWidth,
  JSON.stringify({ row: m.pathRow.width, form: m.formWidth, scroll: m.path.scrollWidth, client: m.path.clientWidth }))
check('the path line uses the monospace token', /mono|Menlo|Consolas|Courier/i.test(m.path.fontFamily), m.path.fontFamily)
check('the three answers sit on one line', m.radios.count === 3 && m.radios.oneLine,
  JSON.stringify({ count: m.radios.count, height: m.radios.height }))
check('the chosen answer is painted with the plugin accent, not the browser default',
  m.selectedRadio.borderColor !== 'rgb(0, 0, 0)' && m.selectedRadio.borderColor !== 'rgba(0, 0, 0, 0)'
  && m.selectedRadio.background !== 'rgba(0, 0, 0, 0)',
  JSON.stringify(m.selectedRadio))
check('the product-card note is a full-width row', m.note.width > 400 && m.note.height > 20,
  JSON.stringify(m.note))
check('the modal card is still the shipped card', m.cardColor.radius === '24px' && m.cardColor.background !== 'rgba(0, 0, 0, 0)',
  JSON.stringify(m.cardColor))
check('the form stacks its fields with a gap', Number.parseFloat(m.formGap) >= 10, m.formGap)

await browser.close()

for (const problem of problems.slice(0, 5)) check('no page error', false, problem)

let failed = 0
for (const entry of results) {
  if (!entry.ok) failed += 1
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name}${entry.detail === '' ? '' : `\n      ${entry.detail}`}`)
}
console.log(failed === 0 ? `\n${String(results.length)} checks passed` : `\n${String(failed)} of ${String(results.length)} checks FAILED`)
process.exit(failed === 0 ? 0 : 1)
