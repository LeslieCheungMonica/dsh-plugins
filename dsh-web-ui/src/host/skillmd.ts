/**
 * Reading a skill's own metadata out of its `SKILL.md`, and deciding what a skill
 * may be called.
 *
 * Both the marketplace installer and the installed-skills scan need the same two
 * answers — this file's `name` and `description` — and both must agree with the
 * LOADER, because a skill this plugin lists but the loader ignores is worse than
 * one it does not list at all. So the rules here mirror
 * `@deepseek-ai/dsh-skill-filesystem`'s own, deliberately:
 *
 * - frontmatter is required, and both `name` and `description` must be present;
 * - the name must match {@link SKILL_NAME} — the loader IGNORES a skill whose
 *   name is anything else (a space, an underscore, an uppercase letter), which is
 *   why the installer refuses such a package instead of unpacking files nobody
 *   will ever see;
 * - the name is also the directory name the installer creates, which is why
 *   {@link skillDirectoryName} exists as a separate, stricter check: the loader's
 *   pattern is a subset of what a filesystem allows, so the loader's rule alone
 *   would be safe, and this second one makes that explicit rather than incidental.
 *
 * ## The parser is a documented SUBSET, and it fails soft
 *
 * `parseSkillFrontmatter` reads the `---` block's `key: value` lines, folds
 * continuation lines into the value, and strips a matching pair of quotes. It is
 * NOT a YAML parser: it has no aliases, no anchors, no flow collections, no nested
 * maps beyond what a skill's own two strings need, and a block scalar's `|`/`>`
 * marker is treated as plain text. That is a deliberate trade — this plugin has no
 * runtime dependencies — and it is safe because every failure mode is SOFT: an
 * unparseable file yields undefined and the skill is left out, exactly as the
 * loader leaves out a file whose frontmatter it cannot read.
 *
 * @module dsh-web-ui/host/skillmd
 */
import { readFile } from 'node:fs/promises'

/**
 * The name pattern the skill loader accepts, copied from
 * `@deepseek-ai/dsh-skill`'s own `SKILL_NAME`. A client bundle may not import a
 * peer package's values, and this is a four-character regex rather than a shared
 * truth — but a skill the two sides disagree about is a skill that silently
 * disappears, so the rule is restated here with its source named.
 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** Longest name this host will create a directory for. */
const MAX_NAME_LENGTH = 100

/**
 * Whether a name is one the skill loader will accept.
 * @param name - the candidate name.
 * @returns whether the loader would load a skill called this.
 */
export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name)
}

/**
 * Turn a loader-valid name into the directory name to create.
 *
 * Returns a failure rather than a cleaned-up name: a name that needs cleaning is a
 * name this host cannot install under, and quietly installing under a DIFFERENT
 * name would leave a directory whose name contradicts the skill inside it.
 * @param name - the `name` field of a parsed `SKILL.md`.
 * @returns the directory name, or the reason to refuse.
 */
export function skillDirectoryName(name: string): { ok: true; name: string } | { ok: false; message: string } {
  if (!isSkillName(name)) {
    return {
      ok: false,
      message: `\`${name}\` is not a skill name the loader accepts (it requires lowercase letters, digits and single hyphens, e.g. test-case-generator)`,
    }
  }
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, message: `\`${name}\` is longer than ${String(MAX_NAME_LENGTH)} characters` }
  }
  return { ok: true, name }
}

/** What this plugin reads out of one `SKILL.md`. */
export interface SkillFileFacts {
  /** The skill's name, already validated against the loader's pattern. */
  readonly name: string
  /** The one-sentence description, as the skill's own card shows it. */
  readonly description: string
  /** The skill's own version when its frontmatter carries one. */
  readonly version: string | undefined
}

/**
 * Read the YAML frontmatter block of a markdown file.
 *
 * @param text - the file's content.
 * @returns the raw key/value pairs, or undefined when there is no block.
 */
function frontmatterBlock(text: string): Map<string, string> | undefined {
  // A byte-order mark is legal and would otherwise make the opening fence
  // invisible, and a CRLF file would keep a `\r` on every value.
  const normalized = text.replace(/^\uFEFF/u, '')
  const lines = normalized.split(/\r?\n/u)
  if (lines[0]?.trim() !== '---') return undefined
  const fields = new Map<string, string>()
  let key: string | undefined
  let value = ''
  const commit = (): void => {
    if (key !== undefined) fields.set(key, value.trim())
    key = undefined
    value = ''
  }
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '---') { commit(); return fields }
    const pair = /^([A-Za-z0-9_-]+):[ \t]?(.*)$/u.exec(line)
    if (pair !== null) {
      commit()
      key = pair[1]
      value = pair[2] ?? ''
      continue
    }
    // Not a new key: either a continuation of the current plain scalar (indented,
    // which is how the multi-line descriptions in this deployment's packages are
    // written) or a comment. Anything else ends the field.
    if (key === undefined) continue
    if (line.trim().startsWith('#')) continue
    if (line.trim() === '') continue
    if (/^[ \t]/u.test(line)) {
      value = `${value} ${line.trim()}`
      continue
    }
    // A line at column zero that is not `key:` means the block is malformed in a
    // way this subset cannot follow; dropping everything read so far is safer than
    // guessing which half of it was real.
    return undefined
  }
  return undefined
}

/**
 * Strip one matching pair of quotes from a scalar.
 * @param value - the raw scalar.
 * @returns the unquoted value.
 */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/**
 * Parse the facts this plugin needs out of one `SKILL.md`.
 *
 * A file without a block, without a name, without a description, or with a name
 * the loader would reject yields undefined — the same three ways the loader
 * ignores it, so a listed skill and a loadable skill are the same set.
 * @param text - the file's content.
 * @returns the facts, or undefined when the file is not a skill the loader takes.
 */
export function parseSkillFacts(text: string): SkillFileFacts | undefined {
  const fields = frontmatterBlock(text)
  if (fields === undefined) return undefined
  const name = unquote(fields.get('name') ?? '')
  const description = unquote(fields.get('description') ?? '')
  if (name === '' || description === '' || !isSkillName(name)) return undefined
  const version = unquote(fields.get('version') ?? '')
  return { name, description, version: version === '' ? undefined : version }
}

/**
 * Read one skill file's facts from disk.
 *
 * A missing or unreadable file is not an error here: a skill root is a directory
 * of things a human put there, and one unreadable entry must not empty the list.
 * @param path - absolute path of the `SKILL.md` (or of a flat `.md` skill).
 * @returns the facts, or undefined when there are none to read.
 */
export async function readSkillFacts(path: string): Promise<SkillFileFacts | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  return parseSkillFacts(text)
}
