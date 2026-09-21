export const HASH_VERSION = 'dct32-ac8-v1'
const cos = Array.from({ length: 8 }, (_, u) =>
  Float64Array.from({ length: 32 }, (_, x) => Math.cos((2 * x + 1) * u * Math.PI / 64)))

// The host supplies area-filtered 32x32 luminance. Separable orthonormal DCT;
// DC is excluded from the median and bit 0 is always zero. Round near-zero
// coefficients to suppress platform floating-point noise on flat images.
export function perceptualHash(pixels) {
  if (!(pixels instanceof Uint8Array) || pixels.length !== 1024) throw new Error('Expected 1024 grayscale bytes')
  const rows = new Float64Array(32 * 8)
  for (let y = 0; y < 32; y++) for (let u = 0; u < 8; u++) {
    let sum = 0
    for (let x = 0; x < 32; x++) sum += pixels[y * 32 + x] * cos[u][x]
    rows[y * 8 + u] = sum
  }
  const coefficients = new Float64Array(64)
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
    let sum = 0
    for (let y = 0; y < 32; y++) sum += rows[y * 8 + u] * cos[v][y]
    sum *= (u === 0 ? Math.SQRT1_2 : 1) * (v === 0 ? Math.SQRT1_2 : 1) / 16
    coefficients[v * 8 + u] = Math.round(sum * 1e8) / 1e8
  }
  const median = [...coefficients.slice(1)].sort((a, b) => a - b)[31]
  let hash = 0n
  for (let i = 1; i < 64; i++) if (coefficients[i] > median) hash |= 1n << BigInt(i)
  return hash
}
export function hamming(a, b) {
  let bits = a ^ b, count = 0
  while (bits) { bits &= bits - 1n; count++ }
  return count
}

// Exact BK-tree search over representatives only. Members never become anchors,
// so A~B~C does not imply A~C. Deterministic first matching anchor, not a claim
// that every similar pair in the dataset will appear together.
export function representativeGroups(images, threshold, { signal, budget = 5_000_000 } = {}) {
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 64) throw new Error('Threshold must be 0..64')
  if (images.length > 20000) throw new Error('Image budget exceeded; no partial results')
  let root, operations = 0
  const anchors = [], ids = new Set()
  const tick = () => {
    if (signal?.aborted) throw new Error('Cancelled')
    if (++operations > budget) throw new Error('Comparison budget exceeded; no partial results')
  }
  for (const image of images) {
    tick()
    if (typeof image.id !== 'string' || !image.id || ids.has(image.id) || typeof image.hash !== 'bigint' || image.hash < 0n || image.hash > 0xffffffffffffffffn) throw new Error('Invalid image hash or ID')
    ids.add(image.id)
    let match
    const pending = root ? [root] : []
    while (pending.length) {
      tick()
      const node = pending.pop(), distance = hamming(image.hash, node.hash)
      if (distance <= threshold && (!match || node.index < match.index)) match = node
      for (const [edge, child] of node.children) if (edge >= distance - threshold && edge <= distance + threshold) pending.push(child)
    }
    if (match) { match.members.push(image.id); match.maxDistance = Math.max(match.maxDistance, hamming(image.hash, match.hash)); continue }
    const node = { hash: image.hash, id: image.id, members: [], children: new Map(), index: anchors.length, maxDistance: 0 }
    anchors.push(node)
    if (!root) { root = node; continue }
    let parent = root
    for (;;) {
      tick()
      const edge = hamming(parent.hash, node.hash)
      if (!parent.children.has(edge)) { parent.children.set(edge, node); break }
      parent = parent.children.get(edge)
    }
  }
  const groups = []
  for (const anchor of anchors) {
    // Split large groups into bounded pages, repeating the same representative.
    for (let start = 0; start < anchor.members.length; start += 255) {
      groups.push({
        id: `group-${anchor.index}-${start / 255}`,
        title: 'Visually similar candidates',
        description: 'Each member is within the threshold of the first image only. Members need not match one another. Equal hashes (including zero) do not prove identical files. Review manually; no deletion is recommended automatically.',
        locales: { zh: { title: '视觉相似候选', description: '每张图片仅保证与第一张代表图的距离在阈值内，其他成员未必两两相似。指纹相同（包括零距离）不证明文件相同。请人工检查，不会自动推荐删除。' } },
        assetIds: [anchor.id, ...anchor.members.slice(start, start + 255)],
        metrics: [{ label: 'Maximum distance to representative', value: String(anchor.maxDistance), locales: { zh: { label: '与代表图的最大距离' } } }, { label: 'Threshold', value: String(threshold), locales: { zh: { label: '距离阈值' } } }],
      })
    }
  }
  return groups
}
