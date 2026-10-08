/**
 * embedding@1 的二进制分帧传输（插件侧）。
 *
 * 帧格式**刻意与 `faces@1` 完全一致**（那套又与宿主 `storage_plugins/frames.go` 严格对称），
 * 每帧 `[4B 大端长度][1B 类型][负载]`，长度**包含类型字节**：
 *
 *   type 0 控制帧 —— 负载是一个 JSON-RPC 信封（无结尾换行）
 *   type 1 数据帧 —— 负载是 `[1B idLen][id][4B 大端 offset][原始字节]`
 *
 * 为什么不复用同一份实现：插件是独立子进程、只读自己包目录与宿主显式授予的目录，跨插件共享源码
 * 要走包依赖或代码复制，两条路都比「照着契约再写一遍」更贵。**代价是两边必须同时改**——所以常量
 * 与宿主同名项取同一个值：插件接受的帧绝不会超过宿主愿意发的，反之亦然。
 *
 * 为什么不用 base64 塞进 JSON 行：一张 1024×1024 的 RGB8 是 3 MiB，base64 后 4 MiB 会顶到宿主的
 * 行上限，还要多付 1/3 的编解码。二进制帧让像素走原生字节。
 */

export const FRAME_TYPE_CONTROL = 0
export const FRAME_TYPE_DATA = 1

/** 单帧上限，与宿主的 `maxFrameBytes` 一致。 */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024
/** 单个二进制负载上限，与宿主的 `maxBlobBytes` 一致（1024×1024×3 = 3 MiB 在其内）。 */
export const MAX_BLOB_BYTES = 4 * 1024 * 1024
/** 负载 id 长度上限，与宿主的 `maxBlobIDBytes` 一致。 */
export const MAX_BLOB_ID_BYTES = 64
/** 写数据帧时的分片大小：1 MiB + 帧头仍在单帧上限内。 */
export const DATA_CHUNK_BYTES = 1024 * 1024

/** 分帧层的问题：一旦发生就无法重新对齐流，只能报错并让宿主机停进程。 */
export class FrameError extends Error {
  constructor(message) {
    super(message)
    this.name = 'FrameError'
  }
}

/** 负载 id 必须是 1..64 字节的可打印 ASCII，与宿主的校验一致。 */
export function isValidBlobID(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BLOB_ID_BYTES) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x21 || code > 0x7e) return false
  }
  return true
}

function encodeFrame(type, payload) {
  const length = payload.length + 1
  if (length > MAX_FRAME_BYTES) {
    throw new FrameError(`frame of ${length} bytes exceeds ${MAX_FRAME_BYTES}`)
  }
  const frame = Buffer.allocUnsafe(5 + payload.length)
  frame.writeUInt32BE(length, 0)
  frame.writeUInt8(type, 4)
  payload.copy(frame, 5)
  return frame
}

/** 编码一个控制帧；负载是 JSON-RPC 信封，不带结尾换行。 */
export function encodeControlFrame(envelope) {
  return encodeFrame(FRAME_TYPE_CONTROL, Buffer.from(JSON.stringify(envelope), 'utf8'))
}

/** 编码一个数据帧（某个负载的第 `offset` 字节起的 `chunk`）。 */
export function encodeDataFrame(id, offset, chunk) {
  if (!isValidBlobID(id)) {
    throw new FrameError(`blob id is invalid: ${JSON.stringify(id)}`)
  }
  const idBytes = Buffer.from(id, 'ascii')
  const head = Buffer.allocUnsafe(1 + idBytes.length + 4)
  head.writeUInt8(idBytes.length, 0)
  idBytes.copy(head, 1)
  head.writeUInt32BE(offset, 1 + idBytes.length)
  return encodeFrame(FRAME_TYPE_DATA, Buffer.concat([head, chunk]))
}

/** 解析数据帧负载。 */
export function decodeDataFrame(payload) {
  if (payload.length < 1) throw new FrameError('data frame is empty')
  const idLength = payload.readUInt8(0)
  if (idLength === 0 || idLength > MAX_BLOB_ID_BYTES || payload.length < 1 + idLength + 4) {
    throw new FrameError('data frame header is invalid')
  }
  const id = payload.subarray(1, 1 + idLength).toString('ascii')
  const offset = payload.readUInt32BE(1 + idLength)
  return { id, offset, chunk: payload.subarray(1 + idLength + 4) }
}

/**
 * 增量帧解码器：stdin 的 chunk 边界与帧边界无关，所以必须自己攒。
 *
 * `push` 返回本次凑齐的帧；帧长非法或类型未知时抛 `FrameError`（流已无法重新对齐）。
 */
export class FrameDecoder {
  #buffer = Buffer.alloc(0)

  /** @param {Buffer} chunk */
  push(chunk) {
    if (chunk.length === 0) return []
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    const frames = []
    while (this.#buffer.length >= 5) {
      const length = this.#buffer.readUInt32BE(0)
      if (length < 1 || length > MAX_FRAME_BYTES) {
        throw new FrameError(`frame length is invalid: ${length}`)
      }
      if (this.#buffer.length < 5 + length - 1) break
      const type = this.#buffer.readUInt8(4)
      const payload = this.#buffer.subarray(5, 5 + length - 1)
      this.#buffer = this.#buffer.subarray(5 + length - 1)
      if (type !== FRAME_TYPE_CONTROL && type !== FRAME_TYPE_DATA) {
        throw new FrameError(`frame type is unknown: ${type}`)
      }
      frames.push({ type, payload })
    }
    return frames
  }
}
