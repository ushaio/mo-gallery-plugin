/**
 * 一个「迷你宿主」：按 `storage_plugins/faces.go` 的真实方式驱动插件。
 *
 * 存在的意义是让测试无需 Go 侧即可覆盖真实链路——真子进程、真权限参数、真二进制帧。
 * 帧编解码直接复用 `src/frames.mjs`（宿主与插件的格式是同一份规格，两边镜像）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_CHUNK_BYTES, FrameDecoder, encodeControlFrame, encodeDataFrame } from '../../src/frames.mjs'

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const WORKSPACE_ROOT = resolve(PLUGIN_ROOT, '..', '..', '..')
export const PLUGIN_ENTRY = join(PLUGIN_ROOT, 'src', 'index.mjs')

/** 宿主下载并校验过的全局模型目录（`Manager.FaceModelsDir()` 的默认位置）。 */
export function defaultModelsDir() {
  const fromEnv = (process.env.MO_GALLERY_FACE_MODELS ?? '').trim()
  if (fromEnv !== '') return fromEnv
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'mo-gallery-desktop', 'models', 'face')
}

/** 装着 onnxruntime-node 的目录：默认指向仓库里现成的那份 sidecar 依赖树。 */
export function defaultRuntimeDir() {
  const fromEnv = (process.env.MO_GALLERY_FACE_RUNTIME ?? '').trim()
  if (fromEnv !== '') return fromEnv
  return join(WORKSPACE_ROOT, 'emulsion-desktop-v3', 'runtime', 'inference')
}

export function modelsAvailable(modelsDir = defaultModelsDir()) {
  return (
    existsSync(join(modelsDir, 'face_detection_yunet_2026may.onnx')) &&
    existsSync(join(modelsDir, 'face_recognition_sface_2021dec.onnx'))
  )
}

export function runtimeAvailable(runtimeDir = defaultRuntimeDir()) {
  return (
    existsSync(join(runtimeDir, 'node_modules', 'onnxruntime-node', 'package.json')) ||
    existsSync(join(runtimeDir, 'onnxruntime-node', 'package.json'))
  )
}

/** 与宿主 `cleanPluginEnvironment()` 同一思路：只留系统必需的，不继承用户环境。 */
function cleanEnvironment(modelsDir, runtimeDir) {
  const env = {
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    WINDIR: process.env.WINDIR ?? 'C:\\Windows',
    TEMP: process.env.TEMP ?? '',
    TMP: process.env.TMP ?? '',
    LANG: process.env.LANG ?? '',
    MO_GALLERY_FACE_MODELS: modelsDir,
    MO_GALLERY_FACE_RUNTIME: runtimeDir,
  }
  for (const key of Object.keys(env)) {
    if (env[key] === '') delete env[key]
  }
  return env
}

/**
 * 按宿主的方式拼启动参数：Node 常量 → 授予的目录 → 能力开关 → 脚本。
 * 顺序与数量都必须和 `faces.go` 一致，测试才具备证明力。
 */
export function launchArgs({
  modelsDir = defaultModelsDir(),
  runtimeDir = defaultRuntimeDir(),
  permissionFlags = true,
} = {}) {
  const args = ['--max-old-space-size=512']
  if (permissionFlags) {
    args.push(
      '--experimental-permission',
      `--allow-fs-read=${PLUGIN_ROOT}`,
      `--allow-fs-read=${modelsDir}`,
      `--allow-fs-read=${runtimeDir}`,
      '--allow-addons',
    )
  }
  args.push(PLUGIN_ENTRY)
  return args
}

/** 一次调用：控制帧 + 可选的二进制负载。 */
export class HostLink {
  #child = null
  #decoder = new FrameDecoder()
  #pending = new Map()
  #blobs = new Map()
  #nextID = 0
  #stderr = ''
  #exit = null

  constructor(options = {}) {
    this.options = options
  }

  start() {
    const modelsDir = this.options.modelsDir ?? defaultModelsDir()
    const runtimeDir = this.options.runtimeDir ?? defaultRuntimeDir()
    this.#child = spawn(
      process.execPath,
      launchArgs({ modelsDir, runtimeDir, permissionFlags: this.options.permissionFlags ?? true }),
      { env: cleanEnvironment(modelsDir, runtimeDir), stdio: ['pipe', 'pipe', 'pipe'] },
    )
    this.#child.stdout.on('data', (chunk) => this.#onStdout(chunk))
    this.#child.stderr.on('data', (chunk) => {
      this.#stderr += chunk.toString('utf8')
    })
    this.#exit = new Promise((resolve) => this.#child.on('exit', (code) => resolve(code)))
    return this
  }

  get stderr() {
    return this.#stderr
  }

  exited() {
    return this.#exit
  }

  #onStdout(chunk) {
    let frames
    try {
      frames = this.#decoder.push(chunk)
    } catch (error) {
      this.#failAll(error)
      return
    }
    for (const frame of frames) {
      if (frame.type === 1) {
        this.#onDataFrame(frame.payload)
        continue
      }
      let message
      try {
        message = JSON.parse(frame.payload.toString('utf8'))
      } catch {
        continue
      }
      const pending = this.#pending.get(message.id)
      if (pending === undefined) continue
      this.#pending.delete(message.id)
      if (message.error !== undefined) pending.reject(new Error(`${message.error.code}: ${message.error.message}`))
      else pending.resolve(message.result)
    }
  }

  #onDataFrame(payload) {
    const idLength = payload.readUInt8(0)
    const id = payload.subarray(1, 1 + idLength).toString('ascii')
    const offset = payload.readUInt32BE(1 + idLength)
    const chunk = payload.subarray(1 + idLength + 4)
    const inbox = this.#blobs.get(id)
    if (inbox === undefined || offset !== inbox.data.length) return
    inbox.data = Buffer.concat([inbox.data, chunk])
    if (inbox.data.length < inbox.length) return
    this.#blobs.delete(id)
    const pending = this.#pending.get(inbox.rpcID)
    if (pending === undefined) return
    this.#pending.delete(inbox.rpcID)
    pending.resolve({ result: inbox.result, blobs: { [id]: inbox.data } })
  }

  #failAll(error) {
    for (const [, pending] of this.#pending) pending.reject(error)
    this.#pending.clear()
  }

  #write(buffer) {
    this.#child.stdin.write(buffer)
  }

  /** 发一条控制帧；`blobs` 里声明的字节按 1 MiB 分片紧跟其后（与宿主一致）。 */
  call(method, params, blobs = []) {
    const id = (this.#nextID += 1)
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#write(encodeControlFrame({ jsonrpc: '2.0', id, method, params }))
      for (const blob of blobs) {
        for (let offset = 0; offset < blob.data.length; offset += DATA_CHUNK_BYTES) {
          const end = Math.min(offset + DATA_CHUNK_BYTES, blob.data.length)
          this.#write(encodeDataFrame(blob.id, offset, blob.data.subarray(offset, end)))
        }
      }
    })
  }

  /** 用二进制帧发一张 RGB8 图，返回插件的回应（`blob` 负载也会被攒齐）。 */
  callWithImage(method, { width, height, rgb, ...rest }, { blobID = 'image' } = {}) {
    const params = { ...rest, image: { width, height, blob: { id: blobID, length: rgb.length } } }
    return this.call(method, params, [{ id: blobID, data: rgb }])
  }

  async close() {
    if (this.#child === null) return null
    this.#child.stdin.end()
    return this.#exit
  }

  kill() {
    this.#child?.kill()
  }
}

/** 确定性伪随机 RGB 缓冲：同样的种子 → 同样的字节，便于跨进程比对。 */
export function syntheticRGB(width, height, seed = 7) {
  const buffer = Buffer.alloc(width * height * 3)
  let state = seed >>> 0
  for (let index = 0; index < buffer.length; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    buffer[index] = (state >>> 16) & 0xff
  }
  return buffer
}
