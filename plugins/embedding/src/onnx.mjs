/**
 * 从宿主提供的只读目录里加载 `onnxruntime-node`。
 *
 * 与 `faces/src/onnx.mjs` 是同一套约定（**刻意不抽公共包**：插件是独立子进程，共享源码要跨仓库
 * 同步，收益不抵成本）。宿主把装好 addon 的目录通过 `MO_GALLERY_EMBEDDING_RUNTIME` 交过来，
 * 并同时授予 `--allow-fs-read=<runtimeDir>` 与 `--allow-addons`（后者目前只发给 faces@1，
 * 放给 embedding@1 需要双仓库契约改动，见设计文档 §4.3）。
 *
 * 目录布局由宿主决定，按优先级尝试三种形状：`<root>/node_modules/<pkg>`、`<root>/<pkg>`、`<root>`。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ERROR_CODES, ProtocolError } from './errors.mjs'

export const ONNX_PACKAGE = 'onnxruntime-node'

/** 宿主授予的原生运行时目录；未设置时返回空串。 */
export function onnxRuntimeRoot(env = process.env) {
  const value = env.MO_GALLERY_EMBEDDING_RUNTIME
  return typeof value === 'string' ? value.trim() : ''
}

/** 读包目录里的 package.json，确认它确实是目标包并取出入口。 */
function packageEntry(directory) {
  const manifestPath = join(directory, 'package.json')
  if (!existsSync(manifestPath)) return null
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
  if (manifest === null || typeof manifest !== 'object' || manifest.name !== ONNX_PACKAGE) return null
  const main = typeof manifest.main === 'string' && manifest.main !== '' ? manifest.main : 'dist/index.js'
  return join(directory, main)
}

/** 候选包目录。 */
export function onnxCandidateDirs(root = onnxRuntimeRoot()) {
  if (root === '') return []
  return [join(root, 'node_modules', ONNX_PACKAGE), join(root, ONNX_PACKAGE), root]
}

/**
 * 加载原生运行时。
 *
 * @returns {Promise<{InferenceSession: object, Tensor: object, env?: object}>}
 */
export async function loadOnnxRuntime(root = onnxRuntimeRoot()) {
  const attempts = []
  for (const directory of onnxCandidateDirs(root)) {
    const entry = packageEntry(directory)
    if (entry === null) {
      attempts.push(`${directory}: 不是 ${ONNX_PACKAGE} 包`)
      continue
    }
    try {
      const module = await import(pathToFileURL(entry).href)
      return module.default ?? module
    } catch (error) {
      attempts.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    const module = await import(ONNX_PACKAGE)
    return module.default ?? module
  } catch (error) {
    attempts.push(`bare ${ONNX_PACKAGE}: ${error instanceof Error ? error.message : String(error)}`)
  }
  throw new ProtocolError(
    ERROR_CODES.INFER_FAILED,
    `无法加载 ${ONNX_PACKAGE}（MO_GALLERY_EMBEDDING_RUNTIME=${root === '' ? '(未设置)' : root}）：${attempts.join('；')}`,
  )
}
