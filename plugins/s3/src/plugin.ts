import { Readable } from 'node:stream'
import { createHash, createHmac } from 'node:crypto'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import {
  PluginError,
  ERROR_CODES,
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

interface S3Config {
  endpoint?: string
  region: string
  bucket: string
  basePath: string
  publicUrl?: string
  forcePathStyle: boolean
  urlMode: 'public' | 'signed'
  signedUrlExpiresSeconds: number
}

interface CredentialValues {
  accessKey: string
  secretKey: string
  sessionToken?: string
}

const HEALTH_REQUEST_TIMEOUT_MS = 10_000
// Uploads and downloads of large originals can keep a socket busy for minutes.
// Only the health check should use the short 10s window; data operations get a
// much longer socket-idle budget so a slow but progressing transfer never trips
// the Node HTTP handler's inactivity timeout.
const DATA_REQUEST_TIMEOUT_MS = 5 * 60_000

export function createS3Plugin(): StoragePlugin {
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
      await withRequestTimeout(
        signal => client.send(new HeadBucketCommand({ Bucket: config.bucket }), { abortSignal: signal }),
        HEALTH_REQUEST_TIMEOUT_MS,
      )
      return { status: 'ready' }
    },
    async put(request: PutRequest, context: PluginContext) {
      const config = readConfig(context)
      const credentials = readCredentials(context)
      const client = createClient(config, credentials)
      const key = objectKey(config, request.key)
      const transfer = context.transfer.open({ id: request.transferId, size: request.size })
      const body = Readable.from(transfer.stream({ signal: undefined }))
      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentLength: request.size,
        ContentType: request.contentType,
        ChecksumSHA256: checksumHeader(request.checksum),
        Metadata: request.idempotencyKey ? { 'mo-idempotency-key': request.idempotencyKey } : undefined,
      })
      const response = await withRetry(() => client.send(command), context)
      const url = await resolveUrl(config, credentials, key, request.size)
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
      const response = await withRetry(() => client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key })), context)
      if (!response.Body) throw new PluginError('provider_error', 'S3 object response did not contain a body')
      const writer = context.transferWriter.open({ id: request.transferId, size: 0 })
      let offset = 0
      for await (const chunk of response.Body as AsyncIterable<Uint8Array | string>) {
        const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk instanceof Uint8Array ? chunk : Buffer.from(chunk)
        if (data.byteLength === 0) continue
        const result = await writer.write(offset, data)
        offset = result.next
      }
      return objectInfo(config, key, response.ContentLength ?? offset, response.ContentType, response.ETag?.replaceAll('"', ''), response.VersionId)
    },
    async stat(request: StatRequest, context: PluginContext) {
      const config = readConfig(context)
      const client = createClient(config, readCredentials(context))
      const key = objectKey(config, request.key)
      const response = await withRetry(() => client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key })), context)
      return objectInfo(config, key, response.ContentLength ?? 0, response.ContentType, response.ETag?.replaceAll('"', ''), response.VersionId)
    },
    async list(request: ListRequest, context: PluginContext): Promise<ListResult> {
      const config = readConfig(context)
      const client = createClient(config, readCredentials(context))
      const prefix = objectPrefix(config, request.prefix ?? '').replace(/\/$/, '')
      const response = await withRetry(() => client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix || undefined, ContinuationToken: request.cursor, MaxKeys: clampLimit(request.limit) })), context)
      return {
        objects: (response.Contents ?? []).map(item => objectInfo(config, item.Key ?? '', item.Size ?? 0, undefined, item.ETag?.replaceAll('"', ''))),
        nextCursor: response.NextContinuationToken,
        hasMore: Boolean(response.IsTruncated),
      }
    },
    async move(request: MoveRequest, context: PluginContext) {
      const config = readConfig(context)
      const credentials = readCredentials(context)
      const client = createClient(config, credentials)
      const fromKey = objectKey(config, request.fromKey)
      const toKey = objectKey(config, request.toKey)
      await withRetry(() => client.send(new CopyObjectCommand({ Bucket: config.bucket, Key: toKey, CopySource: `${config.bucket}/${encodeKey(fromKey)}` })), context)
      await withRetry(() => client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: fromKey })), context)
      return objectInfo(config, toKey, 0)
    },
    async delete(request: DeleteRequest, context: PluginContext) {
      const config = readConfig(context)
      const client = createClient(config, readCredentials(context))
      await withRetry(() => client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: objectKey(config, request.key) })), context)
    },
    async getUrl(request: UrlRequest, context: PluginContext) {
      const config = readConfig(context)
      const credentials = readCredentials(context)
      const key = objectKey(config, request.key)
      const resolved = await resolveUrl(config, credentials, key, 0)
      return { key, size: 0, url: resolved.url, urlType: resolved.urlType, expiresAt: resolved.expiresAt }
    },
  }
}

function readConfig(context: PluginContext): S3Config {
  const value = context.config
  const region = value.region?.trim() || 'auto'
  const bucket = value.bucket?.trim()
  if (!bucket) throw new PluginError('invalid_config', 'S3 bucket is required')
  const urlMode = value.urlMode === 'signed' || value.urlMode === 'temporary' ? 'signed' : 'public'
  const expires = Number.parseInt(value.signedUrlExpiresSeconds || '900', 10)
  return {
    endpoint: value.endpoint?.trim() || undefined,
    region,
    bucket,
    basePath: cleanPrefix(value.basePath || ''),
    publicUrl: value.publicUrl?.trim() || undefined,
    forcePathStyle: value.forcePathStyle !== 'false',
    urlMode,
    signedUrlExpiresSeconds: Number.isFinite(expires) ? Math.min(Math.max(expires, 60), 86400) : 900,
  }
}

function readCredentials(context: PluginContext): CredentialValues {
  return {
    accessKey: context.credentials.require('accessKey'),
    secretKey: context.credentials.require('secretKey'),
    sessionToken: context.credentials.get('sessionToken'),
  }
}

function createClient(config: S3Config, credentials: CredentialValues, requestTimeoutMs = DATA_REQUEST_TIMEOUT_MS): S3Client {
  const clientConfig: S3ClientConfig = {
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: credentials.accessKey,
      secretAccessKey: credentials.secretKey,
      sessionToken: credentials.sessionToken,
    },
    requestHandler: NodeHttpHandler.create({
      connectionTimeout: HEALTH_REQUEST_TIMEOUT_MS,
      requestTimeout: requestTimeoutMs,
      socketTimeout: requestTimeoutMs,
    }),
    maxAttempts: 1,
  }
  return new S3Client(clientConfig)
}

function objectKey(config: S3Config, key: string): string {
  const clean = cleanPrefix(key)
  if (!clean) throw new PluginError('invalid_object_key', 'object key is required')
  return config.basePath ? `${config.basePath}/${clean}` : clean
}

function objectPrefix(config: S3Config, prefix: string): string {
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

function objectInfo(config: S3Config, key: string, size: number, contentType?: string, checksum?: string, version?: string): ObjectInfo {
  const relativeKey = config.basePath && key.startsWith(`${config.basePath}/`) ? key.slice(config.basePath.length + 1) : key
  return { key: relativeKey, size, contentType, checksum, version, urlType: 'public', url: publicObjectUrl(config, key) }
}

async function resolveUrl(config: S3Config, credentials: CredentialValues, key: string, size: number): Promise<{ url: string; urlType: 'public' | 'temporary'; expiresAt?: string }> {
  if (config.urlMode === 'signed') {
    const expiresAt = new Date(Date.now() + config.signedUrlExpiresSeconds * 1000)
    return { url: signedObjectUrl(config, credentials, key, config.signedUrlExpiresSeconds), urlType: 'temporary', expiresAt: expiresAt.toISOString() }
  }
  return { url: publicObjectUrl(config, key), urlType: 'public' }
}

function publicObjectUrl(config: S3Config, key: string): string {
  const base = config.publicUrl?.replace(/\/+$/, '') || endpointFor(config)
  return `${base}/${encodeKey(key)}`
}

function endpointFor(config: S3Config): string {
  return (config.endpoint || `https://s3.${config.region}.amazonaws.com`).replace(/\/+$/, '') + `/${encodeKey(config.bucket)}`
}

function signedObjectUrl(config: S3Config, credentials: CredentialValues, key: string, expires: number): string {
  const endpoint = new URL(config.endpoint || `https://s3.${config.region}.amazonaws.com`)
  const host = config.forcePathStyle ? endpoint.host : `${config.bucket}.${endpoint.host}`
  const pathname = `${endpoint.pathname.replace(/\/+$/, '')}${config.forcePathStyle ? `/${encodeKey(config.bucket)}` : ''}/${encodeKey(key)}`
  const now = new Date()
  const amzDate = formatAmzDate(now)
  const date = amzDate.slice(0, 8)
  const credentialScope = `${date}/${config.region}/s3/aws4_request`
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${credentials.accessKey}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  }
  if (credentials.sessionToken) query['X-Amz-Security-Token'] = credentials.sessionToken
  const canonicalQuery = Object.entries(query).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${awsEncode(name)}=${awsEncode(value)}`).join('&')
  const canonicalHeaders = `host:${host}\n`
  const canonicalRequest = `GET\n${pathname}\n${canonicalQuery}\n${canonicalHeaders}\nhost\nUNSIGNED-PAYLOAD`
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretKey}`, date), config.region), 's3'), 'aws4_request')
  query['X-Amz-Signature'] = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  const finalQuery = Object.entries(query).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${awsEncode(name)}=${awsEncode(value)}`).join('&')
  return `${endpoint.protocol}//${host}${pathname}?${finalQuery}`
}

function encodeKey(value: string): string {
  return value.split('/').map(part => awsEncode(part)).join('/')
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest()
}

function checksumHeader(checksum: string | undefined): string | undefined {
  if (!checksum || !/^[a-f0-9]{64}$/i.test(checksum)) return undefined
  return Buffer.from(checksum, 'hex').toString('base64')
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
      context.log.warn('Retrying S3 request', { attempt: attempt + 1, delayMs: delay })
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw normalizeProviderError(lastError, 'S3 request failed')
}

async function withRequestTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await operation(controller.signal)
  } catch (error) {
    if (controller.signal.aborted) {
      throw new PluginError('request_timeout', `S3 request timed out after ${timeoutMs}ms`)
    }
    throw normalizeProviderError(error, 'S3 request failed')
  } finally {
    clearTimeout(timer)
  }
}

// The AWS SDK masks provider errors that carry no deserialized body as an
// exception whose name and message are both "UnknownError". Reconstruct an
// actionable PluginError from the response metadata (HTTP status + error name)
// so the desktop host can surface the real failure to the user.
function normalizeProviderError(error: unknown, action: string): PluginError {
  if (error instanceof PluginError) return error
  const candidate = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } }
  const status = candidate.$metadata?.httpStatusCode
  const details: string[] = []
  if (status) details.push(`HTTP ${status}`)
  const name = typeof candidate.name === 'string' && candidate.name !== 'UnknownError' ? candidate.name : undefined
  if (name && name !== String(status)) details.push(name)
  const message = typeof candidate.message === 'string' && candidate.message !== 'UnknownError' ? candidate.message : undefined
  if (message && !details.includes(message)) details.push(message)
  const suffix = details.length > 0 ? ` (${details.join(' - ')})` : ''
  return new PluginError('provider_error', `${action}${suffix}`)
}

function isRetryable(error: unknown): boolean {
  const candidate = error as { $metadata?: { httpStatusCode?: number }; name?: string }
  return Boolean(candidate.$metadata?.httpStatusCode && candidate.$metadata.httpStatusCode >= 500) || candidate.name === 'TimeoutError' || candidate.name === 'Throttling'
}
