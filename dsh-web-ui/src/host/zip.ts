/**
 * Reading an untrusted ZIP, in process, under a hard safety posture.
 *
 * A downloaded skill package is a file from a service, and it is about to be
 * unpacked into a directory that this host's skill loader reads. That makes it
 * the one piece of input in this plugin that is both UNTRUSTED and WRITTEN TO
 * DISK, so this module exists to make the refusal list explicit and testable
 * rather than to be fast.
 *
 * ## Why not `unzip`
 *
 * The plugin has no runtime dependencies and the host already pays for the tools
 * it shells out to (`git`, `lark-cli`). A write path is the worst place to add
 * another one, and — the real reason — a subprocess would move the security
 * question into a binary's behaviour: this harness can BUILD a hostile archive
 * and assert that THIS code refuses it, which is not something `unzip`'s
 * behaviour can be held to. `node:zlib` has `inflateRawSync`, which is all a ZIP
 * needs beyond the header parsing below.
 *
 * ## The refusals, and what each one is for
 *
 * - **Path escape** (`../`, an absolute path, a drive letter, a backslash, a
 *   control character): the classic zip-slip, where an entry writes outside the
 *   directory it was unpacked into. Every entry name is normalized and validated
 *   BEFORE anything is written, and the extractor below re-checks containment
 *   against the resolved root as a second, independent guard.
 * - **Links and specials**: a symlink entry (or a hardlink, device, or fifo)
 *   would let an archive point a NAME inside the target directory at a path
 *   outside it — the same escape, one indirection later. Only regular files and
 *   directories are accepted.
 * - **Bombs and sizes**: four independent caps (entry count, per-entry bytes,
 *   total bytes, compression ratio) plus `zlib`'s own `maxOutputLength`, so a
 *   header that LIES about its uncompressed size cannot allocate its way through.
 * - **Zip64 and multi-disk**: refused rather than misparsed. Their offsets live in
 *   records this reader does not implement, and a wrong offset read as a valid one
 *   is exactly the kind of silent misbehaviour this module exists to prevent.
 *
 * What this module does NOT do: it does not write anything (see
 * `extractZipInto`), and it does not decide WHICH entries a skill needs.
 *
 * @module dsh-web-ui/host/zip
 */
import { inflateRawSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

/** Why an archive could not be read. */
export type ZipFailure =
  /** Not a ZIP at all, truncated, corrupt, Zip64, or split across disks. */
  | 'archive-invalid'
  /** Readable, but holds an entry this host refuses to unpack. */
  | 'unsafe-archive'
  /** Readable and safe, but past one of the size caps. */
  | 'archive-too-large'

/** How one archive failed, with the entry that caused it where there is one. */
export interface ZipError {
  /** The machine code. */
  readonly code: ZipFailure
  /** One sentence naming the entry or the cap. */
  readonly message: string
}

/** One entry, already validated and decompressed. */
export interface ZipEntry {
  /** The normalized relative path, always `/`-separated. */
  readonly path: string
  /** Whether the entry names a directory. */
  readonly directory: boolean
  /** The entry's bytes (empty for a directory). */
  readonly content: Buffer
}

/** The caps every read is held to. */
export interface ZipLimits {
  /** Most entries one archive may hold. */
  readonly maxEntries: number
  /** Most bytes one entry may decompress to. */
  readonly maxEntryBytes: number
  /** Most bytes the whole archive may decompress to. */
  readonly maxTotalBytes: number
  /**
   * Most bytes one entry may decompress to per compressed byte. The bomb guard
   * for entries big enough to matter (`maxEntryBytes` is the blunt one).
   */
  readonly maxRatio: number
}

/** The caps a skill package is read under. See the module comment. */
export const SKILL_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2000,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  // 200:1. The sample this was written against decompresses ~3.4:1, and a text
  // skill package is nowhere near this; a ratio past it is a decompression bomb
  // rather than a document.
  maxRatio: 200,
}

/** Bytes of a ZIP that may sit between the last entry and the end of the file. */
const EOCD_SEARCH_BYTES = 65_557

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const ZIP64_EOCD_LOCATOR = 0x07064b50

/** Compression methods this reader implements. */
const METHOD_STORED = 0
const METHOD_DEFLATE = 8

/** Unix mode bits, from a central entry's external attributes. */
const UNIX_FILE_TYPE = 0xf000
const UNIX_SYMLINK = 0xa000

/**
 * Validate and normalize one entry name.
 *
 * Returns the normalized path rather than a boolean so callers cannot forget to
 * use it: the validated form is the only form this module hands out.
 * @param raw - the name exactly as the archive holds it.
 * @returns the normalized `/`-separated relative path, or the reason to refuse.
 */
export function safeRelativePath(raw: string): { ok: true; path: string } | { ok: false; message: string } {
  if (raw.length === 0) return { ok: false, message: 'an entry has an empty name' }
  if (raw.length > 1024) return { ok: false, message: 'an entry name is longer than 1024 characters' }
  // eslint-disable-next-line no-control-regex -- the point IS to reject control characters
  if (/[\u0000-\u001f]/u.test(raw)) return { ok: false, message: `entry name ${JSON.stringify(raw)} holds a control character` }
  // A backslash is a separator on Windows and a literal character here, so the
  // same archive would mean two different trees. Refused rather than guessed at.
  if (raw.includes('\\')) return { ok: false, message: `entry name ${JSON.stringify(raw)} uses a backslash separator` }
  if (raw.startsWith('/')) return { ok: false, message: `entry name ${JSON.stringify(raw)} is an absolute path` }
  if (/^[A-Za-z]:/u.test(raw)) return { ok: false, message: `entry name ${JSON.stringify(raw)} is a drive-qualified path` }
  const segments: string[] = []
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return { ok: false, message: `entry name ${JSON.stringify(raw)} escapes the target directory` }
    if (Buffer.byteLength(segment, 'utf8') > 255) {
      return { ok: false, message: `entry name ${JSON.stringify(raw)} has a segment longer than 255 bytes` }
    }
    segments.push(segment)
  }
  if (segments.length === 0) return { ok: false, message: `entry name ${JSON.stringify(raw)} names no file` }
  return { ok: true, path: segments.join('/') }
}

/**
 * Locate the end-of-central-directory record.
 * @param buffer - the whole archive.
 * @returns the record's offset, or undefined when there is none.
 */
function findEocd(buffer: Buffer): number | undefined {
  const floor = Math.max(0, buffer.length - EOCD_SEARCH_BYTES)
  for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  return undefined
}

/**
 * Read every entry of a ZIP, validating each one, and decompress it.
 *
 * All-or-nothing: one refused entry refuses the archive, because a skill whose
 * package is partly unpacked is a skill that will misbehave later instead of now.
 * @param buffer - the archive's bytes.
 * @param limits - the caps to hold it to.
 * @returns the entries, or the first reason to refuse.
 */
export function readZip(buffer: Buffer, limits: ZipLimits = SKILL_ZIP_LIMITS): { ok: true; entries: ZipEntry[] } | { ok: false; error: ZipError } {
  const invalid = (message: string): { ok: false; error: ZipError } => ({ ok: false, error: { code: 'archive-invalid', message } })
  const unsafe = (message: string): { ok: false; error: ZipError } => ({ ok: false, error: { code: 'unsafe-archive', message } })
  const tooLarge = (message: string): { ok: false; error: ZipError } => ({ ok: false, error: { code: 'archive-too-large', message } })

  const eocd = findEocd(buffer)
  if (eocd === undefined) return invalid('the download is not a ZIP archive (no end-of-central-directory record)')
  // Zip64 keeps its real counts and offsets in a separate record. Refusing beats
  // reading 0xffff as a literal count and mis-slicing the directory — and an
  // archive short enough to have no room for the locator is refused as invalid
  // rather than allowed to throw out of a bounds read.
  if (eocd < 20) return invalid('the archive is too short to be a ZIP this host reads')
  if (buffer.readUInt32LE(eocd - 20) === ZIP64_EOCD_LOCATOR) {
    return invalid('the archive is Zip64, which this host does not unpack')
  }
  const diskNumber = buffer.readUInt16LE(eocd + 4)
  const directoryDisk = buffer.readUInt16LE(eocd + 6)
  if (diskNumber !== 0 || directoryDisk !== 0) return invalid('the archive is split across disks')
  const total = buffer.readUInt16LE(eocd + 10)
  if (total === 0xffff) return invalid('the archive holds more entries than this host reads')
  const directorySize = buffer.readUInt32LE(eocd + 12)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)
  if (directoryOffset + directorySize > buffer.length) return invalid('the archive\'s central directory runs past its end')
  if (total > limits.maxEntries) {
    return tooLarge(`the archive holds ${String(total)} entries, past this host's limit of ${String(limits.maxEntries)}`)
  }

  const entries: ZipEntry[] = []
  let written = 0
  let offset = directoryOffset
  for (let index = 0; index < total; index += 1) {
    if (offset + 46 > buffer.length) return invalid('the archive\'s central directory is truncated')
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      return invalid(`central directory entry ${String(index + 1)} has a wrong signature`)
    }
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const externalAttributes = buffer.readUInt32LE(offset + 38)
    const localOffset = buffer.readUInt32LE(offset + 42)
    if (offset + 46 + nameLength > buffer.length) return invalid('a central directory entry name runs past the archive')
    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength)
    // Bit 11 is the "names are UTF-8" flag. Without it the historical encoding is
    // CP437, which node cannot decode; latin1 is the closest lossless reading and
    // is only ever used for names this host will refuse or write verbatim.
    const name = rawName.toString((flags & 0x800) !== 0 ? 'utf8' : 'latin1')
    offset += 46 + nameLength + extraLength + commentLength

    const directory = name.endsWith('/')
    const unixMode = (externalAttributes >>> 16) & 0xffff
    if ((unixMode & UNIX_FILE_TYPE) === UNIX_SYMLINK) {
      return unsafe(`entry ${JSON.stringify(name)} is a symbolic link`)
    }
    // A directory's "mode" also carries S_IFDIR; anything else that is not a
    // regular file (a fifo, a device, a socket) has no business in a skill.
    const type = unixMode & UNIX_FILE_TYPE
    if (!directory && type !== 0 && type !== 0x8000) {
      return unsafe(`entry ${JSON.stringify(name)} is not a regular file or a directory`)
    }

    const safe = safeRelativePath(name)
    if (!safe.ok) return unsafe(safe.message)

    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      return invalid(`entry ${JSON.stringify(name)} uses compression method ${String(method)}, which this host does not read`)
    }
    if (uncompressedSize > limits.maxEntryBytes) {
      return tooLarge(`entry ${JSON.stringify(name)} declares ${String(uncompressedSize)} bytes, past this host's per-file limit of ${String(limits.maxEntryBytes)}`)
    }
    if (compressedSize > 0 && uncompressedSize > 1024 * 1024 && uncompressedSize / compressedSize > limits.maxRatio) {
      return tooLarge(`entry ${JSON.stringify(name)} expands ${String(Math.round(uncompressedSize / compressedSize))}:1, past this host's ratio limit`)
    }
    written += uncompressedSize
    if (written > limits.maxTotalBytes) {
      return tooLarge(`the archive expands past this host's total limit of ${String(limits.maxTotalBytes)} bytes`)
    }
    if (directory) {
      entries.push({ path: safe.path, directory: true, content: Buffer.alloc(0) })
      continue
    }

    // The LOCAL header is the authority on where the data starts: its own
    // name/extra lengths may differ from the central copy's (a data descriptor
    // is one reason), so both lengths are read again here.
    if (localOffset + 30 > buffer.length) return invalid(`entry ${JSON.stringify(name)} points past the archive`)
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      return invalid(`entry ${JSON.stringify(name)} has a wrong local header signature`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + compressedSize > buffer.length) return invalid(`entry ${JSON.stringify(name)} runs past the archive`)
    const payload = buffer.subarray(dataStart, dataStart + compressedSize)

    let content: Buffer
    if (method === METHOD_STORED) {
      content = Buffer.from(payload)
    } else {
      try {
        // `maxOutputLength` is the SECOND bomb guard: an entry that lies about
        // its uncompressed size still cannot allocate past the per-entry cap.
        content = inflateRawSync(payload, { maxOutputLength: limits.maxEntryBytes })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return invalid(`entry ${JSON.stringify(name)} could not be decompressed: ${reason}`)
      }
    }
    // A declared size that does not match what came out means the archive is not
    // what it says it is, which is worth refusing rather than writing.
    if (content.length !== uncompressedSize) {
      return invalid(`entry ${JSON.stringify(name)} declares ${String(uncompressedSize)} bytes but expands to ${String(content.length)}`)
    }
    entries.push({ path: safe.path, directory: false, content })
  }
  return { ok: true, entries }
}

/**
 * Write validated entries under one directory.
 *
 * The containment check here is deliberately independent of
 * {@link safeRelativePath}: that function decides what a name MEANS, and this one
 * proves where it LANDS, on the resolved absolute paths. Two guards, because one
 * guard that is wrong is a directory full of somebody else's files.
 *
 * The caller owns the target directory's existence and its emptiness: this
 * function creates what is missing beneath it and overwrites nothing that was
 * already there (the caller has already refused a non-empty target).
 * @param root - the absolute directory to unpack into.
 * @param entries - validated entries from {@link readZip}.
 * @returns the number of files written, or a failure describing the first write.
 */
export async function extractZipInto(
  root: string,
  entries: readonly ZipEntry[],
): Promise<{ ok: true; files: number; bytes: number } | { ok: false; message: string }> {
  const base = resolve(root)
  const fence = base.endsWith(sep) ? base : `${base}${sep}`
  let files = 0
  let bytes = 0
  for (const entry of entries) {
    const target = resolve(join(base, entry.path))
    if (!target.startsWith(fence)) {
      return { ok: false, message: `entry ${JSON.stringify(entry.path)} would be written outside ${base}` }
    }
    try {
      if (entry.directory) {
        await mkdir(target, { recursive: true })
        continue
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, entry.content, { flag: 'wx' })
      files += 1
      bytes += entry.content.length
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { ok: false, message: `could not write ${entry.path}: ${reason}` }
    }
  }
  return { ok: true, files, bytes }
}
