/**
 * Client-bundle build for the browser half.
 *
 * The in-repo preset that emits this artifact (`packages/client/tsdown.client.ts`)
 * is not published, so this file reproduces its output contract exactly:
 *
 *   - the bundle is a CLASSIC SCRIPT that registers a closure factory:
 *     `window.__ModuleLoader__.load({ id, factory: (require) => exports })`
 *   - the `id` MUST equal the Loader entry name / package name, which is also
 *     the module-table key and the `/plugins/<id>/client.js` route segment
 *   - shared modules stay `require()` calls answering from the shell's module
 *     table; everything else is inlined
 *   - the factory body (styles included) runs at materialization, never at
 *     script execution
 */
import { defineConfig } from 'tsdown'

/** Plugin id: the Loader entry name, the package name, and the module-table key. */
const ID = 'dsh-web-ui'

/**
 * The shell's seed table plus its parser-preloaded runtime row
 * (`packages/client/web/src/platform.ts`). These specifiers stay imports; a
 * bundle that inlined React would hold a second React instance and break hooks.
 */
const SHARED_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
])

/** Node half: the Loader row's `name` must resolve to this package's `main`. */
const nodeHalf = {
  name: ID,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'es2022',
  dts: false,
  clean: false,
  // `type: module` would otherwise push ESM output to `lib/index.mjs`; the
  // Loader resolves this package's `main`, which is `lib/index.js`.
  fixedExtension: false,
}

const clientHalf = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs' as const,
  platform: 'browser' as const,
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: (specifier: string) => SHARED_MODULES.has(specifier),
    alwaysBundle: (specifier: string) => !SHARED_MODULES.has(specifier),
  },
  // Browser bundles inline libraries that read these (zustand/immer probe
  // both). They must be substituted or the factory throws at materialization.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  plugins: [{
    // Build-time mirror of the module-edge rule: a cross-plugin VALUE import
    // either inlines a duplicate runtime instance or asks the module table for
    // a specifier it cannot answer. Type-only imports are erased upstream and
    // never reach this gate; collaboration happens through cordis services.
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (SHARED_MODULES.has(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not a shared module — `
        + 'use a type-only import and reach the value through a cordis service',
      )
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([nodeHalf, clientHalf])
