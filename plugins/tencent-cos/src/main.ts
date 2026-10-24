import { createStoragePlugin } from '@mo-gallery/plugin-sdk'

import { createCosPlugin } from './plugin.js'

createStoragePlugin(createCosPlugin()).start()
