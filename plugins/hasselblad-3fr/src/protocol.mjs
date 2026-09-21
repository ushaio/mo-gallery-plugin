import { extractPreview, validateRequest, LIMITS } from './preview.mjs'

export const formats = { formats: [{ extensions: ['.3fr'], format: '3fr', mimeType: 'image/x-hasselblad-3fr' }] }

export function registerPreview(transport, manifest) {
  let busy = false
  // Current SDK/library core discovery uses plugin.getManifest; initialize is
  // also exposed for the image-preview host's lifecycle negotiation.
  transport.on('plugin.getManifest', () => manifest)
  transport.on('initialize', params => {
    if (params?.coreApiVersion !== undefined && params.coreApiVersion !== '1') throw new Error('Unsupported core API version')
    return manifest
  })
  transport.on('image-preview.getFormats', () => formats)
  transport.on('image-preview.extract', async params => {
    validateRequest(params)
    if (busy) throw new Error('Preview extraction already running')
    busy = true
    try {
      return await extractPreview(params, async (offset, length) => {
        if (length > LIMITS.chunk) throw new Error('Transfer chunk exceeds limit')
        const result = await transport.request('host.transfer.read', {
          transferId: params.input.id, offset, length,
        }, { timeoutMs: 30000 })
        if (!result || typeof result.data !== 'string' || result.data.length !== 4 * Math.ceil(length / 3) ||
            result.offset !== offset || result.next !== offset + length || typeof result.eof !== 'boolean') {
          throw new Error('Invalid host transfer response')
        }
        const data = Buffer.from(result.data, 'base64')
        if (data.length !== length || data.toString('base64') !== result.data) throw new Error('Invalid transfer base64')
        return data
      })
    } finally { busy = false }
  })
  return transport
}
