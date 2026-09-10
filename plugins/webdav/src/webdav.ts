import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage, RequestOptions } from 'node:http'
import { Readable } from 'node:stream'

export interface WebdavResponse {
  status: number
  headers: IncomingMessage['headers']
  body?: Readable
}

export interface WebdavRequestOptions {
  method: string
  url: string
  auth: string
  headers?: Record<string, string | undefined>
  bodyStream?: Readable
  bodyBuffer?: Buffer
  timeoutMs: number
}

export interface WebdavResource {
  href: string
  isCollection: boolean
  size: number
  etag?: string
  contentType?: string
  lastModified?: string
}

export class WebdavHttpError extends Error {
  readonly status: number
  readonly method: string

  constructor(method: string, status: number, message: string) {
    super(message)
    this.name = 'WebdavHttpError'
    this.method = method
    this.status = status
  }
}

export function webdavRequest(options: WebdavRequestOptions): Promise<WebdavResponse> {
  const url = new URL(options.url)
  const transport = url.protocol === 'http:' ? httpRequest : httpsRequest
  const requestHeaders: Record<string, string> = {
    'user-agent': 'mo-gallery-desktop-plugin-webdav/0.1',
  }
  if (options.auth) requestHeaders.authorization = options.auth
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value !== undefined) requestHeaders[name] = value
  }

  if (options.bodyStream) requestHeaders['transfer-encoding'] = 'chunked'
  else if (options.bodyBuffer) requestHeaders['content-length'] = String(options.bodyBuffer.byteLength)

  const requestOptions: RequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    method: options.method,
    headers: requestHeaders,
    timeout: options.timeoutMs,
  }

  return new Promise<WebdavResponse>((resolve, reject) => {
    const request = transport(requestOptions, response => {
      clearTimeout(timer)
      if (response.statusCode && response.statusCode >= 400) {
        response.resume()
        reject(new WebdavHttpError(options.method, response.statusCode, `WebDAV ${options.method} failed with HTTP ${response.statusCode}`))
        return
      }
      resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response })
    })
    request.on('timeout', () => {
      request.destroy(new Error(`WebDAV ${options.method} timed out after ${options.timeoutMs}ms`))
    })
    request.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    // Total-duration guard: cleared once response headers arrive so a slow
    // body stream is governed only by the socket-idle timeout above.
    const timer = setTimeout(() => {
      request.destroy(new Error(`WebDAV ${options.method} timed out after ${options.timeoutMs}ms`))
    }, options.timeoutMs)
    if (options.bodyStream) {
      options.bodyStream.on('error', error => request.destroy(error))
      options.bodyStream.pipe(request)
    } else {
      request.end(options.bodyBuffer)
    }
  })
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:displayname/>
    <D:resourcetype/>
    <D:getcontentlength/>
    <D:getcontenttype/>
    <D:getetag/>
    <D:getlastmodified/>
  </D:prop>
</D:propfind>`

export async function webdavPropfind(url: string, auth: string, depth: 0 | 1, timeoutMs: number): Promise<WebdavResource[]> {
  const response = await webdavRequest({
    method: 'PROPFIND',
    url,
    auth,
    headers: { depth: String(depth), 'content-type': 'application/xml' },
    bodyBuffer: Buffer.from(PROPFIND_BODY, 'utf8'),
    timeoutMs,
  })
  const body = await readAll(response.body)
  if (response.status !== 207 && response.status !== 200) {
    throw new WebdavHttpError('PROPFIND', response.status, `WebDAV PROPFIND returned HTTP ${response.status}`)
  }
  return parseMultistatus(body.toString('utf8'))
}

async function readAll(stream: Readable | undefined): Promise<Buffer> {
  if (!stream) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

// Minimal multistatus XML parser: WebDAV servers emit a variety of namespace
// prefixes (D:, d:, dav:, or none) and may interleave whitespace/CDATA, so we
// tokenize tags and slice the <response> blocks instead of matching a fixed
// prefix. Entities beyond the XML spec basics (& < > " ') are rare in hrefs.
export function parseMultistatus(xml: string): WebdavResource[] {
  const resources: WebdavResource[] = []
  const responseBlocks = sliceElements(xml, 'response')
  for (const block of responseBlocks) {
    const hrefRaw = firstText(sliceElements(block, 'href')[0] ?? '')
    if (!hrefRaw) continue
    const href = decodeHrefSafe(hrefRaw)
    const propStatBlocks = sliceElements(block, 'propstat')
    const propBlocks = (propStatBlocks.length > 0 ? propStatBlocks : [block]).flatMap(propStat => sliceElements(propStat, 'prop'))
    const props = propBlocks.length > 0 ? propBlocks.join('\n') : block
    const resource: WebdavResource = {
      href,
      isCollection: sliceElements(props, 'resourcetype').some(value => hasChildTag(value, 'collection')),
      size: parseOptionalInteger(firstText(sliceElements(props, 'getcontentlength')[0] ?? '')) ?? 0,
      etag: stripEtagQuotes(firstText(sliceElements(props, 'getetag')[0] ?? '')) || undefined,
      contentType: firstText(sliceElements(props, 'getcontenttype')[0] ?? '') || undefined,
      lastModified: firstText(sliceElements(props, 'getlastmodified')[0] ?? '') || undefined,
    }
    resources.push(resource)
  }
  return resources
}

function sliceElements(xml: string, localName: string): string[] {
  // The lookahead after the tag name keeps <myresponse>/<responseX> from
  // matching while accepting D:response, d:response and bare response forms.
  const tagPattern = new RegExp(`<(/?)((?:[A-Za-z0-9_.-]+:)?${localName})(?=[\\s/>])([^>]*)>`, 'g')
  const blocks: string[] = []
  let depth = 0
  let openEnd = 0
  let match: RegExpExecArray | null
  while ((match = tagPattern.exec(xml)) !== null) {
    const isClosing = match[1] === '/'
    const isSelfClosing = !isClosing && /\/\s*$/.test(match[3] ?? '')
    if (!isClosing && !isSelfClosing) {
      if (depth === 0) openEnd = match.index + match[0].length
      depth += 1
    } else if (isClosing) {
      depth -= 1
      if (depth === 0) blocks.push(xml.slice(openEnd, match.index))
      if (depth < 0) depth = 0
    }
  }
  return blocks
}

function hasChildTag(xml: string, localName: string): boolean {
  return new RegExp(`<\\w*:?${localName}[\\s/>]`).test(xml)
}

function firstText(xml: string): string {
  return decodeEntities(xml.trim())
}

function parseOptionalInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function stripEtagQuotes(value: string): string {
  return value.replace(/^"|"$/g, '').replace(/^W\//, '').trim()
}

export function decodeHrefSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
