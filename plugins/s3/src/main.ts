import { createStoragePlugin } from '@mo-gallery/plugin-sdk'
import { createS3Plugin } from './plugin.js'

createStoragePlugin(createS3Plugin()).start()
