import { createStoragePlugin } from '@mo-gallery/plugin-sdk'
import { createOssPlugin } from './plugin.js'

createStoragePlugin(createOssPlugin()).start()
