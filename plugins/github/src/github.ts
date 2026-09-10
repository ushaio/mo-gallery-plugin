export class GitHubHttpError extends Error {
  readonly status: number
  readonly url: string

  constructor(status: number, url: string, message?: string) {
    super(message || `GitHub API returned HTTP ${status}`)
    this.name = 'GitHubHttpError'
    this.status = status
    this.url = url
  }
}

export class GitHubTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`GitHub request timed out after ${timeoutMs}ms`)
    this.name = 'GitHubTimeoutError'
  }
}

export interface GitHubResponse<T = unknown> {
  status: number
  headers: Record<string, string>
  json?: T
  body?: AsyncIterable<Uint8Array>
}

export interface GitHubRequestOptions {
  method: 'GET' | 'PUT' | 'DELETE'
  path: string
  token: string
  apiUrl: string
  accept?: string
  body?: unknown
  timeoutMs: number
}

export async function githubRequest<T = unknown>(options: GitHubRequestOptions): Promise<GitHubResponse<T>> {
  const url = `${options.apiUrl.replace(/\/+$/, '')}/${options.path.replace(/^\/+/, '')}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  let response: Response
  try {
    response = await fetch(url, {
      method: options.method,
      signal: controller.signal,
      headers: {
        accept: options.accept ?? 'application/vnd.github+json',
        authorization: `Bearer ${options.token}`,
        'x-github-api-version': '2022-11-28',
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    })
  } catch (error) {
    if (controller.signal.aborted) throw new GitHubTimeoutError(options.timeoutMs)
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`GitHub request failed (${message})`)
  } finally {
    clearTimeout(timer)
  }

  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => { headers[name] = value })

  const result: GitHubResponse<T> = { status: response.status, headers }
  if (options.accept === 'application/vnd.github.raw') {
    // Node's fetch ReadableStream is async-iterable at runtime; the DOM lib
    // types just do not declare it.
    if (response.body) result.body = response.body as unknown as AsyncIterable<Uint8Array>
    return result
  }
  const text = await response.text()
  if (text) {
    try {
      result.json = JSON.parse(text) as T
    } catch {
      if (!response.ok) throw new GitHubHttpError(response.status, url, text.slice(0, 200))
    }
  }
  if (!response.ok) {
    const message = (result.json as { message?: string } | undefined)?.message
    throw new GitHubHttpError(response.status, url, message)
  }
  return result
}
