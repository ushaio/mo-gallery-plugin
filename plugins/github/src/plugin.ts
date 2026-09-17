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
import { GitHubHttpError, GitHubTimeoutError, githubRequest } from './github.js'
import { manifest } from './manifest.js'

interface GitHubConfig {
  owner: string
  repo: string
  branch?: string
  basePath: string
  apiUrl: string
  rawUrlBase: string
}

interface ContentEntry {
  name: string
  path: string
  sha: string
  size: number
  type: string
}

interface TreeEntry {
  path: string
  sha: string
  size: number
  type: string
}

interface TreeResponse {
  tree?: TreeEntry[]
  truncated?: boolean
}

interface PutContentResponse {
  content?: ContentEntry
  commit?: { sha?: string }
}

interface RepoResponse {
  default_branch?: string
  permissions?: { push?: boolean }
}

const HEALTH_REQUEST_TIMEOUT_MS = 10_000
// A Contents API PUT embeds the file as base64 JSON, so the whole body must be
// buffered anyway; only the probes use the short timeout so a slow repository
// lookup never hangs health checks.
const DATA_REQUEST_TIMEOUT_MS = 5 * 60_000
// The GitHub Contents API refuses files at 100 MiB; larger originals must use
// a storage plugin with streaming uploads (e.g. S3).
const MAX_CONTENTS_FILE_BYTES = 100 * 1024 * 1024

const defaultBranches = new Map<string, string>()

export function createGitHubPlugin(): StoragePlugin {
  return {
    manifest,
    async validate(request: ValidateRequest, context: PluginContext) {
      const config = readConfig(context)
      if (!request.sourceId || !config.owner || !config.repo) return { valid: false, error: 'owner, repo, and sourceId are required' }
      try {
        await fetchRepo(config, readToken(context), HEALTH_REQUEST_TIMEOUT_MS)
        return { valid: true }
      } catch (error) {
        return { valid: false, error: validateError(error) }
      }
    },
    async health(_request: HealthRequest, context: PluginContext) {
      const config = readConfig(context)
      const token = readToken(context)
      const repo = await withRetry(() => fetchRepo(config, token, HEALTH_REQUEST_TIMEOUT_MS), context)
      if (repo.permissions && repo.permissions.push === false) {
        return { status: 'degraded', message: '令牌没有该仓库的写入权限（push = false），无法上传照片' }
      }
      return { status: 'ready' }
    },
    async put(request: PutRequest, context: PluginContext) {
      const config = readConfig(context)
      const token = readToken(context)
      const branch = await resolveBranch(config, token, context)
      const key = objectKey(config, request.key)
      if (request.size > MAX_CONTENTS_FILE_BYTES) {
        throw new PluginError('invalid_config', `GitHub Contents API 不支持超过 100 MiB 的文件（当前 ${request.size} 字节），请使用 S3 等支持流式上传的插件`)
      }
      const existing = await statEntry(config, token, branch, key)
      // A retried upload with the same idempotency key that already reached
      // GitHub reports the same size: return the stored object instead of
      // creating an overwrite commit.
      if (existing && request.idempotencyKey && existing.size === request.size) {
        return objectInfo(config, branch, key, existing, undefined)
      }
      const transfer = context.transfer.open({ id: request.transferId, size: request.size })
      const chunks: Buffer[] = []
      let received = 0
      for await (const chunk of transfer.stream()) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        chunks.push(data)
        received += data.byteLength
      }
      if (received !== request.size) {
        throw new PluginError('transfer_failed', `上传数据不完整：期望 ${request.size} 字节，实际收到 ${received} 字节`)
      }
      const message = request.idempotencyKey
        ? `mo-gallery upload ${key} [${request.idempotencyKey}]`
        : `mo-gallery upload ${key}`
      const response = await withRetry(() => githubRequest<PutContentResponse>({
        method: 'PUT',
        path: contentsPath(config, key, branch),
        token,
        apiUrl: config.apiUrl,
        body: {
          message,
          content: Buffer.concat(chunks).toString('base64'),
          branch,
          sha: existing?.sha,
        },
        timeoutMs: DATA_REQUEST_TIMEOUT_MS,
      }), context)
      const entry = response.json?.content
      return {
        key,
        url: publicObjectUrl(config, branch, key),
        urlType: 'public',
        size: request.size,
        contentType: request.contentType,
        checksum: request.checksum,
        version: response.json?.commit?.sha,
      }
    },
    async get(request: GetRequest, context: PluginContext) {
      const config = readConfig(context)
      const token = readToken(context)
      const branch = await resolveBranch(config, token, context)
      const key = objectKey(config, request.key)
      const response = await withRetry(() => githubRequest({
        method: 'GET',
        path: contentsPath(config, key, branch),
        token,
        apiUrl: config.apiUrl,
        accept: 'application/vnd.github.raw',
        timeoutMs: DATA_REQUEST_TIMEOUT_MS,
      }), context)
      if (!response.body) throw new PluginError('provider_error', 'GitHub object response did not contain a body')
      const writer = context.transferWriter.open({ id: request.transferId, size: 0 })
      let offset = 0
      for await (const chunk of response.body) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (data.byteLength === 0) continue
        const result = await writer.write(offset, data)
        offset = result.next
      }
      const declared = Number.parseInt(response.headers['content-length'] ?? '', 10)
      return {
        key,
        size: Number.isFinite(declared) ? declared : offset,
        contentType: response.headers['content-type'],
        url: publicObjectUrl(config, branch, key),
        urlType: 'public',
      }
    },
    async stat(request: StatRequest, context: PluginContext) {
      const config = readConfig(context)
      const token = readToken(context)
      const branch = await resolveBranch(config, token, context)
      const key = objectKey(config, request.key)
      const entry = await withRetry(() => statEntry(config, token, branch, key), context)
      if (!entry) throw new PluginError('provider_error', `GitHub object not found: ${key} (HTTP 404)`)
      return objectInfo(config, branch, key, entry, undefined)
    },
    async list(request: ListRequest, context: PluginContext): Promise<ListResult> {
      const config = readConfig(context)
      const token = readToken(context)
      const branch = await resolveBranch(config, token, context)
      // The Git Trees API walks the branch recursively in one request, which
      // gives the flat prefix semantics the host expects (the Contents API
      // would only return one directory level per call).
      const response = await withRetry(() => githubRequest<TreeResponse>({
        method: 'GET',
        path: `repos/${config.owner}/${config.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
        token,
        apiUrl: config.apiUrl,
        timeoutMs: DATA_REQUEST_TIMEOUT_MS,
      }), context)
      const prefix = cleanPrefix(request.prefix ?? '')
      const limit = clampLimit(request.limit) ?? 1000
      // Code-unit ordering for both the cursor filter and the sort so paginated
      // walks never skip or repeat keys (same rationale as the WebDAV plugin).
      const filtered = (response.json?.tree ?? [])
        .filter(entry => entry.type === 'blob')
        .map(entry => ({ key: relativeKey(config, entry.path), entry }))
        .filter(({ key }) => key.startsWith(prefix))
        .filter(({ key }) => request.cursor ? key > request.cursor : true)
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      const page = filtered.slice(0, limit)
      return {
        objects: page.map(({ key, entry }) => ({
          key,
          size: entry.size,
          checksum: entry.sha,
          urlType: 'public' as const,
          url: publicObjectUrl(config, branch, `${config.basePath ? `${config.basePath}/` : ''}${key}`),
        })),
        nextCursor: filtered.length > page.length ? page[page.length - 1].key : undefined,
        hasMore: filtered.length > page.length,
      }
    },
    async move(request: MoveRequest, context: PluginContext) {
      const config = readConfig(context)
      const token = readToken(context)
      const branch = await resolveBranch(config, token, context)
      const fromKey = objectKey(config, request.fromKey)
      const toKey = objectKey(config, request.toKey)
      const source = await withRetry(() => statEntry(config, token, branch, fromKey), context)
      if (!source) throw new PluginError('provider_error', `GitHub object not found: ${fromKey} (HTTP 404)`)
      // The Contents API has no server-side rename: download the raw bytes,
      // write them to the new key, then delete the old blob.
      const raw = await withRetry(() => githubRequest({
        method: 'GET',
        path: contentsPath(config, fromKey, branch),
        token,
        apiUrl: config.apiUrl,
        accept: 'application/vnd.github.raw',
        timeoutMs: DATA_REQUEST_TIMEOUT_MS,
      }), context)
      const chunks: Buffer[] = []
      if (raw.body) for await (const chunk of raw.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      const destination = await withRetry(() => statEntry(config, token, branch, toKey), context)
      await withRetry(() => githubRequest<PutContentResponse>({
        method: 'PUT',
        path: contentsPath(config, toKey, branch),
        token,
        apiUrl: config.apiUrl,
        body: { message: `mo-gallery move ${fromKey} -> ${toKey}`, content: body.toString('base64'), branch, sha: destination?.sha },
        timeoutMs: DATA_REQUEST_TIMEOUT_MS,
      }), context)
      await withRetry(() => githubRequest({
        method: 'DELETE',
        path: contentsPath(config, fromKey, branch),
        token,
        apiUrl: config.apiUrl,
        body: { message: `mo-gallery delete ${fromKey}`, sha: source.sha, branch },
        timeoutMs: DATA_REQUEST_TIMEOUT_MS,
      }), context)
      return {
        key: toKey,
        url: publicObjectUrl(config, branch, toKey),
        urlType: 'public' as const,
        size: source.size,
        checksum: undefined,
      }
    },
    async delete(request: DeleteRequest, context: PluginContext) {
      const config = readConfig(context)
      const token = readToken(context)
      const branch = await resolveBranch(config, token, context)
      const key = objectKey(config, request.key)
      const entry = await withRetry(() => statEntry(config, token, branch, key), context)
      if (!entry) throw new PluginError('provider_error', `GitHub object not found: ${key} (HTTP 404)`)
      await withRetry(() => githubRequest({
        method: 'DELETE',
        path: contentsPath(config, key, branch),
        token,
        apiUrl: config.apiUrl,
        body: { message: `mo-gallery delete ${key}`, sha: entry.sha, branch },
        timeoutMs: DATA_REQUEST_TIMEOUT_MS,
      }), context)
    },
    async getUrl(request: UrlRequest, context: PluginContext) {
      const config = readConfig(context)
      const token = readToken(context)
      const branch = await resolveBranch(config, token, context)
      const key = objectKey(config, request.key)
      return { key, size: 0, url: publicObjectUrl(config, branch, key), urlType: 'public' }
    },
  }
}

function readConfig(context: PluginContext): GitHubConfig {
  const value = context.config
  const owner = value.owner?.trim() || ''
  const repo = value.repo?.trim() || ''
  if (!owner || !repo) throw new PluginError('invalid_config', 'GitHub owner and repo are required')
  if (owner.includes('/') || repo.includes('/')) throw new PluginError('invalid_config', 'GitHub owner and repo must not contain "/"')
  const apiUrl = value.apiUrl?.trim() || 'https://api.github.com'
  try {
    new URL(apiUrl)
  } catch {
    throw new PluginError('invalid_config', 'GitHub API URL is not a valid URL')
  }
  return {
    owner,
    repo,
    branch: value.branch?.trim() || undefined,
    // The desktop host resolves basePath into object keys and blanks the
    // config value before spawning this plugin; keep accepting it only for
    // standalone/contract-test runs (same contract as the WebDAV plugin).
    basePath: cleanPrefix(value.basePath || ''),
    apiUrl,
    rawUrlBase: value.rawUrl?.trim().replace(/\/+$/, '') || `https://raw.githubusercontent.com/${owner}/${repo}`,
  }
}

function readToken(context: PluginContext): string {
  return context.credentials.require('token')
}

async function fetchRepo(config: GitHubConfig, token: string, timeoutMs: number): Promise<RepoResponse> {
  const response = await githubRequest<RepoResponse>({
    method: 'GET',
    path: `repos/${config.owner}/${config.repo}`,
    token,
    apiUrl: config.apiUrl,
    timeoutMs,
  })
  return response.json ?? {}
}

async function resolveBranch(config: GitHubConfig, token: string, context: PluginContext): Promise<string> {
  if (config.branch) return config.branch
  const cacheKey = `${config.apiUrl}/${config.owner}/${config.repo}`
  const cached = defaultBranches.get(cacheKey)
  if (cached) return cached
  const repo = await withRetry(() => fetchRepo(config, token, HEALTH_REQUEST_TIMEOUT_MS), context)
  const branch = repo.default_branch || 'main'
  defaultBranches.set(cacheKey, branch)
  return branch
}

// GET on the Contents API returns the file entry (with its blob sha) for an
// existing object, or null when the server answers 404. A directory with the
// same name answers an array, which is not a storable object.
async function statEntry(config: GitHubConfig, token: string, branch: string, key: string): Promise<ContentEntry | null> {
  try {
    const response = await githubRequest<ContentEntry | ContentEntry[]>({
      method: 'GET',
      path: contentsPath(config, key, branch),
      token,
      apiUrl: config.apiUrl,
      timeoutMs: DATA_REQUEST_TIMEOUT_MS,
    })
    const entry = response.json
    if (Array.isArray(entry)) return null
    return entry?.type === 'file' ? entry : null
  } catch (error) {
    if (error instanceof GitHubHttpError && error.status === 404) return null
    throw error
  }
}

function objectInfo(config: GitHubConfig, branch: string, key: string, entry: ContentEntry, version?: string): ObjectInfo {
  return {
    key: relativeKey(config, entry.path || key),
    url: publicObjectUrl(config, branch, key),
    urlType: 'public',
    size: entry.size,
    checksum: entry.sha,
    version,
  }
}

function relativeKey(config: GitHubConfig, path: string): string {
  const clean = cleanPrefix(path)
  if (config.basePath && clean.startsWith(`${config.basePath}/`)) return clean.slice(config.basePath.length + 1)
  return clean
}

function contentsPath(config: GitHubConfig, key: string, branch: string): string {
  const path = `repos/${config.owner}/${config.repo}/contents/${encodeKey(key)}`
  return `${path}?ref=${encodeURIComponent(branch)}`
}

function publicObjectUrl(config: GitHubConfig, branch: string, key: string): string {
  return `${config.rawUrlBase}/${encodeURIComponent(branch)}/${encodeKey(key)}`
}

function objectKey(config: GitHubConfig, key: string): string {
  const clean = cleanPrefix(key)
  if (!clean) throw new PluginError('invalid_object_key', 'object key is required')
  return config.basePath ? `${config.basePath}/${clean}` : clean
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

function validateError(error: unknown): string {
  if (error instanceof GitHubHttpError) {
    if (error.status === 401 || error.status === 403) return '认证失败：请检查 Personal Access Token 及其仓库权限'
    if (error.status === 404) return '仓库不存在或令牌无权访问（404）'
    return `GitHub API 返回 HTTP ${error.status}`
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/timed out|timeout/i.test(message)) return `连接超时：${message}`
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return '域名无法解析，请检查 API 地址'
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
      context.log.warn('Retrying GitHub request', { attempt: attempt + 1, delayMs: delay })
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw normalizeGitHubError(lastError, 'GitHub request failed')
}

function normalizeGitHubError(error: unknown, action: string): PluginError {
  if (error instanceof PluginError) return error
  if (error instanceof GitHubTimeoutError) return new PluginError('request_timeout', error.message)
  if (error instanceof GitHubHttpError) {
    return new PluginError('provider_error', `${action} (HTTP ${error.status})`)
  }
  const message = error instanceof Error ? error.message : String(error)
  return new PluginError('provider_error', `${action} (${message})`)
}

function isRetryable(error: unknown): boolean {
  if (error instanceof GitHubHttpError) return error.status >= 500
  if (error instanceof Error) return /timed out|timeout|ECONNRESET|ECONNREFUSED|EPIPE|fetch failed/i.test(error.message)
  return false
}
