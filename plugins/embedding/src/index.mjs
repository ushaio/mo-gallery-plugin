/**
 * embedding@1 插件的协议入口。
 *
 * 宿主（`emulsion-desktop-v3/storage_plugins/`）启动这个进程后：
 *
 *   1. 发 `plugin.getManifest`，核对 id / version 与 `embedding@1` 贡献，否则握手失败；
 *   2. 发 `embedding.getModelSpecs`，把插件声明的模型（文件、体积、sha256、许可、来源）
 *      当作唯一真相，自己去下载校验——宿主**不硬编码任何模型清单**（与 faces@1 同一条约定）；
 *   3. `embedding.health` 供探活（**只查体积、不做哈希**，可被频繁调用）；
 *   4. 之后调 `embedding.text` / `embedding.image` 取向量。
 *
 * 像素不走 JSON：控制帧在 `params.image.blob = {id, length}` 里声明长度，紧随其后的二进制数据帧
 * 带字节（见 `frames.mjs`）。一条 `embedding.image` 的生命周期是「控制帧 → 攒数据帧 → 推理 →
 * 控制帧回应」，攒的过程中不回任何东西。
 *
 * 四条刻意的约束：
 *
 * - **stdout 只有协议帧**，日志一律走 stderr（宿主会把 stderr 拼进退出错误里，正好用来排障）。
 * - **单条错误不能毒化整个进程**：参数错误只回错误码，流继续；只有帧级损坏（长度/类型非法，
 *   流已无法重新对齐）才退出。
 * - **不做插件侧缓存**：请求里既没有资产 id 也没有内容哈希，落盘缓存无法被稳定地键索引；跳过与
 *   重算的判定权在宿主。插件只保留「模型哈希已校验」这一层进程内缓存。
 * - **不猜任何 token**：占位符与序列装配由 `tokenizer.mjs` 按 HF 处理器的约定给出
 *   （`<|image>` + `<|image|>`×N + `<image|>`，N 取视觉编码器实际吐出的 token 数），
 *   本文件不硬编码任何 token id。
 */

import process from 'node:process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createEmbeddingEngine } from './engine.mjs'
import { ERROR_CODES, ProtocolError, RPC_ERRORS, toRpcError } from './errors.mjs'
import {
  FRAME_TYPE_CONTROL,
  FRAME_TYPE_DATA,
  FrameDecoder,
  MAX_BLOB_BYTES,
  decodeDataFrame,
  encodeControlFrame,
  isValidBlobID,
} from './frames.mjs'
import { DEFAULT_GRID, MIN_GRID, patchifyRaster } from './image.mjs'
import {
  DEFAULT_VARIANT,
  EMBEDDING_DIM_CHOICES,
  EMBEDDING_DIM_DEFAULT,
  MODEL_LICENSE,
  TASK_PROMPTS,
  UPSTREAM_REVISION,
  modelSpecs,
} from './models.mjs'
import { onnxRuntimeRoot } from './onnx.mjs'
import { encodeText, imagePlaceholderSequence, loadTokenizer, resolveRuntimeDir } from './tokenizer.mjs'

/** 模型声明协议版本：宿主 EmbeddingProtocol 必须等于它。 */
export const EMBEDDING_PROTOCOL = 1
/** 算法身份，写进宿主的审计记录。 */
export const ENGINE = Object.freeze({ name: 'emulsion-embedding', version: '0.1.0' })
/** 贡献域与版本：与宿主 embeddingDomain / embeddingAPIVersion 一致。 */
export const EMBEDDING_DOMAIN = 'embedding'
export const EMBEDDING_API_VERSION = '1'
/** 对宿主可见的方法集合（顺序无关，仅用于文档与测试断言）。 */
export const METHODS = Object.freeze([
  'plugin.getManifest',
  'embedding.getModelSpecs',
  'embedding.health',
  'embedding.text',
  'embedding.image',
])

/** 宿主送进来的整图是 RGB8 交错、无 alpha。 */
const CHANNEL_COUNT = 3
/** 单边上限，与 faces@1 的 `FACE_MAX_EDGE` 取同量级：宿主有现成的缩图管线。 */
const MAX_IMAGE_EDGE = 1024

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 读插件自己的 manifest.json：握手必须原样回显宿主机读到的那个文件。 */
export function readManifest(path = join(PACKAGE_ROOT, 'manifest.json')) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * 成功响应的形状（宿主 `storage_plugins/embedding.go` 的 `EmbeddingVector`）：
 * `{"embedding": []float32, "norm": float64, "dim": int}`。
 *
 * **口径说明**：契约注释的口径是「embedding 是 raw 未归一化向量、norm 是其模长，宿主自行 L2」，
 * 但宿主当前根本不消费 norm（`local_library/embedding_inference.go` 里 grep `Norm|norm|l2` 无匹配），
 * 而引擎内部已把「截断到 MRL 维度 + 重新 L2 归一化」做成不可拆的一步
 * （`models.mjs` 的 `truncateAndNormalize`，设计文档 §1 的硬约定）。因此这里返回
 * **单位向量 + `norm: 1`**：与「raw + 模长」在现有宿主代码里等价（宿主自己 L2 一次，结果相同），
 * 又不给宿主留「拿到未归一化向量却忘了归一化」的机会。若宿主将来真的开始用 norm 做 L2，
 * 这里必须改成返回 raw 向量与真实模长——这是一次**有意的语义选择**，不是疏忽。
 */
function vectorPayload(vector, dim) {
  return { embedding: Array.from(vector), norm: 1, dim }
}

/**
 * 把请求参数变成真正喂给模型的文本：**前缀由插件统一注入**。
 *
 * 卡片原文「omitting the recommended task prefix … reduces precision」——缺前缀不报错、只是质量
 * 变差，所以不允许调用方裸传文本。抽成纯函数是为了让这条不变量能被单测直接钉住。
 *
 * @param {string} prompt {@link TASK_PROMPTS} 的键
 * @param {{ text?: string, title?: string }} params
 */
export function buildTextInput(prompt, params = {}) {
  if (typeof prompt !== 'string' || typeof TASK_PROMPTS[prompt] !== 'function') {
    throw new ProtocolError(
      ERROR_CODES.BAD_REQUEST,
      `params.prompt must be one of ${Object.keys(TASK_PROMPTS).join(', ')}`,
    )
  }
  if (typeof params.text !== 'string' || params.text === '') {
    throw new ProtocolError(ERROR_CODES.BAD_REQUEST, 'params.text must be a non-empty string')
  }
  if (prompt === 'document') {
    return TASK_PROMPTS.document(params.text, typeof params.title === 'string' ? params.title : null)
  }
  return TASK_PROMPTS[prompt](params.text)
}

function optionalDim(value) {
  if (value === undefined || value === null) return EMBEDDING_DIM_DEFAULT
  if (!Number.isInteger(value) || !EMBEDDING_DIM_CHOICES.includes(value)) {
    throw new ProtocolError(
      ERROR_CODES.BAD_REQUEST,
      `dim must be one of ${EMBEDDING_DIM_CHOICES.join(', ')}`,
    )
  }
  return value
}

/** 校验 `params.image` 的形状与声明，返回攒数据帧所需的信息。 */
function declaredImage(params) {
  const image = params === null || typeof params !== 'object' ? undefined : params.image
  if (image === null || typeof image !== 'object' || Array.isArray(image)) {
    throw new ProtocolError(ERROR_CODES.BAD_REQUEST, 'params.image is required')
  }
  const { width, height } = image
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new ProtocolError(ERROR_CODES.DECODE_FAILED, 'image width and height must be positive integers')
  }
  if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) {
    throw new ProtocolError(ERROR_CODES.DECODE_FAILED, `image exceeds the ${MAX_IMAGE_EDGE} px limit per edge`)
  }
  const blob = image.blob
  if (blob === null || typeof blob !== 'object' || Array.isArray(blob)) {
    throw new ProtocolError(ERROR_CODES.BAD_REQUEST, 'params.image.blob is required')
  }
  if (!isValidBlobID(blob.id)) {
    throw new ProtocolError(ERROR_CODES.BAD_REQUEST, 'params.image.blob.id is invalid')
  }
  const expected = width * height * CHANNEL_COUNT
  if (expected > MAX_BLOB_BYTES) {
    throw new ProtocolError(ERROR_CODES.DECODE_FAILED, `image of ${width}x${height} exceeds the ${MAX_BLOB_BYTES} byte limit`)
  }
  if (!Number.isInteger(blob.length) || blob.length !== expected) {
    throw new ProtocolError(
      ERROR_CODES.DECODE_FAILED,
      `declared blob length ${blob.length} does not match ${width}x${height} RGB (${expected} bytes)`,
    )
  }
  const grid = image.grid === undefined ? DEFAULT_GRID : image.grid
  if (!Number.isInteger(grid) || grid < MIN_GRID) {
    // 网格下限是**模型约束**不是偏好：实测 16×16 会让视觉图内部张量越界（设计文档 §5.5）。
    throw new ProtocolError(ERROR_CODES.BAD_REQUEST, `image.grid must be an integer >= ${MIN_GRID}`)
  }
  return { width, height, id: blob.id, length: blob.length, grid }
}

/** 模型声明：宿主据此下载与校验，插件不再重复声明体积/哈希。 */
function modelSpecsPayload({ variant = DEFAULT_VARIANT, kinds = ['text', 'vision', 'tokenizer'] } = {}) {
  return {
    protocol: EMBEDDING_PROTOCOL,
    engine: ENGINE,
    revision: UPSTREAM_REVISION,
    variant,
    dims: { native: 768, default: EMBEDDING_DIM_DEFAULT, choices: EMBEDDING_DIM_CHOICES },
    grid: { default: DEFAULT_GRID, min: MIN_GRID },
    prompts: Object.keys(TASK_PROMPTS),
    license: MODEL_LICENSE,
    models: modelSpecs({ variant, kinds }).map((spec) => ({
      id: spec.id,
      kind: spec.kind,
      file: spec.file,
      sizeBytes: spec.sizeBytes,
      sha256: spec.sha256,
      license: MODEL_LICENSE.license,
      licenseUrl: MODEL_LICENSE.licenseUrl,
      source: spec.source,
    })),
  }
}

/** 探活：只查体积，不算哈希（哈希在首次建会话时做一次）。 */
function healthPayload(modelsDirectory, specs) {
  const models = specs.map((spec) => {
    let size = null
    try {
      size = statSync(join(modelsDirectory, spec.file)).size
    } catch {
      size = null
    }
    return { file: spec.file, kind: spec.kind, present: size !== null, sizeMatches: size === spec.sizeBytes }
  })
  return {
    engine: ENGINE,
    protocol: EMBEDDING_PROTOCOL,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    modelsDirectory: modelsDirectory === '' ? null : modelsDirectory,
    models,
    ready: models.every((item) => item.sizeMatches),
  }
}

/**
 * 插件实例。`write` 是帧出口（生产环境写 stdout；测试可直接收集），
 * 便于在没有子进程的情况下把整套协议跑完。
 */
export function createEmbeddingPlugin({
  write,
  manifestValue = readManifest(),
  modelsDirectory = (process.env.MO_GALLERY_EMBEDDING_MODELS ?? '').trim(),
  log = () => {},
} = {}) {
  if (typeof write !== 'function') throw new TypeError('write is required')
  let queue = Promise.resolve()
  /** 正在等数据帧的那个请求（宿主串行调用，所以同时只可能有一个）。 */
  let pending = null
  /** 分词器单例（存 Promise：并发请求只加载一次；失败会退出缓存，下次重试）。 */
  let tokenizerPromise = null
  /** 引擎单例。首次取用时才建会话（建会话要校验哈希 + 加载 200 MB 权重，很贵）。 */
  let engine = null

  function tokenizerInstance() {
    if (tokenizerPromise === null) {
      tokenizerPromise = loadTokenizer({ modelsDir: modelsDirectory, runtimeDir: resolveRuntimeDir })
      tokenizerPromise.catch(() => {
        tokenizerPromise = null
      })
    }
    return tokenizerPromise
  }

  function engineInstance() {
    if (engine === null) {
      // 显式传 runtimeRoot：让「运行时目录从哪来」在本文件里可读，不依赖 engine.mjs 的默认参数
      // （engine.mjs 现在也自己 import 了 onnxRuntimeRoot，两条路等价）。
      engine = createEmbeddingEngine({ modelsDir: modelsDirectory, runtimeRoot: onnxRuntimeRoot(), log })
    }
    return engine
  }

  function reply(id, result, error) {
    const envelope = { jsonrpc: '2.0', id }
    if (error === undefined) envelope.result = result
    else envelope.error = error
    write(encodeControlFrame(envelope))
  }

  /** 串行执行：Node 是单线程，推理本身就是瓶颈，串行让调用顺序完全确定。 */
  function enqueue(work) {
    queue = queue.then(work).catch((error) => {
      log(`plugin task failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    return queue
  }

  async function runText(params) {
    // 顺序很重要：参数错先报 BAD_REQUEST（调用方的错，能立即修），再撞模型缺失（MODEL_MISSING，
    // 用户能自己补齐），最后才是推理失败。混起来会把排障方向带偏。
    const text = buildTextInput(params?.prompt, params)
    const dim = optionalDim(params?.dim)
    const tokenizer = await tokenizerInstance()
    const { ids, attentionMask } = encodeText(tokenizer, text)
    const { vector } = await engineInstance().embedTokenIds(ids, { attentionMask, dim })
    return vectorPayload(vector, dim)
  }

  async function runImage(pixels, declared, params) {
    const dim = optionalDim(params?.dim)
    const patches = patchifyRaster(
      { width: declared.width, height: declared.height, data: pixels },
      { gridWidth: declared.grid, gridHeight: declared.grid },
    )
    // 视觉编码器先跑：它的 tokenCount 就是占位符个数 N。
    //
    // 这里**不能**用 `embedImagePatches`——那个方法会自己再跑一次视觉编码器（同一个前向白算一遍，
    // 50×50 网格实测 4.4 秒），而文本塔要的是「已算好的 imageFeatures」，所以拆开跑。
    const { imageFeatures, tokenCount } = await engineInstance().encodeImageFeatures(patches)
    const tokenizer = await tokenizerInstance()
    // N 必须等于视觉编码器实际 token 数：文本塔按占位符位置 scatter imageFeatures，
    // 个数对不上是**静默劣化**（不报错），所以这里只能用它，不能猜。
    const { ids, attentionMask } = encodeText(tokenizer, imagePlaceholderSequence(tokenCount))
    const { vector } = await engineInstance().embedWithModalities({ ids, attentionMask, imageFeatures, dim })
    return vectorPayload(vector, dim)
  }

  /** 处理一条控制帧：要么立即应答，要么转成「等数据帧」状态。 */
  function handleControl(payload) {
    if (pending !== null) {
      // 上一条 blob 请求还没攒完，却来了新控制帧：流已经不同步了。
      throw new ProtocolError(
        ERROR_CODES.INTERNAL,
        `received a control frame while waiting for ${pending.declared.length} bytes of blob ${pending.declared.id}`,
      )
    }
    let envelope
    try {
      envelope = JSON.parse(payload.toString('utf8'))
    } catch {
      reply(null, undefined, { code: RPC_ERRORS.PARSE_ERROR, message: 'control frame is not JSON' })
      return
    }
    const id = envelope?.id ?? null
    const method = envelope?.method
    if (typeof method !== 'string' || method === '') {
      reply(id, undefined, { code: RPC_ERRORS.INVALID_REQUEST, message: 'method is required' })
      return
    }
    const params = envelope.params ?? {}

    if (method === 'plugin.getManifest') {
      reply(id, manifestValue)
      return
    }
    if (method === 'embedding.getModelSpecs') {
      enqueue(async () => {
        try {
          reply(id, modelSpecsPayload({ variant: params.variant ?? DEFAULT_VARIANT, kinds: params.kinds ?? undefined }))
        } catch (error) {
          reply(id, undefined, toRpcError(error))
        }
      })
      return
    }
    if (method === 'embedding.health') {
      enqueue(async () => {
        try {
          reply(id, healthPayload(modelsDirectory, modelSpecs()))
        } catch (error) {
          reply(id, undefined, toRpcError(error))
        }
      })
      return
    }
    if (method === 'embedding.text') {
      enqueue(async () => {
        try {
          reply(id, await runText(params))
        } catch (error) {
          reply(id, undefined, toRpcError(error))
        }
      })
      return
    }
    if (method === 'embedding.image') {
      let declared
      try {
        declared = declaredImage(params)
      } catch (error) {
        reply(id, undefined, toRpcError(error))
        return
      }
      // 先校验再收字节：参数不成立时不该让宿主白传 3 MiB。
      pending = { id, declared, params, chunks: [], received: 0 }
      return
    }
    reply(id, undefined, { code: RPC_ERRORS.METHOD_NOT_FOUND, message: `unknown method: ${method}` })
  }

  /** 处理一条数据帧：攒字节，攒够就执行。 */
  function handleData(payload) {
    const { id, offset, chunk } = decodeDataFrame(payload)
    if (pending === null || pending.declared.id !== id) {
      throw new ProtocolError(ERROR_CODES.INTERNAL, `unexpected data frame for blob ${id}`)
    }
    if (offset !== pending.received) {
      throw new ProtocolError(
        ERROR_CODES.INTERNAL,
        `blob ${id} arrived out of order: expected offset ${pending.received}, got ${offset}`,
      )
    }
    if (pending.received + chunk.length > pending.declared.length) {
      throw new ProtocolError(ERROR_CODES.INTERNAL, `blob ${id} exceeded its declared length`)
    }
    pending.chunks.push(Buffer.from(chunk))
    pending.received += chunk.length
    if (pending.received !== pending.declared.length) return

    const request = pending
    pending = null
    const pixels = Buffer.concat(request.chunks, request.declared.length)
    enqueue(async () => {
      try {
        reply(request.id, await runImage(pixels, request.declared, request.params))
      } catch (error) {
        reply(request.id, undefined, toRpcError(error))
      }
    })
  }

  return {
    /** 喂入一条已解码的帧。 */
    push(frame) {
      if (frame.type === FRAME_TYPE_CONTROL) handleControl(frame.payload)
      else if (frame.type === FRAME_TYPE_DATA) handleData(frame.payload)
    },
    /** 等所有已入队的工作写完回应；关停前调用，避免丢掉已算完的答案。 */
    drain() {
      return queue
    },
    /** 当前是否在等数据帧（测试与排障用）。 */
    pendingBlob() {
      return pending === null ? null : { id: pending.declared.id, declared: pending.declared.length, received: pending.received }
    },
  }
}

/** 进程入口：stdin 收帧、stdout 只写协议帧、日志走 stderr。 */
function main() {
  const log = (message) => process.stderr.write(`[embedding] ${message}\n`)
  const plugin = createEmbeddingPlugin({ write: (frame) => process.stdout.write(frame), log })
  const decoder = new FrameDecoder()
  process.stdin.on('data', (chunk) => {
    let frames
    try {
      frames = decoder.push(chunk)
    } catch (error) {
      // 帧级损坏无法重新对齐流，只能停。
      log(`framing failed: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
    for (const frame of frames) {
      try {
        plugin.push(frame)
      } catch (error) {
        log(`protocol failed: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    }
  })
  process.stdin.on('end', () => {
    plugin.drain().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  })
  process.stdin.resume()
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main()
