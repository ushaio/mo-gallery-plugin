import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { createFakeHost, createStoragePlugin } from '@mo-gallery/plugin-sdk'
import { createOssPlugin } from '../src/plugin.js'

interface StoredObject {
  body: Buffer
  contentType?: string
}

// The plugin talks to OSS through a cname endpoint, so the fake provider keys
// objects by path only and treats every host as the same bucket.
async function startFakeOss() {
  const objects = new Map<string, StoredObject>()
  const server = createServer((request, response) => handleRequest(request, response, objects))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fake OSS did not bind to a TCP port')
  const endpoint = `http://127.0.0.1:${address.port}`
  return { endpoint, objects, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

async function startHangingOss() {
  const server = createServer(() => {
    // Keep the socket open to model a provider that never completes a request.
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('hanging OSS did not bind to a TCP port')
  const endpoint = `http://127.0.0.1:${address.port}`
  return { endpoint, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

// A provider that rejects every request models a wrong region, a bucket that does
// not exist, or revoked credentials: OSS answers with an XML error body, and the
// plugin has to turn that into a message naming the HTTP status.
async function startRejectingOss() {
  const server = createServer((request, response) => {
    request.resume()
    response.writeHead(404, { 'content-type': 'application/xml' })
    response.end('<Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist.</Message><RequestId>req-1</RequestId></Error>')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('rejecting OSS did not bind to a TCP port')
  const endpoint = `http://127.0.0.1:${address.port}`
  return { endpoint, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, objects: Map<string, StoredObject>) {
  const url = new URL(request.url || '/', `http://${request.headers.host}`)
  const key = url.pathname.replace(/^\/+/, '').split('/').map(decodeURIComponent).join('/')

  // Healthy bucket probe: getBucketInfo is a bucket-level GET with ?bucketInfo.
  if (url.searchParams.has('bucketInfo')) {
    response.writeHead(200, { 'content-type': 'application/xml' })
    response.end('<BucketInfo><Bucket>bucket</Bucket></BucketInfo>')
    return
  }

  if (request.method === 'HEAD') {
    const object = objects.get(key)
    if (!object) {
      response.writeHead(404).end()
      return
    }
    sendObjectHeaders(response, object)
    response.end()
    return
  }

  if (request.method === 'GET' && url.searchParams.get('list-type') === '2') {
    const prefix = url.searchParams.get('prefix') || ''
    const maxKeys = Number.parseInt(url.searchParams.get('max-keys') || '1000', 10) || 1000
    const entries = [...objects.entries()]
      .filter(([objectKey]) => objectKey.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))
    const page = entries.slice(0, maxKeys)
    const contents = page.map(([objectKey, object]) => `<Contents><Key>${escapeXml(objectKey)}</Key><Size>${object.body.byteLength}</Size><ETag>"${etag(object.body)}"</ETag><LastModified>2024-01-01T00:00:00.000Z</LastModified><StorageClass>Standard</StorageClass></Contents>`).join('')
    response.writeHead(200, { 'content-type': 'application/xml' })
    response.end(`<ListBucketResult><Name>bucket</Name><Prefix>${escapeXml(prefix)}</Prefix>${contents}<KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${entries.length > page.length ? 'true' : 'false'}</IsTruncated></ListBucketResult>`)
    return
  }

  if (request.method === 'GET') {
    const object = objects.get(key)
    if (!object) {
      response.writeHead(404, { 'content-type': 'application/xml' })
      response.end('<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>')
      return
    }
    sendObjectHeaders(response, object)
    response.end(object.body)
    return
  }

  if (request.method === 'PUT') {
    const copySource = request.headers['x-oss-copy-source']
    if (typeof copySource === 'string') {
      // OSS copy sources are '/<bucket>/<urlencoded key>'.
      const sourceKey = copySource.replace(/^\/[^/]+\//, '').split('/').map(decodeURIComponent).join('/')
      const source = objects.get(sourceKey)
      if (!source) {
        response.writeHead(404, { 'content-type': 'application/xml' })
        response.end('<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>')
        return
      }
      objects.set(key, { body: Buffer.from(source.body), contentType: source.contentType })
      response.writeHead(200, { 'content-type': 'application/xml' })
      response.end(`<CopyObjectResult><ETag>"${etag(source.body)}"</ETag><LastModified>2024-01-01T00:00:00.000Z</LastModified></CopyObjectResult>`)
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const body = Buffer.concat(chunks)
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

test('OSS plugin completes the storage object contract against a fake provider', async () => {
  const fakeOss = await startFakeOss()
  const host = createFakeHost()
  const running = createStoragePlugin(createOssPlugin(), {
    input: host.pluginInput,
    output: host.pluginOutput,
    env: {
      MO_STORAGE_PLUGIN_CONFIG: JSON.stringify({
        endpoint: fakeOss.endpoint,
        region: 'oss-cn-hangzhou',
        bucket: 'photos',
        urlMode: 'public',
      }),
      MO_STORAGE_PLUGIN_CREDENTIAL_ACCESSKEYID: 'test-access-key-id',
      MO_STORAGE_PLUGIN_CREDENTIAL_ACCESSKEYSECRET: 'test-access-key-secret',
    },
  })

  try {
    const manifest = await host.request<{ capabilities: string[] }>('plugin.getManifest')
    assert.ok(manifest.capabilities.includes('object.get'))
    assert.deepEqual(await host.request('plugin.health', { sourceId: 'source-1' }), { status: 'ready' })
    assert.deepEqual(await host.request('source.validate', { sourceId: 'source-1', config: {} }), { valid: true })

    const body = new TextEncoder().encode('oss plugin body')
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
    assert.deepEqual(fakeOss.objects.get('photos/original.jpg')?.body, Buffer.from(body))

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
      url: `${fakeOss.endpoint}/photos/original.jpg`,
    })

    const listed = await host.request<{ objects: Array<{ key: string }> }>('object.list', {
      sourceId: 'source-1', prefix: 'photos', limit: 100,
    })
    assert.deepEqual(listed.objects.map(object => object.key), ['photos/original.jpg'])

    const moved = await host.request<{ key: string }>('object.move', {
      sourceId: 'source-1', fromKey: 'photos/original.jpg', toKey: 'photos/moved.jpg',
    })
    assert.equal(moved.key, 'photos/moved.jpg')
    assert.equal(fakeOss.objects.has('photos/original.jpg'), false)
    assert.equal(fakeOss.objects.has('photos/moved.jpg'), true)

    const url = await host.request<{ url: string; urlType: string }>('object.getUrl', {
      sourceId: 'source-1', key: 'photos/moved.jpg',
    })
    assert.deepEqual(url, {
      key: 'photos/moved.jpg', size: 0, urlType: 'public',
      url: `${fakeOss.endpoint}/photos/moved.jpg`,
    })

    await host.request('object.delete', { sourceId: 'source-1', key: 'photos/moved.jpg' })
    assert.equal(fakeOss.objects.has('photos/moved.jpg'), false)
  } finally {
    running.close()
    host.close()
    await fakeOss.close()
  }
})

test('OSS health request fails when the provider does not respond', async () => {
  const hangingOss = await startHangingOss()
  const host = createFakeHost()
  const running = createStoragePlugin(createOssPlugin(), {
    input: host.pluginInput,
    output: host.pluginOutput,
    env: {
      MO_STORAGE_PLUGIN_CONFIG: JSON.stringify({ endpoint: hangingOss.endpoint, region: 'oss-cn-hangzhou', bucket: 'photos' }),
      MO_STORAGE_PLUGIN_CREDENTIAL_ACCESSKEYID: 'test-access-key-id',
      MO_STORAGE_PLUGIN_CREDENTIAL_ACCESSKEYSECRET: 'test-access-key-secret',
    },
  })

  try {
    // ali-oss only retries when retryMax is set, which this client leaves unset,
    // so the socket timeout fires once. Pin the surfaced message either way.
    await assert.rejects(
      host.request('plugin.health', { sourceId: 'source-1' }),
      (error: unknown) => error instanceof Error && /OSS health check failed/.test(error.message),
    )
  } finally {
    running.close()
    host.close()
    await hangingOss.close()
  }
})

test('OSS health surfaces the provider HTTP status instead of UnknownError', async () => {
  const rejectingOss = await startRejectingOss()
  const host = createFakeHost()
  const running = createStoragePlugin(createOssPlugin(), {
    input: host.pluginInput,
    output: host.pluginOutput,
    env: {
      MO_STORAGE_PLUGIN_CONFIG: JSON.stringify({
        endpoint: rejectingOss.endpoint,
        region: 'oss-cn-hangzhou',
        bucket: 'photos',
      }),
      MO_STORAGE_PLUGIN_CREDENTIAL_ACCESSKEYID: 'test-access-key-id',
      MO_STORAGE_PLUGIN_CREDENTIAL_ACCESSKEYSECRET: 'test-access-key-secret',
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
    await rejectingOss.close()
  }
})
