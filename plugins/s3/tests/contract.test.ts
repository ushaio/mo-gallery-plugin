import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { createFakeHost, createStoragePlugin } from '@mo-gallery/desktop-plugin-sdk'
import { createS3Plugin } from '../src/plugin.js'

interface StoredObject {
  body: Buffer
  contentType?: string
}

async function startFakeS3() {
  const objects = new Map<string, StoredObject>()
  const server = createServer((request, response) => handleRequest(request, response, objects))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fake S3 did not bind to a TCP port')
  const endpoint = `http://127.0.0.1:${address.port}`
  return { endpoint, objects, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

async function startHangingS3() {
  const server = createServer(() => {
    // Keep the socket open to model a provider that never completes a request.
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('hanging S3 did not bind to a TCP port')
  const endpoint = `http://127.0.0.1:${address.port}`
  return { endpoint, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, objects: Map<string, StoredObject>) {
  const url = new URL(request.url || '/', `http://${request.headers.host}`)
  const pathParts = url.pathname.split('/').slice(1).map(decodeURIComponent)
  const bucket = pathParts.shift() || ''
  const key = pathParts.join('/')
  if (bucket !== 'bucket') {
    response.writeHead(404).end()
    return
  }

  if (request.method === 'HEAD') {
    if (!key) {
      response.writeHead(200).end()
      return
    }
    const object = objects.get(key)
    if (!object) {
      response.writeHead(404).end()
      return
    }
    sendObjectHeaders(response, object)
    response.end()
    return
  }

  if (request.method === 'GET' && !key && url.searchParams.has('list-type')) {
    const prefix = url.searchParams.get('prefix') || ''
    const entries = [...objects.entries()].filter(([objectKey]) => objectKey.startsWith(prefix))
    const contents = entries.map(([objectKey, object]) => `<Contents><Key>${escapeXml(objectKey)}</Key><Size>${object.body.byteLength}</Size><ETag>"${etag(object.body)}"</ETag></Contents>`).join('')
    response.writeHead(200, { 'content-type': 'application/xml' })
    response.end(`<ListBucketResult><Name>bucket</Name>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`)
    return
  }

  if (request.method === 'GET') {
    const object = objects.get(key)
    if (!object) {
      response.writeHead(404).end()
      return
    }
    sendObjectHeaders(response, object)
    response.end(object.body)
    return
  }

  if (request.method === 'PUT') {
    const copySource = request.headers['x-amz-copy-source']
    if (typeof copySource === 'string') {
      const sourceKey = decodeURIComponent(copySource.replace(/^\/?bucket\//, ''))
      const source = objects.get(sourceKey)
      if (!source) {
        response.writeHead(404).end()
        return
      }
      objects.set(key, { body: Buffer.from(source.body), contentType: source.contentType })
      response.writeHead(200, { 'content-type': 'application/xml' })
      response.end(`<CopyObjectResult><ETag>"${etag(source.body)}"</ETag></CopyObjectResult>`)
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const body = decodeAwsChunkedBody(Buffer.concat(chunks), request.headers['x-amz-content-sha256'])
    objects.set(key, { body, contentType: headerString(request.headers['content-type']) })
    response.writeHead(200, { etag: `"${etag(body)}"` }).end()
    return
  }

  if (request.method === 'DELETE') {
    objects.delete(key)
    response.writeHead(204).end()
    return
  }

  response.writeHead(405).end()
}

function sendObjectHeaders(response: ServerResponse, object: StoredObject) {
  response.setHeader('content-length', object.body.byteLength)
  response.setHeader('etag', `"${etag(object.body)}"`)
  if (object.contentType) response.setHeader('content-type', object.contentType)
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function etag(body: Buffer): string {
  return createHash('md5').update(body).digest('hex')
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function decodeAwsChunkedBody(body: Buffer, checksumHeader: string | string[] | undefined): Buffer {
  const header = headerString(checksumHeader)
  if (!header?.startsWith('STREAMING-')) return body
  const chunks: Buffer[] = []
  let offset = 0
  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset)
    if (lineEnd < 0) throw new Error('invalid AWS chunked body header')
    const size = Number.parseInt(body.subarray(offset, lineEnd).toString('ascii').split(';', 1)[0], 16)
    if (!Number.isFinite(size) || size < 0) throw new Error('invalid AWS chunked body size')
    offset = lineEnd + 2
    if (size === 0) break
    const end = offset + size
    if (end + 2 > body.length || body[end] !== 13 || body[end + 1] !== 10) throw new Error('invalid AWS chunked body payload')
    chunks.push(body.subarray(offset, end))
    offset = end + 2
  }
  return Buffer.concat(chunks)
}

test('S3 plugin completes the storage object contract against a fake provider', async () => {
  const fakeS3 = await startFakeS3()
  const host = createFakeHost()
  const running = createStoragePlugin(createS3Plugin(), {
    input: host.pluginInput,
    output: host.pluginOutput,
    env: {
      MO_STORAGE_PLUGIN_CONFIG: JSON.stringify({
        endpoint: fakeS3.endpoint,
        region: 'us-east-1',
        bucket: 'bucket',
        forcePathStyle: 'true',
        urlMode: 'public',
      }),
      MO_STORAGE_PLUGIN_CREDENTIAL_ACCESSKEY: 'test-access',
      MO_STORAGE_PLUGIN_CREDENTIAL_SECRETKEY: 'test-secret',
    },
  })

  try {
    const manifest = await host.request<{ capabilities: string[] }>('plugin.getManifest')
    assert.ok(manifest.capabilities.includes('object.get'))
    assert.deepEqual(await host.request('plugin.health', { sourceId: 'source-1' }), { status: 'ready' })
    assert.deepEqual(await host.request('source.validate', { sourceId: 'source-1', config: {} }), { valid: true })

    const body = new TextEncoder().encode('s3 plugin body')
    const uploadHandle = { id: 'upload-1', size: body.byteLength }
    host.setTransfer(uploadHandle, body)
    const uploaded = await host.request<{ key: string; size: number; urlType: string }>('object.put', {
      sourceId: 'source-1', transferId: uploadHandle.id, size: body.byteLength,
      key: 'photos/original.jpg', contentType: 'image/jpeg', checksum: undefined,
      idempotencyKey: 'source-1:hash',
    })
    assert.equal(uploaded.key, 'photos/original.jpg')
    assert.equal(uploaded.size, body.byteLength)
    assert.equal(uploaded.urlType, 'public')
    assert.deepEqual(fakeS3.objects.get('photos/original.jpg')?.body, Buffer.from(body))

    const downloadedHandle = { id: 'download-1', size: 0 }
    host.setDownloadTransfer(downloadedHandle)
    const downloaded = await host.request<{ key: string; size: number }>('object.get', {
      sourceId: 'source-1', transferId: downloadedHandle.id, key: 'photos/original.jpg',
    })
    assert.equal(downloaded.key, 'photos/original.jpg')
    assert.equal(downloaded.size, body.byteLength)
    assert.deepEqual(host.readDownloadTransfer(downloadedHandle.id), body)

    const stat = await host.request<{ key: string; size: number; contentType?: string }>('object.stat', {
      sourceId: 'source-1', key: 'photos/original.jpg',
    })
    assert.deepEqual(stat, {
      key: 'photos/original.jpg',
      size: body.byteLength,
      contentType: 'image/jpeg',
      checksum: etag(Buffer.from(body)),
      urlType: 'public',
      url: `${fakeS3.endpoint}/bucket/photos/original.jpg`,
    })

    const listed = await host.request<{ objects: Array<{ key: string }> }>('object.list', {
      sourceId: 'source-1', prefix: 'photos', limit: 100,
    })
    assert.deepEqual(listed.objects.map(object => object.key), ['photos/original.jpg'])

    const moved = await host.request<{ key: string }>('object.move', {
      sourceId: 'source-1', fromKey: 'photos/original.jpg', toKey: 'photos/moved.jpg',
    })
    assert.equal(moved.key, 'photos/moved.jpg')
    assert.equal(fakeS3.objects.has('photos/original.jpg'), false)
    assert.equal(fakeS3.objects.has('photos/moved.jpg'), true)

    const url = await host.request<{ url: string; urlType: string }>('object.getUrl', {
      sourceId: 'source-1', key: 'photos/moved.jpg',
    })
    assert.deepEqual(url, {
      key: 'photos/moved.jpg', size: 0, urlType: 'public',
      url: `${fakeS3.endpoint}/bucket/photos/moved.jpg`,
    })

    await host.request('object.delete', { sourceId: 'source-1', key: 'photos/moved.jpg' })
    assert.equal(fakeS3.objects.has('photos/moved.jpg'), false)
  } finally {
    running.close()
    host.close()
    await fakeS3.close()
  }
})

test('S3 health request is canceled when the provider does not respond', async () => {
  const hangingS3 = await startHangingS3()
  const host = createFakeHost()
  const running = createStoragePlugin(createS3Plugin(), {
    input: host.pluginInput,
    output: host.pluginOutput,
    env: {
      MO_STORAGE_PLUGIN_CONFIG: JSON.stringify({ endpoint: hangingS3.endpoint, region: 'us-east-1', bucket: 'bucket' }),
      MO_STORAGE_PLUGIN_CREDENTIAL_ACCESSKEY: 'test-access',
      MO_STORAGE_PLUGIN_CREDENTIAL_SECRETKEY: 'test-secret',
    },
  })

  try {
    await assert.rejects(
      host.request('plugin.health', { sourceId: 'source-1' }),
      /S3 request timed out after 10000ms/,
    )
  } finally {
    running.close()
    host.close()
    await hangingS3.close()
  }
})

test('S3 health surfaces the provider HTTP status instead of UnknownError', async () => {
  const fakeS3 = await startFakeS3()
  const host = createFakeHost()
  const running = createStoragePlugin(createS3Plugin(), {
    input: host.pluginInput,
    output: host.pluginOutput,
    env: {
      MO_STORAGE_PLUGIN_CONFIG: JSON.stringify({ endpoint: fakeS3.endpoint, region: 'us-east-1', bucket: 'missing-bucket' }),
      MO_STORAGE_PLUGIN_CREDENTIAL_ACCESSKEY: 'test-access',
      MO_STORAGE_PLUGIN_CREDENTIAL_SECRETKEY: 'test-secret',
    },
  })

  try {
    await assert.rejects(
      host.request('plugin.health', { sourceId: 'source-1' }),
      (error: unknown) => error instanceof Error && /HTTP 404/.test(error.message) && !/UnknownError/.test(error.message),
    )
  } finally {
    running.close()
    host.close()
    await fakeS3.close()
  }
})
