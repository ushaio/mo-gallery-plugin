/**
 * 图像占位符序列的纯函数单测——**不需要模型文件、不需要运行时目录、不需要 onnxruntime**。
 *
 * 这一层之所以必须单独钉住：占位符的**个数**（N）决定文本塔怎么 scatter `image_features`，
 * 个数错了不会报错，只会静默劣化向量（设计文档反复提到的同一种失效形态）。
 * 又能白盒跑，是因为 `tokenizer.mjs` 顶部没有任何指向运行时目录的静态 import。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { ERROR_CODES, ProtocolError } from '../src/errors.mjs'
import { MULTIMODAL_TOKENS } from '../src/models.mjs'
import { imagePlaceholderSequence } from '../src/tokenizer.mjs'

/**
 * 真实 tokenizer.json 的 id 布局（2026-10-08 用 `.tmp/embedding-models` 实测）：
 *
 *   encode('<|image>' + '<|image|>' * n + '<image|>') === [2, 255999, 258880×n, 258882, 1]
 *
 * 两端的 2 / 1 是 `tokenizer.json` 的 `post_processor`（`TemplateProcessing single=[<bos>, A, <eos>]`）
 * **自动加上**的，所以总长 = n + 4。把这条布局写成常量，是为了让「n 是软 token 数、总长比它多 4」
 * 这条公式在测试里可读、可核对（真实 encode 的交叉验证在 `scripts/verify-embeddings.mjs`）。
 */
const SEQUENCE_ID_LAYOUT = Object.freeze({ bos: 2, boi: 255999, image: 258880, eoi: 258882, eos: 1 })

/** 按上面的布局还原「n 个软 token 时 tokenizer 会给出的 input_ids」。 */
function expectedInputIds(numSoftTokens) {
  return [
    SEQUENCE_ID_LAYOUT.bos,
    SEQUENCE_ID_LAYOUT.boi,
    ...new Array(numSoftTokens).fill(SEQUENCE_ID_LAYOUT.image),
    SEQUENCE_ID_LAYOUT.eoi,
    SEQUENCE_ID_LAYOUT.eos,
  ]
}

test('imagePlaceholderSequence 是 <|image> + <|image|>×n + <image|>', () => {
  assert.equal(imagePlaceholderSequence(1), '<|image><|image|><image|>')
  assert.equal(imagePlaceholderSequence(3), '<|image>' + '<|image|>'.repeat(3) + '<image|>')
  // 真实网格实测值：50×50 → 273 个软 token（设计文档 §5.5）。
  assert.equal(imagePlaceholderSequence(273).length, MULTIMODAL_TOKENS.boi.length + 273 * MULTIMODAL_TOKENS.image.length + MULTIMODAL_TOKENS.eoi.length)
})

test('序列里软 token 出现 n 次，且不含 bos/eos（那两颗由 post_processor 加）', () => {
  const sequence = imagePlaceholderSequence(4)
  assert.ok(sequence.startsWith(MULTIMODAL_TOKENS.boi))
  assert.ok(sequence.endsWith(MULTIMODAL_TOKENS.eoi))
  const middle = sequence.slice(MULTIMODAL_TOKENS.boi.length, sequence.length - MULTIMODAL_TOKENS.eoi.length)
  assert.deepEqual(middle.split(MULTIMODAL_TOKENS.image).length, 4 + 1, '中间段应正好是 n 个 <|image|>')
  assert.ok(!sequence.includes('<bos>') && !sequence.includes('<eos>'))
})

test('input_ids 被 post_processor 包上 bos/eos，长度 = n + 4', () => {
  for (const numSoftTokens of [1, 63, 273]) {
    const ids = expectedInputIds(numSoftTokens)
    assert.equal(ids.length, numSoftTokens + 4)
    assert.deepEqual(ids.slice(0, 2), [SEQUENCE_ID_LAYOUT.bos, SEQUENCE_ID_LAYOUT.boi])
    assert.deepEqual(ids.slice(-2), [SEQUENCE_ID_LAYOUT.eoi, SEQUENCE_ID_LAYOUT.eos])
    const soft = ids.slice(2, -2)
    assert.equal(soft.length, numSoftTokens)
    assert.ok(soft.every((id) => id === SEQUENCE_ID_LAYOUT.image))
  }
  // 外部交叉校验：HF 文档 processor(images=[IMAGE], max_soft_tokens=70) 给出 input_ids.shape=[1,67]，
  // 即 63 + 4 = 67（63 = 70 个软 token 预算下视觉编码器实际吐出的 token 数）。
  assert.equal(expectedInputIds(63).length, 67)
})

test('n<=0 或非整数时拒绝（BAD_REQUEST）', () => {
  for (const value of [0, -1, -273, 1.5, NaN, Infinity, '3', null, undefined, 280n]) {
    assert.throws(
      () => imagePlaceholderSequence(value),
      (error) => {
        assert.ok(error instanceof ProtocolError)
        assert.equal(error.code, ERROR_CODES.BAD_REQUEST)
        return true
      },
      `应拒绝 ${String(value)}`,
    )
  }
})

test('MULTIMODAL_TOKENS 的字面量与 tokenizer_config.json 一致', (t) => {
  const modelsDir = (process.env.MO_GALLERY_EMBEDDING_MODELS ?? '').trim()
  const configPath = modelsDir === '' ? '' : join(modelsDir, 'tokenizer_config.json')
  if (configPath === '' || !existsSync(configPath)) {
    // 模型目录不在场（CI / 开发机）：退化为对字面量的钉死。这几个值改动就等于换模型契约，
    // 值得让测试红一次。
    assert.deepEqual(MULTIMODAL_TOKENS, {
      boi: '<|image>',
      image: '<|image|>',
      eoi: '<image|>',
      video: '<|video|>',
    })
    t.diagnostic(`tokenizer_config.json 不在场（MO_GALLERY_EMBEDDING_MODELS=${modelsDir || '(空)'}），只校对了字面量`)
    return
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  assert.equal(MULTIMODAL_TOKENS.boi, config.boi_token)
  assert.equal(MULTIMODAL_TOKENS.image, config.image_token)
  assert.equal(MULTIMODAL_TOKENS.eoi, config.eoi_token)
  assert.equal(MULTIMODAL_TOKENS.video, config.model_specific_special_tokens?.video_token ?? config.extra_special_tokens?.[0])
})
