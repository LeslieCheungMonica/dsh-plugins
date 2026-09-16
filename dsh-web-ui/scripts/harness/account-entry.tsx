/**
 * Test entry for the account harness: the column's bottom-left corner.
 *
 * Every half of the surface is exported from the source the shipped client
 * bundle is built from, so the harness verifies the code that actually ships:
 * the dock (row + drawer + seat plumbing), the Usage block (the projection fold
 * and its formatting), the Plugins modal (the host inventory read, and the
 * Settings → Plugins presentation it reproduces), and the Skills modal (the
 * installed/marketplace split, rendered from a fixture list because the host read
 * that will fill it does not exist yet).
 */
export { AccountDock } from '../../src/client/AccountDock.tsx'
export {
  UsagePanel, billedInputTokens, cacheHitPercent, contextOccupancy, formatTokens,
} from '../../src/client/UsagePanel.tsx'
export { PluginsDialog, moduleShortName } from '../../src/client/PluginsDialog.tsx'
export { SkillsDialog } from '../../src/client/SkillsDialog.tsx'
export { searchMarketSkills } from '../../src/client/skillapi.ts'
