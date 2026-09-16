/**
 * Test entry for the marketplace harnesses: the host half that talks to SkillHub,
 * and the write path that unpacks what it returns.
 *
 * The route, the three flows, and the pure helpers behind them are exported from
 * the source the shipped host bundle is built from, so the harnesses verify the
 * code that actually ships — the session verification, the token convention, the
 * SkillHub hops and their order, the archive's refusal list, the `SKILL.md` rules,
 * and the configuration reader.
 */
export {
  installSkill, listInstalledSkills, readSkillOptions, registerSkillRoutes, searchMarket,
} from '../../src/host/skills.ts'
export { extractZipInto, readZip, safeRelativePath, SKILL_ZIP_LIMITS } from '../../src/host/zip.ts'
export { isSkillName, parseSkillFacts, skillDirectoryName } from '../../src/host/skillmd.ts'
export {
  SKILLS_INSTALL_PATH, SKILLS_INSTALLED_PATH, SKILLS_MARKET_PATH, SKILL_SOURCE_FILE,
  skillHandle, skillToken,
} from '../../src/shared/skillswire.ts'
