/**
 * 子进程端到端：按宿主的启动方式真的拉起 `node src/index.mjs`，用 stdin/stdout 说协议。
 *
 * 为什么单测不够：可注入的 `write` 让协议逻辑能在进程内跑完，但**启动路径**（manifest 里的
 * `runtime.entry` 是否存在、`main()` 有没有被触发、stdout 有没有被非协议输出污染、退出码）
 * 全部绕过。这几样恰是最容易在打包后才暴露的。
 *
 * 断言三件事：握手能成、`health` 能回、**stdout 上除了协议帧没有任何人类可读文本**
 * （宿主会把混进去的一行当成畸形响应，整个会话就废了）。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { FrameDecoder, encodeControlFrame } from '../src/frames.mjs'
import { readManifest } from '../src/index.mjs'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ENTRY = join(PACKAGE_ROOT, readManifest().runtime.entry)

/** 起一个插件进程，返回 { ask, done }。 */
function startPlugin() {
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MO_GALLERY_EMBEDDING_MODELS: join(PACKAGE_ROOT, 'definitely-not-here') },
  })
  const decoder = new FrameDecoder()
  const envelopes = []
  const extraStdout = []
  let stderr = ''

  child.stdout.on('data', (chunk) => {
    let frames
    try {
      frames = decoder.push(chunk)
    } catch (error) {
      // 协议流一旦错位，后面的断言就没有意义了——把原因直接暴露出来。
      extraStdout.push(`FRAMING FAILED: ${error.message}`)
      return
    }
    for (const frame of frames) {
      try {
        envelopes.push(JSON.parse(frame.payload.toString('utf8')))
      } catch {
        extraStdout.push(frame.payload.toString('utf8'))
      }
    }
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })

  function ask(envelope) {
    child.stdin.write(encodeControlFrame(envelope))
  }

  async function waitFor(count, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs
    while (envelopes.length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return envelopes
  }

  return { child, ask, waitFor, extraStdout: () => extraStdout, stderr: () => stderr }
}

test('子进程：握手与 health 都能通，且 stdout 上只有协议帧', async () => {
  const plugin = startPlugin()
  try {
    plugin.ask({ jsonrpc: '2.0', id: 1, method: 'plugin.getManifest' })
    plugin.ask({ jsonrpc: '2.0', id: 2, method: 'embedding.health' })
    const replies = await plugin.waitFor(2)

    assert.ok(replies.length >= 2, `只收到 ${replies.length} 条回应；stderr=${plugin.stderr()}`)
    const manifest = replies.find((item) => item.id === 1)?.result
    assert.equal(manifest.id, 'embedding')
    assert.equal(manifest.runtime.entry, 'src/index.mjs')

    const health = replies.find((item) => item.id === 2)?.result
    assert.equal(health.ready, false, '模型目录刻意指向不存在的位置，ready 应为 false')
    assert.ok(health.models.length >= 4)
    assert.equal(health.engine.name, 'emulsion-embedding')

    assert.deepEqual(plugin.extraStdout(), [], 'stdout 上出现了非协议内容——宿主会把它当成畸形响应')
  } finally {
    plugin.child.stdin.end()
    plugin.child.kill()
  }
})

test('子进程：stdin 关闭后干净退出（退出码 0）', async () => {
  const plugin = startPlugin()
  plugin.ask({ jsonrpc: '2.0', id: 1, method: 'plugin.getManifest' })
  await plugin.waitFor(1)
  const code = await new Promise((resolve) => {
    plugin.child.on('exit', (value) => resolve(value))
    plugin.child.stdin.end()
  })
  assert.equal(code, 0)
})
