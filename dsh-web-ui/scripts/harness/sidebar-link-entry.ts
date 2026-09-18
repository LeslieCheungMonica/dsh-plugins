/**
 * Harness entry for the sidebar-link capability's PROVIDER side.
 *
 * The offline harness (`sidebar-link.mjs`) drives the REAL adapters this plugin
 * registers for the peers that can show a page inside the GUI — the module
 * `src/client/index.tsx` builds its `openInSidebar` from. This module is only the
 * door to them: an adapter takes a peer's cordis service, so the harness hands it
 * a stub and needs no plugin runtime, no DOM, and no peer package.
 *
 * The consumer side of the same capability is covered where it belongs: the
 * Feishu panel's own harness (`lark-panel.mjs`) drives the real rows and asserts
 * that a sidebar which answers `true` suppresses the new tab.
 */
export { betterSidebarOpener, combineOpeners, webSidebarOpener } from '../../src/client/sidebarLink.ts'
