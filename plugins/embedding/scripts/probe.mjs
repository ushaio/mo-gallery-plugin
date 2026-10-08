/**
 * Step 0 / Step 3 / Step 5 探针：在真机上回答「这条路能不能走」。
 *
 * 设计文档 §5.2 的 Step 0、Step 5，以及 Step 3 的**执行部分**（量化保真需要 Python 参考向量，
 * 不在本脚本范围内）都在这里一次性跑完。**它不验证检索质量**——中文召回要另有样本集与 query 集。
 *
 * 跑法（Windows / Git Bash，Node 22）：
 *
 *   node scripts/probe.mjs \
 *     --runtime "D:/Projects/mo-gallery/emulsion-desktop-v3/build/bin/resources/inference/windows-amd64" \
 *     --models  "D:/Projects/mo-gallery/.tmp/embedding-spike/models"
 *
 * 输出是一张 PASS/FAIL 表，可直接贴回设计文档 §5.4 的产出物。
 *
 * 三件事要在这里被证伪或证实：
 *   1. **onnxruntime-node 的 CPU EP 能不能加载 4bit MatMulNBits 图**——不能的话整条 ONNX 路线要重议；
 *   2. **激活精度不是 fp16**——模型卡明令 fp16 会返回 NaN 或静默劣化的向量且不报错；
 *   3. **CPU 上的延迟量级**——单图 / 单条短文本，决定全库索引是否可行。
 */
import { parseArgs } from 'node:util'
import { performance } from 'node:perf_hooks'
import os from 'node:os'

import { createEmbeddingEngine, verifyModelFiles } from '../src/engine.mjs'
import { patchifyRaster } from '../src/image.mjs'
import { DEFAULT_VARIANT, EMBEDDING_DIM_DEFAULT, modelSpecs, truncateAndNormalize } from '../src/models.mjs'
import { onnxRuntimeRoot } from '../src/onnx.mjs'

const { values } = parseArgs({
  options: {
    models: { type: 'string' },
    runtime: { type: 'string' },
    variant: { type: 'string', default: DEFAULT_VARIANT },
    grid: { type: 'string', default: '50' },
    dim: { type: 'string', default: String(EMBEDDING_DIM_DEFAULT) },
    kinds: { type: 'string', default: 'text,vision' },
  },
})

const modelsDir = values.models
if (typeof modelsDir !== 'string' || modelsDir === '') {
  console.error('必须用 --models 指定模型目录')
  process.exit(2)
}
const runtimeDir = values.runtime ?? onnxRuntimeRoot()
const grid = Number.parseInt(values.grid, 10)
const dim = Number.parseInt(values.dim, 10)
// Step 0 只关心「4bit 图能不能在 CPU EP 上跑起来」，不需要 32MB 的分词器，所以默认不含 tokenizer。
const kinds = values.kinds.split(',').map((item) => item.trim()).filter((item) => item !== '')

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok === true ? 'PASS' : ok === null ? 'INFO' : 'FAIL'}  ${name}${detail === undefined ? '' : ` —— ${detail}`}`)
}
function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
async function timed(run) {
  const start = performance.now()
  const value = await run()
  return { value, ms: performance.now() - start }
}

/** 合成一张确定性的彩色渐变图：只为驱动真实前向，不用于质量判断。 */
function synthesizeRaster(width, height) {
  const data = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3
      // 低频渐变 + 一点高频纹理：避免全平坦输入让某些算子走到极端分支。
      data[index] = Math.round((x / width) * 200 + ((x * 7 + y * 13) % 55))
      data[index + 1] = Math.round((y / height) * 200 + ((x * 5 + y * 3) % 55))
      data[index + 2] = Math.round(((x + y) / (width + height)) * 200 + ((x * 11) % 55))
    }
  }
  return { width, height, data }
}

console.log('=== EmbeddingGemma 2 探针（Step 0 / 3-执行 / 5） ===')
console.log(`node         : ${process.version} (${process.platform}/${process.arch})`)
console.log(`runtime dir  : ${runtimeDir === '' ? '(未设置 MO_GALLERY_EMBEDDING_RUNTIME)' : runtimeDir}`)
console.log(`models dir   : ${modelsDir}`)
console.log(`variant/dim  : ${values.variant} / ${dim}d, grid=${grid}x${grid}`)
console.log(`rss 起始     : ${mb(process.memoryUsage().rss)}`)

// ---- 1. 模型校验（体积 + sha256）--------------------------------------------------------
console.log('\n--- 1. 模型校验 ---')
try {
  const verification = await verifyModelFiles(modelsDir, modelSpecs({ variant: values.variant, kinds }))
  record('模型 sha256 校验', verification.missing.length === 0 && verification.mismatched.length === 0,
    `ready=${verification.ready.length} missing=${verification.missing.length} mismatched=${verification.mismatched.length}`)
  for (const item of verification.ready) {
    console.log(`      ok   ${item.file.padEnd(32)} ${String(item.sizeBytes).padStart(12)} B  ${item.sha256.slice(0, 16)}…`)
  }
  for (const item of verification.missing) console.log(`      MISS ${item.file}`)
  for (const item of verification.mismatched) {
    console.log(`      BAD  ${item.file} ${item.reason === 'size' ? `体积 ${item.actualSize} ≠ ${item.sizeBytes}` : `sha256 ${item.actualSha256}`}`)
  }
} catch (error) {
  record('模型 sha256 校验', false, String(error?.message ?? error))
}

// ---- 2. 建会话 + dtype 检查（Step 0 的核心）--------------------------------------------
console.log('\n--- 2. 建会话 / dtype（Step 0 核心） ---')
const engine = createEmbeddingEngine({ modelsDir, runtime: null, runtimeRoot: runtimeDir, variant: values.variant, kinds, log: (message) => console.log(`      · ${message}`) })
let description = null
try {
  const { value, ms } = await timed(() => engine.describe())
  description = value
  record('CPU EP 建会话（4bit MatMulNBits）', true, `耗时 ${ms.toFixed(0)} ms`)
  console.log(`      文本塔  in : ${value.text.inputs.map((i) => `${i.name}:${i.type}${JSON.stringify(i.dimensions)}`).join('  ')}`)
  console.log(`      文本塔  out: ${value.text.outputs.map((i) => `${i.name}:${i.type}${JSON.stringify(i.dimensions)}`).join('  ')}`)
  if (value.vision !== null) {
    console.log(`      视觉    in : ${value.vision.inputs.map((i) => `${i.name}:${i.type}${JSON.stringify(i.dimensions)}`).join('  ')}`)
    console.log(`      视觉    out: ${value.vision.outputs.map((i) => `${i.name}:${i.type}${JSON.stringify(i.dimensions)}`).join('  ')}`)
  }
  // fp16 检查：输入/输出里出现 float16 就是踩了模型卡的禁令。
  const types = [...value.text.inputs, ...value.text.outputs, ...(value.vision?.inputs ?? []), ...(value.vision?.outputs ?? [])].map((i) => i.type)
  const hasFp16 = types.some((type) => typeof type === 'string' && type.toLowerCase().includes('float16'))
  record('激活精度非 fp16', !hasFp16, hasFp16 ? '发现 float16 输入/输出！' : `dtypes=${[...new Set(types)].join(',')}`)
} catch (error) {
  record('CPU EP 建会话（4bit MatMulNBits）', false, String(error?.message ?? error))
  console.log('\n会话建不起来 ⇒ 设计文档 §5.3「Step 0」不通过：先换 `quantized`(int8) 变体重试；')
  console.log('若 int8 同样失败，则 ONNX 路线需要重新论证（§2.6 GGUF 备选）。')
  process.exit(1)
}

// ---- 3. 文本塔：零长模态张量策略 + 延迟 ------------------------------------------------
console.log('\n--- 3. 文本塔（模态占位策略 + 延迟） ---')
// 没有分词器时用合法范围内的伪 token：这些数字**只能测延迟，不能测质量**。
const fakeIds = (length) => Array.from({ length }, (_, index) => 1 + (index * 7919) % 100000)

// 三个模态输入是图的必需输入，缺席时必须喂点东西。ORT 对 0 长度维度的态度没有文档保证，
// 所以两种策略都试，并把「究竟哪种能用」作为实测结论记下来。
let placeholder = 'empty'
try {
  await engine.embedTokenIds(fakeIds(8), { dim })
  record('模态占位策略 empty（[0,512] 零行张量）', true)
} catch (error) {
  const emptyError = String(error?.message ?? error).slice(0, 200)
  try {
    await engine.embedTokenIds(fakeIds(8), { dim, modalityPlaceholder: 'zero-row' })
    placeholder = 'zero-row'
    record('模态占位策略 empty（[0,512] 零行张量）', null, `不被接受（${emptyError}）→ **实测回退 zero-row 可用**`)
  } catch (fallbackError) {
    record('模态占位策略 empty（[0,512] 零行张量）', false,
      `empty 与 zero-row 都失败：empty=${emptyError}｜zero-row=${String(fallbackError?.message ?? fallbackError).slice(0, 200)}`)
  }
}
console.log(`      采用策略：${placeholder}`)

for (const length of [8, 64, 256]) {
  for (let round = 1; round <= (length === 256 ? 2 : 1); round += 1) {
    try {
      const { value, ms } = await timed(() => engine.embedTokenIds(fakeIds(length), { dim, modalityPlaceholder: placeholder }))
      const sumSquares = value.vector.reduce((sum, item) => sum + item * item, 0)
      record(`文本前向 seq=${length}${round > 1 ? `（第 ${round} 次，热态）` : ''}`, true,
        `${ms.toFixed(0)} ms · native=${value.nativeDim}d → ${value.dim}d · ‖v‖²=${sumSquares.toFixed(6)} · head=[${Array.from(value.vector.slice(0, 3)).map((item) => item.toFixed(4)).join(', ')}]`)
    } catch (error) {
      record(`文本前向 seq=${length}`, false, String(error?.message ?? error).slice(0, 300))
      break
    }
  }
}

// ---- 4. 视觉编码器：patch → 512 维特征，并反推 pooling 行为 -----------------------------
console.log('\n--- 4. 视觉编码器 ---')
let imageFeatures = null
let tokenCount = 0
let patchLayout = 'batch-first'
try {
  const raster = synthesizeRaster(grid * 16, grid * 16)
  const patches = patchifyRaster(raster, { gridWidth: grid, gridHeight: grid })
  let firstError = null
  for (const layout of ['batch-first', 'middle']) {
    try {
      // 冷/热分开测：首次前向含内存池与算子规划的一次性成本，直接拿它推算全库索引耗时会高估很多。
      const { value, ms } = await timed(() => engine.encodeImageFeatures(patches, { patchLayout: layout }))
      imageFeatures = value.imageFeatures
      tokenCount = value.tokenCount
      patchLayout = layout
      const ratio = value.patchCount / value.tokenCount
      record(`视觉前向冷启动（layout=${layout}）`, true,
        `${ms.toFixed(0)} ms · ${value.patchCount} patch → ${value.tokenCount} token（压缩比 ${ratio.toFixed(2)}，3×3 pooling 应为 9）`)
      if (layout !== 'batch-first') {
        record('视觉输入 rank 布局', null, `batch-first 不被接受（${firstError}）→ **实测为 ${layout}**`)
      }
      for (let round = 1; round <= 2; round += 1) {
        const warm = await timed(() => engine.encodeImageFeatures(patches, { patchLayout: layout }))
        record(`视觉前向热态（第 ${round} 次）`, true, `${warm.ms.toFixed(0)} ms`)
      }
      break
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 200)
      if (firstError === null) firstError = message
      if (layout === 'middle') {
        record('视觉前向（patch → 512d）', false, `两种布局都失败：batch-first=${firstError}｜middle=${message}`)
      }
    }
  }
} catch (error) {
  record('视觉前向（patch → 512d）', false, String(error?.message ?? error).slice(0, 300))
}

// ---- 4b. 网格尺寸扫描：质量 ↔ 耗时 的旋钮 -----------------------------------------------
console.log('\n--- 4b. 网格尺寸扫描（决定全库索引是否可行的那个数） ---')
console.log(`      CPU 逻辑核数：${os.cpus().length}`)
if (imageFeatures !== null) {
  // 16×16 是**已知会崩**的尺寸（图内 ScatterElements 越界），所以它检验的不是「能不能跑」，
  // 而是「下限有没有被挡住」——按设计它应当在这里被 MIN_GRID 主动拒绝。
  try {
    const raster = synthesizeRaster(16 * 16, 16 * 16)
    const patches = patchifyRaster(raster, { gridWidth: 16, gridHeight: 16 })
    await engine.encodeImageFeatures(patches, { patchLayout })
    record('网格下限 16×16 被挡住', false, '没有被挡住，竟然后向成功了——MIN_GRID 需要重估')
  } catch (error) {
    record('网格下限 16×16 被挡住', true, String(error?.message ?? error).slice(0, 160))
  }
  for (const sweepGrid of [26, 38, 50]) {
    try {
      const raster = synthesizeRaster(sweepGrid * 16, sweepGrid * 16)
      const patches = patchifyRaster(raster, { gridWidth: sweepGrid, gridHeight: sweepGrid })
      const { value, ms } = await timed(() => engine.encodeImageFeatures(patches, { patchLayout }))
      const perImage = ms / 1000
      const thousand = (perImage * 1000) / 60
      record(`grid=${sweepGrid}×${sweepGrid}`, null,
        `${value.patchCount} patch → ${value.tokenCount} token · ${ms.toFixed(0)} ms/图 · 1000 张 ≈ ${thousand.toFixed(0)} 分钟`)
    } catch (error) {
      record(`grid=${sweepGrid}×${sweepGrid}`, false, String(error?.message ?? error).slice(0, 200))
    }
  }
} else {
  record('网格扫描', null, '跳过（视觉编码器不可用）')
}

// ---- 5. 两段式连通性：视觉特征 → 文本塔 → 768d ----------------------------------------
console.log('\n--- 5. 两段式连通性（非质量验证） ---')
if (imageFeatures !== null) {
  try {
    const ids = [2, 1] // 占位：真实占位符 id 必须由分词器给出，见 §4.4
    const { value, ms } = await timed(() => engine.embedWithModalities({ ids, imageFeatures, dim, modalityPlaceholder: placeholder }))
    record('视觉特征 → 文本塔 → 向量', true, `${ms.toFixed(0)} ms · ${value.nativeDim}d → ${value.dim}d`)
    const sumSquares = value.vector.reduce((sum, item) => sum + item * item, 0)
    record('截断后 L2 归一化', Math.abs(sumSquares - 1) < 1e-4, `‖v‖² = ${sumSquares.toFixed(6)}`)
    const finite = value.vector.every((item) => Number.isFinite(item))
    record('向量无 NaN/Inf', finite)
  } catch (error) {
    record('视觉特征 → 文本塔 → 向量', false, String(error?.message ?? error).slice(0, 300))
  }
} else {
  record('视觉特征 → 文本塔 → 向量', null, '跳过（视觉编码器不可用）')
}

// ---- 6. 截断 + 归一化的独立自检 -------------------------------------------------------
const truncated = truncateAndNormalize(Float32Array.from({ length: 768 }, (_, index) => Math.sin(index) * 3), dim)
record('truncateAndNormalize 幂等性', Math.abs(truncated.reduce((sum, item) => sum + item * item, 0) - 1) < 1e-6)

// ---- 7. 资源占用 ---------------------------------------------------------------------
console.log('\n--- 7. 资源占用 ---')
record('常驻内存（热态）', process.memoryUsage().rss < 2 * 1024 * 1024 * 1024, `rss = ${mb(process.memoryUsage().rss)}`)

await engine.dispose()

// ---- 汇总 ---------------------------------------------------------------------------
const failed = results.filter((item) => item.ok === false)
console.log(`\n=== 汇总：${results.filter((item) => item.ok === true).length} PASS / ${failed.length} FAIL / ${results.filter((item) => item.ok === null).length} INFO ===`)
if (failed.length > 0) {
  console.log('未通过：')
  for (const item of failed) console.log(`  - ${item.name}: ${item.detail ?? ''}`)
}
process.exit(failed.length === 0 ? 0 : 1)
