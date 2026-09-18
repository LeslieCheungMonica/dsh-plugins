/**
 * Harness entry for the FDE stage tag (`stage-tag.mjs`).
 *
 * The harness drives the REAL tag, so this module is only the glue that makes it
 * importable from the bundle: the tag is a component, and re-exporting it — with
 * the one constant the harness needs to say "no project is selected" — is the
 * whole of it. The UI primitives arrive as a stub through the bundle's alias (see
 * `tsdown.mjs`).
 */
export { NO_PROJECT_SCOPE } from '../../src/client/stage.ts'
export { StageTag } from '../../src/client/StageTag.tsx'
