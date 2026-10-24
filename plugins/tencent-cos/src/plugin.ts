import { Readable } from 'node:stream'
import COS from 'cos-nodejs-sdk-v5'
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

interface CosConfig {
  region: string
  bucket: string
  endpoint?: string
  basePath: string
  publicUrl?: string
  urlMode: 'public' | 'signed'
  signedUrlExpiresSeconds: number
}

interface CredentialValues {
  secretId: string
  secretKey: string
  sessionToken?: string
}

const HEALTH_REQUEST_TIMEOUT_MS = 10_000
// COS applies its Timeout option to every request issued by a client instance and
// offers no per-request override. Uploads and downloads of large originals can
// keep a socket busy for minutes, so data operations get a much longer socket-idle
// budget than the health check.
const DATA_REQUEST_TIMEOUT_MS = 5 * 60_000

export function createCosPlugin(): StoragePlugin {
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
      // The SDK retries a stalled request four times and offers no per-request way
      // to turn that off, so a socket timeout alone would let an unreachable
      // endpoint hold the Test connection button for four times the budget. The
      // deadline caps the whole check instead.
      await withDeadline(
        () => normalizeProviderErrorAsync(() => client.headBucket({ Bucket: config.bucket, Region: config.region }), 'COS health check failed'),
        HEALTH_REQUEST_TIMEOUT_MS,
        'COS health check',
      )
      return { status: 'ready' }
    },
    async put(request: PutRequest, context: PluginContext) {
      const config = readConfig(context)
      const credentials = readCredentials(context)
      const client = createClient(config, credentials)
      const key = objectKey(config, request.key)
      const transfer = context.transfer.open({ id: request.transferId, size: request.size })
      const params: Record<string, unknown> = {
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
        // The host hands out an async generator, but COS only accepts a Buffer,
        // string, or piping stream and rejects anything else with
        // 'params Body format error'.
        Body: Readable.from(transfer.stream({ signal: undefined })),
        // ContentLength is mandatory for a streaming body. Without it the SDK sends
        // chunked transfer encoding, which COS rejects for object uploads.
        ContentLength: request.size,
      }
      if (request.contentType) params.ContentType = request.contentType
      if (request.idempotencyKey) params['x-cos-meta-mo-idempotency-key'] = request.idempotencyKey
      // A streamed body cannot be replayed, so an upload is never retried.
      const response = await normalizeProviderErrorAsync(
        () => client.putObject(params as unknown as COS.PutObjectParams),
        'COS upload failed',
      )
      const url = await resolveUrl(config, credentials, key)
      return {
        key,
        url: url.url,
        urlType: url.urlType,
        expiresAt: url.expiresAt,
        size: request.size,
        contentType: request.contentType,
        checksum: request.checksum,
        version: response.VersionId,
      }
    },
    async get(request: GetRequest, context: PluginContext) {
      const config = readConfig(context)
      const client = createClient(config, readCredentials(context))
      const key = objectKey(config, request.key)
      const stream = client.getObjectStream({ Bucket: config.bucket, Region: config.region, Key: key }) as unknown as NodeJS.ReadableStream & AsyncIterable<Uint8Array>
      // The SDK reports a provider failure by emitting 'error' on the returned
      // PassThrough *and* invoking its callback. Without a listener, Node treats the
      // emit as an unhandled 'error' event and terminates the plugin process.
      let streamError: unknown
      stream.once('error', (error: unknown) => { streamError = error })
      const writer = context.transferWriter.open({ id: request.transferId, size: 0 })
      let offset = 0
      try {
        for await (const chunk of stream) {
          const data = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array)
          if (data.byteLength === 0) continue
          const result = await writer.write(offset, data)
          offset = result.next
        }
      } catch (error) {
        throw normalizeProviderError(streamError ?? error, 'COS download failed')
      }
      if (streamError) throw normalizeProviderError(streamError, 'COS download failed')
      return objectInfo(config, key, offset)
    },
    async stat(request: StatRequest, context: PluginContext) {
      const config = readConfig(context)
      const client = createClient(config, readCredentials(context))
      const key = objectKey(config, request.key)
      const response = await normalizeProviderErrorAsync(
        () => client.headObject({ Bucket: config.bucket, Region: config.region, Key: key }),
        'COS stat failed',
      )
      const headers = (response.headers ?? {}) as Record<string, string>
      return objectInfo(config, key, toNumber(headers['content-length']), headers['content-type'], stripQuotes(response.ETag))
    },
    async list(request: ListRequest, context: PluginContext): Promise<ListResult> {
      const config = readConfig(context)
      const client = createClient(config, readCredentials(context))
      const prefix = objectPrefix(config, request.prefix ?? '').replace(/\/$/, '')
      const params: Record<string, unknown> = {
        Bucket: config.bucket,
        Region: config.region,
        MaxKeys: String(clampLimit(request.limit) ?? 1000),
      }
      if (prefix) params.Prefix = prefix
      if (request.cursor) params.Marker = request.cursor
      const response = await normalizeProviderErrorAsync(
        () => client.getBucket(params as unknown as COS.GetBucketParams),
        'COS list failed',
      )
      const contents = response.Contents ?? []
      const hasMore = String(response.IsTruncated) === 'true'
      // A v1 bucket listing only returns NextMarker when a delimiter is supplied;
      // without one, the next page has to start after the last returned key.
      const nextCursor = hasMore ? response.NextMarker || contents[contents.length - 1]?.Key : undefined
      return {
        objects: contents.map(item => objectInfo(config, item.Key ?? '', toNumber(item.Size), undefined, stripQuotes(item.ETag))),
        nextCursor: nextCursor || undefined,
        hasMore,
      }
    },
    async move(request: MoveRequest, context: PluginContext) {
      const config = readConfig(context)
      const client = createClient(config, readCredentials(context))
      const fromKey = objectKey(config, request.fromKey)
      const toKey = objectKey(config, request.toKey)
      await normalizeProviderErrorAsync(
        () => client.putObjectCopy({
          Bucket: config.bucket,
          Region: config.region,
          Key: toKey,
          CopySource: copySource(config, fromKey),
        }),
        'COS copy failed',
      )
      await normalizeProviderErrorAsync(
        () => client.deleteObject({ Bucket: config.bucket, Region: config.region, Key: fromKey }),
        'COS delete failed',
      )
      return objectInfo(config, toKey, 0)
    },
    async delete(request: DeleteRequest, context: PluginContext) {
      const config = readConfig(context)
      const client = createClient(config, readCredentials(context))
      // COS answers a missing object with BucketNotFound instead of an error, which
      // already matches the idempotent delete the host expects.
      await normalizeProviderErrorAsync(
        () => client.deleteObject({ Bucket: config.bucket, Region: config.region, Key: objectKey(config, request.key) }),
        'COS delete failed',
      )
    },
    async getUrl(request: UrlRequest, context: PluginContext) {
      const config = readConfig(context)
      const key = objectKey(config, request.key)
      const resolved = await resolveUrl(config, readCredentials(context), key)
      return { key, size: 0, url: resolved.url, urlType: resolved.urlType, expiresAt: resolved.expiresAt }
    },
  }
}

function readConfig(context: PluginContext): CosConfig {
  const value = context.config
  const region = value.region?.trim()
  const bucket = value.bucket?.trim()
  if (!bucket) throw new PluginError('invalid_config', 'COS bucket is required')
  if (!region) throw new PluginError('invalid_config', 'COS region is required')
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
    secretId: context.credentials.require('secretId'),
    secretKey: context.credentials.require('secretKey'),
    sessionToken: context.credentials.get('sessionToken'),
  }
}

function createClient(config: CosConfig, credentials: CredentialValues, timeoutMs = DATA_REQUEST_TIMEOUT_MS): COS {
  const options: COS.COSOptions = {
    SecretId: credentials.secretId,
    SecretKey: credentials.secretKey,
    SecurityToken: credentials.sessionToken,
    Timeout: timeoutMs,
    // PutObjectCopy needs the source split back into bucket/region/key, but the SDK
    // only recognizes standard myqcloud.com hosts. A custom Domain therefore has to
    // be resolved through this hook, or every copy fails with 'CopySource format error'.
    CopySourceParser: source => parseCopySource(config, source),
  }
  const endpoint = parseEndpoint(config.endpoint)
  if (endpoint) {
    options.Protocol = endpoint.protocol
    options.Domain = endpoint.domain
  }
  return new COS(options)
}

function parseEndpoint(endpoint: string | undefined): { protocol: 'http:' | 'https:'; domain: string } | undefined {
  if (!endpoint) return undefined
  const withScheme = /^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`
  const url = new URL(withScheme)
  if (!url.hostname) return undefined
  return { protocol: url.protocol === 'http:' ? 'http:' : 'https:', domain: url.host }
}

function parseCopySource(config: CosConfig, source: string): { Bucket: string; Region: string; Key: string } | null {
  const trimmed = source.replace(/^https?:\/\//i, '')
  const slash = trimmed.indexOf('/')
  if (slash <= 0) return null
  const encodedKey = trimmed.slice(slash + 1)
  if (!encodedKey) return null
  let key = encodedKey
  try {
    key = decodeURIComponent(encodedKey)
  } catch {
    // A malformed escape is left as-is so the provider reports the real failure.
  }
  // The configured endpoint already *is* the bucket's access domain, so the source
  // bucket is always this source's bucket rather than the leading host label.
  return { Bucket: config.bucket, Region: config.region, Key: key }
}

// PutObjectCopy requires an absolute source host. The value is re-parsed by
// CopySourceParser above, so a custom Domain configuration still resolves cleanly.
function copySource(config: CosConfig, key: string): string {
  const domain = parseEndpoint(config.endpoint)?.domain ?? `${config.bucket}.cos.${config.region}.myqcloud.com`
  return `${domain}/${encodeKey(key)}`
}

function objectKey(config: CosConfig, key: string): string {
  const clean = cleanPrefix(key)
  if (!clean) throw new PluginError('invalid_object_key', 'object key is required')
  return config.basePath ? `${config.basePath}/${clean}` : clean
}

function objectPrefix(config: CosConfig, prefix: string): string {
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

function objectInfo(config: CosConfig, key: string, size: number, contentType?: string, checksum?: string): ObjectInfo {
  const relativeKey = config.basePath && key.startsWith(`${config.basePath}/`) ? key.slice(config.basePath.length + 1) : key
  return { key: relativeKey, size, contentType, checksum, urlType: 'public', url: publicObjectUrl(config, key) }
}

async function resolveUrl(config: CosConfig, credentials: CredentialValues, key: string): Promise<{ url: string; urlType: 'public' | 'temporary'; expiresAt?: string }> {
  if (config.urlMode !== 'signed') return { url: publicObjectUrl(config, key), urlType: 'public' }
  const client = createClient(config, credentials)
  // getObjectUrl is a callback API and never returns a promise, so the signed URL
  // has to be captured through its callback and folded back into a promise.
  const url = await new Promise<string>((resolve, reject) => {
    client.getObjectUrl(
      { Bucket: config.bucket, Region: config.region, Key: key, Sign: true, Expires: config.signedUrlExpiresSeconds },
      (error, data) => {
        if (error) reject(normalizeProviderError(error, 'COS sign URL failed'))
        else if (!data?.Url) reject(new PluginError('provider_error', 'COS did not return a signed URL'))
        else resolve(data.Url)
      },
    )
  })
  return { url, urlType: 'temporary', expiresAt: new Date(Date.now() + config.signedUrlExpiresSeconds * 1000).toISOString() }
}

function publicObjectUrl(config: CosConfig, key: string): string {
  return `${objectHostBase(config)}/${encodeKey(key)}`
}

function objectHostBase(config: CosConfig): string {
  const base = config.publicUrl?.replace(/\/+$/, '')
  if (base) return base
  const endpoint = parseEndpoint(config.endpoint)
  if (endpoint) return `${endpoint.protocol}//${endpoint.domain}`
  return `https://${config.bucket}.cos.${config.region}.myqcloud.com`
}

function encodeKey(value: string): string {
  return value.split('/').map(part => encodeURIComponent(part)).join('/')
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

// Races an operation against a deadline. The timer is unref'd so a finished
// operation never keeps the plugin process alive, and the losing promise's
// rejection is swallowed so a late provider error cannot become unhandled.
async function withDeadline<T>(operation: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const pending = operation()
  // The race may settle on the deadline, after which this rejection has no
  // consumer. Attaching it to a no-op keeps Node from reporting it as unhandled.
  pending.catch(() => {})
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new PluginError('request_timeout', `${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref()
  })
  try {
    return await Promise.race([pending, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// COS puts the HTTP status directly on the error object, and a failure that could
// not be parsed into a body often leaves message empty. Rebuild an actionable
// message from status + code so the host can show what actually failed.
function normalizeProviderError(error: unknown, action: string): PluginError {
  if (error instanceof PluginError) return error
  const candidate = error as { statusCode?: number; code?: string; name?: string; message?: string }
  const status = typeof candidate?.statusCode === 'number' ? candidate.statusCode : undefined
  const details: string[] = []
  if (status) details.push(`HTTP ${status}`)
  const code = typeof candidate?.code === 'string' && candidate.code !== 'UnknownError' ? candidate.code : undefined
  if (code && code !== String(status)) details.push(code)
  const message = typeof candidate?.message === 'string' && candidate.message.trim() && candidate.message !== 'UnknownError' ? candidate.message : undefined
  if (message && !details.includes(message)) details.push(message)
  const suffix = details.length > 0 ? ` (${details.join(' - ')})` : ''
  return new PluginError('provider_error', `${action}${suffix}`)
}
