import { Readable, Transform } from 'node:stream'
import { createHash } from 'node:crypto'
import {
  PluginError,
  type HealthRequest,
  type GetRequest,
  type ListRequest,
  type ListResult,
  type MoveRequest,
  type ObjectInfo,
  type PluginContext,
  type PutRequest,
  type DeleteRequest,
  type StatRequest,
  type StoragePlugin,
  type UrlRequest,
  type ValidateRequest,
} from '@mo-gallery/desktop-plugin-sdk'
import { manifest } from './manifest.js'
import { webdavPropfind, webdavRequest, WebdavHttpError, decodeHrefSafe, type WebdavResource } from './webdav.js'

interface WebdavConfig {
  url: string
  basePath: string
  publicUrl?: string
}

const HEALTH_REQUEST_TIMEOUT_MS = 10_000
// Slow self-hosted servers (fnOS over LAN, 坚果云 free tier) can keep a body
// stream open for minutes; only the health/validate probes use the short
// timeout so a progressing transfer is never cut off mid-flight.
const DATA_REQUEST_TIMEOUT_MS = 5 * 60_000

export function createWebdavPlugin(): StoragePlugin {
  return {
    manifest,
    async validate(request: ValidateRequest, context: PluginContext) {
      const config = readConfig(context)
      if (!request.sourceId || !config.url) return { valid: false, error: 'url and sourceId are required' }
      const auth = authHeader(context)
      try {
        await webdavPropfind(config.url, auth, 0, HEALTH_REQUEST_TIMEOUT_MS)
        return { valid: true }
      } catch (error) {
        return { valid: false, error: validateError(error) }
      }
    },
    async health(_request: HealthRequest, context: PluginContext) {
      const config = readConfig(context)
      const auth = authHeader(context)
      try {
        await webdavPropfind(config.url, auth, 0, HEALTH_REQUEST_TIMEOUT_MS)
      } catch (error) {
        throw normalizeWebdavError(error, 'WebDAV health check failed')
      }
      return { status: 'ready' }
    },
    async put(request: PutRequest, context: PluginContext) {
      const config = readConfig(context)
      const auth = authHeader(context)
      const key = objectKey(request.key)
      // Many WebDAV servers (Apache mod_dav, nginx dav_module, Sabre/DAV) fail
      // a PUT with 409 when the parent collection does not exist yet.
      const parent = parentDirectory(key)
      if (parent) await ensureCollections(config, auth, parent)
      const url = objectUrl(config, key)
      const transfer = context.transfer.open({ id: request.transferId, size: request.size })
      const body = Readable.from(transfer.stream())
      const { etag, checksum } = await streamPut(url, auth, body, request)
      return {
        key,
        url: publicObjectUrl(config, key),
        urlType: urlTypeFor(config),
        size: request.size,
        contentType: request.contentType,
        checksum: etag || checksum || request.checksum,
      }
    },
    async get(request: GetRequest, context: PluginContext) {
      const config = readConfig(context)
      const auth = authHeader(context)
      const key = objectKey(request.key)
      const response = await withRetry(() => webdavRequest({ method: 'GET', url: objectUrl(config, key), auth, timeoutMs: DATA_REQUEST_TIMEOUT_MS }), context)
      if (!response.body) throw new PluginError('provider_error', 'WebDAV object response did not contain a body')
      const writer = context.transferWriter.open({ id: request.transferId, size: 0 })
      let offset = 0
      let size = 0
      for await (const chunk of response.body) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (data.byteLength === 0) continue
        const result = await writer.write(offset, data)
        offset = result.next
        size += data.byteLength
      }
      const declared = Number.parseInt(String(response.headers['content-length'] ?? ''), 10)
      return {
        key,
        size: Number.isFinite(declared) ? declared : size,
        contentType: headerValue(response.headers['content-type']),
        checksum: stripEtag(response.headers.etag),
        url: publicObjectUrl(config, key),
        urlType: urlTypeFor(config),
      }
    },
    async stat(request: StatRequest, context: PluginContext) {
      const config = readConfig(context)
      const auth = authHeader(context)
      const key = objectKey(request.key)
      const resource = await statResource(config, auth, key)
      return objectInfo(config, resource, key)
    },
    async list(request: ListRequest, context: PluginContext): Promise<ListResult> {
      const config = readConfig(context)
      const auth = authHeader(context)
      const prefix = cleanPrefix(request.prefix ?? '')
      const entries = await listEntries(config, auth, prefix, context)
      const limit = clampLimit(request.limit) ?? 1000
      // Code-unit ordering is used for both the cursor filter and the sort so
      // paginated walks never skip or repeat keys (localeCompare orders
      // differently and would diverge from the > cursor comparison).
      const filtered = entries
        .filter(entry => entry.key.startsWith(prefix))
        .filter(entry => request.cursor ? entry.key > request.cursor : true)
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      const page = filtered.slice(0, limit)
      return {
        objects: page.map(entry => ({ key: entry.key, size: entry.resource.size, contentType: entry.resource.contentType, checksum: entry.resource.etag, urlType: urlTypeFor(config), url: publicObjectUrl(config, entry.key) })),
        nextCursor: filtered.length > page.length ? page[page.length - 1].key : undefined,
        hasMore: filtered.length > page.length,
      }
    },
    async move(request: MoveRequest, context: PluginContext) {
      const config = readConfig(context)
      const auth = authHeader(context)
      const fromKey = objectKey(request.fromKey)
      const toKey = objectKey(request.toKey)
      const toParent = parentDirectory(toKey)
      if (toParent) await ensureCollections(config, auth, toParent)
      const base = new URL(config.url)
      const destination = `${base.origin}${base.pathname.replace(/\/+$/, '')}/${encodeKey(toKey)}`
      const response = await withRetry(() => webdavRequest({
        method: 'MOVE',
        url: objectUrl(config, fromKey),
        auth,
        headers: { destination },
        timeoutMs: DATA_REQUEST_TIMEOUT_MS,
      }), context)
      const resource = await statResource(config, auth, toKey)
      return objectInfo(config, resource, toKey, { version: stripEtag(response.headers.etag) })
    },
    async delete(request: DeleteRequest, context: PluginContext) {
      const config = readConfig(context)
      const auth = authHeader(context)
      await withRetry(() => webdavRequest({
        method: 'DELETE',
        url: objectUrl(config, request.key),
        auth,
        timeoutMs: DATA_REQUEST_TIMEOUT_MS,
      }), context)
    },
    async getUrl(request: UrlRequest, context: PluginContext) {
      const config = readConfig(context)
      const key = objectKey(request.key)
      return { key, size: 0, url: publicObjectUrl(config, key), urlType: urlTypeFor(config) }
    },
  }
}

function readConfig(context: PluginContext): WebdavConfig {
  const value = context.config
  const url = value.url?.trim().replace(/\/+$/, '')
  if (!url) throw new PluginError('invalid_config', 'WebDAV url is required')
  try {
    new URL(url)
  } catch {
    throw new PluginError('invalid_config', 'WebDAV url is not a valid URL')
  }
  return {
    url,
    // The desktop host resolves basePath into object keys and blanks the
    // config value before spawning this plugin; keep accepting it only for
    // standalone/contract-test runs and never re-prepend it to keys.
    basePath: cleanPrefix(value.basePath || ''),
    publicUrl: value.publicUrl?.trim().replace(/\/+$/, '') || undefined,
  }
}

function authHeader(context: PluginContext): string {
  const username = context.credentials.get('username')
  const password = context.credentials.get('password')
  if (!username && !password) return ''
  const token = Buffer.from(`${username ?? ''}:${password ?? ''}`, 'utf8').toString('base64')
  return `Basic ${token}`
}

interface ListEntry {
  key: string
  resource: WebdavResource
}

// WebDAV has no server-side prefix listing: Depth:1 PROPFIND on a collection
// returns its direct children. When the prefix names a collection we list that
// collection; when it names an object (or a partial name) the PROPFIND 404s
// and we fall back to the parent directory, filtering names by the last
// segment to approximate S3 prefix semantics.
async function listEntries(config: WebdavConfig, auth: string, prefix: string, context: PluginContext): Promise<ListEntry[]> {
  try {
    const resources = await withRetry(() => webdavPropfind(collectionUrl(config, prefix), auth, 1, DATA_REQUEST_TIMEOUT_MS), context)
    return resourcesToEntries(config, resources, prefix)
  } catch (error) {
    if (!(error instanceof WebdavHttpError) || error.status !== 404) throw error
    const parent = parentDirectory(prefix)
    const lastSegment = prefix.slice(parent ? parent.length + 1 : 0)
    const resources = await withRetry(() => webdavPropfind(collectionUrl(config, parent), auth, 1, DATA_REQUEST_TIMEOUT_MS), context)
    return resourcesToEntries(config, resources, parent)
      .filter(entry => entry.key.startsWith(prefix) && (lastSegment === '' || entry.key !== prefix))
  }
}

function resourcesToEntries(config: WebdavConfig, resources: WebdavResource[], directory: string): ListEntry[] {
  const rootHref = collectionRootHref(config, directory)
  const entries: ListEntry[] = []
  for (const resource of resources) {
    if (resource.isCollection) continue
    const name = hrefToRelativeName(resource.href, rootHref)
    if (!name) continue
    const key = directory ? `${directory}/${name}` : name
    // Keys the host already prefixed with basePath must not re-carry it.
    const relativeKey = config.basePath && key.startsWith(`${config.basePath}/`) ? key.slice(config.basePath.length + 1) : key
    entries.push({ key: relativeKey, resource })
  }
  return entries
}

function collectionRootHref(config: WebdavConfig, directory: string): string {
  const pathname = new URL(config.url).pathname.replace(/\/+$/, '')
  return trimSlashes(`${pathname}/${directory}`)
}

// Server hrefs can be absolute paths ("/dav/photos/x.jpg"), absolute URLs
// ("http://host/dav/photos/x.jpg"), or percent-encoded; normalize to a name
// relative to the listed collection. Returns null for hrefs outside the root.
function hrefToRelativeName(href: string, rootHref: string): string | null {
  let path = href
  const schemeIndex = path.indexOf('://')
  if (schemeIndex >= 0) path = path.slice(path.indexOf('/', schemeIndex + 3))
  path = decodeHrefSafe(path)
  const trimmed = trimSlashes(path)
  const trimmedRoot = trimSlashes(rootHref)
  if (!trimmed) return null
  if (!trimmedRoot) return trimmed
  if (trimmed === trimmedRoot) return null
  if (trimmed.startsWith(`${trimmedRoot}/`)) return trimmed.slice(trimmedRoot.length + 1)
  return null
}

const knownCollections = new Set<string>()

async function ensureCollections(config: WebdavConfig, auth: string, directory: string): Promise<void> {
  let current = ''
  for (const segment of directory.split('/')) {
    current = current ? `${current}/${segment}` : segment
    const cacheKey = `${config.url}/${current}`
    if (knownCollections.has(cacheKey)) continue
    try {
      await webdavRequest({ method: 'MKCOL', url: `${config.url}/${encodeKey(current)}`, auth, timeoutMs: DATA_REQUEST_TIMEOUT_MS })
    } catch (error) {
      // 405 means the collection already exists; a few servers answer 200/301.
      if (error instanceof WebdavHttpError && [200, 301, 405].includes(error.status)) {
        knownCollections.add(cacheKey)
        continue
      }
      throw normalizeWebdavError(error, `WebDAV MKCOL failed for ${current}`)
    }
    knownCollections.add(cacheKey)
  }
}

async function streamPut(url: string, auth: string, body: Readable, request: PutRequest): Promise<{ etag?: string; checksum?: string }> {
  // A PUT that fails after body bytes hit the wire cannot be retried safely
  // (a retry would resend a partially-drained stream), so it runs without retry.
  const hash = /^[a-f0-9]{64}$/i.test(request.checksum ?? '') ? createHash('sha256') : undefined
  // Hash through a Transform so backpressure from the socket still applies —
  // buffering the whole body would defeat the streaming transfer design.
  const stream = hash
    ? body.pipe(new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk)
          callback(null, chunk)
        },
      }))
    : body
  const response = await webdavRequest({
    method: 'PUT',
    url,
    auth,
    headers: { 'content-type': request.contentType },
    bodyStream: stream,
    timeoutMs: DATA_REQUEST_TIMEOUT_MS,
  })
  response.body?.resume()
  return { etag: stripEtag(response.headers.etag), checksum: hash?.digest('hex') }
}

async function statResource(config: WebdavConfig, auth: string, key: string): Promise<WebdavResource> {
  try {
    const resources = await webdavPropfind(objectUrl(config, key), auth, 0, DATA_REQUEST_TIMEOUT_MS)
    const resource = resources.find(candidate => !candidate.isCollection)
      ?? resources[0]
    if (!resource) throw new PluginError('provider_error', `WebDAV stat returned no resources for ${key}`)
    return resource
  } catch (error) {
    throw normalizeWebdavError(error, `WebDAV stat failed for ${key}`)
  }
}

function objectInfo(config: WebdavConfig, resource: WebdavResource, key: string, extra?: { version?: string }): ObjectInfo {
  return {
    key,
    url: publicObjectUrl(config, key),
    urlType: urlTypeFor(config),
    size: resource.size,
    contentType: resource.contentType,
    checksum: resource.etag,
    version: extra?.version,
  }
}

function objectUrl(config: WebdavConfig, key: string): string {
  return `${config.url}/${encodeKey(key)}`
}

function collectionUrl(config: WebdavConfig, prefix: string): string {
  const clean = cleanPrefix(prefix)
  return clean ? `${config.url}/${encodeKey(clean)}/` : `${config.url}/`
}

function publicObjectUrl(config: WebdavConfig, key: string): string {
  return config.publicUrl ? `${config.publicUrl}/${encodeKey(key)}` : `${config.url}/${encodeKey(key)}`
}

// WebDAV object URLs never expire — they are stable public addresses in the
// host's sense. Browsers may still need Basic Auth credentials to fetch one
// unless a publicUrl prefix is configured, but that does not make the URL
// temporary or signed.
function urlTypeFor(_config: WebdavConfig): ObjectInfo['urlType'] {
  return 'public'
}

function objectKey(key: string): string {
  const clean = cleanPrefix(key)
  if (!clean) throw new PluginError('invalid_object_key', 'object key is required')
  return clean
}

function parentDirectory(prefix: string): string {
  const index = prefix.lastIndexOf('/')
  return index >= 0 ? prefix.slice(0, index) : ''
}

function cleanPrefix(value: string): string {
  const clean = value.trim().replaceAll('\\', '/')
  if (!clean || clean === '.') return ''
  if (clean.startsWith('/') || clean.split('/').some(part => part === '..' || part === '.')) throw new PluginError('invalid_object_key', 'object key cannot escape its prefix')
  return clean.replace(/^\/+|\/+$/g, '')
}

function encodeKey(value: string): string {
  return value.split('/').map(part => encodeURIComponent(part)).join('/')
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '')
}

function stripEtag(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string' || !raw) return undefined
  return raw.replace(/^W\//, '').replace(/^"|"$/g, '').trim() || undefined
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function validateError(error: unknown): string {
  if (error instanceof WebdavHttpError) {
    if (error.status === 401 || error.status === 403) return '认证失败：请检查用户名和密码'
    if (error.status === 404) return 'WebDAV 地址不存在（404）'
    return `WebDAV 服务器返回 HTTP ${error.status}`
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/timed out|timeout/i.test(message)) return `连接超时：${message}`
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return '域名无法解析，请检查地址'
  if (/ECONNREFUSED/i.test(message)) return '连接被拒绝，请检查地址和端口'
  return message
}

function clampLimit(value: number | undefined): number | undefined {
  if (!value) return undefined
  return Math.min(Math.max(Math.trunc(value), 1), 1000)
}

async function withRetry<T>(operation: () => Promise<T>, context: PluginContext): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isRetryable(error) || attempt === 2) break
      const delay = 250 * 2 ** attempt
      context.log.warn('Retrying WebDAV request', { attempt: attempt + 1, delayMs: delay })
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw normalizeWebdavError(lastError, 'WebDAV request failed')
}

function normalizeWebdavError(error: unknown, action: string): PluginError {
  if (error instanceof PluginError) return error
  if (error instanceof WebdavHttpError) {
    return new PluginError('provider_error', `${action} (HTTP ${error.status})`)
  }
  const message = error instanceof Error ? error.message : String(error)
  return new PluginError('provider_error', `${action} (${message})`)
}

function isRetryable(error: unknown): boolean {
  if (error instanceof WebdavHttpError) return error.status >= 500
  if (error instanceof Error) return /timed out|timeout|ECONNRESET|ECONNREFUSED|EPIPE/i.test(error.message)
  return false
}
