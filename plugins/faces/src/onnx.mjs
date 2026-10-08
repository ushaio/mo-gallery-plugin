/**
 * 从宿主提供的只读目录里加载 `onnxruntime-node`。
 *
 * 为什么不能直接 `import 'onnxruntime-node'`：插件是**独立子进程**，只有自己的包目录和宿主
 * 显式授予的目录可读（`--allow-fs-read=`）；原生 addon 也不在插件包里（各平台几十上百 MB，
 * 塞进插件包等于每个插件重复一份）。所以宿主把装好 addon 的目录通过
 * `MO_GALLERY_FACE_RUNTIME` 交过来，并同时授予：
 *
 *   --allow-fs-read=<runtimeDir>   —— 读得到 js 与 .node
 *   --allow-addons                 —— 允许 dlopen 原生扩展（faces@1 专属，见 CAPABILITIES.md）
 *
 * 目录布局由宿主决定，所以这里按优先级尝试三种形状，任一种命中即可：
 *
 *   <root>/node_modules/onnxruntime-node   （pnpm/npm 安装目录）
 *   <root>/onnxruntime-node                （<root> 本身就是 node_modules）
 *   <root>                                 （<root> 就是包目录）
 *
 * 全部失败才报错，并把每次尝试的原因一并带出——排障时「为什么加载不了」比「加载失败」有用。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ERROR_CODES, ProtocolError } from './errors.mjs'

export const ONNX_PACKAGE = 'onnxruntime-node'

/** 宿主授予的原生运行时目录；未设置时返回空串。 */
export function onnxRuntimeRoot(env = process.env) {
  const value = env.MO_GALLERY_FACE_RUNTIME
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

/** 候选包目录，按上面的三种形状展开。 */
export function onnxCandidateDirs(root = onnxRuntimeRoot()) {
  if (root === '') return []
  return [join(root, 'node_modules', ONNX_PACKAGE), join(root, ONNX_PACKAGE), root]
}

/**
 * 加载原生运行时。`root` 默认取自 `MO_GALLERY_FACE_RUNTIME`。
 *
 * @returns {Promise<{InferenceSession: object, Tensor: object}>}
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
  // 最后再试一次裸模块名：宿主如果把运行时目录加进了模块解析路径，这条路也能成。
  try {
    const module = await import(ONNX_PACKAGE)
    return module.default ?? module
  } catch (error) {
    attempts.push(`bare ${ONNX_PACKAGE}: ${error instanceof Error ? error.message : String(error)}`)
  }
  throw new ProtocolError(
    ERROR_CODES.INFER_FAILED,
    `无法加载 ${ONNX_PACKAGE}（MO_GALLERY_FACE_RUNTIME=${root === '' ? '(未设置)' : root}）：${attempts.join('；')}`,
  )
}
