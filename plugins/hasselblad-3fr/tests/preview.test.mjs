import test from 'node:test'
import assert from 'node:assert/strict'
import { extractPreview, boundedReader, LIMITS } from '../src/preview.mjs'
import { registerPreview, formats } from '../src/protocol.mjs'
import manifest from '../manifest.json' with { type: 'json' }

// Marker-level fixture, deliberately not an entropy decoder test. APP contains
// a false EOI and entropy contains stuffing/restart markers.
function jpeg(w = 24, h = 12) {
  return Buffer.from([255,216, 255,225,0,6,255,217,0,0,
    255,192,0,11,8,h >> 8,h & 255,w >> 8,w & 255,1,1,17,0,
    255,218,0,8,1,1,0,0,63,0, 1,255,0,217,255,208,2,255,217])
}
function fixture({ be = false, tag = 513, tail = 1024, image = jpeg(), cycle = false, pointer = 0 } = {}) {
  const head = Buffer.alloc(256)
  const w16 = (v,p) => be ? head.writeUInt16BE(v,p) : head.writeUInt16LE(v,p)
  const w32 = (v,p) => be ? head.writeUInt32BE(v,p) : head.writeUInt32LE(v,p)
  head.write(be ? 'MM' : 'II'); w16(42,2); w32(8,4)
  function directory(at, entries, next = 0) {
    w16(entries.length,at)
    entries.forEach(([tag,value],i) => { const p=at+2+i*12; w16(tag,p); w16(4,p+2); w32(1,p+4); w32(value,p+8) })
    w32(next,at+2+entries.length*12)
  }
  if (pointer) { directory(8,[[pointer,64]],cycle ? 8 : 0); directory(64,[[tag,tail],[514,1]],8) }
  else directory(8,[[tag,tail],[514,1]],cycle ? 8 : 0)
  const size = tail + image.length, calls = []
  const read = async (offset,length) => {
    assert.ok(Number.isSafeInteger(offset) && offset >= 0 && offset+length <= size)
    assert.ok(length <= LIMITS.chunk)
    calls.push([offset,length])
    const out = Buffer.alloc(length)
    for (const [at,buf] of [[0,head],[tail,image]]) {
      const from=Math.max(at,offset), to=Math.min(at+buf.length,offset+length)
      if(to>from) buf.copy(out,from-offset,from-at,to-at)
    }
    return out
  }
  return { head, size, read, calls, tail, image }
}
const request = (f, extra = {}) => ({ input: { id: 'input-1', size: f.size }, extension: '.3fr', maxPreviewBytes: LIMITS.preview, maxPixels: LIMITS.pixels, ...extra })

for (const be of [false,true]) for (const tag of [513,273,324]) {
  test(`classic TIFF ${be ? 'MM' : 'II'} tag ${tag}, inaccurate length and marker EOI`, async () => {
    const f=fixture({be,tag}), r=await extractPreview(request(f),f.read)
    assert.deepEqual(r,{mimeType:'image/jpeg',offset:f.tail,length:f.image.length,width:24,height:12})
  })
}
for (const pointer of [330,34665,34853]) test(`directory pointer ${pointer}, cycles and sparse large-file tail`, async () => {
  const f=fixture({pointer,cycle:true,tail:150*1024*1024})
  const r=await extractPreview(request(f),f.read)
  assert.equal(r.offset,f.tail)
  assert.ok(f.calls.reduce((n,c)=>n+c[1],0)<65536)
  assert.ok(f.calls.length<20)
})
test('largest preview wins even if TIFF only points at thumbnail', async () => {
  const f=fixture(), larger=jpeg(1200,800), size=2048+larger.length
  const read=async(o,n)=>{const b=Buffer.alloc(n); if(o<f.size){const part=await f.read(o,Math.min(n,f.size-o)); part.copy(b)}
    const a=Math.max(o,2048),z=Math.min(o+n,size); if(z>a)larger.copy(b,a-o,a-2048,z-2048);return b}
  const r=await extractPreview(request({...f,size}),read)
  assert.equal(r.width,1200);assert.equal(r.offset,2048)
  const limited=await extractPreview(request({...f,size},{maxPixels:1000}),read)
  assert.equal(limited.width,24)
})
test('scan detects SOI across a transfer chunk boundary',async()=>{
  const f=fixture({tail:LIMITS.chunk-1});f.head.writeUInt32LE(0xffffffff,18)
  assert.equal((await extractPreview(request(f),f.read)).offset,f.tail)
})
test('next IFD is traversed on large inputs',async()=>{
  const f=fixture({pointer:330,tail:100*1024*1024})
  f.head.writeUInt32LE(0,18);f.head.writeUInt32LE(64,22)
  assert.equal((await extractPreview(request(f),f.read)).offset,f.tail)
})
test('sensor data and no preview rejected',async()=>{
  const f=fixture({image:Buffer.alloc(100,17)})
  await assert.rejects(extractPreview(request(f),f.read),/No usable/)
})
test('truncated JPEG, missing SOF and pixel/byte limits rejected',async()=>{
  for(const image of [jpeg().subarray(0,-1),Buffer.from([255,216,255,217])]) {
    const f=fixture({image});await assert.rejects(extractPreview(request(f),f.read),/No usable/)
  }
  const f=fixture()
  await assert.rejects(extractPreview(request(f,{maxPixels:1}),f.read),/No usable/)
  await assert.rejects(extractPreview(request(f,{maxPreviewBytes:10}),f.read),/No usable/)
})
test('bad offsets, cycles and huge field counts are bounded',async()=>{
  const f=fixture({tail:100*1024*1024,cycle:true})
  f.head.writeUInt32LE(0xffffffff,18)
  await assert.rejects(extractPreview(request(f),f.read),/No usable/)
  assert.ok(f.calls.length<10)
  f.head.writeUInt32LE(0xffffffff,14)
  await assert.rejects(extractPreview(request(f),f.read),/No usable/)
})
test('invalid formats, headers and limits fail before arbitrary reads',async()=>{
  const f=fixture()
  for(const change of [{extension:'.nef'},{extension:'.3FR'},{maxPixels:0},{maxPreviewBytes:Infinity},{input:{id:'x',size:Number.MAX_SAFE_INTEGER+1}}]) {
    await assert.rejects(extractPreview(request(f,change),()=>assert.fail('must not read')),/Invalid/)
  }
  f.head.writeUInt16LE(43,2)
  await assert.rejects(extractPreview(request(f),f.read),/classic TIFF/)
})
test('read budget and transfer/range checks fail closed',async()=>{
  const f=fixture()
  await assert.rejects(extractPreview(request(f),f.read,{readBudget:8}),/budget/)
  await assert.rejects(extractPreview(request(f),async()=>Buffer.alloc(0)),/Short/)
  const read=boundedReader(10,()=>assert.fail('must not read'))
  for(const [o,n] of [[-1,1],[9,2],[0,0.5],[NaN,1],[Number.MAX_SAFE_INTEGER,1]]) await assert.rejects(read(o,n),/range/)
})
test('protocol uses exact transfer fields and range-only result',async()=>{
  const f=fixture(), handlers=new Map()
  registerPreview({on:(k,v)=>handlers.set(k,v),request:async(method,p)=>{
    assert.equal(method,'host.transfer.read');assert.equal(p.transferId,'input-1')
    assert.deepEqual(Object.keys(p).sort(),['length','offset','transferId'])
    return {data:(await f.read(p.offset,p.length)).toString('base64'),offset:p.offset,next:p.offset+p.length,eof:p.offset+p.length===f.size}
  }},manifest)
  assert.deepEqual(handlers.get('image-preview.getFormats')(),formats)
  assert.equal(handlers.get('initialize')({coreApiVersion:'1'}),manifest)
  assert.throws(()=>handlers.get('initialize')({coreApiVersion:'2'}),/Unsupported/)
  const result=await handlers.get('image-preview.extract')(request(f))
  assert.deepEqual(Object.keys(result).sort(),['height','length','mimeType','offset','width'])
})
test('protocol rejects invalid host offset and allows retry after failure',async()=>{
  const f=fixture(), handlers=new Map()
  registerPreview({on:(k,v)=>handlers.set(k,v),request:async()=>({data:'',offset:99,next:0,eof:false})},manifest)
  for(let i=0;i<2;i++) await assert.rejects(handlers.get('image-preview.extract')(request(f)),/Invalid host/)
})
test('offset arrays skip sensor strip and preserve contiguous JPEG across strips',async()=>{
  const f=fixture({tag:273,tail:100*1024*1024})
  f.head.writeUInt32LE(3,14);f.head.writeUInt32LE(128,18)
  f.head.writeUInt32LE(512,128);f.head.writeUInt32LE(f.tail,132);f.head.writeUInt32LE(f.tail+16,136)
  assert.equal((await extractPreview(request(f),f.read)).length,f.image.length)
})
test('progressive multi-scan markers and EOI crossing JPEG read window',async()=>{
  const prefix=jpeg().subarray(0,-2);prefix[11]=194
  const image=Buffer.concat([prefix,Buffer.from([255,218,0,8,1,1,0,1,63,0]),Buffer.alloc(65536-prefix.length-11,1),Buffer.from([255,217])])
  const f=fixture({image})
  assert.equal((await extractPreview(request(f),f.read)).length,image.length)
})
test('candidate and marker limits terminate degenerate input',async()=>{
  const f=fixture({image:Buffer.alloc((LIMITS.candidates+1)*4)})
  for(let i=0;i<f.image.length;i+=4) f.image.set([255,216,255,217],i)
  await assert.rejects(extractPreview(request(f),f.read),/Candidate budget/)
  const many=Buffer.alloc((LIMITS.markers+1)*4)
  for(let i=0;i<many.length;i+=4) many.set([255,225,0,2],i)
  const g=fixture({image:Buffer.concat([Buffer.from([255,216]),many,jpeg().subarray(2)])})
  await assert.rejects(extractPreview(request(g),g.read),/No usable/)
})
test('more than 65536 entropy stuffing pairs and restarts do not exhaust structural markers',async()=>{
  for(const marker of [0,208]) {
    const entropy=Buffer.alloc((LIMITS.markers+1)*2)
    for(let i=0;i<entropy.length;i+=2) entropy.set([255,marker],i)
    const f=fixture({image:Buffer.concat([jpeg().subarray(0,-2),entropy,Buffer.from([255,217])])})
    assert.equal((await extractPreview(request(f),f.read)).length,f.image.length)
    assert.ok(f.calls.length<20)
  }
})
test('512 sensor strip probes do not consume the JPEG candidate budget',async()=>{
  const f=fixture({tag:273,tail:100*1024*1024})
  f.head.writeUInt32LE(512,14);f.head.writeUInt32LE(256,18)
  f.head.writeUInt16LE(513,22);f.head.writeUInt32LE(f.tail,30)
  const offsets=Buffer.alloc(512*4)
  for(let i=0;i<512;i++) offsets.writeUInt32LE(4096+i*4,i*4)
  const read=async(o,n)=>o===256 ? offsets : f.read(o,n)
  assert.equal((await extractPreview(request(f),read)).offset,f.tail)
  assert.ok(f.calls.length<600)
})
test('host-aligned caps reject oversized requests and exhausted read calls',async()=>{
  const f=fixture()
  for(const change of [{maxPixels:LIMITS.pixels+1},{maxPreviewBytes:LIMITS.preview+1}])
    await assert.rejects(extractPreview(request(f,change),()=>assert.fail('must not read')),/Invalid/)
  const read=boundedReader(1,async()=>Buffer.alloc(1))
  for(let i=0;i<LIMITS.calls;i++) await read(0,1)
  await assert.rejects(read(0,1),/budget/)
})
