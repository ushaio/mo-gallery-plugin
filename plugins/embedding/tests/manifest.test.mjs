/**
 * manifest 与协议面的单测——**不需要模型文件、不需要 onnxruntime**。
 *
 * 第一条测试是有来历的：`runtime.entry` 指向的 `src/index.mjs` 曾一度**不存在**（manifest 缺席
 * 时无人发现，是因为没有任何东西去核这条路径）。打包器按这个字段找入口，所以它必须存在。
 *
 * 其余测试用手工构造的控制帧把握手与错误路径跑完——`createFacesPlugin` 那种「`write` 可注入」的
 * 形状就是为了这个：不用起子进程也能把整套协议跑完。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { EMBEDDING_API_VERSION, EMBEDDING_DOMAIN, METHODS, createEmbeddingPlugin, readManifest } from '../src/index.mjs'
import { ERROR_CODES, RPC_ERRORS } from '../src/errors.mjs'
import { FrameDecoder, encodeControlFrame, encodeDataFrame } from '../src/frames.mjs'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = readManifest()

/** 收集插件写出的帧并解回信封数组。 */
function collector() {
  const chunks = []
  const decoder = new FrameDecoder()
  return {
    write: (frame) => chunks.push(frame),
    envelopes() {
      const frames = decoder.push(Buffer.concat(chunks))
      chunks.length = 0
      return frames.map((frame) => JSON.parse(frame.payload.toString('utf8')))
    },
  }
}

async function ask(plugin, collected, envelope) {
  plugin.push({ type: 0, payload: Buffer.from(JSON.stringify(envelope), 'utf8') })
  await plugin.drain()
  return collected.envelopes()
}

test('runtime.entry 指向的文件真的存在', () => {
  const entry = manifest.runtime.entry
  assert.equal(typeof entry, 'string')
  assert.ok(existsSync(join(PACKAGE_ROOT, entry)), `manifest.runtime.entry 指向不存在的文件：${entry}`)
})

test('manifest 与 package.json 的版本一致，且有 domain/apiVersion 贡献', () => {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.version, pkg.version)
  const contribution = manifest.contributions[0]
  assert.equal(contribution.domain, EMBEDDING_DOMAIN)
  assert.equal(contribution.apiVersion, EMBEDDING_API_VERSION)
  for (const capability of contribution.capabilities) {
    assert.ok(capability.startsWith(`${EMBEDDING_DOMAIN}.`), `能力 id 必须以域名为前缀：${capability}`)
  }
})

test('声明 addons:onnx 以加载原生 ONNX 运行时（索引侧另有一道校验）', () => {
  // 注意：mo-gallery-plugin 的 validate-index.mjs 目前规定「声明 addons:onnx 必须有 faces 贡献」，
  // 所以这个插件在宿主登记 embedding@1 域之前**进不了索引**。见设计文档 §4.3。
  assert.ok(manifest.permissions.includes('addons:onnx'))
})

test('METHODS 覆盖 manifest 声明的域与握手方法', () => {
  assert.ok(METHODS.includes('plugin.getManifest'))
  for (const method of METHODS) {
    assert.ok(method === 'plugin.getManifest' || method.startsWith(`${EMBEDDING_DOMAIN}.`), method)
  }
})

test('握手：plugin.getManifest 原样回显宿主机读到的 manifest', async () => {
  const collected = collector()
  const plugin = createEmbeddingPlugin({ write: collected.write })
  const [reply] = await ask(plugin, collected, { jsonrpc: '2.0', id: 1, method: 'plugin.getManifest' })
  assert.equal(reply.jsonrpc, '2.0')
  assert.equal(reply.id, 1)
  assert.deepEqual(reply.result, manifest)
})

test('未知方法回 METHOD_NOT_FOUND，而不是断连', async () => {
  const collected = collector()
  const plugin = createEmbeddingPlugin({ write: collected.write })
  const [reply] = await ask(plugin, collected, { jsonrpc: '2.0', id: 7, method: 'embedding.nope' })
  assert.equal(reply.error.code, RPC_ERRORS.METHOD_NOT_FOUND)
})

test('getModelSpecs 交出体积/sha256/来源，宿主据此下载', async () => {
  const collected = collector()
  const plugin = createEmbeddingPlugin({ write: collected.write })
  const [reply] = await ask(plugin, collected, { jsonrpc: '2.0', id: 2, method: 'embedding.getModelSpecs' })
  assert.equal(reply.result.protocol, 1)
  assert.equal(reply.result.dims.default, 256)
  assert.equal(reply.result.grid.min, 26)
  assert.ok(reply.result.prompts.includes('searchQuery'))
  const files = reply.result.models.map((model) => model.file).sort()
  assert.deepEqual(files, [
    'model_q4.onnx',
    'model_q4.onnx_data',
    'tokenizer.json',
    'vision_encoder_q4.onnx',
    'vision_encoder_q4.onnx_data',
  ])
  for (const model of reply.result.models) {
    assert.match(model.sha256, /^[0-9a-f]{64}$/)
    assert.match(model.source, /^https:\/\//)
  }
})

test('health 只查体积（不算哈希），缺模型时如实报告', async () => {
  const collected = collector()
  const plugin = createEmbeddingPlugin({ write: collected.write, modelsDirectory: join(PACKAGE_ROOT, 'definitely-not-here') })
  const [reply] = await ask(plugin, collected, { jsonrpc: '2.0', id: 3, method: 'embedding.health' })
  assert.equal(reply.result.ready, false)
  assert.ok(reply.result.models.every((model) => model.present === false))
})

test('text 这条路径的参数校验先于分词器缺口', async () => {
  const collected = collector()
  const plugin = createEmbeddingPlugin({ write: collected.write })
  const [badPrompt] = await ask(plugin, collected, {
    jsonrpc: '2.0',
    id: 4,
    method: 'embedding.text',
    params: { prompt: 'nope', text: '海边日落' },
  })
  assert.equal(badPrompt.error.code, ERROR_CODES.BAD_REQUEST)

  const [badDim] = await ask(plugin, collected, {
    jsonrpc: '2.0',
    id: 5,
    method: 'embedding.text',
    params: { prompt: 'searchQuery', text: '海边日落', dim: 384 },
  })
  assert.equal(badDim.error.code, ERROR_CODES.BAD_REQUEST)

  // 参数合法但分词器未接入：必须**如实报 UNSUPPORTED**，而不是用猜出来的 token 蒙一个向量。
  const [notImplemented] = await ask(plugin, collected, {
    jsonrpc: '2.0',
    id: 6,
    method: 'embedding.text',
    params: { prompt: 'searchQuery', text: '海边日落' },
  })
  assert.equal(notImplemented.error.code, ERROR_CODES.UNSUPPORTED)
})

test('image：声明与字节不符时立刻回错误，不让宿主白传几 MB', async () => {
  const collected = collector()
  const plugin = createEmbeddingPlugin({ write: collected.write })
  const [reply] = await ask(plugin, collected, {
    jsonrpc: '2.0',
    id: 8,
    method: 'embedding.image',
    params: { image: { width: 2, height: 2, blob: { id: 'px1', length: 99 } } },
  })
  assert.equal(reply.error.code, ERROR_CODES.DECODE_FAILED)
  assert.equal(plugin.pendingBlob(), null)
})

test('image：网格低于模型下限时被挡住（下限是模型约束，不是偏好）', async () => {
  const collected = collector()
  const plugin = createEmbeddingPlugin({ write: collected.write })
  const [reply] = await ask(plugin, collected, {
    jsonrpc: '2.0',
    id: 9,
    method: 'embedding.image',
    params: { image: { width: 2, height: 2, grid: 16, blob: { id: 'px2', length: 12 } } },
  })
  assert.equal(reply.error.code, ERROR_CODES.BAD_REQUEST)
})

test('image：控制帧声明后不回任何东西，攒够字节才应答', async () => {
  const collected = collector()
  const plugin = createEmbeddingPlugin({ write: collected.write })
  plugin.push(encodeControlFrameAsFrame({
    jsonrpc: '2.0',
    id: 10,
    method: 'embedding.image',
    params: { image: { width: 2, height: 2, blob: { id: 'px3', length: 12 } } },
  }))
  await plugin.drain()
  assert.deepEqual(collected.envelopes(), [], '攒字节期间不该有回应')
  assert.equal(plugin.pendingBlob().received, 0)

  plugin.push(frameOf(encodeDataFrame('px3', 0, Buffer.alloc(12, 7))))
  await plugin.drain()
  const [reply] = collected.envelopes()
  assert.equal(reply.id, 10)
  // 向量本身要等分词器（§4.4），但协议链路必须已经通了。
  assert.equal(reply.error.code, ERROR_CODES.UNSUPPORTED)
})

test('image：数据帧乱序属于流不同步，直接抛出而不是猜', () => {
  const collected = collector()
  const plugin = createEmbeddingPlugin({ write: collected.write })
  plugin.push(encodeControlFrameAsFrame({
    jsonrpc: '2.0',
    id: 11,
    method: 'embedding.image',
    params: { image: { width: 2, height: 2, blob: { id: 'px4', length: 12 } } },
  }))
  assert.throws(() => plugin.push(frameOf(encodeDataFrame('px4', 4, Buffer.alloc(8)))), /out of order/)
})

/** 把控制帧信封包成 `push` 需要的形状。 */
function encodeControlFrameAsFrame(envelope) {
  return frameOf(encodeControlFrame(envelope))
}

function frameOf(buffer) {
  return new FrameDecoder().push(buffer)[0]
}
