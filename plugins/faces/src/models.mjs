/**
 * 人脸模型的清单与完整性校验。
 *
 * 规格里的哈希是**构造期常量**（来自 .trellis/spec/emulsion-desktop/local-ai/
 * face-model-selection.md，已用真实字节复算并与 git-LFS oid 交叉验证），不是从磁盘读出来
 * 的——否则「校验」就退化成「确认文件还是它自己」。
 *
 * 文件从哪来：宿主下载并校验（`face_models.go`），放进它自己的全局模型目录，再把目录通过
 * `MO_GALLERY_FACE_MODELS` 和 `--allow-fs-read=<modelsDir>` 交给插件。插件**不下载、不写**
 * 模型目录，只做「在不在、多大、哈希对不对」。
 *
 * 这份声明就是宿主的唯一模型真相：宿主不再硬编码任何模型清单（faces.go 的
 * validateFacesModelSpecs 只校验声明的形状），所以插件换算法不需要宿主发版。
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ERROR_CODES, ProtocolError } from './errors.mjs'

const YUNET_SHA256 = 'ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0'
const SFACE_SHA256 = '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79'

/**
 * 期望模型。`id` 是库内标识（宿主写进 `face_models.id` 与 `faceIDFor` 的隔离键），
 * `file` 是模型目录里的固定文件名——磁盘文件名一旦允许可变，握手就对不上哈希。
 *
 * detector 选 2026may 而不是 2023mar：**2023mar 的 ONNX 把输入声明成固定 [1,3,640,640]**，
 * OpenCV 自带的推理器会忽略该声明按任意尺寸跑，而 onnxruntime 严格校验，喂非 640 输入直接
 * 报 `Got invalid dimensions for input`。2026may 是同一网络的重新导出（112 个 initializer
 * 逐张量 sha256 与 2023mar 完全一致、106 个节点相同、12 个输出同名），H/W 改成符号维度后
 * ORT 可跑任意分辨率的等宽高等比填充输入，与 OpenCV 结果一致（实测最大偏差 2.3e-5）。
 */
export const FACE_MODEL_SPECS = Object.freeze({
  yunet: Object.freeze({
    id: 'yunet',
    kind: 'detector',
    version: '2026may',
    file: 'face_detection_yunet_2026may.onnx',
    sha256: YUNET_SHA256,
    sizeBytes: 229738,
    license: 'MIT',
    licenseUrl: 'https://github.com/opencv/opencv_zoo/blob/main/models/face_detection_yunet/LICENSE',
    source:
      'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2026may.onnx',
  }),
  sface: Object.freeze({
    id: 'sface',
    kind: 'recognizer',
    version: '2021dec',
    file: 'face_recognition_sface_2021dec.onnx',
    sha256: SFACE_SHA256,
    sizeBytes: 38696353,
    license: 'Apache-2.0',
    licenseUrl: 'https://github.com/opencv/opencv_zoo/blob/main/models/face_recognition_sface/LICENSE',
    source:
      'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx',
  }),
})

/** 已校验过的文件缓存：key = path|size|mtimeMs，避免每次都重算 38 MB 的哈希。 */
const verifiedCache = new Map()

/** 流式 sha256（38 MB 全读进内存没必要）。 */
export async function hashFile(path) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

async function statOrNull(path) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

/** 只查在不在、多大；health 每几十秒就可能被调一次，不能在这里做哈希。 */
export async function inspectModels(modelsDir, specs = FACE_MODEL_SPECS) {
  const list = []
  for (const spec of Object.values(specs)) {
    const path = join(modelsDir, spec.file)
    const info = await statOrNull(path)
    list.push({
      id: spec.id,
      kind: spec.kind,
      version: spec.version,
      file: spec.file,
      present: info !== null && info.isFile(),
      sizeBytes: info !== null && info.isFile() ? info.size : 0,
      expectedSizeBytes: spec.sizeBytes,
    })
  }
  return list
}

/**
 * 校验全部模型；缺失抛 MODEL_MISSING，体积/哈希不符抛 MODEL_HASH_MISMATCH。
 * 返回已确认的模型（含许可与来源），供宿主落库审计。
 */
export async function ensureModels(modelsDir, specs = FACE_MODEL_SPECS) {
  const confirmed = []
  for (const spec of Object.values(specs)) {
    const path = join(modelsDir, spec.file)
    const info = await statOrNull(path)
    if (info === null || !info.isFile()) {
      throw new ProtocolError(ERROR_CODES.MODEL_MISSING, `model ${spec.id} is missing: ${spec.file}`)
    }
    // 体积先行：不一致立刻报，省掉 38 MB 的哈希开销。
    if (info.size !== spec.sizeBytes) {
      throw new ProtocolError(
        ERROR_CODES.MODEL_HASH_MISMATCH,
        `model ${spec.id} has ${info.size} bytes, expected ${spec.sizeBytes}`,
      )
    }
    const key = `${path}|${info.size}|${info.mtimeMs}`
    let digest = verifiedCache.get(key)
    if (digest === undefined) {
      digest = await hashFile(path)
      verifiedCache.set(key, digest)
    }
    if (digest !== spec.sha256) {
      throw new ProtocolError(
        ERROR_CODES.MODEL_HASH_MISMATCH,
        `model ${spec.id} sha256 is ${digest}, expected ${spec.sha256}`,
      )
    }
    confirmed.push({
      id: spec.id,
      kind: spec.kind,
      version: spec.version,
      file: spec.file,
      path,
      sizeBytes: spec.sizeBytes,
      sha256: spec.sha256,
      license: spec.license,
      licenseUrl: spec.licenseUrl,
      source: spec.source,
    })
  }
  return confirmed
}

/**
 * 纯粹的规格清单，不碰文件系统：宿主据此下载并校验，避免把哈希/体积再抄一份。
 * 字段名与宿主的 FacesModelSpec 一一对应。
 */
export function modelSpecs(specs = FACE_MODEL_SPECS) {
  return Object.values(specs).map((spec) => ({
    id: spec.id,
    kind: spec.kind,
    version: spec.version,
    file: spec.file,
    sizeBytes: spec.sizeBytes,
    sha256: spec.sha256,
    license: spec.license,
    licenseUrl: spec.licenseUrl,
    source: spec.source,
  }))
}

/** 已确认过哈希的模型文件条数，供 `faces.health` 如实汇报。 */
export function verifiedModelCount() {
  return verifiedCache.size
}

/** 仅测试用：清掉哈希缓存，避免伪造文件命中别人的结果。 */
export function resetVerifiedCache() {
  verifiedCache.clear()
}
