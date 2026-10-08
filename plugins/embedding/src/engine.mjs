/**
 * ONNX Runtime 会话管理：EmbeddingGemma 2 的文本塔 + 视觉编码器。
 *
 * 与 `image.mjs` 分开的原因和 faces 那边一致：几何/张量数学要能脱离原生运行时单测，
 * 而这里的一切都依赖 `onnxruntime-node`。
 *
 * ## 与 faces 最重要的一处结构差异
 *
 * 人脸是「一个模型一张脸」，这里是**两段式**：模态编码器先产出 512 维中间特征，文本塔再把
 * 它们当作软 token 与文本一起编码，最后输出 768 维句向量。所以本模块**不替调用方决定
 * 多模态怎么拼**（占位符 token 的插入位置属于分词/处理器那一层），只提供三个不重叠的入口：
 *
 *   encodeImageFeatures()  视觉编码器：像素 patch → [N, 512]
 *   embedTokenIds()        纯文本：token id → 归一化向量
 *   embedWithModalities()  文本塔通用入口：调用方自行装配 ids 与各模态特征
 *
 * 这样切的好处是：**任何需要用 `<|image|>` 占位符猜位置的地方，都不会藏在引擎里静默出错。**
 *
 * ## 不可协商的两条
 *
 * 1. 不得用 fp16 计算精度——模型卡的原文警告是返回 NaN 或静默劣化的向量且不报错。当前
 *    `q4` 产物已静态确认（图内 0 个 fp16 initializer、输入输出均 FLOAT）与 4bit MatMulNBits
 *    共存，属安全组合；换档时必须重新确认（`scripts/probe.mjs` 会把 dtype 打出来）。
 * 2. 截断到 MRL 维度后必须重新 L2 归一化，且 query 与库内同维度——由 `truncateAndNormalize`
 *    强制成一步不可拆的操作。
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ERROR_CODES, ProtocolError } from './errors.mjs'
import { MIN_GRID } from './image.mjs'
import { loadOnnxRuntime } from './onnx.mjs'
import {
  DEFAULT_VARIANT,
  EMBEDDING_DIM_DEFAULT,
  MODEL_FILES,
  MODALITY_FEATURE_DIM,
  PATCH_ELEMENTS,
  SENTENCE_EMBEDDING_OUTPUT,
  modelSpecs,
  truncateAndNormalize,
} from './models.mjs'

/** 流式计算文件 sha256（模型 174MB，不能整读进内存）。 */
async function fileDigest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * 校验模型目录：体积先筛（省掉 174MB 的哈希），再算哈希。
 *
 * @returns {Promise<{ ready: object[], missing: object[], mismatched: object[] }>}
 */
export async function verifyModelFiles(modelsDir, specs = modelSpecs()) {
  const ready = []
  const missing = []
  const mismatched = []
  for (const spec of specs) {
    const path = join(modelsDir, spec.file)
    let size
    try {
      size = (await stat(path)).size
    } catch {
      missing.push({ ...spec, path })
      continue
    }
    if (size !== spec.sizeBytes) {
      mismatched.push({ ...spec, path, actualSize: size, reason: 'size' })
      continue
    }
    const digest = await fileDigest(path)
    if (digest.toLowerCase() !== spec.sha256.toLowerCase()) {
      mismatched.push({ ...spec, path, actualSha256: digest, reason: 'sha256' })
      continue
    }
    ready.push({ ...spec, path })
  }
  return { ready, missing, mismatched }
}

/**
 * 把 onnxruntime 的 metadata 统一成数组。
 *
 * 1.30 的 `inputMetadata` 是**数组**（每项自带 `name`），早期版本/其他绑定可能是 Map 或对象。
 * 早期版本的本函数拿 `Object.entries` 的 key 当名字，于是名字被打印成 `0`、`1`、`2`——
 * 排查形状契约时这等于没有信息，所以这里一律以条目自带的 `name` 为准。
 */
function metadataEntries(metadata) {
  if (metadata === null || metadata === undefined) return []
  let values
  if (metadata instanceof Map) {
    values = [...metadata.values()]
  } else if (Array.isArray(metadata)) {
    values = metadata
  } else if (typeof metadata === 'object') {
    values = Object.values(metadata)
  } else {
    return []
  }
  return values.map((value) => ({
    name: typeof value?.name === 'string' && value.name !== '' ? value.name : '(unnamed)',
    type: value?.type ?? null,
    dimensions: Array.from(value?.dimensions ?? value?.dims ?? []),
  }))
}

/**
 * 文本塔的模态特征输入：缺席时的喂法。
 *
 * 三个模态输入是图的**必需**输入（不是可选），缺席时必须喂点东西：
 *
 *   `empty`     `[0, 512]`——零行长张量，语义上最干净（「没有这个模态」）；
 *   `zero-row`  `[1, 512]` 全零——某些运行时/算子不接受 0 长度维度时的退路。
 *
 * 两种都不算「编造一行假 token」以外的新语义：`empty` 根本不贡献 token，`zero-row` 会贡献一个
 * 零向量软 token。默认用 `empty`，探针会实测 ORT 接受哪一种（`onnxruntime-node` 对 0 长度维度
 * 的态度没有文档保证）。**不要**用真实形状的一行来「凑数」——那会静默改变语义。
 */
function modalityTensor(runtime, features, columns = MODALITY_FEATURE_DIM, placeholder = 'empty') {
  if (features === null || features === undefined) {
    if (placeholder === 'zero-row') {
      return new runtime.Tensor('float32', new Float32Array(columns), [1, columns])
    }
    return new runtime.Tensor('float32', new Float32Array(0), [0, columns])
  }
  if (features.length % columns !== 0) {
    throw new ProtocolError(
      ERROR_CODES.DECODE_FAILED,
      `模态特征长度 ${features.length} 不是 ${columns} 的整数倍`,
    )
  }
  return new runtime.Tensor('float32', features, [features.length / columns, columns])
}

function int64Tensor(runtime, values, dims) {
  const data = values instanceof BigInt64Array ? values : BigInt64Array.from(values, (value) => BigInt(value))
  return new runtime.Tensor('int64', data, dims)
}

/**
 * @param {{ modelsDir: string, variant?: string, log?: (message: string) => void,
 *           runtime?: object | null, sessionOptions?: object,
 *           kinds?: string[] }} options
 */
export function createEmbeddingEngine({
  modelsDir,
  variant = DEFAULT_VARIANT,
  log = () => {},
  runtime = null,
  runtimeRoot = onnxRuntimeRoot(),
  sessionOptions,
  kinds = ['text', 'vision', 'tokenizer'],
  modalityPlaceholder = 'empty',
  patchLayout = 'batch-first',
} = {}) {
  if (typeof modelsDir !== 'string' || modelsDir === '') {
    throw new ProtocolError(ERROR_CODES.MODEL_MISSING, '模型目录未配置')
  }

  let pending = null
  let provided = runtime
  let opening = null

  async function resolveRuntime() {
    if (provided !== null) return provided
    if (opening === null) {
      // 目录由宿主通过 MO_GALLERY_EMBEDDING_RUNTIME 交过来；显式传 runtimeRoot 是为了让探针
      // 与测试能直接指定，而不是只能改环境变量（早期版本漏了这条，探针的 --runtime 被静默忽略）。
      opening = loadOnnxRuntime(runtimeRoot)
      opening.catch(() => {
        opening = null
      })
    }
    provided = await opening
    return provided
  }

  async function open() {
    // 先查模型、再加载原生运行时：这样「模型没下全」报的是 MODEL_MISSING（用户能自己补），
    // 而不是把 addon 的加载失败当成根因。哈希只在首次会话时算。
    const specs = modelSpecs({ variant, kinds })
    const { ready, missing, mismatched } = await verifyModelFiles(modelsDir, specs)
    if (missing.length > 0) {
      throw new ProtocolError(
        ERROR_CODES.MODEL_MISSING,
        `模型未就位：${missing.map((item) => item.file).join('、')}`,
      )
    }
    if (mismatched.length > 0) {
      throw new ProtocolError(
        ERROR_CODES.MODEL_HASH_MISMATCH,
        `模型校验失败：${mismatched
          .map((item) => `${item.file}(${item.reason === 'size' ? `体积 ${item.actualSize} ≠ ${item.sizeBytes}` : 'sha256 不符'})`)
          .join('、')}`,
      )
    }

    const active = await resolveRuntime()
    if (active === null || typeof active.InferenceSession?.create !== 'function') {
      throw new ProtocolError(ERROR_CODES.INTERNAL, 'onnxruntime-node 不可用（运行时目录未提供）')
    }
    const text = ready.find((item) => item.kind === 'text' && item.file.endsWith('.onnx'))
    if (text === undefined) {
      throw new ProtocolError(ERROR_CODES.MODEL_MISSING, '缺少文本塔图文件')
    }
    // 只保留 error 级日志：4bit 量化图会为每个量化节点打 warning，宿主会把 stderr 拼进
    // 退出错误里，噪声会把真正的错误顶掉（faces 那边踩过同一个坑）。
    const options = { logSeverityLevel: 3, ...sessionOptions }
    const sessions = {
      text: await active.InferenceSession.create(text.path, options),
      vision: null,
      models: ready,
      runtime: active,
      variant,
    }
    const vision = ready.find((item) => item.kind === 'vision' && item.file.endsWith('.onnx'))
    if (vision !== undefined) {
      sessions.vision = await active.InferenceSession.create(vision.path, options)
    }
    log(`embedding engine ready (variant=${variant}, text=${text.path}${vision === undefined ? '' : `, vision=${vision.path}`})`)
    return sessions
  }

  function sessions() {
    if (pending === null) {
      pending = open()
      // 失败不永久缓存：用户补齐模型后应当能重试。
      pending.catch(() => {
        pending = null
      })
    }
    return pending
  }

  /** 会话的输入/输出元数据——换档时用来确认「激活不是 fp16」的那一眼。 */
  async function describe() {
    const active = await sessions()
    const describeSession = (session) =>
      session === null
        ? null
        : { inputs: metadataEntries(session.inputMetadata), outputs: metadataEntries(session.outputMetadata) }
    return {
      variant: active.variant,
      models: active.models.map(({ id, kind, file, sizeBytes, sha256, path }) => ({ id, kind, file, sizeBytes, sha256, path })),
      text: describeSession(active.text),
      vision: describeSession(active.vision),
    }
  }

  function firstOutput(session, label) {
    const name = session.outputNames[0]
    if (typeof name !== 'string') {
      throw new ProtocolError(ERROR_CODES.INFER_FAILED, `${label} 会话没有输出`)
    }
    return name
  }

  /**
   * 视觉编码器：像素 patch → [num_tokens, 512] 特征。
   *
   * ⚠️ `pixel_values` 的 rank 是 **3**，不是 2：静态检查显示的 `[s11, s35, 768]` 本来就是三维。
   * 首轮探针按 `[N, 768]` 喂，ORT 直接回
   * 「Invalid rank for input: pixel_values Got: 2 Expected: 3」。两种可能布局里
   * `batch-first`（`[1, N, 768]` + `[1, N, 2]`）与 position_ids 的语义最自洽，作为默认，
   * 另一种留给探针实测排除。
   *
   * @param {{ pixelValues: Float32Array, positionIds: BigInt64Array, patchCount: number }} patches
   * @param {{ patchLayout?: 'batch-first'|'middle' }} [options]
   */
  async function encodeImageFeatures(patches, options = {}) {
    const active = await sessions()
    if (active.vision === null) {
      throw new ProtocolError(ERROR_CODES.UNSUPPORTED, '视觉编码器未下载（本档位只含文本塔）')
    }
    const session = active.vision
    const expects = session.inputNames
    if (!expects.includes('pixel_values') || !expects.includes('pixel_position_ids')) {
      throw new ProtocolError(
        ERROR_CODES.UNSUPPORTED,
        `视觉编码器输入与本实现约定不符：${expects.join('、')}`,
      )
    }
    const layout = options.patchLayout ?? patchLayout
    // 网格下限：太小的网格会让图内部张量越界（见 image.mjs 的 MIN_GRID）。在这里挡住，
    // 而不是让调用方拿到一句「ScatterElements 越界」——
    if (patches.gridWidth !== undefined && patches.gridHeight !== undefined) {
      if (patches.gridWidth < MIN_GRID || patches.gridHeight < MIN_GRID) {
        throw new ProtocolError(
          ERROR_CODES.BAD_REQUEST,
          `网格 ${patches.gridWidth}×${patches.gridHeight} 小于模型下限 ${MIN_GRID}×${MIN_GRID}（实测该尺寸会让视觉图内部张量越界）`,
        )
      }
    }
    const pixelDims = layout === 'middle' ? [patches.patchCount, 1, PATCH_ELEMENTS] : [1, patches.patchCount, PATCH_ELEMENTS]
    const positionDims = layout === 'middle' ? [patches.patchCount, 1, 2] : [1, patches.patchCount, 2]
    const feeds = {
      pixel_values: new active.runtime.Tensor('float32', patches.pixelValues, pixelDims),
      pixel_position_ids: int64Tensor(active.runtime, patches.positionIds, positionDims),
    }
    const results = await session.run(feeds)
    const outputName = firstOutput(session, '视觉编码器')
    const values = results[outputName].data
    const tokenCount = values.length / MODALITY_FEATURE_DIM
    if (!Number.isInteger(tokenCount) || tokenCount === 0) {
      throw new ProtocolError(
        ERROR_CODES.INFER_FAILED,
        `视觉编码器输出 ${values.length} 个值，不是 ${MODALITY_FEATURE_DIM} 的正整数倍`,
      )
    }
    return { imageFeatures: values, tokenCount, patchCount: patches.patchCount, layout }
  }

  /**
   * 文本塔通用入口：调用方装配 ids 与各模态特征。
   *
   * @param {{ ids: ArrayLike<number>, attentionMask?: ArrayLike<number>,
   *           imageFeatures?: Float32Array|null, videoFeatures?: Float32Array|null,
   *           audioFeatures?: Float32Array|null, dim?: number }} input
   */
  async function embedWithModalities(input) {
    const active = await sessions()
    const session = active.text
    const ids = Array.from(input.ids ?? [])
    if (ids.length === 0) {
      throw new ProtocolError(ERROR_CODES.BAD_REQUEST, 'ids 不能为空')
    }
    const mask = input.attentionMask === undefined || input.attentionMask === null
      ? ids.map(() => 1)
      : Array.from(input.attentionMask)
    if (mask.length !== ids.length) {
      throw new ProtocolError(ERROR_CODES.BAD_REQUEST, 'attention_mask 与 ids 长度不一致')
    }
    const feeds = {
      input_ids: int64Tensor(active.runtime, ids, [1, ids.length]),
      attention_mask: int64Tensor(active.runtime, mask, [1, ids.length]),
    }
    // 三个模态输入是图的必需输入（不是可选），缺席时按约定喂空——不要编造一行假 token。
    const placeholder = input.modalityPlaceholder ?? modalityPlaceholder
    if (session.inputNames.includes('image_features')) {
      feeds.image_features = modalityTensor(active.runtime, input.imageFeatures ?? null, MODALITY_FEATURE_DIM, placeholder)
    }
    if (session.inputNames.includes('video_features')) {
      feeds.video_features = modalityTensor(active.runtime, input.videoFeatures ?? null, MODALITY_FEATURE_DIM, placeholder)
    }
    if (session.inputNames.includes('audio_features')) {
      feeds.audio_features = modalityTensor(active.runtime, input.audioFeatures ?? null, MODALITY_FEATURE_DIM, placeholder)
    }
    const results = await session.run(feeds)
    const tensor = results[SENTENCE_EMBEDDING_OUTPUT] ?? results[firstOutput(session, '文本塔')]
    const raw = tensor.data
    const dim = input.dim ?? EMBEDDING_DIM_DEFAULT
    // 截断 + 归一化一步完成；非有限值在这里就会被拒绝，不会写进库。
    const vector = truncateAndNormalize(raw, dim)
    return { vector, nativeDim: raw.length, dim }
  }

  /** 纯文本：token id → 归一化向量。分词由调用方负责（见设计文档 §4.4）。 */
  async function embedTokenIds(ids, options = {}) {
    return embedWithModalities({ ids, attentionMask: options.attentionMask, dim: options.dim })
  }

  /** 图 → 向量：视觉编码器 → 文本塔。`ids` 必须由调用方按占位符约定装配。 */
  async function embedImagePatches(patches, ids, options = {}) {
    const { imageFeatures } = await encodeImageFeatures(patches)
    return embedWithModalities({ ids, attentionMask: options.attentionMask, imageFeatures, dim: options.dim })
  }

  return {
    describe,
    encodeImageFeatures,
    embedWithModalities,
    embedTokenIds,
    embedImagePatches,
    /** 已确认的模型（含路径与哈希）。 */
    models: async () => (await sessions()).models,
    /** 供热重载/测试：下次调用重新建会话。 */
    reset() {
      pending = null
    },
    /** 释放原生会话，避免 Windows 上进程退出前残留文件句柄。 */
    async dispose() {
      if (pending === null) return
      const active = await pending.catch(() => null)
      pending = null
      if (active === null || active === undefined) return
      for (const session of [active.text, active.vision]) {
        if (session !== null && typeof session.release === 'function') await session.release()
      }
    },
  }
}

/** 供测试与探针使用：一次性算出某个文件的 sha256。 */
export { fileDigest, MODEL_FILES }
