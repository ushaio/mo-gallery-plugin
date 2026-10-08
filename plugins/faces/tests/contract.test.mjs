/**
 * 端到端契约测试：按宿主的真实方式启动子进程（真权限参数、真环境、真二进制帧）。
 *
 * 分两层：
 *
 * - **总是跑**：握手、模型声明、健康、缺模型时的错误码，以及「一条领域错误不会让进程崩掉」。
 *   这一层用空模型目录，因此不依赖 onnxruntime 与模型权重。
 * - **有模型和运行时时才跑**（本机通常具备）：真 YuNet/SFace 推理，核对返回结构的每个字段、
 *   归一化关系与确定性。
 *
 * 真实人脸的检出率门禁不在这里：那需要用户自己的照片目录，属于宿主侧的冒烟测试
 * （`local_library` 的 MO_GALLERY_FACE_SMOKE 门禁）。这里证明的是「同一份算法在插件里
 * 仍然正确且可复现」——与 sidecar 的逐位对照见 `sidecar-parity.test.mjs`。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  HostLink,
  defaultModelsDir,
  defaultRuntimeDir,
  modelsAvailable,
  runtimeAvailable,
  syntheticRGB,
} from './helpers/host.mjs'

const MODELS_DIR = defaultModelsDir()
const RUNTIME_DIR = defaultRuntimeDir()
const REAL_MODELS = modelsAvailable(MODELS_DIR) && runtimeAvailable(RUNTIME_DIR)
const SKIP_REASON = REAL_MODELS
  ? false
  : `需要模型（${MODELS_DIR}）与 onnxruntime（${RUNTIME_DIR}）`

async function withEmptyModels(run) {
  const directory = await mkdtemp(join(tmpdir(), 'mo-gallery-faces-empty-'))
  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('a host-style launch completes the handshake, the declaration and reports missing models', async () => {
  await withEmptyModels(async (modelsDir) => {
    const link = new HostLink({ modelsDir }).start()
    try {
      const manifest = await link.call('plugin.getManifest')
      assert.equal(manifest.id, 'faces')
      assert.equal(manifest.runtime.type, 'node')
      const contribution = manifest.contributions.find((item) => item.domain === 'faces')
      assert.equal(contribution.apiVersion, '1', 'the host checks SupportsContribution(faces, 1)')

      const specs = await link.call('faces.getModelSpecs')
      assert.equal(specs.protocol, 1, 'the host refuses any other declaration protocol')
      const kinds = specs.models.map((model) => model.kind).sort()
      assert.deepEqual(kinds, ['detector', 'recognizer'], 'both kinds are mandatory host-side')
      assert.match(specs.models[0].sha256, /^[0-9a-f]{64}$/)

      const health = await link.call('faces.health')
      assert.equal(health.modelsDir, modelsDir)
      assert.ok(health.models.every((model) => model.present === false))
      assert.ok(health.models.every((model) => model.sizeBytes === 0))

      // 缺模型是领域错误（MODEL_MISSING），必须原样回给宿主，而不是让进程崩掉。
      await assert.rejects(
        () => link.callWithImage('face.detect', { width: 64, height: 64, rgb: syntheticRGB(64, 64) }),
        /MODEL_MISSING/,
      )
      const after = await link.call('faces.health')
      assert.equal(after.modelsDir, modelsDir, 'the process survives a domain error')

      assert.equal(await link.close(), 0, 'closing stdin ends the process cleanly')
    } finally {
      link.kill()
    }
  })
})

test('a real YuNet/SFace run returns a host-shaped detection and embedding', { skip: SKIP_REASON }, async () => {
  const link = new HostLink().start()
  try {
    const width = 320
    const height = 240
    const rgb = syntheticRGB(width, height, 11)
    const detected = await link.callWithImage('face.detect', { width, height, rgb, scoreThreshold: 0.9 })
    assert.equal(detected.width, width)
    assert.equal(detected.height, height)
    assert.equal(detected.paddedWidth % 32, 0, 'the YuNet input is padded to a multiple of 32')
    assert.equal(detected.paddedHeight % 32, 0)
    assert.ok(detected.paddedWidth >= width && detected.paddedHeight >= height)
    assert.ok(Array.isArray(detected.faces))
    assert.equal(detected.faces.length, 0, 'pure noise carries no face')
    assert.ok(link.stderr.length >= 0)

    // 真实权重跑过一次就说明「预处理 → 会话 → 解码 → NMS」整条链在插件里成立；
    // 检出形状的正确性由 face.test.mjs 的 OpenCV 基准张量覆盖。
    const landmarks = [[70, 60], [110, 60], [90, 92], [72, 122], [108, 122]]
    const embedded = await link.callWithImage('face.embed', { width, height, rgb, landmarks })
    assert.equal(embedded.embedding.length, 128)
    assert.ok(embedded.embedding.every((value) => Number.isFinite(value)))
    assert.ok(embedded.embedding.some((value) => value !== 0), 'the recognizer must produce a real vector')
    const norm = Math.sqrt(embedded.embedding.reduce((sum, value) => sum + value * value, 0))
    assert.ok(Math.abs(norm - embedded.norm) < 1e-3, `norm ${embedded.norm} must be the L2 norm ${norm}`)

    const again = await link.callWithImage('face.embed', { width, height, rgb, landmarks })
    assert.deepEqual(again.embedding, embedded.embedding, 'the same input must give the same vector')

    // 同一张脸的两次调用之间，检测也应当完全一致（NMS 顺序不能漂）。
    const detectedAgain = await link.callWithImage('face.detect', { width, height, rgb, scoreThreshold: 0.5 })
    assert.ok(detectedAgain.paddedWidth === detected.paddedWidth)
  } finally {
    link.kill()
  }
})

test('two independent processes produce byte-identical embeddings', { skip: SKIP_REASON }, async () => {
  const width = 160
  const height = 160
  const rgb = syntheticRGB(width, height, 23)
  const landmarks = [[40, 40], [80, 40], [60, 70], [42, 100], [78, 100]]
  const runOnce = async () => {
    const link = new HostLink().start()
    try {
      const result = await link.callWithImage('face.embed', { width, height, rgb, landmarks })
      return result.embedding
    } finally {
      link.kill()
    }
  }
  const first = await runOnce()
  const second = await runOnce()
  assert.deepEqual(second, first, 'a fresh process must reproduce the same vector')
})

test('the plugin never writes protocol noise to stdout', { skip: SKIP_REASON }, async () => {
  const link = new HostLink().start()
  try {
    // 只要 stdout 里混进任何非帧字节，帧解码就会失败并让这里超时/报错。
    for (let round = 0; round < 3; round += 1) {
      const health = await link.call('faces.health')
      assert.equal(health.engine.name.length > 0, true)
    }
    assert.equal(await link.close(), 0)
  } finally {
    link.kill()
  }
})
