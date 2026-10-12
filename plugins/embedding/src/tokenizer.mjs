/**
 * 文本分词与图像占位符序列装配。
 *
 * 这里解决的是 embedding@1 之前如实报 `UNSUPPORTED` 的那一段：文本要 encode，图像要在序列里
 * 放 `<|image|>` 占位符（**占位符怎么与 bos/eos 组合是「处理器」的约定，不是分词器的约定**）。
 *
 * 三条刻意的设计：
 *
 * - **解析库不随插件打包**：`@huggingface/tokenizers` 由宿主放在只读运行时目录里
 *   （设计文档 §4.4 的 staging 约定），插件通过 `MO_GALLERY_EMBEDDING_RUNTIME` 拿到它。
 *   所以本文件顶部**不能**含对运行时目录的静态 `import`——纯函数测试要在没有模型、
 *   没有运行时的机器上跑得起来（`tests/sequence.test.mjs` 就靠这条）。
 * - **动态 import 必须走 file URL**：Windows 裸路径会被 Node 以
 *   `ERR_UNSUPPORTED_ESM_URL_SCHEME` 拒绝（实测），必须 `pathToFileURL(...).href`。
 * - **词表按 (运行时目录, 模型目录) 缓存**：tokenizer.json 有 32 MB，进程内重复解析纯属浪费；
 *   换模型目录意味着换词表，所以模型目录是缓存键的一部分。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { ERROR_CODES, ProtocolError } from './errors.mjs'
import { MULTIMODAL_TOKENS } from './models.mjs'

/** 词表落盘名，与 `models.mjs` 里 `kind:'tokenizer'` 的那条 MODEL_FILES 一致。 */
export const TOKENIZER_FILE = 'tokenizer.json'

/**
 * 解析库在运行时目录下的相对路径。
 *
 * 运行时目录的形状是 `resources/inference/<platform>/`，其 `node_modules` 里装着
 * `@huggingface/tokenizers`（0.2.0，`type:'module'`，导出 `Tokenizer`）。
 */
export const TOKENIZERS_ENTRY = join('node_modules', '@huggingface', 'tokenizers', 'dist', 'tokenizers.mjs')

/**
 * 取宿主授予的推理运行时目录。
 *
 * 为空是**宿主契约缺失**（不是用户能自己补的东西），所以报 INTERNAL 而不是 MODEL_MISSING；
 * 文案里带上环境变量名与实际取值，排障时一眼能看出是启动参数没接上。
 */
export function resolveRuntimeDir(value = process.env.MO_GALLERY_EMBEDDING_RUNTIME) {
  const runtimeDir = typeof value === 'string' ? value.trim() : ''
  if (runtimeDir === '') {
    throw new ProtocolError(
      ERROR_CODES.INTERNAL,
      '宿主未提供分词器解析库目录（MO_GALLERY_EMBEDDING_RUNTIME 为空）：' +
        '该目录应形如 resources/inference/<platform>，其 node_modules 下装着 @huggingface/tokenizers；' +
        '请检查宿主的插件启动参数',
    )
  }
  return runtimeDir
}

/** 缓存的是 Promise（并发调用只加载一次）；失败会从缓存里删掉，下一次调用重试。 */
const tokenizers = new Map()

/**
 * 加载并缓存 tokenizer。
 *
 * 顺序刻意是「先读模型文件、再解析运行时目录」：`MODEL_MISSING` 是用户自己能补的（宿主据此
 * 提示下载），`INTERNAL` 是宿主契约问题，两者混起来会把排障方向带偏。
 *
 * @param {{ modelsDir?: string, runtimeDir?: string|(() => string) }} options
 *   `runtimeDir` 可以给函数（默认 `resolveRuntimeDir`），这样「宿主没配置运行时」这件事
 *   只在真要加载解析库时才发作，纯函数路径不受影响。
 * @returns {Promise<object>} `@huggingface/tokenizers` 的 `Tokenizer` 实例
 */
export function loadTokenizer({ modelsDir, runtimeDir = resolveRuntimeDir } = {}) {
  if (typeof modelsDir !== 'string' || modelsDir === '') {
    return Promise.reject(
      new ProtocolError(ERROR_CODES.MODEL_MISSING, '模型目录未配置（MO_GALLERY_EMBEDDING_MODELS 为空），无法读取 tokenizer.json'),
    )
  }
  const tokenizerPath = join(modelsDir, TOKENIZER_FILE)
  let raw
  try {
    raw = readFileSync(tokenizerPath, 'utf8')
  } catch (error) {
    return Promise.reject(
      new ProtocolError(
        ERROR_CODES.MODEL_MISSING,
        `缺少分词器文件 ${tokenizerPath}：${error instanceof Error ? error.message : String(error)}`,
      ),
    )
  }

  const dir = typeof runtimeDir === 'function' ? runtimeDir() : runtimeDir
  const key = `${dir}\u0000${modelsDir}`
  const cached = tokenizers.get(key)
  if (cached !== undefined) return cached

  const pending = loadFrom(dir, tokenizerPath, raw)
  tokenizers.set(key, pending)
  // 失败不留在缓存里：宿主补好文件后同进程重试应当真的重试。
  pending.catch(() => tokenizers.delete(key))
  return pending
}

/** 真正的加载：动态 import 解析库 + 解析词表 + 构造 Tokenizer。 */
async function loadFrom(runtimeDir, tokenizerPath, raw) {
  const entry = pathToFileURL(join(runtimeDir, TOKENIZERS_ENTRY)).href
  let module
  try {
    module = await import(entry)
  } catch (error) {
    throw new ProtocolError(
      ERROR_CODES.INTERNAL,
      `无法从 ${entry} 加载 @huggingface/tokenizers：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const { Tokenizer } = module ?? {}
  if (typeof Tokenizer !== 'function') {
    throw new ProtocolError(ERROR_CODES.INTERNAL, `${entry} 未导出 Tokenizer 构造函数`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ProtocolError(
      ERROR_CODES.MODEL_MISSING,
      `${tokenizerPath} 不是合法 JSON（文件可能下载不完整）：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  try {
    // 实测：构造函数要**已解析的对象**，传 JSON 字符串会抛 "Tokenizer must be a valid object"。
    return new Tokenizer(parsed, {})
  } catch (error) {
    throw new ProtocolError(
      ERROR_CODES.INTERNAL,
      `${tokenizerPath} 无法构造 Tokenizer：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * 编码一段文本。
 *
 * `encode()` 自带 `post_processor` 语义（`tokenizer.json` 里是
 * `TemplateProcessing single=[<bos>, A, <eos>]`，实测 `encode('hello world').ids === [2,23391,1902,1]`），
 * 所以**不要**自己加 bos/eos。`attention_mask` 由解析库一并给出，直接透传，别在这里造。
 *
 * @returns {{ ids: number[], attentionMask: number[] }}
 */
export function encodeText(tokenizer, text) {
  if (typeof text !== 'string' || text === '') {
    throw new ProtocolError(ERROR_CODES.BAD_REQUEST, 'text must be a non-empty string')
  }
  const encoded = tokenizer.encode(text)
  const ids = Array.from(encoded.ids ?? [])
  if (ids.length === 0) {
    throw new ProtocolError(ERROR_CODES.BAD_REQUEST, 'text encoded to zero tokens')
  }
  const attentionMask = Array.from(encoded.attention_mask ?? new Array(ids.length).fill(1))
  return { ids, attentionMask }
}

/**
 * 把 N 个软 token 装配成图像占位符序列。
 *
 * 依据是 HF 参考实现 `processing_embedding_gemma2.py` 的
 * `replace_image_token()`：`f"{boi_token}{image_token * num_soft_tokens}{eoi_token}"`，
 * 三个字面量取自 `tokenizer_config.json` 的 `boi_token` / `image_token` / `eoi_token`
 * （见 {@link MULTIMODAL_TOKENS}）。**N 必须等于视觉编码器实际吐出的 token 数**
 * （`engine.encodeImageFeatures(patches).tokenCount`），因为文本塔是按占位符位置把
 * `image_features` scatter 进去的；N 猜错不会报错，只会静默劣化。
 */
export function imagePlaceholderSequence(numSoftTokens) {
  if (!Number.isInteger(numSoftTokens) || numSoftTokens <= 0) {
    throw new ProtocolError(
      ERROR_CODES.BAD_REQUEST,
      `numSoftTokens must be a positive integer (got ${typeof numSoftTokens === 'number' ? numSoftTokens : typeof numSoftTokens})`,
    )
  }
  return MULTIMODAL_TOKENS.boi + MULTIMODAL_TOKENS.image.repeat(numSoftTokens) + MULTIMODAL_TOKENS.eoi
}
