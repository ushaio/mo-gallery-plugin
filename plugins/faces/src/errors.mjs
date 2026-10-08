/**
 * faces@1 插件的错误码与错误类型。
 *
 * 两个层次刻意分开：
 *
 * - **领域码**（前五个）与宿主 `local_library` 的 `FaceInferenceCode*` 常量逐字对应。
 *   宿主用它们区分「这张照片有问题」（`DECODE_FAILED` / `BAD_REQUEST` 只跳过当前素材）
 *   与「这台机器的人脸推理彻底不可用」（其余：连续出现就该停索引）。因此它们是契约的
 *   一部分：不能改名，也不能换成别的字符串。
 * - **协议码**（后两个 + JSON-RPC 标准码）是传输层补充：畸形请求与内部异常不属于任何
 *   领域错误，混用会误导排障。
 *
 * 宿主 JSON-RPC 错误对象里的 `code` 是 `any`（见 storage_plugins 的 rpcError），所以
 * 字符串码会原样穿到 Go 侧的错误消息里，形如
 * `storage plugin face.detect failed (DECODE_FAILED): …`。
 */

export const ERROR_CODES = Object.freeze({
  MODEL_MISSING: 'MODEL_MISSING',
  MODEL_HASH_MISMATCH: 'MODEL_HASH_MISMATCH',
  DECODE_FAILED: 'DECODE_FAILED',
  INFER_FAILED: 'INFER_FAILED',
  UNSUPPORTED: 'UNSUPPORTED',
  BAD_REQUEST: 'BAD_REQUEST',
  INTERNAL: 'INTERNAL',
})

/** JSON-RPC 2.0 标准错误码，用于「请求本身不成立」这一类。 */
export const RPC_ERRORS = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
})

/** 携带契约错误码的异常。`code` 是上面两个表里的任意值。 */
export class ProtocolError extends Error {
  constructor(code, message, data) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
    if (data !== undefined) this.data = data
  }
}

/** 把任意抛出物映射成 JSON-RPC 的 error 成员：宿主只读 `code` 与 `message`。 */
export function toRpcError(error) {
  if (error instanceof ProtocolError) {
    const payload = { code: error.code, message: error.message }
    if (error.data !== undefined) payload.data = error.data
    return payload
  }
  return {
    code: ERROR_CODES.INTERNAL,
    message: error instanceof Error ? error.message : String(error),
  }
}
