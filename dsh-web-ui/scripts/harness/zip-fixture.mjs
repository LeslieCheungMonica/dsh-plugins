/**
 * A deliberately dumb ZIP builder, for the harnesses that must feed an archive
 * this host should refuse.
 *
 * The safety of the install path is only as good as the hostile archives it is
 * tested against, and no real ZIP will ever contain `../etc/passwd` or a symlink
 * entry. So the harness BUILDS them: a local header, the data, a central
 * directory, and an end-of-central-directory record — enough structure for the
 * reader under test, and small enough to read in one sitting.
 *
 * It is not a general ZIP writer and does not aim to be: no data descriptors, no
 * Zip64, no encryption, no CRCs (the reader does not verify them), and every field
 * a test wants to lie about is a parameter.
 */
import { deflateRawSync } from 'node:zlib'

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50

/** Unix file-type bits a test can put in an entry's external attributes. */
export const UNIX_REGULAR = 0x8000
export const UNIX_SYMLINK = 0xa000
export const UNIX_FIFO = 0x1000
export const UNIX_DIRECTORY = 0x4000

/**
 * Build one ZIP.
 * @param {Array<object>} entries - one per entry: `name` (string), `data`
 * (string|Buffer, default empty), `method` (0 stored, 8 deflate; default 0),
 * `unixMode` (file-type bits plus permissions; default a regular file),
 * `declaredSize` (override the uncompressed size the header claims, for a lying
 * archive), `raw` (Buffer appended as-is instead of `data`).
 * @returns {Buffer} the archive.
 */
export function buildZip(entries) {
  const parts = []
  const directory = []
  let offset = 0
  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8')
    const raw = entry.raw !== undefined
      ? entry.raw
      : Buffer.from(entry.data ?? '')
    const method = entry.method ?? 0
    const compressed = method === 8 ? deflateRawSync(raw) : raw
    const declaredSize = entry.declaredSize ?? raw.length
    const header = Buffer.alloc(30)
    header.writeUInt32LE(LOCAL_SIGNATURE, 0)
    header.writeUInt16LE(20, 4)
    // Bit 11: names are UTF-8. Set for every entry so a Chinese file name in a
    // fixture travels the way a real package's does.
    header.writeUInt16LE(0x800, 6)
    header.writeUInt16LE(method, 8)
    header.writeUInt32LE(0, 10)
    header.writeUInt32LE(0, 14)
    header.writeUInt32LE(compressed.length, 18)
    header.writeUInt32LE(declaredSize, 22)
    header.writeUInt16LE(nameBuffer.length, 26)
    header.writeUInt16LE(0, 28)
    parts.push(header, nameBuffer, compressed)
    directory.push({ nameBuffer, compressed, declaredSize, method, offset, entry })
    offset += header.length + nameBuffer.length + compressed.length
  }

  const centralParts = []
  for (const record of directory) {
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(CENTRAL_SIGNATURE, 0)
    cd.writeUInt16LE(0x031e, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x800, 8)
    cd.writeUInt16LE(record.method, 10)
    cd.writeUInt32LE(0, 12)
    cd.writeUInt32LE(0, 16)
    cd.writeUInt32LE(record.compressed.length, 20)
    cd.writeUInt32LE(record.declaredSize, 24)
    cd.writeUInt16LE(record.nameBuffer.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    const mode = record.entry.unixMode ?? (UNIX_REGULAR | 0o644)
    cd.writeUInt32LE((mode << 16) >>> 0, 38)
    cd.writeUInt32LE(record.offset, 42)
    centralParts.push(cd, record.nameBuffer)
  }
  const central = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(directory.length, 8)
  eocd.writeUInt16LE(directory.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...parts, central, eocd])
}

/**
 * The `SKILL.md` a well-formed fixture skill carries.
 * @param {object} fields - `name`, `description`, and any extra frontmatter lines.
 * @returns {string} the file's text.
 */
export function skillMarkdown({ name = 'fixture-skill', description = '一个用于测试的技能。', ...rest } = {}) {
  const extra = Object.entries(rest).map(([key, value]) => `${key}: ${value}`).join('\n')
  return `---\nname: ${name}\ndescription: ${description}${extra === '' ? '' : `\n${extra}`}\n---\n\n# 标题\n\n正文。\n`
}
