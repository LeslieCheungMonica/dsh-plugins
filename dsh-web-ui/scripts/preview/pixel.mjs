/**
 * Read single pixels out of a browser screenshot.
 *
 * Why this exists: everything else in `measure-stage-tag.mjs` reads COMPUTED
 * STYLES, and a computed style is a promise, not a picture — a masked
 * `conic-gradient` ring, a white check glyph on a green disc, or a tinted row can
 * all compute correctly and still paint nothing (a broken mask, an icon that
 * resolves to the wrong colour, a rule that loses the cascade to the theme). The
 * only way to know what the browser actually drew is to look at the pixels, and
 * nothing in this deployment can LOOK at them: every configured model takes text
 * only.
 *
 * So the pixels are read back as numbers instead. Playwright returns a PNG, and a
 * PNG this small is a signature, one IHDR, one IDAT and one IEND — small enough
 * to decode with `node:zlib` and no image library, which is what this module
 * does. It handles exactly what a screenshot of a page produces: 8-bit truecolor,
 * no interlace, alpha or not.
 */
import { inflateSync } from 'node:zlib'

/** An RGB colour as three 0–255 channels. */
export const rgb = (r, g, b) => ({ r, g, b })

/**
 * Whether a colour is dominated by its green channel — the test that says "this
 * pixel is the flow's green" without demanding an exact value, so an
 * anti-aliased edge or a themed variant of the same green still passes.
 * @param colour - the sampled colour.
 * @returns true when green is clearly the strongest channel.
 */
export const isGreen = colour => colour.g > colour.r + 30 && colour.g > colour.b + 30

/** Signature of every PNG. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * Undo one scanline's filter (the PNG spec's five types).
 * @param type - the filter byte.
 * @param line - the filtered bytes of this row.
 * @param previous - the already-decoded row above, or zeros for the first row.
 * @param bpp - bytes per pixel.
 * @returns the decoded row.
 */
function unfilter(type, line, previous, bpp) {
  const out = Buffer.alloc(line.length)
  for (let i = 0; i < line.length; i += 1) {
    const raw = line[i]
    const left = i >= bpp ? out[i - bpp] : 0
    const up = previous[i]
    const upLeft = i >= bpp ? previous[i - bpp] : 0
    let value
    switch (type) {
      case 0: value = raw; break
      case 1: value = raw + left; break
      case 2: value = raw + up; break
      case 3: value = raw + ((left + up) >> 1); break
      case 4: {
        // Paeth: whichever neighbour is closest to left + up - upLeft.
        const p = left + up - upLeft
        const dl = Math.abs(p - left)
        const du = Math.abs(p - up)
        const dul = Math.abs(p - upLeft)
        value = raw + (dl <= du && dl <= dul ? left : (du <= dul ? up : upLeft))
        break
      }
      default: throw new Error(`pixel: unknown PNG filter ${type}`)
    }
    out[i] = value & 0xff
  }
  return out
}

/**
 * Decode a PNG screenshot.
 * @param buffer - the PNG bytes.
 * @returns the image, with a channel reader.
 * @throws {Error} on an interlaced or non-8-bit PNG (neither is what a
 * screenshot produces, and guessing would be worse than failing).
 */
export function decodePng(buffer) {
  for (const [index, byte] of PNG_SIGNATURE.entries()) {
    if (buffer[index] !== byte) throw new Error('pixel: not a PNG')
  }
  let offset = PNG_SIGNATURE.length
  let header = null
  const data = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colorType: body[9],
        interlace: body[12],
      }
    }
    if (type === 'IDAT') data.push(body)
    offset += 12 + length
  }
  if (header === null) throw new Error('pixel: PNG has no IHDR')
  if (header.depth !== 8 || header.interlace !== 0) {
    throw new Error(`pixel: unsupported PNG (depth ${header.depth}, interlace ${header.interlace})`)
  }
  if (header.colorType !== 2 && header.colorType !== 6) {
    throw new Error(`pixel: unsupported PNG colour type ${header.colorType}`)
  }
  const channels = header.colorType === 6 ? 4 : 3
  const stride = header.width * channels
  const raw = inflateSync(Buffer.concat(data))
  const rows = []
  for (let y = 0; y < header.height; y += 1) {
    const start = y * (stride + 1)
    const filterType = raw[start]
    const line = raw.subarray(start + 1, start + 1 + stride)
    const previous = y === 0 ? Buffer.alloc(stride) : rows[y - 1]
    rows.push(unfilter(filterType, line, previous, channels))
  }
  return {
    width: header.width,
    height: header.height,
    /**
     * The colour at one pixel.
     * @param x - column, from the left.
     * @param y - row, from the top.
     * @returns the three channels (alpha is dropped: this page is opaque).
     */
    at(x, y) {
      const row = rows[y]
      if (row === undefined) throw new Error(`pixel: y ${y} is outside the image`)
      const index = x * channels
      return rgb(row[index], row[index + 1], row[index + 2])
    },
  }
}
