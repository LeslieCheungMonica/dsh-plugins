/**
 * Test entry for the account harness: the column's bottom-left corner.
 *
 * Every half of the surface is exported from the source the shipped client
 * bundle is built from, so the harness verifies the code that actually ships:
 * the dock (row + drawer + seat plumbing), the Usage block (the projection fold
 * and its formatting), and the Plugins modal (the host inventory read, and the
 * Settings → Plugins presentation it reproduces).
 */
export { AccountDock } from '../../src/client/AccountDock.tsx'
export {
  UsagePanel, billedInputTokens, cacheHitPercent, contextOccupancy, formatTokens,
} from '../../src/client/UsagePanel.tsx'
export { PluginsDialog, moduleShortName } from '../../src/client/PluginsDialog.tsx'
