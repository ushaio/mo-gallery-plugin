import { createStoragePlugin } from '@mo-gallery/desktop-plugin-sdk'
import { createWebdavPlugin } from './plugin.js'

createStoragePlugin(createWebdavPlugin()).start()
