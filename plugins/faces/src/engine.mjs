/**
 * ONNX Runtime 会话管理：YuNet 检测 + SFace 特征。
 *
 * 与 `face.mjs` 分开的原因：几何/张量数学要能脱离原生运行时被单测，而这里的一切都依赖
 * `onnxruntime-node`（预编译 N-API 二进制，由宿主提供）。模型在首次请求时校验并建会话，
 * 失败不缓存——用户补齐模型文件后应当能重试。
 *
 * 与旧内置 sidecar 的差别只有两处：像素从二进制帧来（`Uint8Array`，不再走 base64），以及
 * 原生运行时按 `MO_GALLERY_FACE_RUNTIME` 解析。算法路径一字未改，所以输出与 sidecar 逐位
 * 相同（`tests/sidecar-parity.test.mjs` 在真机模型上核对这一点）。
 */
import { ERROR_CODES, ProtocolError } from './errors.mjs'
import { ensureModels } from './models.mjs'
import { loadOnnxRuntime } from './onnx.mjs'
import {
  FACE_ALIGN_SIZE,
  FACE_CHANNEL_COUNT,
  FACE_EMBEDDING_DIM,
  alignFace,
  buildSfaceInput,
  buildYunetInput,
  decodeYunetOutputs,
  planYunetInput,
} from './face.mjs'

function tensorPayload(tensor, label) {
  if (tensor === undefined || tensor === null) {
    throw new ProtocolError(ERROR_CODES.INFER_FAILED, `${label} produced no output`)
  }
  return { dims: Array.from(tensor.dims), data: tensor.data }
}

function l2Norm(values) {
  let sum = 0
  for (const value of values) sum += value * value
  return Math.sqrt(sum)
}

/**
 * @param {{ modelsDir: string, log?: (message: string) => void,
 *           runtime?: object | null, sessionOptions?: object }} options
 */
export function createFaceEngine({ modelsDir, log = () => {}, runtime = null, sessionOptions } = {}) {
  if (typeof modelsDir !== 'string' || modelsDir === '') {
    throw new ProtocolError(ERROR_CODES.MODEL_MISSING, 'models directory is not configured')
  }

  let pending = null
  let provided = runtime
  let opening = null

  async function resolveRuntime() {
    if (provided !== null) return provided
    if (opening === null) {
      opening = loadOnnxRuntime()
      // 加载失败同样不缓存：宿主修好运行时目录后应当能重试。
      opening.catch(() => {
        opening = null
      })
    }
    provided = await opening
    return provided
  }

  async function open() {
    // 先查模型、再加载原生运行时：这样「模型没下全」报的是 MODEL_MISSING（用户能自己去补），
    // 而不是把 addon 的加载失败当成根因。模型哈希只在首次会话时算。
    const confirmed = await ensureModels(modelsDir)
    const active = await resolveRuntime()
    if (active === null || typeof active.InferenceSession?.create !== 'function') {
      throw new ProtocolError(ERROR_CODES.INTERNAL, 'onnxruntime-node is not available in this build')
    }
    const detector = confirmed.find((model) => model.kind === 'detector')
    const recognizer = confirmed.find((model) => model.kind === 'recognizer')
    if (detector === undefined || recognizer === undefined) {
      throw new ProtocolError(
        ERROR_CODES.MODEL_MISSING,
        'detector and recognizer models are both required',
      )
    }
    // 只保留 error 级日志：SFace 的图里有一批 initializer 同时是 graph input，ORT 会为每一个
    // 打一条 warning（实测上百行），而宿主会把插件 stderr 拼进退出错误里——崩溃时这些噪声会把
    // 真正的错误顶掉。数值不受影响，纯粹是日志噪声。
    const options = { logSeverityLevel: 3, ...sessionOptions }
    const sessions = {
      detector: await active.InferenceSession.create(detector.path, options),
      recognizer: await active.InferenceSession.create(recognizer.path, options),
      models: confirmed,
      runtime: active,
    }
    log(`face engine ready (yunet=${detector.path}, sface=${recognizer.path})`)
    return sessions
  }

  function sessions() {
    if (pending === null) {
      pending = open()
      // 加载失败不能把失败状态永久缓存：用户补齐模型后应当能重试。
      pending.catch(() => {
        pending = null
      })
    }
    return pending
  }

  function firstInput(session, label) {
    const name = session.inputNames[0]
    if (typeof name !== 'string') {
      throw new ProtocolError(ERROR_CODES.INFER_FAILED, `${label} session exposes no input`)
    }
    return name
  }

  async function run(session, inputName, data, dims, runtimeInstance) {
    const tensor = new runtimeInstance.Tensor('float32', data, dims)
    return session.run({ [inputName]: tensor })
  }

  async function detectParsed(parsed, active, options) {
    const plan = planYunetInput(parsed.width, parsed.height)
    const blob = buildYunetInput(parsed.data, parsed.width, parsed.height, plan)
    const session = active.detector
    const results = await run(
      session,
      firstInput(session, 'YuNet'),
      blob,
      [1, FACE_CHANNEL_COUNT, plan.paddedHeight, plan.paddedWidth],
      active.runtime,
    )
    const tensors = {}
    for (const name of session.outputNames) {
      if (results[name] !== undefined) {
        tensors[name] = tensorPayload(results[name], name)
      }
    }
    return { plan, faces: decodeYunetOutputs(tensors, plan, options) }
  }

  async function embedParsed(parsed, active, landmarks) {
    const aligned = alignFace(parsed.data, parsed.width, parsed.height, landmarks)
    const session = active.recognizer
    const outputName = session.outputNames[0]
    if (typeof outputName !== 'string') {
      throw new ProtocolError(ERROR_CODES.INFER_FAILED, 'SFace session exposes no output')
    }
    const results = await run(
      session,
      firstInput(session, 'SFace'),
      buildSfaceInput(aligned),
      [1, FACE_CHANNEL_COUNT, FACE_ALIGN_SIZE, FACE_ALIGN_SIZE],
      active.runtime,
    )
    const embedding = Array.from(tensorPayload(results[outputName], 'SFace').data)
    if (embedding.length !== FACE_EMBEDDING_DIM) {
      throw new ProtocolError(
        ERROR_CODES.INFER_FAILED,
        `SFace produced ${embedding.length} values, expected ${FACE_EMBEDDING_DIM}`,
      )
    }
    return { embedding, norm: l2Norm(embedding) }
  }

  /** @param {{width: number, height: number, data: Uint8Array}} raster */
  async function detect(raster, options = {}) {
    const active = await sessions()
    const { plan, faces } = await detectParsed(raster, active, options)
    return {
      width: raster.width,
      height: raster.height,
      paddedWidth: plan.paddedWidth,
      paddedHeight: plan.paddedHeight,
      faces,
    }
  }

  /** @param {{width: number, height: number, data: Uint8Array}} raster */
  async function embed(raster, landmarks) {
    const active = await sessions()
    const { embedding, norm } = await embedParsed(raster, active, landmarks)
    // 未归一化的原始 128 维：归一化由宿主做，库里的存量向量与聚类代码一字不动。
    return { embedding, norm }
  }

  return {
    detect,
    embed,
    /** 已确认的模型（含许可/来源）。 */
    models: async () => (await sessions()).models,
    /** 供热重载/测试用：下次调用重新建会话。 */
    reset() {
      pending = null
    },
    /** 释放原生会话，避免 Windows 上进程退出前残留文件句柄。 */
    async dispose() {
      if (pending === null) return
      const active = await pending.catch(() => null)
      pending = null
      if (active === null || active === undefined) return
      for (const session of [active.detector, active.recognizer]) {
        if (typeof session.release === 'function') await session.release()
      }
    },
  }
}
