import { createStoragePlugin } from '@mo-gallery/plugin-sdk'
import { createGitHubPlugin } from './plugin.js'

createStoragePlugin(createGitHubPlugin()).start()
