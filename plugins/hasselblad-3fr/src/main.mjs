import { JsonRpcStdioTransport } from '@mo-gallery/plugin-sdk'
import manifest from '../manifest.json' with { type: 'json' }
import { registerPreview } from './protocol.mjs'

registerPreview(new JsonRpcStdioTransport(process.stdin, process.stdout, { maxLineBytes: 512 * 1024 }), manifest)
