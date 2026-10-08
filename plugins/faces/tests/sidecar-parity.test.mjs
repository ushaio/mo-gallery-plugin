/**
 * 与旧内置 sidecar 的等价性对照。
 *
 * 这是「移植没有改算法」的直接证据：同一批合成像素同时喂给
 * ① `emulsion-desktop-v3/runtime/inference`（旧 sidecar，NDJSON + base64）与
 * ② 本插件（二进制帧），逐字段比对检测框与 128 维特征。
 *
 * 为什么用合成像素而不是真实照片：真实照片属于用户，不该被测试读取；而等价性只要求
 * 「两边吃同样的输入、吐同样的输出」。为了不比对空数组，检测用例用 0.05 的极低阈值——
 * 随机噪声里也确实会冒出真实候选框（实测 320×240 能出 1–31 个），于是框、分数、五点
 * 关键点都被逐位比对到。真正需要真人脸的门禁是宿主侧的 MO_GALLERY_FACE_SMOKE。
 *
 * 旧 sidecar 从 desktop 仓库删除后，本文件自动跳过（它是迁移期的一次性对照）。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
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
const SIDECAR_ENTRY = join(RUNTIME_DIR, 'main.js')
const AVAILABLE =
  modelsAvailable(MODELS_DIR) && runtimeAvailable(RUNTIME_DIR) && existsSync(SIDECAR_ENTRY)
const SKIP_REASON = AVAILABLE ? false : '需要旧 sidecar、模型与 onnxruntime'

/** 旧 sidecar 的 NDJSON 客户端：一次一行 JSON，`{id, ok, result}` 信封。 */
class Sidecar {
  #child = null
  #pending = new Map()
  #nextID = 0

  start() {
    this.#child = spawn(process.execPath, [SIDECAR_ENTRY, '--serve', '--models-dir', MODELS_DIR], {
      cwd: RUNTIME_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#child.stderr.on('data', () => {})
    createInterface({ input: this.#child.stdout }).on('line', (line) => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      const pending = this.#pending.get(String(message.id))
      if (pending === undefined) return
      this.#pending.delete(String(message.id))
      if (message.ok === false) pending.reject(new Error(`${message.error?.code}: ${message.error?.message}`))
      else pending.resolve(message.result)
    })
    return this
  }

  call(method, params) {
    const id = String((this.#nextID += 1))
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  image(width, height, rgb) {
    return { width, height, data: Buffer.from(rgb).toString('base64') }
  }

  detect(width, height, rgb, scoreThreshold) {
    return this.call('face.detect', { image: this.image(width, height, rgb), scoreThreshold })
  }

  embed(width, height, rgb, landmarks) {
    return this.call('face.embed', { image: this.image(width, height, rgb), landmarks })
  }

  kill() {
    this.#child?.kill()
  }
}

function cosine(a, b) {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index]
    normA += a[index] * a[index]
    normB += b[index] * b[index]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

function maxDifference(a, b) {
  let worst = 0
  for (let index = 0; index < a.length; index += 1) {
    worst = Math.max(worst, Math.abs(a[index] - b[index]))
  }
  return worst
}

/**
 * 低阈值那两条保证「确实有框可比」；高阈值那条是反向对照：没有脸时两边都必须报 0。
 */
const CASES = [
  { width: 320, height: 240, seed: 11, threshold: 0.05, expectFaces: true },
  { width: 1024, height: 768, seed: 47, threshold: 0.05, expectFaces: true },
  { width: 100, height: 100, seed: 29, threshold: 0.9, expectFaces: false },
]
const LANDMARKS = [[70, 60], [110, 60], [90, 92], [72, 122], [108, 122]]

test('the plugin reproduces the sidecar detection geometry on the same pixels', { skip: SKIP_REASON }, async () => {
  const sidecar = new Sidecar().start()
  const plugin = new HostLink().start()
  try {
    for (const testCase of CASES) {
      const { width, height, seed, threshold, expectFaces } = testCase
      const label = `${width}x${height}@${threshold}`
      const rgb = syntheticRGB(width, height, seed)
      const expected = await sidecar.detect(width, height, rgb, threshold)
      const actual = await plugin.callWithImage('face.detect', { width, height, rgb, scoreThreshold: threshold })
      assert.equal(actual.paddedWidth, expected.paddedWidth, `${label} padded width`)
      assert.equal(actual.paddedHeight, expected.paddedHeight, `${label} padded height`)
      assert.equal(actual.faces.length, expected.faces.length, `${label} detection count`)
      if (expectFaces) {
        assert.ok(expected.faces.length > 0, `${label} must produce candidates so the comparison is real`)
      }
      for (let index = 0; index < expected.faces.length; index += 1) {
        const want = expected.faces[index]
        const got = actual.faces[index]
        for (const key of ['score', 'x', 'y', 'width', 'height']) {
          assert.ok(
            Math.abs(want[key] - got[key]) < 1e-9,
            `${label} face ${index} ${key}: ${got[key]} vs ${want[key]}`,
          )
        }
        assert.deepEqual(got.landmarks, want.landmarks, `${label} face ${index} landmarks`)
      }
    }
  } finally {
    sidecar.kill()
    plugin.kill()
  }
})

test('the plugin reproduces the sidecar embedding on the same pixels', { skip: SKIP_REASON }, async () => {
  const sidecar = new Sidecar().start()
  const plugin = new HostLink().start()
  try {
    for (const testCase of CASES) {
      const { width, height, seed } = testCase
      const label = `${width}x${height}`
      const rgb = syntheticRGB(width, height, seed)
      const expected = await sidecar.embed(width, height, rgb, LANDMARKS)
      const actual = await plugin.callWithImage('face.embed', {
        width,
        height,
        rgb,
        landmarks: LANDMARKS,
      })
      assert.equal(actual.embedding.length, expected.embedding.length)
      const drift = maxDifference(actual.embedding, expected.embedding)
      assert.ok(drift < 1e-6, `${label} embeddings drifted by ${drift}`)
      assert.ok(cosine(actual.embedding, expected.embedding) > 0.9999999, `${label} cosine`)
      assert.ok(Math.abs(actual.norm - expected.norm) < 1e-6, `${label} norm`)
    }
  } finally {
    sidecar.kill()
    plugin.kill()
  }
})
