import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { perceptualHash, hamming, representativeGroups } from '../src/algorithm.mjs'

test('flat-image zero hash is stable, but not evidence of identical images', () => {
  assert.equal(perceptualHash(new Uint8Array(1024)), 0n)
  assert.equal(perceptualHash(new Uint8Array(1024).fill(255)), 0n)
  assert.throws(() => perceptualHash(new Uint8Array(10)))
  assert.equal(hamming(0n, 0xffffffffffffffffn), 64)
})
test('DCT deterministic and brightness-invariant for non-clipped input', () => {
  const pixels = Uint8Array.from({ length: 1024 }, (_, i) => (i * 37 + (i % 32) ** 2) % 128)
  const hash = perceptualHash(pixels)
  assert.notEqual(hash, 0n)
  assert.equal(hash, perceptualHash(pixels))
  assert.equal(hash, perceptualHash(pixels.map(v => v + 40)))
})
test('representative grouping does not merge a transitive chain', () => {
  const groups = representativeGroups([{ id: 'a', hash: 0n }, { id: 'b', hash: 1n }, { id: 'c', hash: 3n }], 1)
  assert.deepEqual(groups.map(g => g.assetIds), [['a', 'b']])
  assert.match(groups[0].description, /do not prove identical/)
})
test('BK-tree agrees with a brute-force representative oracle', () => {
  let seed = 1234n
  const images = Array.from({ length: 300 }, (_, i) => {
    seed = (seed * 6364136223846793005n + 1n) & 0xffffffffffffffffn
    return { id: String(i), hash: seed }
  })
  for (const threshold of [0, 8, 24, 32, 64]) {
    const anchors = []
    for (const image of images) {
      const match = anchors.find(a => hamming(a.hash, image.hash) <= threshold)
      if (match) match.members.push(image.id)
      else anchors.push({ ...image, members: [] })
    }
    const expected = anchors.flatMap(a => Array.from({ length: Math.ceil(a.members.length / 255) }, (_, i) => [a.id, ...a.members.slice(i * 255, (i + 1) * 255)]))
    assert.deepEqual(representativeGroups(images, threshold).map(g => g.assetIds), expected)
  }
})
test('bounded groups preserve every member and fail budgets explicitly', () => {
  const images = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), hash: 0n }))
  const groups = representativeGroups(images, 0)
  assert.ok(groups.every(g => g.assetIds.length <= 256))
  assert.equal(new Set(groups.flatMap(g => g.assetIds)).size, 1000)
  assert.throws(() => representativeGroups(images, 0, { budget: 1 }), /budget/)
  assert.throws(() => representativeGroups(images, 0, { signal: AbortSignal.abort() }), /Cancelled/)
  assert.throws(() => representativeGroups(images, -1), /Threshold/)
})
test('stdio handshake, command schema, batches, cache, results and rejection', { timeout: 10000 }, async t => {
  const child = spawn(process.execPath, [new URL('../src/index.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  const pending = new Map(); let next = 0
  createInterface({ input: child.stdout }).on('line', line => { const value = JSON.parse(line); pending.get(value.id)?.(value); pending.delete(value.id) })
  const request = (method, params) => new Promise(resolve => { const id = ++next; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  assert.equal((await request('plugin.getManifest')).result.contributions[0].domain, 'library')
  const command = (await request('library.getCommands')).result[0]
  assert.equal(command.parameters[0].default, 8)
  assert.equal(command.autoRunAfterScan, true)
  assert.ok((await request('library.run', { phase: 'start', commandId: command.id, parameters: { threshold: 65 } })).error)
  assert.ok((await request('object.delete', { id: 'a' })).error)
  await request('library.run', { phase: 'start', commandId: command.id })
  const pixels = Buffer.alloc(1024).toString('base64')
  const batch = await request('library.run', { phase: 'batch', images: [{ id: 'a', sourceVersion: 'v1', pixels }, { id: 'b', sourceVersion: 'v1', pixels }] })
  assert.equal(batch.result.cache.a.hash, '0000000000000000')
  assert.equal((await request('library.run', { phase: 'finish' })).result.total, 1)
  assert.deepEqual((await request('library.run', { phase: 'results', offset: 0, limit: 1 })).result.groups[0].assetIds, ['a', 'b'])
  assert.ok((await request('library.run', { phase: 'results', offset: -1, limit: 1 })).error)
  child.stdin.end()
})
