/**
 * 模型 staging：把 `MODEL_FILES` 声明的权重补齐到本地目录。
 *
 * 为什么不写一行 curl 就够：**下载会被静默截断**。2026-10-08 实测过一次——`model_q4.onnx_data`
 * 在 158,388,990 B 处提前结束（规格 174,028,800 B），curl 自身退出码为 0，循环直接进了下一个文件。
 * 少了 15 MB 的 `.onnx_data` 不会在下载时报错，只会在建会话时炸成一句难以定位的算子错误。所以：
 *
 *   - 落盘一律走 `.tmp/<file>.part`，**体积与 sha256 都对了才原子改名**到目标名；
 *   - 期望体积不符就带着 `Range` 续传（服务器忽略 Range 返回 200 时从头写）；
 *   - 校验失败**删掉 .part**，绝不留下一个「体积对但哈希错」的文件给下一次续传当基础；
 *   - 已有的目标文件若体积不符，先挪回 `.part` 复用已下到的字节，而不是从头再来。
 *
 * 与宿主侧 `local_library/face_models.go` 的不变量一致（同一套语义的 Node 实现，服务于开发/发布
 * staging；运行时下载仍由宿主负责——模型不进安装包）。
 *
 * 用法：
 *   node scripts/fetch-models.mjs --out <目录> [--kinds text,vision,tokenizer] [--variant q4] [--retries 8]
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parseArgs } from 'node:util'

import { fileDigest } from '../src/engine.mjs'
import { DEFAULT_VARIANT, modelSpecs } from '../src/models.mjs'

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    variant: { type: 'string', default: DEFAULT_VARIANT },
    kinds: { type: 'string', default: 'text,vision' },
    retries: { type: 'string', default: '8' },
    only: { type: 'string' },
  },
})

const outDir = values.out
if (typeof outDir !== 'string' || outDir === '') {
  console.error('必须用 --out 指定输出目录')
  process.exit(2)
}
const kinds = values.kinds.split(',').map((item) => item.trim()).filter((item) => item !== '')
const retries = Number.parseInt(values.retries, 10)
const only = values.only === undefined ? null : new Set(values.only.split(',').map((item) => item.trim()))

mkdirSync(outDir, { recursive: true })
mkdirSync(join(outDir, '.tmp'), { recursive: true })

function human(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 已就位？体积先筛（省掉 174MB 的哈希），再算 sha256。 */
async function alreadyOk(target, spec) {
  if (!existsSync(target)) return false
  if (statSync(target).size !== spec.sizeBytes) return false
  return (await fileDigest(target)).toLowerCase() === spec.sha256.toLowerCase()
}

async function downloadOnce(spec, target, part) {
  let have = existsSync(part) ? statSync(part).size : 0
  if (have > spec.sizeBytes) {
    // 比规格还大的 .part 只可能是上一次跑错了档位，不能拿它续传。
    unlinkSync(part)
    have = 0
  }
  if (have === spec.sizeBytes) return
  const response = await fetch(spec.source, have > 0 ? { headers: { Range: `bytes=${have}-` } } : undefined)
  if (!response.ok && response.status !== 206) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`)
  }
  // 206 才是真的续传；200 表示服务器忽略了 Range，必须从头写而不是往后追加。
  const resumable = response.status === 206 && have > 0
  if (!resumable) have = 0
  await pipeline(Readable.fromWeb(response.body), createWriteStream(part, { flags: resumable ? 'a' : 'w' }))
}

for (const spec of modelSpecs({ variant: values.variant, kinds })) {
  if (only !== null && !only.has(spec.file)) continue
  const target = join(outDir, spec.file)
  const part = join(outDir, '.tmp', `${spec.file}.part`)

  if (await alreadyOk(target, spec)) {
    console.log(`ok    ${spec.file.padEnd(32)} ${human(spec.sizeBytes)}（已就位，跳过）`)
    continue
  }
  // 目标文件存在但校验没过：挪回 .part 复用已下到的字节。
  if (existsSync(target)) {
    const existing = statSync(target).size
    const partSize = existsSync(part) ? statSync(part).size : 0
    if (existing > partSize) {
      if (existsSync(part)) unlinkSync(part)
      renameSync(target, part)
      console.log(`note  ${spec.file}：目标文件体积不符（${human(existing)}），挪回 .part 续传`)
    } else {
      unlinkSync(target)
    }
  }

  let done = false
  let lastError = null
  for (let attempt = 1; attempt <= retries && !done; attempt += 1) {
    const before = existsSync(part) ? statSync(part).size : 0
    try {
      await downloadOnce(spec, target, part)
    } catch (error) {
      lastError = error
      console.log(`warn  ${spec.file} 第 ${attempt}/${retries} 次中断：${error?.message ?? error}`)
      continue
    }
    const size = existsSync(part) ? statSync(part).size : 0
    if (size !== spec.sizeBytes) {
      lastError = new Error(`体积 ${size} ≠ ${spec.sizeBytes}`)
      console.log(`warn  ${spec.file} 第 ${attempt}/${retries} 次不完整：${human(before)} → ${human(size)} / ${human(spec.sizeBytes)}`)
      continue
    }
    const digest = await fileDigest(part)
    if (digest.toLowerCase() !== spec.sha256.toLowerCase()) {
      // 体积对、哈希错：整份删掉，绝不拿去续传。
      unlinkSync(part)
      lastError = new Error(`sha256 ${digest} ≠ ${spec.sha256}`)
      console.log(`warn  ${spec.file} 第 ${attempt}/${retries} 次 sha256 不符，已删除重下`)
      continue
    }
    renameSync(part, target)
    console.log(`ok    ${spec.file.padEnd(32)} ${human(size)}  ${digest.slice(0, 16)}…`)
    done = true
  }
  if (!done) {
    console.error(`FAIL  ${spec.file}：${retries} 次仍失败（${lastError?.message ?? '未知原因'}）`)
    console.error(`      已下到的字节保留在 ${part}，重跑本脚本会续传。`)
    process.exit(1)
  }
}

console.log('\nstaging 完成。校验：')
let bad = 0
for (const spec of modelSpecs({ variant: values.variant, kinds })) {
  if (only !== null && !only.has(spec.file)) continue
  const target = join(outDir, spec.file)
  const ok = await alreadyOk(target, spec)
  if (!ok) bad += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${spec.file}`)
}
process.exit(bad === 0 ? 0 : 1)
