/**
 * 分帧层单测：格式、增量解码、边界与失败语义。
 *
 * 这一层是宿主与插件之间唯一的字节级契约（宿主 `storage_plugins/frames.go`），
 * 所以每个常量、每个偏移都钉在这里。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FRAME_TYPE_CONTROL,
  FRAME_TYPE_DATA,
  FrameDecoder,
  FrameError,
  MAX_BLOB_ID_BYTES,
  MAX_FRAME_BYTES,
  decodeDataFrame,
  encodeControlFrame,
  encodeDataFrame,
  isValidBlobID,
} from '../src/frames.mjs'

test('control frames carry [4B big-endian length][type][JSON] in both directions', () => {
  const frame = encodeControlFrame({ jsonrpc: '2.0', id: 1, method: 'faces.health' })
  assert.equal(frame.readUInt32BE(0), frame.length - 4, 'length covers the type byte and payload')
  assert.equal(frame.readUInt8(4), FRAME_TYPE_CONTROL)
  assert.deepEqual(JSON.parse(frame.subarray(5).toString('utf8')), {
    jsonrpc: '2.0',
    id: 1,
    method: 'faces.health',
  })
})

test('data frames carry [idLen][id][offset][bytes]', () => {
  const frame = encodeDataFrame('image', 1024, Buffer.from([1, 2, 3]))
  assert.equal(frame.readUInt8(4), FRAME_TYPE_DATA)
  const payload = frame.subarray(5)
  assert.equal(payload.readUInt8(0), 'image'.length)
  assert.equal(payload.subarray(1, 6).toString('ascii'), 'image')
  assert.equal(payload.readUInt32BE(6), 1024)
  assert.deepEqual([...payload.subarray(10)], [1, 2, 3])
  assert.deepEqual(decodeDataFrame(payload), {
    id: 'image',
    offset: 1024,
    chunk: payload.subarray(10),
  })
})

test('blob ids are bounded printable ASCII, matching the host', () => {
  assert.equal(isValidBlobID('image'), true)
  assert.equal(isValidBlobID('a'.repeat(MAX_BLOB_ID_BYTES)), true)
  assert.equal(isValidBlobID('a'.repeat(MAX_BLOB_ID_BYTES + 1)), false)
  assert.equal(isValidBlobID(''), false)
  assert.equal(isValidBlobID('bad id'), false, 'space is not printable ASCII here')
  assert.equal(isValidBlobID('脸'), false)
  assert.equal(isValidBlobID(7), false)
  assert.throws(() => encodeDataFrame('bad id', 0, Buffer.alloc(1)), FrameError)
})

test('the decoder reassembles frames across arbitrary chunk boundaries', () => {
  const stream = Buffer.concat([
    encodeControlFrame({ id: 1, method: 'a' }),
    encodeDataFrame('image', 0, Buffer.from('hello')),
    encodeControlFrame({ id: 2, method: 'b' }),
  ])
  const decoder = new FrameDecoder()
  const frames = []
  // 逐字节喂：最坏的分片情况。
  for (let offset = 0; offset < stream.length; offset += 1) {
    frames.push(...decoder.push(stream.subarray(offset, offset + 1)))
  }
  assert.equal(frames.length, 3)
  assert.equal(frames[0].type, FRAME_TYPE_CONTROL)
  assert.equal(frames[1].type, FRAME_TYPE_DATA)
  assert.equal(decodeDataFrame(frames[1].payload).chunk.toString('utf8'), 'hello')
  assert.equal(JSON.parse(frames[2].payload.toString('utf8')).id, 2)
})

test('an empty chunk never disturbs the buffer', () => {
  const decoder = new FrameDecoder()
  assert.deepEqual(decoder.push(Buffer.alloc(0)), [])
  const half = encodeControlFrame({ id: 1 })
  assert.deepEqual(decoder.push(half.subarray(0, 3)), [])
  assert.equal(decoder.push(half.subarray(3)).length, 1)
})

test('a bad frame length or type is a transport failure, not a recoverable one', () => {
  const decoder = new FrameDecoder()
  const zero = Buffer.alloc(5)
  zero.writeUInt32BE(0, 0)
  assert.throws(() => decoder.push(zero), FrameError)

  const huge = Buffer.alloc(5)
  huge.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
  assert.throws(() => new FrameDecoder().push(huge), FrameError)

  const unknownType = Buffer.alloc(6)
  unknownType.writeUInt32BE(2, 0)
  unknownType.writeUInt8(9, 4)
  assert.throws(() => new FrameDecoder().push(unknownType), FrameError)
})

test('oversized payloads are refused when encoding', () => {
  assert.throws(() => encodeDataFrame('image', 0, Buffer.alloc(MAX_FRAME_BYTES)), FrameError)
  assert.throws(() => decodeDataFrame(Buffer.alloc(0)), FrameError)
  assert.throws(() => decodeDataFrame(Buffer.from([5, 1, 2])), FrameError, 'truncated header')
})
