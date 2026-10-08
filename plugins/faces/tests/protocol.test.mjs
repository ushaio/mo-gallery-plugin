/**
 * 协议行为单测：不启子进程、不碰 ONNX，用替身引擎把 faces@1 的每条语义跑完。
 *
 * 覆盖的是宿主 `storage_plugins/faces.go` 会依赖的全部形状：握手、模型声明、健康、
 * 二进制负载装配、参数校验、错误码，以及「一条坏请求不毒化进程」。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ERROR_CODES, RPC_ERRORS } from '../src/errors.mjs'
import {
  FRAME_TYPE_CONTROL,
  FrameDecoder,
  encodeControlFrame,
  encodeDataFrame,
} from '../src/frames.mjs'
import { FACES_PROTOCOL, createFacesPlugin, readManifest } from '../src/index.mjs'

function stubEngine() {
  return {
    calls: [],
    async detect(raster, options) {
      this.calls.push({ kind: 'detect', raster, options })
      return {
        width: raster.width,
        height: raster.height,
        paddedWidth: 640,
        paddedHeight: 640,
        faces: [{ score: 0.99, x: 1, y: 2, width: 3, height: 4, landmarks: [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]] }],
      }
    },
    async embed(raster, landmarks) {
      this.calls.push({ kind: 'embed', raster, landmarks })
      return { embedding: Array.from({ length: 128 }, (_, index) => index / 128), norm: 12.5 }
    },
    async dispose() {
      this.calls.push({ kind: 'dispose' })
    },
  }
}

/** 把插件当作真进程来驱动：字节进 → 字节出，中间只经过帧解码。 */
function harness({ engine = stubEngine(), modelsDirectory = join(tmpdir(), 'mo-gallery-faces-missing-models') } = {}) {
  const written = []
  const plugin = createFacesPlugin({
    write: (frame) => written.push(Buffer.from(frame)),
    modelsDirectory,
    engine,
  })
  const decoder = new FrameDecoder()
  function feed(buffer) {
    for (const frame of decoder.push(Buffer.from(buffer))) plugin.acceptFrame(frame.type, frame.payload)
  }
  return {
    engine,
    plugin,
    feed,
    send(envelope) {
      feed(encodeControlFrame(envelope))
    },
    sendChunked(buffer, size) {
      for (let offset = 0; offset < buffer.length; offset += size) {
        feed(buffer.subarray(offset, offset + size))
      }
    },
    /** 已写出的帧，按到达顺序解码成 JSON 信封。 */
    async messages() {
      await plugin.drain()
      const frames = []
      const local = new FrameDecoder()
      for (const chunk of written) frames.push(...local.push(chunk))
      return frames.map((frame) => {
        assert.equal(frame.type, FRAME_TYPE_CONTROL, 'the plugin only ever writes control frames')
        return JSON.parse(frame.payload.toString('utf8'))
      })
    },
    async last() {
      const messages = await this.messages()
      return messages[messages.length - 1]
    },
  }
}

/** 手工造一个控制帧：用来喂「负载不是合法 JSON」这种真实世界里的坏输入。 */
function rawControlFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const frame = Buffer.alloc(5 + payload.length)
  frame.writeUInt32BE(payload.length + 1, 0)
  frame.writeUInt8(0, 4)
  payload.copy(frame, 5)
  return frame
}

function declareDetect(harnessRef, { width = 4, height = 2, id = 11, blobID = 'image', extra = {}, rgb } = {}) {
  const bytes = rgb ?? Buffer.alloc(width * height * 3, 3)
  harnessRef.send({
    jsonrpc: '2.0',
    id,
    method: 'face.detect',
    params: { ...extra, image: { width, height, blob: { id: blobID, length: bytes.length } } },
  })
  harnessRef.feed(encodeDataFrame(blobID, 0, bytes))
  return bytes
}

test('the handshake echoes the manifest the host reads from disk', async () => {
  const link = harness()
  link.send({ jsonrpc: '2.0', id: 1, method: 'plugin.getManifest' })
  const reply = await link.last()
  const manifest = readManifest()
  assert.equal(reply.id, 1)
  assert.deepEqual(reply.result, manifest)
  assert.equal(reply.result.id, 'faces')
  const contribution = reply.result.contributions.find((item) => item.domain === 'faces')
  assert.equal(contribution.apiVersion, '1')
  assert.deepEqual(contribution.capabilities, ['faces.models', 'faces.detect', 'faces.embed'])
  assert.equal(reply.result.runtime.type, 'node')
  assert.ok(reply.result.permissions.includes('addons:onnx'), 'the ONNX addon permission is required by the host')
})

test('the model declaration satisfies every host-side validation rule', async () => {
  const link = harness()
  link.send({ jsonrpc: '2.0', id: 2, method: 'faces.getModelSpecs' })
  const reply = await link.last()
  assert.equal(reply.result.protocol, FACES_PROTOCOL)
  assert.ok(reply.result.engine.name.length > 0 && reply.result.engine.version.length > 0)
  assert.equal(reply.result.models.length, 2)
  const kinds = reply.result.models.map((model) => model.kind).sort()
  assert.deepEqual(kinds, ['detector', 'recognizer'])
  const yunet = reply.result.models.find((model) => model.id === 'yunet')
  assert.equal(yunet.sha256, 'ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0')
  assert.equal(yunet.sizeBytes, 229738)
  for (const model of reply.result.models) {
    assert.ok(model.id.length > 0 && model.id.length <= 64)
    assert.ok(!/[/\\]/.test(model.file), 'the host refuses paths, only bare file names')
    assert.match(model.sha256, /^[0-9a-f]{64}$/)
    assert.ok(model.sizeBytes > 0)
    assert.ok(typeof model.license === 'string' && model.license.length > 0)
  }
})

test('health reports the model directory without hashing and admits there is no analysis cache', async () => {
  const modelsDirectory = join(tmpdir(), 'mo-gallery-faces-absent-models')
  const link = harness({ modelsDirectory })
  link.send({ jsonrpc: '2.0', id: 3, method: 'faces.health' })
  const reply = await link.last()
  assert.equal(reply.result.modelsDir, modelsDirectory)
  assert.equal(reply.result.models.length, 2)
  for (const model of reply.result.models) {
    assert.equal(model.present, false)
    assert.equal(model.sizeBytes, 0)
    assert.ok(model.expectedSizeBytes > 0)
  }
  assert.deepEqual(reply.result.cache, { entries: 0, bytes: 0 })
  // 一个请求只能有一个回应：health 曾经因为漏写 return 而掉进 detect 分支，同时回了
  // 「缺 image」和健康数据两条，这一条断言就是那次的回归锁。
  assert.equal((await link.messages()).length, 1, 'faces.health must answer exactly once')
})

test('a detect call assembles its blob and hands the exact pixels to the engine', async () => {
  const link = harness()
  const bytes = declareDetect(link, { width: 6, height: 5 })
  const reply = await link.last()
  assert.equal(reply.id, 11)
  assert.equal(reply.result.width, 6)
  assert.equal(reply.result.height, 5)
  assert.equal(reply.result.faces.length, 1)
  assert.deepEqual(reply.result.faces[0].landmarks[4], [9, 10])
  assert.equal(link.engine.calls.length, 1)
  const call = link.engine.calls[0]
  assert.equal(call.kind, 'detect')
  assert.equal(call.raster.width, 6)
  assert.equal(call.raster.height, 5)
  assert.deepEqual(Buffer.from(call.raster.data), bytes)
})

test('a 3 MiB blob split into 1 MiB frames arrives byte-identical', async () => {
  const link = harness()
  const size = 1024 * 1024 * 3
  const rgb = Buffer.alloc(size)
  for (let index = 0; index < size; index += 1) rgb[index] = index % 251
  link.send({
    jsonrpc: '2.0',
    id: 12,
    method: 'face.detect',
    params: { image: { width: 1024, height: 1024, blob: { id: 'image', length: size } } },
  })
  for (let offset = 0; offset < size; offset += 1024 * 1024) {
    const end = Math.min(offset + 1024 * 1024, size)
    link.feed(encodeDataFrame('image', offset, rgb.subarray(offset, end)))
  }
  const reply = await link.last()
  assert.equal(reply.error, undefined)
  const received = Buffer.from(link.engine.calls[0].raster.data)
  assert.equal(received.length, size)
  assert.ok(received.equals(rgb), 'the reassembled buffer must be byte-identical')
})

test('detection options are validated and passed through', async () => {
  const link = harness()
  declareDetect(link, { extra: { scoreThreshold: 0.75, nmsThreshold: 0.4, topK: 100 } })
  await link.last()
  assert.deepEqual(link.engine.calls[0].options, { scoreThreshold: 0.75, nmsThreshold: 0.4, topK: 100 })

  const bad = harness()
  declareDetect(bad, { id: 21, extra: { scoreThreshold: 2 } })
  const reply = await bad.last()
  assert.equal(reply.error.code, ERROR_CODES.BAD_REQUEST)
  assert.equal(bad.engine.calls.length, 0)
})

test('an embed call hands the raster and the five landmarks over', async () => {
  const link = harness()
  const landmarks = [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]]
  link.send({
    jsonrpc: '2.0',
    id: 13,
    method: 'face.embed',
    params: { landmarks, image: { width: 4, height: 2, blob: { id: 'image', length: 24 } } },
  })
  link.feed(encodeDataFrame('image', 0, Buffer.alloc(24, 1)))
  const reply = await link.last()
  assert.equal(reply.result.embedding.length, 128)
  assert.equal(reply.result.norm, 12.5)
  assert.deepEqual(link.engine.calls[0].landmarks, landmarks)
})

test('bad images and bad landmarks are refused before any inference runs', async () => {
  const cases = [
    { name: 'too large per edge', params: { image: { width: 2048, height: 8, blob: { id: 'image', length: 2048 * 8 * 3 } } }, code: ERROR_CODES.DECODE_FAILED },
    { name: 'declared length mismatch', params: { image: { width: 4, height: 2, blob: { id: 'image', length: 23 } } }, code: ERROR_CODES.DECODE_FAILED },
    { name: 'missing blob', params: { image: { width: 4, height: 2 } }, code: ERROR_CODES.BAD_REQUEST },
    { name: 'missing image', params: {}, code: ERROR_CODES.BAD_REQUEST },
  ]
  for (const testCase of cases) {
    const link = harness()
    link.send({ jsonrpc: '2.0', id: 30, method: 'face.detect', params: testCase.params })
    const reply = await link.last()
    assert.equal(reply.error.code, testCase.code, testCase.name)
    assert.equal(link.engine.calls.length, 0, testCase.name)
  }

  const embed = harness()
  embed.send({
    jsonrpc: '2.0',
    id: 31,
    method: 'face.embed',
    params: { landmarks: [[1, 2]], image: { width: 4, height: 2, blob: { id: 'image', length: 24 } } },
  })
  const reply = await embed.last()
  assert.equal(reply.error.code, ERROR_CODES.BAD_REQUEST)
  assert.match(reply.error.message, /5 \[x, y\] pairs/)
  assert.equal(embed.engine.calls.length, 0)
})

test('a broken data frame fails only its own request', async () => {
  const link = harness()
  link.send({
    jsonrpc: '2.0',
    id: 40,
    method: 'face.detect',
    params: { image: { width: 4, height: 2, blob: { id: 'image', length: 24 } } },
  })
  link.feed(encodeDataFrame('image', 8, Buffer.alloc(8)))
  const reply = await link.last()
  assert.equal(reply.id, 40)
  assert.equal(reply.error.code, ERROR_CODES.INTERNAL)
  assert.match(reply.error.message, /out of order/)

  // 流仍然可用：下一条请求照常工作。
  declareDetect(link, { id: 41 })
  const after = await link.last()
  assert.equal(after.id, 41)
  assert.equal(after.error, undefined)

  const overlong = harness()
  overlong.send({
    jsonrpc: '2.0',
    id: 42,
    method: 'face.detect',
    params: { image: { width: 4, height: 2, blob: { id: 'image', length: 24 } } },
  })
  overlong.feed(encodeDataFrame('image', 0, Buffer.alloc(25)))
  const overlongReply = await overlong.last()
  assert.equal(overlongReply.error.code, ERROR_CODES.INTERNAL)
  assert.match(overlongReply.error.message, /exceeds its declared length/)
})

test('bytes with no owner are dropped instead of killing the process', async () => {
  const link = harness()
  link.feed(encodeDataFrame('nobody', 0, Buffer.alloc(4)))
  link.send({ jsonrpc: '2.0', id: 50, method: 'faces.health' })
  const reply = await link.last()
  assert.equal(reply.id, 50)
  assert.equal(reply.error, undefined)
})

test('declaring a blob id that is already in use is refused', async () => {
  const link = harness()
  link.send({
    jsonrpc: '2.0',
    id: 60,
    method: 'face.detect',
    params: { image: { width: 4, height: 2, blob: { id: 'image', length: 24 } } },
  })
  link.send({
    jsonrpc: '2.0',
    id: 61,
    method: 'face.detect',
    params: { image: { width: 4, height: 2, blob: { id: 'image', length: 24 } } },
  })
  const first = await link.last()
  assert.equal(first.id, 61)
  assert.equal(first.error.code, ERROR_CODES.BAD_REQUEST)
  assert.match(first.error.message, /already in use/)
  // 在途的那条仍然能被满足。
  link.feed(encodeDataFrame('image', 0, Buffer.alloc(24, 2)))
  const pending = (await link.messages()).find((message) => message.id === 60)
  assert.equal(pending.error, undefined)
})

test('unknown methods, malformed JSON and notifications follow JSON-RPC', async () => {
  const link = harness()
  link.send({ jsonrpc: '2.0', id: 70, method: 'face.analyze', params: {} })
  const unknown = await link.last()
  assert.equal(unknown.error.code, RPC_ERRORS.METHOD_NOT_FOUND)

  link.feed(rawControlFrame('{not json'))
  const malformed = await link.last()
  assert.equal(malformed.error.code, RPC_ERRORS.PARSE_ERROR)
  assert.equal(malformed.id, null)

  link.send({ jsonrpc: '2.0', id: null, method: 'faces.health' })
  const messages = await link.messages()
  assert.equal(messages.filter((message) => message.error?.code === RPC_ERRORS.PARSE_ERROR).length, 1)
  assert.equal(messages.length, 2, 'a notification must not be answered')
})

test('engine failures surface as the host-side domain error codes', async () => {
  const engine = {
    async detect() {
      const { ProtocolError } = await import('../src/errors.mjs')
      throw new ProtocolError('MODEL_MISSING', 'model yunet is missing: face_detection_yunet_2026may.onnx')
    },
    async embed() {
      throw new Error('boom')
    },
    async dispose() {},
  }
  const link = harness({ engine })
  declareDetect(link, { id: 80 })
  const missing = await link.last()
  assert.equal(missing.error.code, 'MODEL_MISSING', 'string codes travel to Go unchanged')
  assert.match(missing.error.message, /face_detection_yunet_2026may.onnx/)

  link.send({
    jsonrpc: '2.0',
    id: 81,
    method: 'face.embed',
    params: { landmarks: [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]], image: { width: 4, height: 2, blob: { id: 'image', length: 24 } } },
  })
  link.feed(encodeDataFrame('image', 0, Buffer.alloc(24, 1)))
  const generic = await link.last()
  assert.equal(generic.error.code, ERROR_CODES.INTERNAL)
  assert.equal(generic.error.message, 'boom')
})

test('dispose is idempotent so shutdown cannot double-release the session', async () => {
  const link = harness()
  await link.plugin.dispose()
  await link.plugin.dispose()
  assert.equal(link.engine.calls.filter((call) => call.kind === 'dispose').length, 1)
})

test('a blob delivered in small chunks reaches the engine byte-identical', async () => {
  const link = harness()
  const bytes = Buffer.from(Array.from({ length: 96 }, (_, index) => (index * 7) % 256))
  link.send({
    jsonrpc: '2.0',
    id: 90,
    method: 'face.detect',
    params: { image: { width: 8, height: 4, blob: { id: 'image', length: bytes.length } } },
  })
  for (let offset = 0; offset < bytes.length; offset += 3) {
    link.feed(encodeDataFrame('image', offset, bytes.subarray(offset, offset + 3)))
  }
  const reply = await link.last()
  assert.equal(reply.id, 90)
  assert.equal(reply.error, undefined)
  assert.ok(Buffer.from(link.engine.calls[0].raster.data).equals(bytes))
})
