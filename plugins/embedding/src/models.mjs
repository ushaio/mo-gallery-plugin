/**
 * EmbeddingGemma 2 的产物规格与调用约定。
 *
 * 这里是**唯一的规格来源**（与 `faces/src/models.mjs` 同样的定位）：体积、sha256、许可、
 * 来源、任务前缀、维度全部集中在此，宿主不再另抄一份。
 *
 * 事实依据：`.trellis/spec/emulsion-desktop/local-ai/embeddinggemma-2-design.md`。
 * sha256 由 HF `resolve` 端点的 `x-linked-etag`（LFS oid）实测得到，并在 2026-10-08 用
 * 本地 `sha256sum` 对 `model_q4.onnx` / `vision_encoder_q4.onnx` **复算交叉验证**过。
 *
 * ⚠️ 两条不可协商的约定（详见设计文档 §1）：
 *   1. **不得使用 fp16 计算精度**——模型卡的原文警告是「返回 NaN 或静默劣化的向量，不报错」。
 *      当前 `q4` 产物已静态确认是「4bit 权重（MatMulNBits, block_size=32）+ fp32 激活」
 *      （图内 0 个 fp16 initializer，输入/输出均为 FLOAT），因此默认变体安全。
 *   2. 截断到 MRL 维度后**必须重新 L2 归一化**，且 query 与库内向量必须同维度。
 */

/** 权重来源的上游 revision（钉死版本，避免上游重传导致 sha256 漂移）。 */
export const UPSTREAM_REVISION = 'daa72c51243991dfcaf9f9137d2c573d8f7790c0'

const RESOLVE_BASE = `https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/${UPSTREAM_REVISION}`

/** 原生输出维度。 */
export const EMBEDDING_DIM_NATIVE = 768

/** 默认落库维度（MRL 截断）：256d 质量近无损，10 万张 ≈ 100MB。 */
export const EMBEDDING_DIM_DEFAULT = 256

/** 支持的 MRL 截断维度，从大到小。 */
export const EMBEDDING_DIM_CHOICES = Object.freeze([768, 512, 256, 128])

/**
 * 模态编码器输出的中间特征维度。
 *
 * 文本塔的 `image_features` / `video_features` / `audio_features` 三个输入都是 `[N, 512]`，
 * 由各自的编码器产出后再喂进文本塔——**多模态是两段式的，不是单次前向**。
 */
export const MODALITY_FEATURE_DIM = 512

/** 视觉编码器的 patch 边长（像素）。 */
export const PATCH_SIZE = 16

/** 单个 patch 展平后的元素数：16×16×3(RGB)，即视觉编码器输入的最后一维 768。 */
export const PATCH_ELEMENTS = PATCH_SIZE * PATCH_SIZE * 3

/** 视觉编码器默认的 soft token 预算（对应 `max_soft_tokens`）。 */
export const IMAGE_SOFT_TOKENS = 280

/** 文本塔的输出名：均值池化并投影到 768 维。 */
export const SENTENCE_EMBEDDING_OUTPUT = 'sentence_embedding'

/**
 * 任务前缀（仅文本使用；图/视频/音频**不加前缀**）。
 *
 * 卡片原文：「For text tasks, omitting the recommended task prefix may lead to sub-optimal
 * embedding quality.」——缺前缀不报错，只是检索变差，所以必须由代码统一注入，
 * 不允许调用方裸传文本。
 */
export const TASK_PROMPTS = Object.freeze({
  /** 非对称：检索的 query 侧。 */
  searchQuery: (query) => `task: search result | query: ${query}`,
  /** 非对称：检索的文档侧。无标题时必须写 `title: none`。 */
  document: (text, title = null) => `title: ${title === null || title === '' ? 'none' : title} | text: ${text}`,
  /** 非对称：问答。 */
  questionAnswering: (question) => `task: question answering | query: ${question}`,
  /** 非对称：事实核查。 */
  factChecking: (claim) => `task: fact checking | query: ${claim}`,
  /** 非对称：代码检索。 */
  codeRetrieval: (query) => `task: code retrieval | query: ${query}`,
  /** 对称：分类（零样本打标）。 */
  classification: (content) => `task: classification | query: ${content}`,
  /** 对称：聚类（自动相册）。 */
  clustering: (content) => `task: clustering | query: ${content}`,
  /** 对称：相似度。 */
  sentenceSimilarity: (content) => `task: sentence similarity | query: ${content}`,
})

/** 变体：`q4` 是默认档（体积与精度平衡最好，且激活为 fp32）。 */
export const DEFAULT_VARIANT = 'q4'

/**
 * 各量化档的文本塔 / 视觉 / 音频权重体积（字节，实测自 HF API 文件清单）。
 *
 * 保留这张表是为了让「换档」有据可依：`fp16` 与 `q4f16` 因 fp16 激活被**排除**
 * （前者是 fp16 权重与激活，后者是 4bit 权重 + fp16 激活）。
 */
export const VARIANT_SIZES = Object.freeze({
  q4: { text: 174028800, vision: 108957696, audio: 189075968, activations: 'fp32' },
  quantized: { text: 313716480, vision: 195231744, audio: 340058112, activations: 'fp32' },
  q4f16: { text: 156860416, vision: 97615872, audio: 170348544, activations: 'fp16' },
  fp16: { text: 542093312, vision: 335511552, audio: 586686464, activations: 'fp16' },
  fp32: { text: 1084171264, vision: 671031296, audio: 1172745216, activations: 'fp32' },
})

/**
 * 文件规格。
 *
 * `kind`：
 *   - `text`    文本塔（含多模态软 token 通路，产出 `sentence_embedding`）
 *   - `vision`  视觉编码器（像素 → 512 维特征）
 *   - `audio`   音频编码器（可选档）
 *   - `tokenizer` 分词器（32MB 词表）
 *
 * 每个条目都是**成对**的（`*.onnx` 图 + `*.onnx_data` 外置权重），外部数据必须与图同目录同名，
 * 否则会话加载失败——下载器必须两个都校验通过才允许就位。
 *
 * `file` 是**本地落盘名**，`remote` 是**仓库内路径**：两者并不相同——除 `tokenizer.json` 在仓库
 * 根目录外，其余五个都在 `onnx/` 下。早期版本把两者混为一谈，结果所有 `onnx/` 下的文件都 404
 * （JSON 形态的失败很安静，下载器报错时才发现），所以这里显式分开并单测钉住。
 */
export const MODEL_FILES = Object.freeze([
  {
    id: 'embeddinggemma2-text-q4',
    kind: 'text',
    file: 'model_q4.onnx',
    remote: 'onnx/model_q4.onnx',
    sizeBytes: 490742,
    sha256: 'f9eeba97acddf139b8ee2ddf04bc30dceafa88de93fadf74d7644e0d61a477a9',
  },
  {
    id: 'embeddinggemma2-text-q4-data',
    kind: 'text',
    file: 'model_q4.onnx_data',
    remote: 'onnx/model_q4.onnx_data',
    sizeBytes: 174028800,
    sha256: 'c3975f2d1ab7a1878ae31a7d7a9b7804a827aff3800b60dfceafce21cac3df49',
  },
  {
    id: 'embeddinggemma2-vision-q4',
    kind: 'vision',
    file: 'vision_encoder_q4.onnx',
    remote: 'onnx/vision_encoder_q4.onnx',
    sizeBytes: 159400,
    sha256: '7ea284226d4938f0ad921ab091f1d80a9ca699aa802984ef5cd5eec4f4761d96',
  },
  {
    id: 'embeddinggemma2-vision-q4-data',
    kind: 'vision',
    file: 'vision_encoder_q4.onnx_data',
    remote: 'onnx/vision_encoder_q4.onnx_data',
    sizeBytes: 108957696,
    sha256: '0a9d6c927334f152a33dd90874f65d6ea5228999abe6a450d3f7813677fa704c',
  },
  {
    id: 'embeddinggemma2-audio-q4-data',
    kind: 'audio',
    file: 'audio_encoder_q4.onnx_data',
    remote: 'onnx/audio_encoder_q4.onnx_data',
    sizeBytes: 189075968,
    sha256: 'ba9328e6341360974083085b44b2bba265003bda564740f7c4c23ed9928f17e2',
  },
  {
    id: 'embeddinggemma2-tokenizer',
    kind: 'tokenizer',
    file: 'tokenizer.json',
    remote: 'tokenizer.json',
    sizeBytes: 32170510,
    sha256: '4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4',
  },
])

/** 许可与来源：随包必须附许可全文（与 YuNet/SFace/onnxruntime 三份同一处理）。 */
export const MODEL_LICENSE = Object.freeze({
  license: 'Apache-2.0（卡片 frontmatter 口径；Gemma 4 license 与 Prohibited Use Policy 待法务确认）',
  licenseUrl: 'https://ai.google.dev/gemma/docs/gemma_4_license',
  source: `https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/tree/${UPSTREAM_REVISION}`,
  // 社区导出，非 Google 官方发布：宿主与设置页文案应如实标注。
  publisher: 'onnx-community（Hugging Face 侧 transformers.js 兼容导出，非 Google 官方）',
})

/**
 * 某档位下必须就位的文件（按 kind 过滤）。
 *
 * @param {{ variant?: string, kinds?: string[] }} [options]
 * @returns {ReadonlyArray<typeof MODEL_FILES[number] & { source: string }>}
 */
export function modelSpecs({ variant = DEFAULT_VARIANT, kinds = ['text', 'vision', 'tokenizer'] } = {}) {
  if (!Object.hasOwn(VARIANT_SIZES, variant)) {
    throw new Error(`unknown variant: ${variant}`)
  }
  return MODEL_FILES.filter((spec) => {
    if (!kinds.includes(spec.kind)) return false
    // 非默认档的权重文件名带档位后缀；图文件同理，避免混档加载。
    if (variant !== DEFAULT_VARIANT && spec.kind !== 'tokenizer' && !spec.file.includes(`_${variant}`)) return false
    return true
  }).map((spec) => ({ ...spec, source: `${RESOLVE_BASE}/${spec.remote}` }))
}

/**
 * MRL 截断 + L2 归一化。
 *
 * 卡片原文：「slicing a unit-length vector does not preserve unit length. The shortened vector
 * must be L2-normalized before it is used for cosine similarity.」——所以截断与归一化必须是
 * 同一个不可分割的操作，不允许调用方只做其中一步。
 *
 * @param {ArrayLike<number>} vector 原生 768 维（未归一化或已归一化都可）
 * @param {number} dim 目标维度，必须是 {@link EMBEDDING_DIM_CHOICES} 之一
 * @returns {Float32Array} 长度为 dim 的单位向量
 */
export function truncateAndNormalize(vector, dim = EMBEDDING_DIM_DEFAULT) {
  if (!EMBEDDING_DIM_CHOICES.includes(dim)) {
    throw new Error(`unsupported embedding dim: ${dim}`)
  }
  if (vector.length < dim) {
    throw new Error(`vector has ${vector.length} values, cannot truncate to ${dim}`)
  }
  // 先扫**整个**原生向量再截断。fp16 溢出会让整条向量变成 NaN，而坏值未必落在保留的前 dim 维里
  // ——只看前 dim 维就会把它当成一条正常向量写进库（模型卡说的「静默劣化」正是这个形态）。
  for (let i = 0; i < vector.length; i += 1) {
    if (!Number.isFinite(vector[i])) {
      throw new Error(`embedding contains a non-finite value at ${i}`)
    }
  }
  const out = new Float32Array(dim)
  let sum = 0
  for (let i = 0; i < dim; i += 1) {
    const value = vector[i]
    out[i] = value
    sum += value * value
  }
  const norm = Math.sqrt(sum)
  if (norm === 0) throw new Error('embedding has zero norm')
  for (let i = 0; i < dim; i += 1) out[i] /= norm
  return out
}
