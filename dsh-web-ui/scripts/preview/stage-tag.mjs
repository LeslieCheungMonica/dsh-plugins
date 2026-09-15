/**
 * Render the FDE stage tag to a standalone HTML file, for LOOKING at it.
 *
 * The tag's true rendering cannot be seen in the running GUI, because that GUI
 * sits behind a QR login — and the panel's design (a rail of nodes, a tinted
 * running node, a ring that fills as the flow advances) is not something a
 * measurement can judge. So this file bundles the REAL component (see
 * `stage-tag-entry.tsx`) and writes it into a page carrying the REAL stylesheet
 * (`STYLES`, imported from source) and the shipped theme tokens, in both themes.
 *
 * What is real: the component, the icons, the placement hook, the stylesheet, the
 * tokens, and the copy (the shipped Chinese dictionary). What is approximate: the
 * column around the tag, which is hand-built here because only the tag is under
 * inspection.
 *
 * The page is served over HTTP by `measure-stage-tag.mjs` — not opened as a file
 * — because the tag remembers its stage in `localStorage`, which a `file://`
 * origin refuses.
 *
 * Usage: node scripts/preview/stage-tag.mjs [out.html]
 *        then open it, or drive it with measure-stage-tag.mjs.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { build } from 'tsdown'
import { STYLES } from '../../src/client/styles.ts'

const out = process.argv[2] ?? new URL('./stage-tag.html', import.meta.url).pathname
const outDir = new URL('./out/', import.meta.url).pathname

await build({
  // Never inherit the package's own tsdown.config.ts: this is a preview bundle,
  // not the plugin artifact (no client-bundle purity gate, react INLINED so the
  // page is self-contained).
  config: false,
  entry: { 'stage-tag': new URL('./stage-tag-entry.tsx', import.meta.url).pathname },
  outDir,
  format: ['iife'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: true,
  alias: {
    // The one redirect: the primitives arrive from the checkout's source (see
    // primitives-shim.ts) so the shipped icons and the shipped hook are used.
    '@deepseek-ai/dsh-client-ui-primitives': new URL('./primitives-shim.ts', import.meta.url).pathname,
  },
})

/** The bundle just written: the entry chunk, never a shared chunk. */
const bundleName = readdirSync(outDir).find(name => /^stage-tag(\.iife)?\.js$/.test(name))
if (bundleName === undefined) {
  throw new Error(`preview: no stage-tag bundle in ${outDir} — got ${readdirSync(outDir).join(', ')}`)
}
const bundle = readFileSync(`${outDir}${bundleName}`, 'utf8')

/** The shipped theme token sheets: both themes, straight from the checkout. */
const tokens = ['design-platform.css', 'gradient-shadow-text.css', 'base.css']
  .map(name => readFileSync(new URL(
    `../../../../deepseek-harness/packages/client/ui-theme/src/styles/${name}`,
    import.meta.url,
  ), 'utf8'))
  .join('\n')

/**
 * Preview-only rules: the page shell and the two columns. Nothing here belongs
 * to the plugin — the tag's own rules are all in STYLES.
 */
const PREVIEW_CSS = `
body.preview {
  margin: 0;
  height: 100vh;
  overflow: hidden;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
}
[data-wui='previewRow'] { display: flex; align-items: stretch; gap: 20px; height: 100%; }
/* The tag's own rules are scoped to the column, so the mock column keeps the
   column's box model — height included. */
[data-wui='column'] { height: 100%; }
[data-wui='column'] [data-wui='header'] { justify-content: space-between; }
[data-wui='brand'] { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; }
[data-wui='iconButton'] { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; }
`

writeFileSync(out, `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>FDE stage tag — visual preview</title>
<style>
/* Body-level tokens: the theme declares them on body, and this page has one. */
${tokens}
${PREVIEW_CSS}
${STYLES}
</style>
</head>
<body class="preview">
<div id="root"></div>
<script>
${bundle}
</script>
</body>
</html>
`)
console.log(`preview written: ${out}`)
