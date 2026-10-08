/**
 * faces@1 插件的协议入口。
 *
 * 宿主（`emulsion-desktop-v3/storage_plugins/faces.go`）启动这个进程后：
 *
 *   1. 发 `plugin.getManifest`，核对 id / version / `faces@1` 贡献，否则握手失败；
 *   2. 发 `faces.getModelSpecs`，把插件声明的模型（文件、体积、sha256、许可）当作唯一真相，
 *      自己去下载校验——宿主不再硬编码任何模型清单；
 *   3. 之后每次分析只调两个方法：`face.detect` 与 `face.embed`。
 *
 * 像素不走 JSON：控制帧在 `params.image.blob = {id, length}` 里声明长度，紧随其后的二进制
 * 数据帧带字节（见 `frames.mjs`）。所以一条 `face.detect` 的生命周期是「控制帧 → 攒数据帧 →
 * 推理 → 控制帧回应」，攒的过程中不回任何东西。
 *
 * 三条刻意的约束：
 *
 * - **stdout 只有协议帧**，日志一律走 stderr（宿主会把 stderr 拼进退出错误里，正好用来排障）。
 * - **单条错误不能毒化整个进程**：参数错误只回错误码，流继续；只有帧级损坏（长度/类型非法，
 *   流已无法重新对齐）才退出。
 * - **不做插件侧缓存**：faces@1 的请求里没有资产 id、也没有内容哈希，落盘缓存无法被稳定地键
 *   索引；跳过与重算的判定权在宿主（`face_index_status` + 内容哈希门）。插件只保留「模型哈希
 *   已校验」这一层进程内缓存。
 */

import process from 'node:process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
import { FACE_CHANNEL_COUNT, FACE_MAX_EDGE, parseFaceRaster } from './face.mjs'
import { inspectModels, modelSpecs, verifiedModelCount } from './models.mjs'
import { createFaceEngine } from './engine.mjs'

/** 模型声明协议版本：宿主 FacesProtocol 必须等于它。 */
export const FACES_PROTOCOL = 1
/** 算法身份，写进宿主的 FaceIndexStatus / face_models 审计。 */
export const ENGINE = Object.freeze({ name: 'emulsion-faces', version: '0.1.0' })
/** 贡献域与版本：与宿主 facesDomain / facesAPIVersion 一致。 */
export const FACES_DOMAIN = 'faces'
export const FACES_API_VERSION = '1'
/** 对宿主可见的方法集合（顺序无关，仅用于文档与测试断言）。 */
export const METHODS = Object.freeze([
  'plugin.getManifest',
  'faces.getModelSpecs',
  'faces.health',
  'face.detect',
  'face.embed',
])

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 读插件自己的 manifest.json：握手必须原样回显宿主机读到的那个文件。 */
export function readManifest(path = join(PACKAGE_ROOT, 'manifest.json')) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function optionalNumber(value, key, minimum, maximum) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ProtocolError(
      ERROR_CODES.BAD_REQUEST,
      `${key} must be a number between ${minimum} and ${maximum}`,
    )
  }
  return value
}

function optionalTopK(value) {
  if (value === undefined || value === null) return undefined
  if (!Number.isInteger(value) || value < 1 || value > 1000000) {
    throw new ProtocolError(ERROR_CODES.BAD_REQUEST, 'topK must be a positive integer')
  }
  return value
}

function detectionOptions(params) {
  const options = {}
  const scoreThreshold = optionalNumber(params.scoreThreshold, 'scoreThreshold', 0, 1)
  const nmsThreshold = optionalNumber(params.nmsThreshold, 'nmsThreshold', 0, 1)
  const topK = optionalTopK(params.topK)
  if (scoreThreshold !== undefined) options.scoreThreshold = scoreThreshold
  if (nmsThreshold !== undefined) options.nmsThreshold = nmsThreshold
  if (topK !== undefined) options.topK = topK
  return options
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
  if (width > FACE_MAX_EDGE || height > FACE_MAX_EDGE) {
    throw new ProtocolError(
      ERROR_CODES.DECODE_FAILED,
      `image exceeds the ${FACE_MAX_EDGE} px limit per edge`,
    )
  }
  const blob = image.blob
  if (blob === null || typeof blob !== 'object' || Array.isArray(blob)) {
    throw new ProtocolError(ERROR_CODES.BAD_REQUEST, 'params.image.blob is required')
  }
  if (!isValidBlobID(blob.id)) {
    throw new ProtocolError(ERROR_CODES.BAD_REQUEST, 'params.image.blob.id is invalid')
  }
  const expected = width * height * FACE_CHANNEL_COUNT
  if (expected > MAX_BLOB_BYTES) {
    throw new ProtocolError(
      ERROR_CODES.DECODE_FAILED,
      `image of ${width}x${height} exceeds the ${MAX_BLOB_BYTES} byte limit`,
    )
  }
  if (!Number.isInteger(blob.length) || blob.length !== expected) {
    throw new ProtocolError(
      ERROR_CODES.DECODE_FAILED,
      `declared blob length ${blob.length} does not match ${width}x${height} RGB (${expected} bytes)`,
    )
  }
  return { width, height, id: blob.id, length: blob.length }
}

/** 五点顺序：右眼 / 左眼 / 鼻尖 / 右嘴角 / 左嘴角（与 OpenCV 模板一致）。 */
function parseLandmarks(value) {
  if (!Array.isArray(value) || value.length !== 5) {
    throw new ProtocolError(ERROR_CODES.BAD_REQUEST, 'landmarks must be 5 [x, y] pairs')
  }
  return value.map((point, index) => {
    if (!Array.isArray(point) || point.length !== 2) {
      throw new ProtocolError(ERROR_CODES.BAD_REQUEST, `landmark ${index} must be a [x, y] pair`)
    }
    const [x, y] = point
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new ProtocolError(ERROR_CODES.BAD_REQUEST, `landmark ${index} must be finite numbers`)
    }
    return [x, y]
  })
}

/**
 * 插件实例。`write` 是帧出口（生产环境写 stdout；测试可直接收集），
 * 便于在没有子进程的情况下把整套协议跑完。
 */
export function createFacesPlugin({
  write,
  manifestValue = readManifest(),
  modelsDirectory = (process.env.MO_GALLERY_FACE_MODELS ?? '').trim(),
  engine = null,
  log = () => {},
} = {}) {
  if (typeof write !== 'function') throw new TypeError('write is required')
  const pendings = new Map()
  let queue = Promise.resolve()
  const inflight = new Set()
  let faceEngine = engine
  let pendingClose = null

  function engineInstance() {
    if (faceEngine === null) {
      faceEngine = createFaceEngine({ modelsDir: modelsDirectory, log })
    }
    return faceEngine
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

  /**
   * 登记一件「不排队但要写完回应」的工作（目前只有 faces.health）。
   * 没有它，`drain()` 就漏掉这些回应，关停时可能把已完成的答案丢掉。
   */
  function track(promise) {
    const tracked = promise.then(
      () => {},
      () => {},
    )
    inflight.add(tracked)
    void tracked.then(() => inflight.delete(tracked))
    return tracked
  }

  function failPending(pending, error) {
    pendings.delete(pending.id)
    reply(pending.rpcID, null, toRpcError(error))
  }

  async function health() {
    return {
      engine: ENGINE,
      modelsDir: modelsDirectory,
      models: await inspectModels(modelsDirectory),
      // 插件不保存人脸分析缓存（请求里没有可稳定索引的资产身份），这里如实汇报的只有
      // 「已经校验过哈希的模型文件条数」，bytes 恒为 0。
      cache: { entries: verifiedModelCount(), bytes: 0 },
    }
  }

  async function execute(pending, raster) {
    // 引擎错误必须变成 JSON-RPC error 而不是异常：宿主靠错误码区分「这张照片有问题」与
    // 「这台机器的人脸推理不可用」，被吞掉的异常会让它误判成进程级故障。
    try {
      if (pending.method === 'face.detect') {
        const result = await engineInstance().detect(raster, detectionOptions(pending.params))
        reply(pending.rpcID, result)
        return
      }
      const landmarks = parseLandmarks(pending.params.landmarks)
      const result = await engineInstance().embed(raster, landmarks)
      reply(pending.rpcID, { embedding: result.embedding, norm: result.norm })
    } catch (error) {
      reply(pending.rpcID, null, toRpcError(error))
    }
  }
  function complete(pending) {
    let raster
    try {
      raster = parseFaceRaster({ width: pending.width, height: pending.height, data: pending.data })
    } catch (error) {
      reply(pending.rpcID, null, toRpcError(error))
      return
    }
    const message = pending
    enqueue(() => execute(message, raster))
  }

  function declare(request) {
    let declared
    try {
      declared = declaredImage(request.params)
      if (request.method === 'face.embed') parseLandmarks(request.params.landmarks)
    } catch (error) {
      reply(request.id, null, toRpcError(error))
      return
    }
    if (pendings.has(declared.id)) {
      // 宿主的 awaitBlob 把「id 复用」当协议错误；这里同样拒绝新的那条，保留在途的。
      reply(request.id, null, {
        code: ERROR_CODES.BAD_REQUEST,
        message: `blob id is already in use: ${declared.id}`,
      })
      return
    }
    pendings.set(declared.id, {
      id: declared.id,
      length: declared.length,
      received: 0,
      data: Buffer.allocUnsafe(declared.length),
      width: declared.width,
      height: declared.height,
      method: request.method,
      params: request.params,
      rpcID: request.id,
    })
  }

  function handleControl(payload) {
    let request
    try {
      request = JSON.parse(payload)
    } catch {
      reply(null, null, { code: RPC_ERRORS.PARSE_ERROR, message: 'request is not valid JSON' })
      return
    }
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      reply(null, null, { code: RPC_ERRORS.INVALID_REQUEST, message: 'request must be a JSON object' })
      return
    }
    // 通知（无 id）与宿主的取消通知不需要回应；宿主不实现 $/cancelRequest，取消靠关进程。
    if (!Number.isSafeInteger(request.id)) {
      log(`ignoring message without an id: ${String(request.method)}`)
      return
    }
    switch (request.method) {
      case 'plugin.getManifest':
        reply(request.id, manifestValue)
        return
      case 'faces.getModelSpecs':
        reply(request.id, { protocol: FACES_PROTOCOL, engine: ENGINE, models: modelSpecs() })
        return
      case 'faces.health':
        // health 不进推理队列：它只 stat 模型文件、读一个计数器，不碰 ONNX 会话。排在
        // detect 后面会让「索引正在跑」时设置页的健康检查顶到宿主的 10 s 超时。
        track(
          health().then(
            (value) => reply(request.id, value),
            (error) => reply(request.id, null, toRpcError(error)),
          ),
        )
        return
      case 'face.detect':
      case 'face.embed':
        declare(request)
        return
      default:
        reply(request.id, null, {
          code: RPC_ERRORS.METHOD_NOT_FOUND,
          message: `method not found: ${String(request.method)}`,
        })
    }
  }

  function handleData(payload) {
    let frame
    try {
      frame = decodeDataFrame(payload)
    } catch (error) {
      // 帧边界本身是对的，只是数据帧头部坏了：丢掉这一帧，流还能继续。
      log(`ignoring malformed data frame: ${error.message}`)
      return
    }
    const pending = pendings.get(frame.id)
    if (pending === undefined) {
      // 已经回过错误、或宿主的请求已被拒；剩下的字节没有归属，丢掉即可。
      log(`ignoring data frame for unknown blob: ${frame.id}`)
      return
    }
    if (frame.offset !== pending.received) {
      failPending(
        pending,
        new ProtocolError(ERROR_CODES.INTERNAL, `data frame for ${frame.id} is out of order`),
      )
      return
    }
    if (pending.received + frame.chunk.length > pending.length) {
      failPending(
        pending,
        new ProtocolError(ERROR_CODES.INTERNAL, `data frame for ${frame.id} exceeds its declared length`),
      )
      return
    }
    frame.chunk.copy(pending.data, pending.received)
    pending.received += frame.chunk.length
    if (pending.received < pending.length) return
    pendings.delete(frame.id)
    complete(pending)
  }

  return {
    /** 喂入一帧（`frame.mjs` 解出的 `{type, payload}`）。 */
    acceptFrame(type, payload) {
      if (type === FRAME_TYPE_CONTROL) handleControl(Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload))
      else if (type === FRAME_TYPE_DATA) handleData(payload)
    },
    /** 等待队列与在途回应都排空（测试与关停用）。 */
    async drain() {
      for (;;) {
        await queue
        if (inflight.size === 0) return
        await Promise.all([...inflight])
      }
    },
    /** 释放原生会话；幂等。 */
    async dispose() {
      if (pendingClose === null) pendingClose = Promise.resolve(faceEngine === null ? null : faceEngine.dispose())
      await pendingClose
    },
    /** 供测试直接注入替身引擎。 */
    get engine() {
      return faceEngine
    },
  }
}

function logLine(message) {
  process.stderr.write(`[faces] ${message}\n`)
}

/** 生产入口：把 stdin 的字节喂给插件，把帧写回 stdout。 */
export function main() {
  const plugin = createFacesPlugin({ write: (frame) => process.stdout.write(frame), log: logLine })
  const decoder = new FrameDecoder()
  process.stdin.on('data', (chunk) => {
    let frames
    try {
      frames = decoder.push(chunk)
    } catch (error) {
      // 帧长度/类型非法 ⇒ 流已无法重新对齐，只能退出；宿主会把在途请求判失败并重启进程。
      logLine(`frame transport failed: ${error.message}`)
      process.exitCode = 1
      process.stdin.destroy()
      return
    }
    for (const frame of frames) plugin.acceptFrame(frame.type, frame.payload)
  })
  process.stdin.on('end', () => {
    plugin
      .drain()
      .then(() => plugin.dispose())
      .catch((error) => logLine(`shutdown failed: ${error.message}`))
  })
  process.on('SIGTERM', () => {
    plugin
      .dispose()
      .catch(() => {})
      .then(() => process.exit(0))
  })
}

/* c8 ignore next 3 -- 只在作为进程入口时执行，测试直接 import 模块。 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
