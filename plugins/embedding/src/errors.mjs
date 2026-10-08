/**
 * 领域错误码与 `ProtocolError`。
 *
 * 码表与旧内置 sidecar（`emulsion-desktop-v3/runtime/inference/README.md`）保持同一口径：
 * 领域 5 个 + 协议层 2 个。宿主按 `error.code` 分流用户可见文案，所以**不要新增码**，
 * 需要更细的区分时用 `message`。
 */
export const ERROR_CODES = {
  /** 模型文件缺失（用户可自行补齐，宿主应提示下载）。 */
  MODEL_MISSING: 'MODEL_MISSING',
  /** 模型体积/sha256 与规格不符：文件是坏的，不得加载。 */
  MODEL_HASH_MISMATCH: 'MODEL_HASH_MISMATCH',
  /** 输入张量构造失败（尺寸/像素格式不满足预处理约定）。 */
  DECODE_FAILED: 'DECODE_FAILED',
  /** 推理本身失败（会话报错、输出维度不符、出现 NaN）。 */
  INFER_FAILED: 'INFER_FAILED',
  /** 本产物不支持的能力（如未下载音频编码器时的音频请求）。 */
  UNSUPPORTED: 'UNSUPPORTED',
  /** 调用方请求畸形。 */
  BAD_REQUEST: 'BAD_REQUEST',
  /** 插件内部错误（含不可序列化、响应超限）。 */
  INTERNAL: 'INTERNAL',
}

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
  /**
   * @param {string|number} code 取自 {@link ERROR_CODES} 或 {@link RPC_ERRORS}
   * @param {string} message 面向排查的中文说明
   * @param {unknown} [data] 可选附加信息（宿主只读 code 与 message）
   */
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
