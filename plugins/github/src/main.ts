import { createStoragePlugin } from '@mo-gallery/desktop-plugin-sdk'
import { createGitHubPlugin } from './plugin.js'

createStoragePlugin(createGitHubPlugin()).start()
