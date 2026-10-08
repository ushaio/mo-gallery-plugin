/**
 * `truncateAndNormalize` 与 `modelSpecs` 的单测。
 *
 * 这两条是设计文档 §1「硬约束 3」与 §4.5「分档下载」的可执行形式：
 * 截断与归一化必须是一步不可拆的操作，档位过滤不能悄悄漏文件。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { EMBEDDING_DIM_CHOICES, EMBEDDING_DIM_DEFAULT, TASK_PROMPTS, modelSpecs, truncateAndNormalize } from '../src/models.mjs'

function ramp(length) {
  return Float32Array.from({ length }, (_, index) => Math.sin(index / 7) * 2 + 1)
}

test('截断到每个 MRL 维度后都是单位向量', () => {
  const source = ramp(768)
  for (const dim of EMBEDDING_DIM_CHOICES) {
    const vector = truncateAndNormalize(source, dim)
    assert.equal(vector.length, dim)
    const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0))
    assert.ok(Math.abs(norm - 1) < 1e-6, `dim=${dim} 的模长应为 1，实得 ${norm}`)
  }
})

test('截断只保留前 dim 维——这是 MRL 的定义，不是随便挑几维', () => {
  const source = ramp(768)
  const vector = truncateAndNormalize(source, 256)
  const norm = Math.sqrt(source.slice(0, 256).reduce((sum, item) => sum + item * item, 0))
  for (let index = 0; index < 256; index += 1) {
    assert.ok(Math.abs(vector[index] - source[index] / norm) < 1e-6)
  }
})

test('默认维度是 256', () => {
  assert.equal(EMBEDDING_DIM_DEFAULT, 256)
  assert.equal(truncateAndNormalize(ramp(768)).length, 256)
})

test('非 MRL 维度被拒绝', () => {
  assert.throws(() => truncateAndNormalize(ramp(768), 384), /unsupported embedding dim/)
  assert.throws(() => truncateAndNormalize(ramp(768), 64), /unsupported embedding dim/)
})

test('源向量短于目标维度被拒绝，而不是零填充', () => {
  assert.throws(() => truncateAndNormalize(ramp(128), 256), /cannot truncate/)
})

test('非有限值被拒绝——fp16 溢出正是这样被挡在库外的', () => {
  const poisoned = ramp(768)
  poisoned[500] = Number.NaN
  assert.throws(() => truncateAndNormalize(poisoned, 256), /non-finite/)
  const infinity = ramp(768)
  infinity[10] = Number.POSITIVE_INFINITY
  assert.throws(() => truncateAndNormalize(infinity, 256), /non-finite/)
})

test('零向量被拒绝（无法归一化）', () => {
  assert.throws(() => truncateAndNormalize(new Float32Array(768), 256), /zero norm/)
})

test('q4 默认档只取该档的文件对：图 + 外置权重成对', () => {
  const specs = modelSpecs({ kinds: ['text', 'vision'] })
  const files = specs.map((item) => item.file).sort()
  assert.deepEqual(files, ['model_q4.onnx', 'model_q4.onnx_data', 'vision_encoder_q4.onnx', 'vision_encoder_q4.onnx_data'])
  for (const spec of specs) {
    assert.match(spec.source, /^https:\/\/huggingface\.co\/onnx-community\/embeddinggemma-2-ONNX\/resolve\/[0-9a-f]{40}\//)
    assert.match(spec.sha256, /^[0-9a-f]{64}$/)
    assert.ok(spec.sizeBytes > 0)
  }
})

test('source 的 URL 路径用 remote 而不是本地落盘名', () => {
  // 早期版本把两者混为一谈：本地名 model_q4.onnx 直接拼到 URL 上，而仓库里它在 onnx/ 下，
  // 于是 5 个文件里 4 个 404。JSON 形态的失败很安静，只有下载器报错时才暴露。
  const specs = modelSpecs({ kinds: ['text', 'vision', 'tokenizer'] })
  for (const spec of specs) {
    assert.ok(spec.source.endsWith(`/${spec.remote}`), `${spec.file} 的 source 应以 /${spec.remote} 结尾`)
  }
  const text = specs.find((item) => item.file === 'model_q4.onnx')
  assert.equal(text.remote, 'onnx/model_q4.onnx')
  // 分词器是唯一在仓库根目录的产物——它没有 onnx/ 前缀。
  const tokenizer = specs.find((item) => item.kind === 'tokenizer')
  assert.equal(tokenizer.remote, 'tokenizer.json')
  assert.ok(!tokenizer.source.includes('/onnx/'))
})

test('含分词器时多一个文件，且分词器不参与档位过滤', () => {
  const withTokenizer = modelSpecs({ kinds: ['text', 'vision', 'tokenizer'] })
  assert.equal(withTokenizer.length, 5)
  assert.ok(withTokenizer.some((item) => item.file === 'tokenizer.json'))
})

test('未知档位直接报错，不做静默降级', () => {
  assert.throws(() => modelSpecs({ variant: 'q8' }), /unknown variant/)
})

test('任务前缀：检索必须能区分 query/doc，无标题必须落 title: none', () => {
  assert.match(TASK_PROMPTS.searchQuery('海边日落'), /^task: search result \| query: 海边日落$/)
  assert.equal(TASK_PROMPTS.document('一张照片'), 'title: none | text: 一张照片')
  assert.equal(TASK_PROMPTS.document('一张照片', '青岛'), 'title: 青岛 | text: 一张照片')
  assert.match(TASK_PROMPTS.clustering('内容'), /^task: clustering \| query: 内容$/)
})
