#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const INDEX_PATH = new URL('../index.json', import.meta.url)
const MAX_INDEX_BYTES = 4 * 1024 * 1024
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024
const PLATFORMS = new Set([
  'windows-amd64',
  'darwin-amd64',
  'darwin-arm64',
  'linux-amd64',
  'linux-arm64',
])
const ID_PATTERN = /^[A-Za-z0-9._-]+$/
const VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const RELEASE_PREFIX = 'https://github.com/ushaio/mo-gallery-plugin/releases/download/'
const checkAssets = process.argv.includes('--check-assets')

function fail(message) {
  throw new Error(message)
}

function nonEmptyString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${path} must be a non-empty string`)
}

function exactKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path} contains unsupported field ${key}`)
  }
}

function validateArtifact(artifact, path) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) fail(`${path} must be an object`)
  exactKeys(artifact, new Set(['url', 'sha256', 'size']), path)
  if (typeof artifact.url !== 'string' || !artifact.url.startsWith(RELEASE_PREFIX)) {
    fail(`${path}.url must reference this repository's GitHub Releases`)
  }
  const releasePath = artifact.url.slice(RELEASE_PREFIX.length).split('/')
  if (releasePath.length !== 2 || releasePath.some(part => part.length === 0)) fail(`${path}.url has an invalid release path`)
  if (typeof artifact.sha256 !== 'string' || !SHA256_PATTERN.test(artifact.sha256)) fail(`${path}.sha256 must be 64 lowercase hex characters`)
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > MAX_PACKAGE_BYTES) {
    fail(`${path}.size must be an integer between 1 and ${MAX_PACKAGE_BYTES}`)
  }
}

function validateContribution(contribution, path) {
  if (!contribution || typeof contribution !== 'object' || Array.isArray(contribution)) fail(`${path} must be an object`)
  exactKeys(contribution, new Set(['domain', 'apiVersion', 'capabilities']), path)
  nonEmptyString(contribution.domain, `${path}.domain`)
  nonEmptyString(contribution.apiVersion, `${path}.apiVersion`)
  if (contribution.capabilities !== undefined) {
    if (!Array.isArray(contribution.capabilities)) fail(`${path}.capabilities must be an array`)
    const seen = new Set()
    contribution.capabilities.forEach((capability, index) => {
      nonEmptyString(capability, `${path}.capabilities[${index}]`)
      if (seen.has(capability)) fail(`${path}.capabilities contains duplicate ${capability}`)
      seen.add(capability)
    })
  }
}

function validatePlugin(plugin, index, ids) {
  const path = `plugins[${index}]`
  if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) fail(`${path} must be an object`)
  exactKeys(plugin, new Set([
    'id', 'name', 'description', 'author', 'version', 'coreApiVersion',
    'contributions', 'homepage', 'repository', 'platforms',
  ]), path)
  if (typeof plugin.id !== 'string' || !ID_PATTERN.test(plugin.id)) fail(`${path}.id is invalid`)
  if (ids.has(plugin.id)) fail(`${path}.id duplicates ${plugin.id}`)
  ids.add(plugin.id)
  nonEmptyString(plugin.name, `${path}.name`)
  if (typeof plugin.version !== 'string' || !VERSION_PATTERN.test(plugin.version)) fail(`${path}.version is invalid`)
  nonEmptyString(plugin.coreApiVersion, `${path}.coreApiVersion`)
  for (const field of ['description', 'author']) {
    if (plugin[field] !== undefined && typeof plugin[field] !== 'string') fail(`${path}.${field} must be a string`)
  }
  for (const field of ['homepage', 'repository']) {
    if (plugin[field] !== undefined) {
      try { new URL(plugin[field]) } catch { fail(`${path}.${field} must be an absolute URL`) }
    }
  }
  if (plugin.contributions !== undefined) {
    if (!Array.isArray(plugin.contributions)) fail(`${path}.contributions must be an array`)
    plugin.contributions.forEach((item, contributionIndex) => validateContribution(item, `${path}.contributions[${contributionIndex}]`))
  }
  if (!plugin.platforms || typeof plugin.platforms !== 'object' || Array.isArray(plugin.platforms)) fail(`${path}.platforms must be an object`)
  for (const [platform, artifact] of Object.entries(plugin.platforms)) {
    if (!PLATFORMS.has(platform)) fail(`${path}.platforms contains unsupported platform ${platform}`)
    validateArtifact(artifact, `${path}.platforms.${platform}`)
  }
}

async function verifyAsset(artifact, label) {
  const response = await fetch(artifact.url, { redirect: 'follow' })
  if (!response.ok) fail(`${label} returned HTTP ${response.status}`)
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null && Number(contentLength) !== artifact.size) fail(`${label} Content-Length does not match index size`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength !== artifact.size) fail(`${label} downloaded size does not match index size`)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== artifact.sha256) fail(`${label} SHA-256 does not match index digest`)
}

const raw = await readFile(INDEX_PATH)
if (raw.byteLength > MAX_INDEX_BYTES) fail(`index.json exceeds ${MAX_INDEX_BYTES} bytes`)
let index
try { index = JSON.parse(raw.toString('utf8')) } catch (error) { fail(`index.json is not valid JSON: ${error.message}`) }
if (!index || typeof index !== 'object' || Array.isArray(index)) fail('index root must be an object')
exactKeys(index, new Set(['schemaVersion', 'updatedAt', 'plugins']), 'index')
if (index.schemaVersion !== 1) fail('schemaVersion must be 1')
if (typeof index.updatedAt !== 'string' || Number.isNaN(Date.parse(index.updatedAt))) fail('updatedAt must be an RFC 3339 timestamp')
if (!Array.isArray(index.plugins)) fail('plugins must be an array')
const ids = new Set()
index.plugins.forEach((plugin, pluginIndex) => validatePlugin(plugin, pluginIndex, ids))

if (checkAssets) {
  for (const plugin of index.plugins) {
    for (const [platform, artifact] of Object.entries(plugin.platforms)) {
      await verifyAsset(artifact, `${plugin.id}@${plugin.version} (${platform})`)
    }
  }
}

console.log(`Validated ${index.plugins.length} plugin(s)${checkAssets ? ' and their release assets' : ''}.`)
