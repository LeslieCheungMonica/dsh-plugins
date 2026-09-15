/**
 * The primitives this plugin's client half imports, answered from the CHECKOUT'S
 * SOURCE rather than from the installed package.
 *
 * The installed package's build imports CSS modules, which the preview bundler
 * cannot resolve — and stubbing them would defeat the point: this preview exists
 * to LOOK at the tag, so the icons have to be the shipped glyphs and the
 * placement has to be the shipped hook. Both source modules import nothing but
 * `react`, so they bundle unchanged. Only the SPECIFIER is redirected.
 *
 * (The offline harnesses take the opposite trade: they stub these to keep their
 * subject — logic, not layout — independent of the primitives. See
 * `scripts/harness/tsdown.mjs`.)
 */
export * from '../../../../deepseek-harness/packages/client/ui-primitives/src/icons/index.tsx'
export { useAnchoredPosition } from '../../../../deepseek-harness/packages/client/ui-primitives/src/useAnchoredPosition.ts'
