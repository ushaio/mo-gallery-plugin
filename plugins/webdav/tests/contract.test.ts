import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { createFakeHost, createStoragePlugin } from '@mo-gallery/desktop-plugin-sdk'
import { createWebdavPlugin } from '../src/plugin.js'

interface StoredObject {
  body: Buffer
  contentType?: string
}

const USERNAME = 'test-user'
const PASSWORD = 'test-pass'

interface FakeWebdav {
  endpoint: string
  objects: Map<string, StoredObject>
  collections: Set<string>
  close: () => Promise<void>
}

async function startFakeWebdav(): Promise<FakeWebdav> {
  const objects = new Map<string, StoredObject>()
  const collections = new Set<string>([''])
  const server = createServer((request, response) => handleRequest(request, response, objects, collections))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fake WebDAV did not bind to a TCP port')
  const endpoint = `http://127.0.0.1:${address.port}`
  return { endpoint, objects, collections, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

async function startHangingWebdav() {
  const server = createServer(() => {
    // Keep the socket open to model a WebDAV server that never completes a request.
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('hanging WebDAV did not bind to a TCP port')
  const endpoint = `http://127.0.0.1:${address.port}`
  return { endpoint, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

async function startUnauthorizedWebdav() {
  const server = createServer((request, response) => {
    response.writeHead(401, { 'www-authenticate': 'Basic realm="webdav"' })
    response.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('401 WebDAV did not bind to a TCP port')
  const endpoint = `http://127.0.0.1:${address.port}`
  return { endpoint, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

function isAuthorized(request: IncomingMessage): boolean {
  const expected = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`, 'utf8').toString('base64')}`
  return request.headers.authorization === expected
}

function requestKey(request: IncomingMessage): string {
  const url = new URL(request.url || '/', `http://${request.headers.host}`)
  return url.pathname.split('/').slice(1).map(part => decodeURIComponentSafe(part)).join('/').replace(/\/+$/, '')
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, objects: Map<string, StoredObject>, collections: Set<string>) {
  if (!isAuthorized(request)) {
    response.writeHead(401, { 'www-authenticate': 'Basic realm="webdav"' })
    response.end()
    return
  }
  const key = requestKey(request)

  if (request.method === 'PROPFIND') {
    // RFC 4918 semantics: Depth:0 returns the resource itself; Depth:1
    // returns the collection plus its DIRECT children only.
    const depth = Number.parseInt(String(request.headers.depth ?? '0'), 10) === 1 ? 1 : 0
    const hasChildren = [...objects.keys()].some(objectKey => objectKey.startsWith(`${key}/`))
    const exists = objects.has(key) || collections.has(key) || hasChildren
    if (!exists) {
      response.writeHead(404).end()
      return
    }
    const entries: string[] = []
    if (key === '' || collections.has(key) || !objects.has(key)) {
      entries.push(propfindCollectionEntry(key))
    } else if (depth === 0) {
      entries.push(propfindObjectEntry(key, objects.get(key)!))
    }
    if (depth === 1 && (collections.has(key) || key === '')) {
      for (const [objectKey, object] of objects) {
        const remainder = objectKey.startsWith(`${key}/`) ? objectKey.slice(key.length + 1) : ''
        if (remainder && !remainder.includes('/')) {
          entries.push(propfindObjectEntry(objectKey, object))
        }
      }
      for (const collection of collections) {
        const remainder = (key === '' ? collection : collection.startsWith(`${key}/`) ? collection.slice(key.length + 1) : '')
        if (remainder && !remainder.includes('/') && collection !== key) {
          entries.push(propfindCollectionEntry(collection))
        }
      }
    }
    response.writeHead(207, { 'content-type': 'application/xml' })
    response.end(`<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
${entries.join('\n')}
</D:multistatus>`)
    return
  }

  if (request.method === 'MKCOL') {
    const slash = key.lastIndexOf('/')
    const parent = slash >= 0 ? key.slice(0, slash) : ''
    if (!collections.has(parent) && parent !== '') {
      response.writeHead(409).end()
      return
    }
    if (collections.has(key)) {
      response.writeHead(405).end()
      return
    }
    collections.add(key)
    response.writeHead(201).end()
    return
  }

  if (request.method === 'GET') {
    const object = objects.get(key)
    if (!object) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-length': object.body.byteLength, etag: `"${etag(object.body)}"`, ...(object.contentType ? { 'content-type': object.contentType } : {}) })
    response.end(object.body)
    return
  }

  if (request.method === 'PUT') {
    // Real WebDAV servers fail nested PUTs with 409 until the parent
    // collection exists (created via MKCOL).
    const slash = key.lastIndexOf('/')
    const parent = slash >= 0 ? key.slice(0, slash) : ''
    if (parent !== '' && !collections.has(parent)) {
      response.writeHead(409).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    objects.set(key, { body, contentType: headerString(request.headers['content-type']) })
    response.writeHead(201, { etag: `"${etag(body)}"` }).end()
    return
  }

  if (request.method === 'MOVE') {
    const destination = headerString(request.headers.destination) ?? ''
    const destinationPath = decodeURIComponentSafe(new URL(destination).pathname)
    const destinationKey = destinationPath.split('/').slice(1).join('/').replace(/^\/+|\/+$/g, '')
    const source = objects.get(key)
    if (!source || !destinationKey) {
      response.writeHead(404).end()
      return
    }
    objects.delete(key)
    objects.set(destinationKey, { body: Buffer.from(source.body), contentType: source.contentType })
    response.writeHead(201).end()
    return
  }

  if (request.method === 'DELETE') {
    if (!objects.has(key)) {
      response.writeHead(404).end()
      return
    }
    objects.delete(key)
    response.writeHead(204).end()
    return
  }

  response.writeHead(405).end()
}

function propfindObjectEntry(key: string, object: StoredObject): string {
  return `<D:response>
  <D:href>${encodeURIComponent(key)}</D:href>
  <D:propstat>
    <D:prop>
      <D:resourcetype/>
      <D:getcontentlength>${object.body.byteLength}</D:getcontentlength>
      ${object.contentType ? `<D:getcontenttype>${object.contentType}</D:getcontenttype>` : ''}
      <D:getetag>"${etag(object.body)}"</D:getetag>
    </D:prop>
    <D:status>HTTP/1.1 200 OK</D:status>
  </D:propstat>
</D:response>`
}

function propfindCollectionEntry(key: string): string {
  return `<D:response>
  <D:href>${encodeURIComponent(key)}/</D:href>
  <D:propstat>
    <D:prop>
      <D:resourcetype><D:collection/></D:resourcetype>
    </D:prop>
    <D:status>HTTP/1.1 200 OK</D:status>
  </D:propstat>
</D:response>`
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function etag(body: Buffer): string {
  return createHash('md5').update(body).digest('hex')
}

function pluginEnv(endpoint: string, extra: Record<string, string> = {}) {
  return {
    MO_STORAGE_PLUGIN_CONFIG: JSON.stringify({ url: endpoint, ...extra }),
    MO_STORAGE_PLUGIN_CREDENTIAL_USERNAME: USERNAME,
    MO_STORAGE_PLUGIN_CREDENTIAL_PASSWORD: PASSWORD,
  }
}

test('WebDAV plugin completes the storage object contract against a fake provider', async () => {
  const fakeWebdav = await startFakeWebdav()
  const host = createFakeHost()
  const running = createStoragePlugin(createWebdavPlugin(), {
    input: host.pluginInput,
    output: host.pluginOutput,
    env: pluginEnv(fakeWebdav.endpoint),
  })

  try {
    const manifest = await host.request<{ capabilities: string[] }>('plugin.getManifest')
    assert.ok(manifest.capabilities.includes('object.get'))
    assert.deepEqual(await host.request('plugin.health', { sourceId: 'source-1' }), { status: 'ready' })
    assert.deepEqual(await host.request('source.validate', { sourceId: 'source-1', config: {} }), { valid: true })

    const body = new TextEncoder().encode('webdav plugin body')
    const uploadHandle = { id: 'upload-1', size: body.byteLength }
    host.setTransfer(uploadHandle, body)
    const uploaded = await host.request<{ key: string; size: number; urlType: string; checksum?: string }>('object.put', {
      sourceId: 'source-1', transferId: uploadHandle.id, size: body.byteLength,
      key: 'photos/original.jpg', contentType: 'image/jpeg',
      checksum: createHash('sha256').update(body).digest('hex'),
      idempotencyKey: 'source-1:hash',
    })
    assert.equal(uploaded.key, 'photos/original.jpg')
    assert.equal(uploaded.size, body.byteLength)
    assert.equal(uploaded.urlType, 'public')
    assert.equal(uploaded.checksum, etag(Buffer.from(body)))
    assert.ok(fakeWebdav.collections.has('photos'), 'PUT should create the parent collection via MKCOL')
    assert.deepEqual(fakeWebdav.objects.get('photos/original.jpg')?.body, Buffer.from(body))

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
      url: `${fakeWebdav.endpoint}/photos/original.jpg`,
    })

    const listed = await host.request<{ objects: Array<{ key: string; size: number }> }>('object.list', {
      sourceId: 'source-1', prefix: 'photos', limit: 100,
    })
    assert.deepEqual(listed.objects.map(object => object.key), ['photos/original.jpg'])
    assert.equal(listed.objects[0].size, body.byteLength)

    const moved = await host.request<{ key: string }>('object.move', {
      sourceId: 'source-1', fromKey: 'photos/original.jpg', toKey: 'photos/moved.jpg',
    })
    assert.equal(moved.key, 'photos/moved.jpg')
    assert.equal(fakeWebdav.objects.has('photos/original.jpg'), false)
    assert.equal(fakeWebdav.objects.has('photos/moved.jpg'), true)

    const url = await host.request<{ url: string; urlType: string }>('object.getUrl', {
      sourceId: 'source-1', key: 'photos/moved.jpg',
    })
    assert.deepEqual(url, {
      key: 'photos/moved.jpg', size: 0, urlType: 'public',
      url: `${fakeWebdav.endpoint}/photos/moved.jpg`,
    })

    await host.request('object.delete', { sourceId: 'source-1', key: 'photos/moved.jpg' })
    assert.equal(fakeWebdav.objects.has('photos/moved.jpg'), false)
  } finally {
    running.close()
    host.close()
    await fakeWebdav.close()
  }
})

test('WebDAV health request is canceled when the provider does not respond', async () => {
  const hangingWebdav = await startHangingWebdav()
  const host = createFakeHost()
  const running = createStoragePlugin(createWebdavPlugin(), {
    input: host.pluginInput,
    output: host.pluginOutput,
    env: pluginEnv(hangingWebdav.endpoint),
  })

  try {
    await assert.rejects(
      host.request('plugin.health', { sourceId: 'source-1' }),
      /timed out after 10000ms/,
    )
  } finally {
    running.close()
    host.close()
    await hangingWebdav.close()
  }
})

test('WebDAV validate reports authentication failures as invalid with a readable error', async () => {
  const unauthorized = await startUnauthorizedWebdav()
  const host = createFakeHost()
  const running = createStoragePlugin(createWebdavPlugin(), {
    input: host.pluginInput,
    output: host.pluginOutput,
    env: pluginEnv(unauthorized.endpoint),
  })

  try {
    const result = await host.request<{ valid: boolean; error?: string }>('source.validate', { sourceId: 'source-1', config: {} })
    assert.equal(result.valid, false)
    assert.match(result.error ?? '', /认证失败/)
  } finally {
    running.close()
    host.close()
    await unauthorized.close()
  }
})

test('WebDAV list uses cursor pagination over the directory listing', async () => {
  const fakeWebdav = await startFakeWebdav()
  const host = createFakeHost()
  const running = createStoragePlugin(createWebdavPlugin(), {
    input: host.pluginInput,
    output: host.pluginOutput,
    env: pluginEnv(fakeWebdav.endpoint),
  })

  try {
    for (const name of ['a.jpg', 'b.jpg', 'c.jpg']) {
      const body = new TextEncoder().encode(name)
      const handle = { id: `upload-${name}`, size: body.byteLength }
      host.setTransfer(handle, body)
      await host.request('object.put', { sourceId: 'source-1', transferId: handle.id, size: body.byteLength, key: `photos/${name}` })
    }

    const pageOne = await host.request<{ objects: Array<{ key: string }>; nextCursor?: string; hasMore?: boolean }>('object.list', {
      sourceId: 'source-1', prefix: 'photos', limit: 2,
    })
    assert.deepEqual(pageOne.objects.map(object => object.key), ['photos/a.jpg', 'photos/b.jpg'])
    assert.equal(pageOne.hasMore, true)
    assert.equal(pageOne.nextCursor, 'photos/b.jpg')

    const pageTwo = await host.request<{ objects: Array<{ key: string }>; hasMore?: boolean }>('object.list', {
      sourceId: 'source-1', prefix: 'photos', limit: 2, cursor: pageOne.nextCursor,
    })
    assert.deepEqual(pageTwo.objects.map(object => object.key), ['photos/c.jpg'])
    assert.equal(pageTwo.hasMore, false)
  } finally {
    running.close()
    host.close()
    await fakeWebdav.close()
  }
})

test('WebDAV list with a mixed-case key order never skips objects across pages', async () => {
  const fakeWebdav = await startFakeWebdav()
  const host = createFakeHost()
  const running = createStoragePlugin(createWebdavPlugin(), {
    input: host.pluginInput,
    output: host.pluginOutput,
    env: pluginEnv(fakeWebdav.endpoint),
  })

  try {
    for (const name of ['a.jpg', 'B.jpg', 'c.jpg']) {
      const body = new TextEncoder().encode(name)
      const handle = { id: `upload-${name}`, size: body.byteLength }
      host.setTransfer(handle, body)
      await host.request('object.put', { sourceId: 'source-1', transferId: handle.id, size: body.byteLength, key: `photos/${name}` })
    }

    const collected: string[] = []
    let cursor: string | undefined = undefined
    for (let page = 0; page < 5; page++) {
      const result: { objects: Array<{ key: string }>; nextCursor?: string; hasMore?: boolean } = await host.request('object.list', {
        sourceId: 'source-1', prefix: 'photos', limit: 1, cursor,
      })
      collected.push(...result.objects.map(object => object.key))
      cursor = result.nextCursor
      if (!result.hasMore) break
    }
    assert.deepEqual(collected.sort(), ['photos/B.jpg', 'photos/a.jpg', 'photos/c.jpg'])
  } finally {
    running.close()
    host.close()
    await fakeWebdav.close()
  }
})
