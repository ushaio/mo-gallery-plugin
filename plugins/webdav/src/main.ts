import { createStoragePlugin } from '@mo-gallery/plugin-sdk'
import { createWebdavPlugin } from './plugin.js'

createStoragePlugin(createWebdavPlugin()).start()
