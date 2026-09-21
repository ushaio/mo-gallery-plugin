import { readFileSync } from 'node:fs'
import { HASH_VERSION, perceptualHash, representativeGroups } from './algorithm.mjs'

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'))
const commands = [{
  id: 'find-similar-images', title: 'Find similar images',
  description: 'Image-only pHash candidates grouped by distance to a representative, not exact duplicates. No automatic deletion.',
  parameters: [{ key: 'threshold', label: 'Maximum distance to representative', locales: { zh: { label: '与代表图的最大距离' } }, type: 'integer', default: 8, minimum: 0, maximum: 64 }],
  resultType: 'asset-groups', autoRunAfterScan: true,
  locales: { zh: { title: '查找相似图片', description: '仅检查图片，按与代表图的 pHash 距离分组；不代表文件完全相同，不会自动删除。' } },
  extension: { name: 'Image Similarity', description: 'Review visually similar images in your local library.', locales: { zh: { name: '相似图片', description: '检查本地资源库中视觉相似的图片。' } } },
  presentation: {
    help: 'Lower distance thresholds are stricter. Crops, rotations and low-detail images can produce missed or false matches.',
    resultHint: 'Review each image manually. The first image is the representative; group members need not match each other.',
    emptyMessage: 'No candidate groups at this threshold in this completed snapshot.',
    locales: { zh: {
      help: '距离阈值越小越严格。裁剪、旋转和低纹理图片可能漏判或误判。',
      resultHint: '请逐张人工检查。第一张是代表图，组内其他图片不保证两两相似。',
      emptyMessage: '本次已完成快照中没有符合此阈值的候选分组。',
    } },
  },
}]
let state = 'idle', threshold = 8, images = [], groups = [], seen = new Set()
function run(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid request')
  switch (input.phase) {
    case 'start': {
      if (input.commandId !== commands[0].id) throw new Error('Unknown command')
      const params = input.parameters ?? {}
      if (Object.keys(params).some(key => key !== 'threshold')) throw new Error('Unknown parameter')
      threshold = params.threshold ?? 8
      if (!Number.isInteger(threshold) || threshold < 0 || threshold > 64) throw new Error('Threshold must be 0..64')
      state = 'running'; images = []; groups = []; seen = new Set()
      return { total: 0 }
    }
    case 'batch': {
      if (state !== 'running' || !Array.isArray(input.images) || input.images.length > 32 || images.length + input.images.length > 20000) throw new Error('Invalid batch or image budget exceeded')
      const cache = Object.create(null)
      for (const image of input.images) {
        if (typeof image.id !== 'string' || !image.id || image.id.length > 128 || seen.has(image.id) || typeof image.sourceVersion !== 'string' || image.sourceVersion.length > 256) throw new Error('Invalid image metadata')
        let hash
        if (image.cache?.version === HASH_VERSION && /^[0-9a-f]{16}$/.test(image.cache.hash)) hash = BigInt(`0x${image.cache.hash}`)
        else {
          if (typeof image.pixels !== 'string' || image.pixels.length > 1400) throw new Error('Invalid pixels')
          hash = perceptualHash(Buffer.from(image.pixels, 'base64'))
        }
        seen.add(image.id); images.push({ id: image.id, hash })
        cache[image.id] = { version: HASH_VERSION, hash: hash.toString(16).padStart(16, '0') }
      }
      return { cache, total: images.length }
    }
    case 'finish':
      if (state !== 'running') throw new Error('Task is not running')
      groups = representativeGroups(images, threshold); images = []; state = 'completed'
      return { total: groups.length }
    case 'results': {
      const { offset = 0, limit = 32 } = input
      if (state !== 'completed' || !Number.isInteger(offset) || offset < 0 || offset > groups.length || !Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error('Invalid result page')
      return { groups: groups.slice(offset, offset + limit), total: groups.length }
    }
    default: throw new Error('Unknown library phase')
  }
}
function reply(id, result, error) {
  process.stdout.write(JSON.stringify(error ? { jsonrpc: '2.0', id, error: { code: -32602, message: error.message } } : { jsonrpc: '2.0', id, result }) + '\n')
}
// Bounded newline transport, sequential host-driven batches. Cancellation closes
// the dedicated process, so no task state or pending work can survive a session.
let pending = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  pending += chunk
  if (Buffer.byteLength(pending) > 512 * 1024) { process.exitCode = 1; process.stdin.destroy(); return }
  for (;;) {
    const end = pending.indexOf('\n'); if (end < 0) break
    const line = pending.slice(0, end); pending = pending.slice(end + 1)
    let request
    try {
      request = JSON.parse(line)
      if (!Number.isSafeInteger(request.id)) continue // notifications, including cancellation
      if (request.method === 'plugin.getManifest') reply(request.id, manifest)
      else if (request.method === 'library.getCommands') reply(request.id, commands)
      else if (request.method === 'library.run') reply(request.id, run(request.params))
      else reply(request.id, undefined, new Error('Method not found'))
    } catch (error) { if (request?.id != null) reply(request.id, undefined, error) }
  }
})
process.stdin.on('end', () => { images = []; groups = [] })
