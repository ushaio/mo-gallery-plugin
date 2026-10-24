import { Readable } from 'node:stream'
import OSS from 'ali-oss'
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
} from '@mo-gallery/plugin-sdk'
import { manifest } from './manifest.js'

interface OssConfig {
  region: string
  bucket: string
  endpoint?: string
  basePath: string
  publicUrl?: string
  urlMode: 'public' | 'signed'
  signedUrlExpiresSeconds: number
}

interface CredentialValues {
  accessKeyId: string
  accessKeySecret: string
  stsToken?: string
}

const HEALTH_REQUEST_TIMEOUT_MS = 10_000
// The SDK reads timeout from the client, so the health check and the data
// operations each get their own client rather than sharing one socket budget.
const DATA_REQUEST_TIMEOUT_MS = 5 * 60_000

export function createOssPlugin(): StoragePlugin {
  return {
    manifest,
    async validate(request: ValidateRequest, context: PluginContext) {
      const config = readConfig(context)
      if (!request.sourceId || !config.bucket || !config.region) return { valid: false, error: 'region, bucket, and sourceId are required' }
      return { valid: true }
    },
    async health(_request: HealthRequest, context: PluginContext) {
      const config = readConfig(context)
      const client = createClient(config, readCredentials(context), HEALTH_REQUEST_TIMEOUT_MS)
      // getBucketInfo is a bucket-level read: it proves the endpoint, the region, and
      // the credentials without needing object permissions.
      await normalizeProviderErrorAsync(() => client.getBucketInfo(config.bucket), 'OSS health check failed')
      return { status: 'ready' }
    },
    async put(request: PutRequest, context: PluginContext) {
      const config = readConfig(context)
      const credentials = readCredentials(context)
      const client = createClient(config, credentials)
      const key = objectKey(config, request.key)
      const transfer = context.transfer.open({ id: request.transferId, size: request.size })
      // The published types mark meta and callback as required even though the SDK
      // skips both when they are absent, so the options object is narrowed here.
      const options: OSS.PutStreamOptions = {
        // Without contentLength the SDK falls back to chunked encoding, which OSS
        // rejects for object uploads.
        contentLength: request.size,
        timeout: DATA_REQUEST_TIMEOUT_MS,
        mime: request.contentType || 'application/octet-stream',
        meta: {},
      } as unknown as OSS.PutStreamOptions
      if (request.idempotencyKey) {
        options.headers = { 'x-oss-meta-mo-idempotency-key': request.idempotencyKey }
      }
      // A streamed body cannot be replayed, so an upload is never retried.
      const response = await normalizeProviderErrorAsync(
        () => client.putStream(key, Readable.from(transfer.stream({ signal: undefined })), options),
        'OSS upload failed',
      )
      const url = await resolveUrl(config, credentials, key)
      return {
        key,
        url: url.url,
        urlType: url.urlType,
        expiresAt: url.expiresAt,
        size: request.size,
        contentType: request.contentType,
        checksum: stripQuotes(responseHeaders(response.res)?.etag) ?? request.checksum,
        version: stripQuotes(headerString(responseHeaders(response.res)?.['x-oss-version-id'])),
      }
    },
    async get(request: GetRequest, context: PluginContext) {
      const config = readConfig(context)
      const client = createClient(config, readCredentials(context))
      const key = objectKey(config, request.key)
      const response = await normalizeProviderErrorAsync(() => client.getStream(key), 'OSS download failed')
      if (!response.stream) throw new PluginError('provider_error', 'OSS returned no object body')
      const writer = context.transferWriter.open({ id: request.transferId, size: 0 })
      let offset = 0
      try {
        for await (const chunk of response.stream as AsyncIterable<Uint8Array | string>) {
          const data = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
          if (data.byteLength === 0) continue
          const result = await writer.write(offset, data)
          offset = result.next
        }
      } catch (error) {
        throw normalizeProviderError(error, 'OSS download failed')
      }
      const headers = responseHeaders(response.res)
      return objectInfo(config, key, offset, headers?.['content-type'], stripQuotes(headers?.etag))
    },
    async stat(request: StatRequest, context: PluginContext) {
      const config = readConfig(context)
      const client = createClient(config, readCredentials(context))
      const key = objectKey(config, request.key)
      const response = await normalizeProviderErrorAsync(() => client.head(key), 'OSS stat failed')
      const headers = responseHeaders(response.res)
      return objectInfo(config, key, toNumber(headers?.['content-length']), headers?.['content-type'], stripQuotes(headers?.etag))
    },
    async list(request: ListRequest, context: PluginContext): Promise<ListResult> {
      const config = readConfig(context)
      const client = createClient(config, readCredentials(context))
      const prefix = objectPrefix(config, request.prefix ?? '').replace(/\/$/, '')
      const query: Record<string, unknown> = { 'max-keys': clampLimit(request.limit) ?? 1000 }
      if (prefix) query.prefix = prefix
      if (request.cursor) query['continuation-token'] = request.cursor
      const response = await normalizeProviderErrorAsync(
        () => client.listV2(query as unknown as OSS.ListV2ObjectsQuery),
        'OSS list failed',
      )
      const objects = response.objects ?? []
      return {
        objects: objects.map(item => objectInfo(config, item.name, toNumber(item.size), item.type, stripQuotes(item.etag))),
        nextCursor: response.isTruncated ? response.nextContinuationToken || undefined : undefined,
        hasMore: Boolean(response.isTruncated),
      }
    },
    async move(request: MoveRequest, context: PluginContext) {
      const config = readConfig(context)
      const client = createClient(config, readCredentials(context))
      const fromKey = objectKey(config, request.fromKey)
      const toKey = objectKey(config, request.toKey)
      await normalizeProviderErrorAsync(() => client.copy(toKey, fromKey), 'OSS copy failed')
      await normalizeProviderErrorAsync(() => client.delete(fromKey), 'OSS delete failed')
      return objectInfo(config, toKey, 0)
    },
    async delete(request: DeleteRequest, context: PluginContext) {
      const config = readConfig(context)
      const client = createClient(config, readCredentials(context))
      await normalizeProviderErrorAsync(() => client.delete(objectKey(config, request.key)), 'OSS delete failed')
    },
    async getUrl(request: UrlRequest, context: PluginContext) {
      const config = readConfig(context)
      const key = objectKey(config, request.key)
      const resolved = resolveUrlSync(config, readCredentials(context), key)
      return { key, size: 0, url: resolved.url, urlType: resolved.urlType, expiresAt: resolved.expiresAt }
    },
  }
}

function readConfig(context: PluginContext): OssConfig {
  const value = context.config
  const region = value.region?.trim()
  const bucket = value.bucket?.trim()
  if (!bucket) throw new PluginError('invalid_config', 'OSS bucket is required')
  if (!region) throw new PluginError('invalid_config', 'OSS region is required')
  const urlMode = value.urlMode === 'signed' || value.urlMode === 'temporary' ? 'signed' : 'public'
  const expires = Number.parseInt(value.signedUrlExpiresSeconds || '900', 10)
  return {
    region,
    bucket,
    endpoint: value.endpoint?.trim() || undefined,
    basePath: cleanPrefix(value.basePath || ''),
    publicUrl: value.publicUrl?.trim() || undefined,
    urlMode,
    signedUrlExpiresSeconds: Number.isFinite(expires) ? Math.min(Math.max(expires, 60), 86400) : 900,
  }
}

function readCredentials(context: PluginContext): CredentialValues {
  return {
    accessKeyId: context.credentials.require('accessKeyId'),
    accessKeySecret: context.credentials.require('accessKeySecret'),
    stsToken: context.credentials.get('stsToken'),
  }
}

function createClient(config: OssConfig, credentials: CredentialValues, timeoutMs = DATA_REQUEST_TIMEOUT_MS): OSS {
  const options: OSS.Options = {
    accessKeyId: credentials.accessKeyId,
    accessKeySecret: credentials.accessKeySecret,
    stsToken: credentials.stsToken,
    bucket: config.bucket,
    region: config.region,
    timeout: timeoutMs,
  }
  const endpoint = parseEndpoint(config.endpoint)
  if (endpoint) {
    // A custom endpoint is addressed as-is, so the bucket must not be prefixed onto
    // the host. That is what cname does in the SDK.
    // The SDK parses the endpoint with url.parse, which reads a bare host:port as a
    // protocol, so the scheme has to be included here.
    options.endpoint = endpoint.url
    options.secure = endpoint.secure
    options.cname = true
  }
  return new OSS(options)
}

function parseEndpoint(endpoint: string | undefined): { url: string; host: string; secure: boolean } | undefined {
  if (!endpoint) return undefined
  const withScheme = /^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`
  const url = new URL(withScheme)
  if (!url.host) return undefined
  return { url: `${url.protocol}//${url.host}`, host: url.host, secure: url.protocol !== 'http:' }
}

function resolveUrlSync(config: OssConfig, credentials: CredentialValues, key: string): { url: string; urlType: 'public' | 'temporary'; expiresAt?: string } {
  if (config.urlMode !== 'signed') return { url: publicObjectUrl(config, key), urlType: 'public' }
  const client = createClient(config, credentials)
  // signatureUrl is synchronous because it only signs locally; no request is made.
  const url = client.signatureUrl(key, { expires: config.signedUrlExpiresSeconds })
  return { url, urlType: 'temporary', expiresAt: new Date(Date.now() + config.signedUrlExpiresSeconds * 1000).toISOString() }
}

function resolveUrl(config: OssConfig, credentials: CredentialValues, key: string) {
  return Promise.resolve(resolveUrlSync(config, credentials, key))
}

function objectKey(config: OssConfig, key: string): string {
  const clean = cleanPrefix(key)
  if (!clean) throw new PluginError('invalid_object_key', 'object key is required')
  return config.basePath ? `${config.basePath}/${clean}` : clean
}

function objectPrefix(config: OssConfig, prefix: string): string {
  const clean = cleanPrefix(prefix)
  if (!clean) return config.basePath
  return config.basePath ? `${config.basePath}/${clean}` : clean
}

function cleanPrefix(value: string): string {
  const clean = value.trim().replaceAll('\\', '/')
  if (!clean || clean === '.') return ''
  if (clean.startsWith('/') || clean.split('/').some(part => part === '..' || part === '.')) throw new PluginError('invalid_object_key', 'object key cannot escape its prefix')
  return clean.replace(/^\/+|\/+$/g, '')
}

function objectInfo(config: OssConfig, key: string, size: number, contentType?: string, checksum?: string): ObjectInfo {
  const relativeKey = config.basePath && key.startsWith(`${config.basePath}/`) ? key.slice(config.basePath.length + 1) : key
  return { key: relativeKey, size, contentType, checksum, urlType: 'public', url: publicObjectUrl(config, key) }
}

function publicObjectUrl(config: OssConfig, key: string): string {
  return `${objectHostBase(config)}/${encodeKey(key)}`
}

function objectHostBase(config: OssConfig): string {
  const base = config.publicUrl?.replace(/\/+$/, '')
  if (base) return base
  const endpoint = parseEndpoint(config.endpoint)
  if (endpoint) return `${endpoint.secure ? 'https:' : 'http:'}//${endpoint.host}`
  return `https://${config.bucket}.${config.region}.aliyuncs.com`
}

function encodeKey(value: string): string {
  return value.split('/').map(part => encodeURIComponent(part)).join('/')
}

function headerString(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : undefined
  if (value === undefined || value === null) return undefined
  return String(value)
}

// NormalSuccessResponse types headers as a bare object, so header lookups need an
// explicit narrowing before any key can be read.
function responseHeaders(response: { headers?: unknown } | undefined): Record<string, string | undefined> | undefined {
  const headers = response?.headers
  if (!headers || typeof headers !== 'object') return undefined
  return headers as Record<string, string | undefined>
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function stripQuotes(value: string | undefined): string | undefined {
  return value?.replaceAll('"', '')
}

function clampLimit(value: number | undefined): number | undefined {
  if (!value) return undefined
  return Math.min(Math.max(Math.trunc(value), 1), 1000)
}

async function normalizeProviderErrorAsync<T>(operation: () => Promise<T>, action: string): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw normalizeProviderError(error, action)
  }
}

// ali-oss reports the provider status on err.status, which is negative for network
// and timeout failures and can be undefined for a response timeout. Rebuild an
// actionable message so the host never shows a bare 'UnknownError'.
function normalizeProviderError(error: unknown, action: string): PluginError {
  if (error instanceof PluginError) return error
  const candidate = error as { status?: number; statusCode?: number; code?: string; name?: string; message?: string }
  const rawStatus = typeof candidate?.status === 'number' ? candidate.status : candidate?.statusCode
  const details: string[] = []
  if (typeof rawStatus === 'number' && rawStatus > 0) details.push(`HTTP ${rawStatus}`)
  const code = typeof candidate?.code === 'string' && candidate.code !== 'UnknownError' ? candidate.code : undefined
  if (code && code !== String(rawStatus)) details.push(code)
  const name = typeof candidate?.name === 'string' && candidate.name !== 'Error' && candidate.name !== 'UnknownError' ? candidate.name : undefined
  if (name && name !== code) details.push(name)
  const message = typeof candidate?.message === 'string' && candidate.message.trim() && candidate.message !== 'UnknownError' ? candidate.message : undefined
  if (message && !details.includes(message)) details.push(message)
  const suffix = details.length > 0 ? ` (${details.join(' - ')})` : ''
  return new PluginError('provider_error', `${action}${suffix}`)
}
