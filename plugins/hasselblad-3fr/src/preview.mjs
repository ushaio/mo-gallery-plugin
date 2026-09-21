export const LIMITS = Object.freeze({ chunk: 256 * 1024, preview: 32 * 1024 * 1024,
  scan: 64 * 1024 * 1024, read: 128 * 1024 * 1024, calls: 4096, pixels: 80000000,
  directories: 128, depth: 16, entries: 1024, candidates: 512, markers: 65536 })
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max
class InvalidJPEG extends Error {}
const invalid = () => { throw new InvalidJPEG('Invalid JPEG') }

export function validateRequest(p) {
  if (!p || p.extension !== '.3fr' || !p.input || typeof p.input.id !== 'string' ||
      !p.input.id.length || p.input.id.length > 256 || !integer(p.input.size, 8, Number.MAX_SAFE_INTEGER) ||
      !integer(p.maxPreviewBytes, 4, LIMITS.preview) || !integer(p.maxPixels, 1, LIMITS.pixels)) {
    throw new Error('Invalid 3FR preview request or limits')
  }
}

// rawRead is an exact random-range reader. All I/O, including probes and fallback,
// passes this single per-extraction budget. No filesystem path is accepted.
export function boundedReader(size, rawRead, budget = LIMITS.read) {
  let bytes = 0, calls = 0
  return async (offset, length) => {
    if (!integer(offset, 0, size) || !integer(length, 0, LIMITS.chunk) || length > size - offset) throw new Error('Invalid read range')
    if (++calls > LIMITS.calls || length > budget - bytes) throw new Error('Read budget exceeded')
    bytes += length
    const data = await rawRead(offset, length)
    if (!(data instanceof Uint8Array) || data.length !== length) throw new Error('Short or invalid transfer read')
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }
}

async function jpeg(read, start, size, maxBytes, maxPixels) {
  const end = start + Math.min(size - start, maxBytes)
  let pos = start, base = -1, block = Buffer.alloc(0), width = 0, height = 0, scans = 0, entropy = false
  const fill = async () => {
    if (pos >= end) invalid()
    if (pos < base || pos >= base + block.length) {
      base = pos; block = await read(pos, Math.min(64 * 1024, end - pos))
    }
  }
  const byte = async () => { await fill(); return block[pos++ - base] }
  const word = async () => (await byte()) * 256 + await byte()
  if (await word() !== 0xffd8) invalid()
  for (let count = 0; count < LIMITS.markers;) {
    if (entropy) {
      for (;;) {
        await fill()
        const at = block.indexOf(255, pos - base)
        if (at >= 0) { pos = base + at; break }
        pos = base + block.length
      }
    }
    if (await byte() !== 255) invalid()
    let marker = await byte(), fills = 0
    while (marker === 255) { if (++fills > 65536) invalid(); marker = await byte() }
    if (entropy && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue
    count++ // Stuffed entropy bytes and restart markers are not structural markers.
    entropy = false
    if (marker === 0xd9) {
      if (!width || !scans) invalid()
      return { mimeType: 'image/jpeg', offset: start, length: pos - start, width, height }
    }
    if (marker === 0 || marker === 0xd8 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) invalid()
    const length = await word(), payload = pos
    if (length < 2 || length - 2 > end - pos) invalid()
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (width || length < 11 || await byte() !== 8) invalid()
      height = await word(); width = await word()
      const components = await byte()
      if (![1, 3, 4].includes(components) || length !== 8 + 3 * components || !width || !height || width * height > maxPixels) invalid()
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) invalid()
    if (marker === 0xda) {
      if (!width || length < 8) invalid()
      const components = await byte()
      if (components < 1 || components > 4 || length !== 6 + components * 2) invalid()
      entropy = true; scans++
    }
    pos = payload + length - 2
  }
  invalid()
}

export async function extractPreview(params, rawRead, options = {}) {
  validateRequest(params)
  const { input, maxPreviewBytes, maxPixels } = params
  const read = boundedReader(input.size, rawRead, options.readBudget ?? LIMITS.read)
  const header = await read(0, 8), order = header.toString('ascii', 0, 2)
  if (order !== 'II' && order !== 'MM') throw new Error('Not classic TIFF 3FR')
  const u16 = (b, p) => order === 'II' ? b.readUInt16LE(p) : b.readUInt16BE(p)
  const u32 = (b, p) => order === 'II' ? b.readUInt32LE(p) : b.readUInt32BE(p)
  if (u16(header, 2) !== 42) throw new Error('Not classic TIFF 3FR')
  let best = null
  const candidates = new Set(), probed = new Set(), visited = new Set(), pending = [[u32(header, 4), 0]]
  const consider = async offset => {
    if (!integer(offset, 8, input.size - 4) || probed.has(offset)) return
    // Sensor strips consume only a three-byte probe/read-call budget, not a JPEG slot.
    if (probed.size >= LIMITS.calls) throw new Error('Read budget exceeded')
    probed.add(offset)
    const probe = await read(offset, 3)
    if (probe[0] !== 255 || probe[1] !== 216 || probe[2] !== 255) return
    if (candidates.size >= LIMITS.candidates) throw new Error('Candidate budget exceeded')
    candidates.add(offset)
    try {
      const found = await jpeg(read, offset, input.size, maxPreviewBytes, maxPixels)
      if (!best || found.width * found.height > best.width * best.height) best = found
    } catch (error) { if (!(error instanceof InvalidJPEG)) throw error }
  }
  while (pending.length && visited.size < LIMITS.directories) {
    const [offset, depth] = pending.shift()
    if (depth > LIMITS.depth || offset < 8 || offset > input.size - 2 || visited.has(offset)) continue
    visited.add(offset)
    const count = u16(await read(offset, 2), 0), length = count * 12 + 4
    if (count > LIMITS.entries || length > input.size - offset - 2) continue
    const table = await read(offset + 2, length)
    const enqueue = value => { if (pending.length < LIMITS.directories * 2) pending.push([value, depth + 1]) }
    enqueue(u32(table, count * 12))
    for (let i = 0; i < count; i++) {
      const p = i * 12, tag = u16(table, p), type = u16(table, p + 2), n = u32(table, p + 4)
      const pointer = [330, 34665, 34853].includes(tag), preview = [273, 324, 513].includes(tag)
      if ((!pointer && !preview) || ![1, 3, 4, 13].includes(type) || !n) continue
      const unit = type === 1 ? 1 : type === 3 ? 2 : 4
      const take = Math.min(n, pointer ? LIMITS.directories : LIMITS.candidates)
      let values = table.subarray(p + 8, p + 12)
      if (n * unit > 4) {
        const at = u32(table, p + 8)
        if (at < 8 || at > input.size || take * unit > input.size - at) continue
        values = await read(at, take * unit)
      }
      for (let j = 0; j < take; j++) {
        const value = unit === 1 ? values[j] : unit === 2 ? u16(values, j * 2) : u32(values, j * 4)
        if (pointer) enqueue(value)
        else await consider(value)
      }
    }
  }
  // Exhaustive only for small files. One-byte overlap catches SOI at chunk edges.
  if (input.size <= LIMITS.scan) {
    let previous = -1
    for (let offset = 0; offset < input.size;) {
      const block = await read(offset, Math.min(LIMITS.chunk, input.size - offset))
      if (previous === 255 && block[0] === 216) await consider(offset - 1)
      for (let at = block.indexOf(Buffer.from([255, 216])); at >= 0; at = block.indexOf(Buffer.from([255, 216]), at + 2)) await consider(offset + at)
      previous = block.at(-1); offset += block.length
    }
  }
  if (!best) throw new Error('No usable contiguous embedded JPEG preview')
  return best
}
