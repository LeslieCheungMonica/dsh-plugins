/**
 * Bundle the New Project flow, its form, the Feishu folder panel, the account
 * dock, and the skill marketplace's host half for the offline harnesses
 * (`folder-flow.mjs`, `new-project-form.mjs` through `form-entry.tsx`,
 * `lark-panel.mjs` through `panel-entry.tsx`, `account-dock.mjs` through
 * `account-entry.tsx`, and `skills-route.mjs` through `skills-entry.ts`).
 *
 * The harnesses verify the flow and the panel through the code the shipped client
 * bundle actually contains, so they are bundled from source rather than
 * re-implemented. React stays external — the harness supplies its own instance —
 * and the primitive library is aliased to a local stub: the flow holds no JSX and
 * never reaches it, while the form and the panel do, and the real package's node
 * build imports CSS modules Node cannot load — the same reason `smoke-git.mjs`
 * answers it from a module table.
 *
 * The stub's icon exports are GENERATED here, from the real package's own type
 * declarations, and written to `ui-stub.generated.js`: a bundler resolves named
 * imports statically, so a Proxy-based stub cannot satisfy `Icon…` imports and a
 * hand-kept list would drift. Generating keeps the harness from needing an edit
 * whenever the form starts using another icon.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { build } from 'tsdown'

const here = import.meta.url
const stubTemplate = new URL('./ui-stub.js', here).pathname
const stubGenerated = new URL('./ui-stub.generated.js', here).pathname
const iconDeclarations = new URL(
  '../../node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/types/icons/index.d.ts',
  here,
).pathname

const icons = [...new Set(readFileSync(iconDeclarations, 'utf8').match(/Icon[A-Za-z0-9]+/g) ?? [])]
  .sort()
if (icons.length === 0) {
  throw new Error('harness: no icon declarations found — is @deepseek-ai/dsh-client-ui-primitives installed?')
}
writeFileSync(
  stubGenerated,
  readFileSync(stubTemplate, 'utf8').replace(
    '/* ICONS: generated — see the module comment above. */',
    icons.map(name => `export const ${name} = asTag('span', '${name}')`).join('\n'),
  ),
)

await build({
  // Never inherit the package's own tsdown.config.ts: these bundles are test
  // artifacts, not plugin artifacts.
  config: false,
  entry: {
    'project-flow': new URL('./entry.ts', here).pathname,
    'new-project-form': new URL('./form-entry.tsx', here).pathname,
    'lark-panel': new URL('./panel-entry.tsx', here).pathname,
    'account-dock': new URL('./account-entry.tsx', here).pathname,
    'skills-route': new URL('./skills-entry.ts', here).pathname,
    'skills-install': new URL('./skills-entry.ts', here).pathname,
  },
  outDir: new URL('./out', here).pathname,
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  // Node built-ins are external to every bundle here — one entry is HOST code that
  // reads the filesystem — and naming them keeps the browser-targeted build from
  // warning about every one of them.
  deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom', /^node:/u] },
  alias: { '@deepseek-ai/dsh-client-ui-primitives': stubGenerated },
  dts: false,
  clean: true,
})
