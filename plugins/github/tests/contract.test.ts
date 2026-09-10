import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { createFakeHost, createStoragePlugin } from '@mo-gallery/desktop-plugin-sdk'
import { createGitHubPlugin } from '../src/plugin.js'

interface StoredObject {
  body: Buffer
  contentType?: string
}

interface FakeGitHub {
  baseUrl: string
  objects: Map<string, StoredObject>
  commits: string[]
  close: () => Promise<void>
}

async function startFakeGitHub(options: { repoPermissionsPush?: boolean; unauthorized?: boolean } = {}): Promise<FakeGitHub> {
  const objects = new Map<string, StoredObject>()
  const commits: string[] = []
  const server = createServer((request, response) => {
    handleGitHubRequest(request, response, objects, commits, options).catch(error => {
      response.writeHead(500).end(String(error))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fake GitHub did not bind to a TCP port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    objects,
    commits,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

async function handleGitHubRequest(
  request: IncomingMessage,
  response: ServerResponse,
  objects: Map<string, StoredObject>,
  commits: string[],
  options: { repoPermissionsPush?: boolean; unauthorized?: boolean },
) {
  const url = new URL(request.url || '/', `http://${request.headers.host}`)
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (parts[0] !== 'repos' || parts.length < 3) {
    response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'Not Found' }))
    return
  }
  const repo = `${parts[1]}/${parts[2]}`

  if (parts.length === 3 && request.method === 'GET') {
    if (options.unauthorized) {
      response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'Bad credentials' }))
      return
    }
    const body = { default_branch: 'main', permissions: { push: options.repoPermissionsPush ?? true } }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    return
  }

  if (parts[3] === 'git' && parts[4] === 'trees' && request.method === 'GET') {
    const tree = [...objects.entries()].map(([key, object]) =>
      ({ path: key, sha: blobSha(object.body), size: object.body.byteLength, type: 'blob' }),
    )
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ tree, truncated: false }))
    return
  }

  if (parts[3] === 'contents' && parts.length >= 4) {
    const key = parts.slice(4).join('/')
    const accept = String(request.headers.accept ?? '')

    if (request.method === 'GET') {
      const object = objects.get(key)
      if (object) {
        if (accept === 'application/vnd.github.raw') {
          response.writeHead(200, { 'content-type': object.contentType ?? 'application/octet-stream', 'content-length': object.body.byteLength })
          response.end(object.body)
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(contentEntry(key, object)))
        return
      }
      if (isDirectory(objects, key)) {
        const entries = directoryEntries(objects, key).map(entry =>
          objects.has(entry.path) ? contentEntry(entry.path, objects.get(entry.path)!) : { name: entry.name, path: entry.path, sha: 'dir', size: 0, type: 'dir' },
        )
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(entries))
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'Not Found' }))
      return
    }

    if (request.method === 'PUT') {
      const body = await readJsonBody(request)
      const content = typeof body.content === 'string' ? Buffer.from(body.content, 'base64') : Buffer.alloc(0)
      const object: StoredObject = { body: content, contentType: 'application/octet-stream' }
      objects.set(key, object)
      commits.push(`commit-${commits.length + 1}`)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ content: contentEntry(key, object), commit: { sha: commits[commits.length - 1] } }))
      return
    }

    if (request.method === 'DELETE') {
      if (!objects.has(key)) {
        response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'Not Found' }))
        return
      }
      await readJsonBody(request)
      objects.delete(key)
      commits.push(`commit-${commits.length + 1}`)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ commit: { sha: commits[commits.length - 1] } }))
      return
    }
  }

  response.writeHead(405).end()
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function contentEntry(key: string, object: StoredObject) {
  return { name: key.split('/').pop() ?? key, path: key, sha: blobSha(object.body), size: object.body.byteLength, type: 'file' }
}

function blobSha(body: Buffer): string {
  const header = Buffer.from(`blob ${body.byteLength}\0`, 'utf8')
  return createHash('sha1').update(header).update(body).digest('hex')
}

function isDirectory(objects: Map<string, StoredObject>, key: string): boolean {
  const prefix = key ? `${key}/` : ''
  for (const objectKey of objects.keys()) {
    if (objectKey.startsWith(prefix)) return true
  }
  return false
}

function directoryEntries(objects: Map<string, StoredObject>, key: string): Array<{ name: string; path: string }> {
  const prefix = key ? `${key}/` : ''
  const children = new Map<string, string>()
  for (const objectKey of objects.keys()) {
    if (!objectKey.startsWith(prefix)) continue
    const name = objectKey.slice(prefix.length).split('/')[0]
    if (!name) continue
    children.set(name, prefix ? `${prefix}${name}` : name)
  }
  return [...children.entries()].map(([name, path]) => ({ name, path }))
}

function pluginEnv(gitHub: FakeGitHub, config: Record<string, string>): Record<string, string> {
  return {
    MO_STORAGE_PLUGIN_CONFIG: JSON.stringify({ ...config, apiUrl: gitHub.baseUrl, rawUrl: gitHub.baseUrl }),
    MO_STORAGE_PLUGIN_CREDENTIAL_TOKEN: 'test-token',
  }
}

test('GitHub plugin completes the storage object contract against a fake provider', async () => {
  const gitHub = await startFakeGitHub()
  const host = createFakeHost()
  const running = createStoragePlugin(createGitHubPlugin(), {
    input: host.pluginInput,
    output: host.pluginOutput,
    env: pluginEnv(gitHub, { owner: 'mo', repo: 'gallery', branch: 'main' }),
  })

  try {
    const manifest = await host.request<{ capabilities: string[] }>('plugin.getManifest')
    assert.ok(manifest.capabilities.includes('object.get'))
    assert.deepEqual(await host.request('plugin.health', { sourceId: 'source-1' }), { status: 'ready' })
    assert.deepEqual(await host.request('source.validate', { sourceId: 'source-1', config: {} }), { valid: true })

    const body = new TextEncoder().encode('github plugin body')
    const uploadHandle = { id: 'upload-1', size: body.byteLength }
    host.setTransfer(uploadHandle, body)
    const uploaded = await host.request<{ key: string; size: number; urlType: string; url: string; version?: string }>('object.put', {
      sourceId: 'source-1', transferId: uploadHandle.id, size: body.byteLength,
      key: 'photos/original.jpg', contentType: 'image/jpeg', checksum: undefined,
      idempotencyKey: 'source-1:hash',
    })
    assert.equal(uploaded.key, 'photos/original.jpg')
    assert.equal(uploaded.size, body.byteLength)
    assert.equal(uploaded.urlType, 'public')
    assert.equal(uploaded.url, `${gitHub.baseUrl}/main/photos/original.jpg`)
    assert.match(uploaded.version ?? '', /^commit-1$/)
    assert.deepEqual(gitHub.objects.get('photos/original.jpg')?.body, Buffer.from(body))
    assert.equal(gitHub.commits.length, 1)

    // A replayed upload with the same idempotency key must not create a second commit.
    host.setTransfer(uploadHandle, body)
    const replay = await host.request<{ key: string }>('object.put', {
      sourceId: 'source-1', transferId: uploadHandle.id, size: body.byteLength,
      key: 'photos/original.jpg', contentType: 'image/jpeg',
      idempotencyKey: 'source-1:hash',
    })
    assert.equal(replay.key, 'photos/original.jpg')
    assert.equal(gitHub.commits.length, 1)

    const downloadedHandle = { id: 'download-1', size: 0 }
    host.setDownloadTransfer(downloadedHandle)
    const downloaded = await host.request<{ key: string; size: number }>('object.get', {
      sourceId: 'source-1', transferId: downloadedHandle.id, key: 'photos/original.jpg',
    })
    assert.equal(downloaded.key, 'photos/original.jpg')
    assert.equal(downloaded.size, body.byteLength)
    assert.deepEqual(host.readDownloadTransfer(downloadedHandle.id), body)

    const stat = await host.request<{ key: string; size: number; checksum?: string; contentType?: string }>('object.stat', {
      sourceId: 'source-1', key: 'photos/original.jpg',
    })
    assert.equal(stat.key, 'photos/original.jpg')
    assert.equal(stat.size, body.byteLength)
    assert.equal(stat.checksum, blobSha(Buffer.from(body)))

    const listed = await host.request<{ objects: Array<{ key: string }> }>('object.list', {
      sourceId: 'source-1', prefix: 'photos', limit: 100,
    })
    assert.deepEqual(listed.objects.map(object => object.key), ['photos/original.jpg'])

    const moved = await host.request<{ key: string; url: string }>('object.move', {
      sourceId: 'source-1', fromKey: 'photos/original.jpg', toKey: 'photos/moved.jpg',
    })
    assert.equal(moved.key, 'photos/moved.jpg')
    assert.equal(moved.url, `${gitHub.baseUrl}/main/photos/moved.jpg`)
    assert.equal(gitHub.objects.has('photos/original.jpg'), false)
    assert.equal(gitHub.objects.has('photos/moved.jpg'), true)
    assert.deepEqual(gitHub.objects.get('photos/moved.jpg')?.body, Buffer.from(body))

    const url = await host.request<{ url: string; urlType: string }>('object.getUrl', {
      sourceId: 'source-1', key: 'photos/moved.jpg',
    })
    assert.deepEqual(url, {
      key: 'photos/moved.jpg', size: 0, urlType: 'public',
      url: `${gitHub.baseUrl}/main/photos/moved.jpg`,
    })

    await host.request('object.delete', { sourceId: 'source-1', key: 'photos/moved.jpg' })
    assert.equal(gitHub.objects.has('photos/moved.jpg'), false)
  } finally {
    running.close()
    host.close()
    await gitHub.close()
  }
})

test('GitHub plugin resolves the default branch and applies basePath', async () => {
  const gitHub = await startFakeGitHub()
  const host = createFakeHost()
  const running = createStoragePlugin(createGitHubPlugin(), {
    input: host.pluginInput,
    output: host.pluginOutput,
    env: pluginEnv(gitHub, { owner: 'mo', repo: 'gallery', basePath: 'photos' }),
  })

  try {
    const body = new TextEncoder().encode('basePath body')
    const uploadHandle = { id: 'upload-1', size: body.byteLength }
    host.setTransfer(uploadHandle, body)
    const uploaded = await host.request<{ key: string }>('object.put', {
      sourceId: 'source-1', transferId: uploadHandle.id, size: body.byteLength,
      key: 'original.jpg', contentType: 'image/jpeg',
    })
    assert.equal(uploaded.key, 'photos/original.jpg')
    assert.equal(gitHub.objects.has('photos/original.jpg'), true)

    // The host strips basePath before calling stat/list, so the plugin must
    // re-apply it when talking to GitHub and return relative keys.
    const stat = await host.request<{ key: string; url: string }>('object.stat', {
      sourceId: 'source-1', key: 'original.jpg',
    })
    assert.equal(stat.key, 'original.jpg')
    assert.equal(stat.url, `${gitHub.baseUrl}/main/photos/original.jpg`)

    const listed = await host.request<{ objects: Array<{ key: string }> }>('object.list', {
      sourceId: 'source-1', prefix: '', limit: 100,
    })
    assert.deepEqual(listed.objects.map(object => object.key), ['original.jpg'])
  } finally {
    running.close()
    host.close()
    await gitHub.close()
  }
})

test('GitHub health reports degraded when the token cannot push', async () => {
  const gitHub = await startFakeGitHub({ repoPermissionsPush: false })
  const host = createFakeHost()
  const running = createStoragePlugin(createGitHubPlugin(), {
    input: host.pluginInput,
    output: host.pluginOutput,
    env: pluginEnv(gitHub, { owner: 'mo', repo: 'gallery', branch: 'main' }),
  })

  try {
    const health = await host.request<{ status: string }>('plugin.health', { sourceId: 'source-1' })
    assert.equal(health.status, 'degraded')
  } finally {
    running.close()
    host.close()
    await gitHub.close()
  }
})

test('GitHub health surfaces the provider HTTP status for bad credentials', async () => {
  const gitHub = await startFakeGitHub({ unauthorized: true })
  const host = createFakeHost()
  const running = createStoragePlugin(createGitHubPlugin(), {
    input: host.pluginInput,
    output: host.pluginOutput,
    env: pluginEnv(gitHub, { owner: 'mo', repo: 'gallery', branch: 'main' }),
  })

  try {
    await assert.rejects(
      host.request('plugin.health', { sourceId: 'source-1' }),
      (error: unknown) => error instanceof Error && /HTTP 401/.test(error.message),
    )
  } finally {
    running.close()
    host.close()
    await gitHub.close()
  }
})
