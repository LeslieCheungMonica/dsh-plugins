/**
 * Harness entry for the Feishu folder panel.
 *
 * The offline panel harness (`lark-panel.mjs`) renders the REAL panel — bundled
 * from `src/client/LarkDocsPanel.tsx`, the same module the shipped client bundle
 * contains — in jsdom, with `fetch` answering the way the host's routes answer.
 * This module is only the door to it: the panel is a component, so the harness
 * needs its export, and bundling it here is what keeps the test from reaching
 * into the plugin's own entry (`src/client/index.tsx`), which registers slots and
 * needs a whole runtime behind it.
 */
export { LarkDocsPanel } from '../../src/client/LarkDocsPanel.tsx'
export { folderTokenFromInput } from '../../src/client/larkapi.ts'
