/**
 * Test entry for the input-anchor rail harness.
 *
 * Both halves of the surface are exported from the source the shipped client
 * bundle is built from, so the harness verifies the code that actually ships:
 * the pure geometry/mapping helpers (`rail.ts` — anchor collection, tick
 * positions, the current-anchor rule) and, once it exists, the rail component
 * itself (`InputRail.tsx`).
 */
export {
  activeAnchorIndex, collectAnchors, previewLine, tickPositions,
} from '../../src/client/rail.ts'
export {
  InputRail, JUMP_INSET, MARKER_HEIGHT, RAIL_INSET, TICK_GAP,
} from '../../src/client/InputRail.tsx'
