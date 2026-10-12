/**
 * 真模型端到端验证：`embedding.text` / `embedding.image` 是否真的产出可比较的向量。
 *
 * 与 `probe.mjs` 的分工：probe 只回答「4bit 图能不能在 CPU EP 上跑起来、激活精度、延迟量级」，
 * 它**不碰分词器**（kinds 默认不含 tokenizer）。本脚本跑的是**接完分词器后的完整链路**。
 *
 * 跑法（Windows / PowerShell，Node 22）：
 *
 *   node scripts/verify-embeddings.mjs `
 *     --models  "D:/Projects/mo-gallery/.tmp/embedding-models" `
 *     --runtime "D:/Projects/mo-gallery/emulsion-desktop-v3/build/bin/resources/inference/windows-amd64" `
 *     --grid 50
 *
 * 可选的真实图片（raw RGB8：无 alpha、无行填充、逐像素 R,G,B）：
 *
 *   node scripts/verify-embeddings.mjs ... --image cats.rgb --image-size 640x480
 *
 * 两项分工刻意的理由：
 *   - **(a)(b)(d) 走 `createEmbeddingPlugin` 的协议面**（控制帧 + 数据帧），验的是宿主真正会走的路；
 *   - **(c) 走等价的直连链路**（`createEmbeddingEngine` + `tokenizer.mjs`），因为只有直连才能拿到
 *     `encodeImageFeatures().tokenCount` 这个中间量，而「input_ids 长度 = tokenCount + 4」正是要验的。
 *     (c) 先跑、跑完 `dispose()`，再起插件，峰值只驻留一份会话（视觉 + 文本塔约 727 MB）。
 */
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { parseArgs } from 'node:util'

import { createEmbeddingEngine } from '../src/engine.mjs'
import { DATA_CHUNK_BYTES, FrameDecoder, encodeDataFrame } from '../src/frames.mjs'
import { DEFAULT_GRID, MIN_GRID, patchifyRaster } from '../src/image.mjs'
import { createEmbeddingPlugin } from '../src/index.mjs'
import { DEFAULT_VARIANT, EMBEDDING_DIM_CHOICES, EMBEDDING_DIM_DEFAULT } from '../src/models.mjs'
import { onnxRuntimeRoot } from '../src/onnx.mjs'
import { encodeText, imagePlaceholderSequence, loadTokenizer, resolveRuntimeDir } from '../src/tokenizer.mjs'

const { values } = parseArgs({
  options: {
    models: { type: 'string' },
    runtime: { type: 'string' },
    variant: { type: 'string', default: DEFAULT_VARIANT },
    grid: { type: 'string', default: String(DEFAULT_GRID) },
    dim: { type: 'string', default: String(EMBEDDING_DIM_DEFAULT) },
    image: { type: 'string' },
    'image-size': { type: 'string' },
  },
})

const modelsDir = values.models
if (typeof modelsDir !== 'string' || modelsDir === '') {
  console.error('必须用 --models 指定模型目录')
  process.exit(2)
}
const runtimeDir = values.runtime ?? onnxRuntimeRoot()
if (runtimeDir === '') {
  console.error('必须用 --runtime 指定运行时目录（或设置 MO_GALLERY_EMBEDDING_RUNTIME）')
  process.exit(2)
}
// 插件内部按环境变量取运行时目录；这里显式回填，保证「脚本参数」与「插件看到的」是同一个值。
process.env.MO_GALLERY_EMBEDDING_RUNTIME = runtimeDir

const grid = Number.parseInt(values.grid, 10)
const dim = Number.parseInt(values.dim, 10)
if (!Number.isInteger(grid) || grid < MIN_GRID) {
  console.error(`--grid 必须是 >= ${MIN_GRID} 的整数`)
  process.exit(2)
}
if (!EMBEDDING_DIM_CHOICES.includes(dim)) {
  console.error(`--dim 必须是 ${EMBEDDING_DIM_CHOICES.join(' / ')} 之一`)
  process.exit(2)
}

const failures = []
function check(name, ok, detail) {
  if (ok !== true) failures.push(name)
  console.log(`${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'INFO'}  ${name}${detail === undefined ? '' : ` —— ${detail}`}`)
}
function fix(value, digits = 4) {
  return Number.isFinite(value) ? value.toFixed(digits) : String(value)
}
/** 向量已是单位长度，所以余弦就是点积。 */
function cosine(a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i]
  return dot
}
function squaredNorm(vector) {
  let sum = 0
  for (const value of vector) sum += value * value
  return sum
}
function allFinite(vector) {
  return vector.every((value) => Number.isFinite(value))
}
function rss() {
  return `${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB`
}
async function timed(run) {
  const start = performance.now()
  const value = await run()
  return { value, ms: performance.now() - start }
}

/** 合成一张确定性的彩色渐变图：只为驱动真实前向，不用于质量判断（照搬 probe.mjs）。 */
function synthesizeRaster(width, height) {
  const data = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3
      // 低频渐变 + 一点高频纹理：避免全平坦输入让某些算子走到极端分支。
      data[index] = Math.round((x / width) * 200 + ((x * 7 + y * 13) % 55))
      data[index + 1] = Math.round((y / height) * 200 + ((x * 5 + y * 3) % 55))
      data[index + 2] = Math.round(((x + y) / (width + height)) * 200 + ((x * 11) % 55))
    }
  }
  return { width, height, data }
}

console.log('=== embedding@1 端到端验证（分词器接线后） ===')
console.log(`node         : ${process.version} (${process.platform}/${process.arch})`)
console.log(`runtime dir  : ${runtimeDir}`)
console.log(`models dir   : ${modelsDir}`)
console.log(`variant/dim  : ${values.variant} / ${dim}d, grid=${grid}x${grid}`)
console.log(`rss 起始     : ${rss()}`)

// 分词器与插件共用同一份进程内缓存（同一个 ESM 模块实例），所以这里加载不会让插件重复解析。
const tokenizer = await loadTokenizer({ modelsDir, runtimeDir: resolveRuntimeDir })

// ---- (c) 图像侧联通性（直连等价链路，先跑完并释放会话）--------------------------------
console.log('\n--- (c) 合成图的完整链路（直连等价链路，先跑） ---')
{
  const edge = grid * 16
  const synthetic = synthesizeRaster(edge, edge)
  const engine = createEmbeddingEngine({ modelsDir, runtimeRoot: runtimeDir, log: (message) => console.log(`  · ${message}`) })
  try {
    const patches = patchifyRaster(synthetic, { gridWidth: grid, gridHeight: grid })
    const vision = await timed(() => engine.encodeImageFeatures(patches))
    const { imageFeatures, tokenCount } = vision.value
    console.log(`  合成图        : ${edge}×${edge} → 网格 ${grid}×${grid}，patchCount=${patches.patchCount}`)
    console.log(`  tokenCount    : ${tokenCount}（视觉编码器实际吐出的软 token 数，即占位符个数 N）`)
    console.log(`  imageFeatures : ${imageFeatures.length / tokenCount}×${tokenCount}，${vision.ms.toFixed(0)} ms`)

    const sequence = imagePlaceholderSequence(tokenCount)
    const { ids, attentionMask } = encodeText(tokenizer, sequence)
    console.log(`  input_ids     : 长度 ${ids.length}（= tokenCount + 4 = ${tokenCount + 4}）`)
    console.log(`  首尾          : [${ids.slice(0, 3).join(', ')} … ${ids.slice(-3).join(', ')}]`)
    check('input_ids 长度 = tokenCount + 4', ids.length === tokenCount + 4, `${ids.length} vs ${tokenCount + 4}`)
    check('input_ids 首尾是 bos/boi … eoi/eos', ids[0] === 2 && ids[1] === 255999 && ids[ids.length - 2] === 258882 && ids[ids.length - 1] === 1, JSON.stringify([ids[0], ids[1], ids[ids.length - 2], ids[ids.length - 1]]))
    check('attention_mask 全 1', attentionMask.every((value) => value === 1))

    const text = await timed(() => engine.embedWithModalities({ ids, attentionMask, imageFeatures, dim }))
    const vector = text.value.vector
    check('合成图向量维度 = dim', vector.length === dim, `${vector.length}`)
    check('合成图向量无 NaN/Inf', allFinite(vector))
    check('合成图向量 ‖v‖² ≈ 1', Math.abs(squaredNorm(vector) - 1) < 1e-3, `‖v‖²=${fix(squaredNorm(vector))}（${text.ms.toFixed(0)} ms）`)
  } finally {
    await engine.dispose()
    console.log(`  （已 dispose 会话，rss ${rss()}）`)
  }
}

// ---- 协议面：起插件，之后 (a)(b)(d) 全走控制帧 + 数据帧 --------------------------------
const chunks = []
const decoder = new FrameDecoder()
const plugin = createEmbeddingPlugin({
  write: (frame) => chunks.push(frame),
  modelsDirectory: modelsDir,
  log: (message) => console.log(`  · ${message}`),
})
function envelopes() {
  const frames = decoder.push(Buffer.concat(chunks))
  chunks.length = 0
  return frames.map((frame) => JSON.parse(frame.payload.toString('utf8')))
}
let requestId = 100
async function ask(envelope) {
  plugin.push({ type: 0, payload: Buffer.from(JSON.stringify(envelope), 'utf8') })
  await plugin.drain()
  return envelopes()[0]
}
async function embedText(prompt, text) {
  requestId += 1
  const reply = await ask({ jsonrpc: '2.0', id: requestId, method: 'embedding.text', params: { prompt, text, dim } })
  if (reply.error !== undefined) throw new Error(`embedding.text(${prompt}) 失败：${reply.error.code} ${reply.error.message}`)
  return reply.result
}
/** 走完整的分帧链路：控制帧声明 + 按 DATA_CHUNK_BYTES 分片的数据帧。 */
async function embedImage(raster) {
  requestId += 1
  const id = `img${requestId}`
  const { width, height, data } = raster
  plugin.push({
    type: 0,
    payload: Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'embedding.image',
      params: { image: { width, height, grid, blob: { id, length: data.length } } },
    }), 'utf8'),
  })
  for (let offset = 0; offset < data.length; offset += DATA_CHUNK_BYTES) {
    const chunk = Buffer.from(data.subarray(offset, Math.min(offset + DATA_CHUNK_BYTES, data.length)))
    // `push` 收的是**已解帧的负载**（`[1B idLen][id][4B offset][字节]`），不是整帧；
    // `encodeDataFrame` 产出的是带 5 字节帧头的整帧，所以这里剥掉帧头。
    plugin.push({ type: 1, payload: encodeDataFrame(id, offset, chunk).subarray(5) })
  }
  await plugin.drain()
  const reply = envelopes()[0]
  if (reply.error !== undefined) throw new Error(`embedding.image 失败：${reply.error.code} ${reply.error.message}`)
  return reply.result
}

// ---- (a) 同一句子两种前缀 --------------------------------------------------------------
console.log('\n--- (a) searchQuery / document 两种前缀都能出向量（走插件协议面） ---')
const sentence = 'cats sleeping on a couch'
const a = await timed(() => embedText('searchQuery', sentence))
const b = await timed(() => embedText('document', sentence))
check('searchQuery 返回向量', a.value.embedding.length === dim && allFinite(a.value.embedding), `dim=${a.value.embedding.length} 声明dim=${a.value.dim} norm=${a.value.norm} ${a.ms.toFixed(0)} ms`)
check('document 返回向量', b.value.embedding.length === dim && allFinite(b.value.embedding), `dim=${b.value.embedding.length} 声明dim=${b.value.dim} norm=${b.value.norm} ${b.ms.toFixed(0)} ms`)
check('两种前缀的 ‖v‖² ≈ 1', Math.abs(squaredNorm(a.value.embedding) - 1) < 1e-3 && Math.abs(squaredNorm(b.value.embedding) - 1) < 1e-3, `‖q‖²=${fix(squaredNorm(a.value.embedding))} ‖d‖²=${fix(squaredNorm(b.value.embedding))}`)
check('两种前缀的向量不同（前缀真的进了模型）', Math.abs(cosine(a.value.embedding, b.value.embedding) - 1) > 1e-6, `cos=${fix(cosine(a.value.embedding, b.value.embedding))}`)

// ---- (b) 文本相似度 sanity --------------------------------------------------------------
console.log('\n--- (b) 文本相似度 sanity ---')
const query = (await embedText('searchQuery', 'cats sleeping on a couch')).embedding
const docCat = (await embedText('document', 'A photo of a cat')).embedding
const docTurtle = (await embedText('document', 'a turtle swimming in the ocean')).embedding
const cosCat = cosine(query, docCat)
const cosTurtle = cosine(query, docTurtle)
console.log(`  cos(query, "A photo of a cat")                = ${fix(cosCat)}`)
console.log(`  cos(query, "a turtle swimming in the ocean")  = ${fix(cosTurtle)}`)
check('猫的余弦明显高于乌龟', cosCat > cosTurtle + 0.05, `差值 ${fix(cosCat - cosTurtle)}（阈值 0.05：这是单图排序 sanity，不是精度评测）`)

// ---- (c2) 同一合成图走插件协议面：证明协议链路也通到文本塔 -----------------------------
console.log('\n--- (c2) 合成图走插件协议面（控制帧 + 数据帧） ---')
{
  const edge = grid * 16
  const result = await timed(() => embedImage(synthesizeRaster(edge, edge)))
  const vector = result.value.embedding
  check('embedding.image 返回向量', vector.length === dim && allFinite(vector), `dim=${vector.length} 声明dim=${result.value.dim} norm=${result.value.norm} ${result.ms.toFixed(0)} ms`)
  check('图像向量 ‖v‖² ≈ 1', Math.abs(squaredNorm(vector) - 1) < 1e-3, `‖v‖²=${fix(squaredNorm(vector))}`)
}

// ---- (d) 真实图片的跨模态排序（可选）---------------------------------------------------
if (typeof values.image === 'string' && values.image !== '') {
  console.log('\n--- (d) 跨模态：真实图片 × 文本 query ---')
  const [imageWidth, imageHeight] = (values['image-size'] ?? '').split('x').map((item) => Number.parseInt(item, 10))
  if (!Number.isInteger(imageWidth) || !Number.isInteger(imageHeight) || imageWidth <= 0 || imageHeight <= 0) {
    console.error('用 --image 时必须同时给 --image-size <宽>x<高>（raw RGB8）')
    process.exit(2)
  }
  const raw = readFileSync(values.image)
  if (raw.length !== imageWidth * imageHeight * 3) {
    console.error(`--image 文件 ${raw.length} 字节，与 --image-size ${imageWidth}x${imageHeight} 的 RGB8 (${imageWidth * imageHeight * 3}) 不符`)
    process.exit(2)
  }
  const realImage = await timed(() => embedImage({ width: imageWidth, height: imageHeight, data: raw }))
  const imageVector = realImage.value.embedding
  check('真实图片返回向量', imageVector.length === dim && allFinite(imageVector), `dim=${imageVector.length} ${realImage.ms.toFixed(0)} ms`)
  check('真实图片向量 ‖v‖² ≈ 1', Math.abs(squaredNorm(imageVector) - 1) < 1e-3, `‖v‖²=${fix(squaredNorm(imageVector))}`)
  const queries = [
    ['cats sleeping on a couch', 0.74],
    ["a president's speech about serving your country", 0.462],
    ['a turtle swimming in the ocean', 0.508],
  ]
  const scored = []
  for (const [text, reference] of queries) {
    const vector = (await embedText('searchQuery', text)).embedding
    const score = cosine(vector, imageVector)
    scored.push({ text, score })
    console.log(`  cos(image, "${text}") = ${fix(score)}  （模型卡参考 ${reference}）`)
  }
  const sorted = [...scored].sort((left, right) => right.score - left.score)
  check('排序与模型卡一致（猫排第一）', sorted[0].text.startsWith('cats'), `第一名：${sorted[0].text} (${fix(sorted[0].score)})`)
}

console.log('\n--- 资源 ---')
console.log(`rss 结束     : ${rss()}（单份会话；文本塔 + 视觉塔同时驻留）`)
console.log(`\n结论：${failures.length === 0 ? 'PASS（全部检查通过）' : `FAIL（${failures.length} 项未通过：${failures.join('；')}）`}`)
process.exit(failures.length === 0 ? 0 : 1)
