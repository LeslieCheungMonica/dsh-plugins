/**
 * Harness entry for the project pick's DECISION.
 *
 * The offline pick harness (`project-pick.mjs`) drives the real module
 * `src/client/projectPick.ts` — the same one the shipped client bundle contains
 * — so the rule it checks is the shipped rule rather than a re-statement of it
 * in the test. This module is only the door: the decision is not the plugin's
 * entry (`src/client/index.tsx` registers slots and needs a whole runtime behind
 * it), so the function is exported here.
 */
export { pickProject } from '../../src/client/projectPick.ts'
