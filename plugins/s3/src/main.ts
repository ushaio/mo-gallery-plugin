import { createStoragePlugin } from '@mo-gallery/desktop-plugin-sdk'
import { createS3Plugin } from './plugin.js'

createStoragePlugin(createS3Plugin()).start()
