#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const INDEX_PATH = new URL('../index.json', import.meta.url)
const CATEGORIES_PATH = new URL('../categories.json', import.meta.url)
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
// 分类栏词表不写在这里：`categories.json` 自己就是分类 API（客户端直接拉这份文件渲染左栏），
// 校验只负责挡住「拼错 / 大小写混用 / 用了没声明的栏」——错值到了客户端会被静默归进
// 「其他」，届时没人看得出是索引写错了。
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const LOCALE_PATTERN = /^[a-z]{2}(?:-[A-Za-z]{2,8})*$/
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

function validateCategory(category, path, ids, domainOwners) {
  if (!category || typeof category !== 'object' || Array.isArray(category)) fail(`${path} must be an object`)
  exactKeys(category, new Set(['id', 'name', 'domains']), path)
  if (typeof category.id !== 'string' || category.id.length > 32 || !SLUG_PATTERN.test(category.id)) {
    fail(`${path}.id must be a lowercase slug of at most 32 characters`)
  }
  if (ids.has(category.id)) fail(`${path}.id duplicates ${category.id}`)
  ids.add(category.id)
  if (!category.name || typeof category.name !== 'object' || Array.isArray(category.name)) fail(`${path}.name must be an object`)
  for (const [locale, label] of Object.entries(category.name)) {
    if (!LOCALE_PATTERN.test(locale)) fail(`${path}.name has an invalid locale key ${locale}`)
    nonEmptyString(label, `${path}.name.${locale}`)
  }
  nonEmptyString(category.name.zh, `${path}.name.zh`)
  nonEmptyString(category.name.en, `${path}.name.en`)
  if (category.domains === undefined) return
  if (!Array.isArray(category.domains)) fail(`${path}.domains must be an array`)
  const seen = new Set()
  category.domains.forEach((domain, index) => {
    if (typeof domain !== 'string' || !SLUG_PATTERN.test(domain)) fail(`${path}.domains[${index}] must be a lowercase slug`)
    if (seen.has(domain)) fail(`${path}.domains contains duplicate ${domain}`)
    seen.add(domain)
    const owner = domainOwners.get(domain)
    // 同一个能力域被两栏认领时，客户端「按域兜底」该选哪栏就得靠数组顺序赌，直接挡掉。
    if (owner !== undefined) fail(`${path}.domains claims ${domain}, which ${owner} already owns`)
    domainOwners.set(domain, category.id)
  })
}

async function loadCategories() {
  const raw = await readFile(CATEGORIES_PATH)
  let categories
  try { categories = JSON.parse(raw.toString('utf8')) } catch (error) { fail(`categories.json is not valid JSON: ${error.message}`) }
  if (!categories || typeof categories !== 'object' || Array.isArray(categories)) fail('categories root must be an object')
  exactKeys(categories, new Set(['schemaVersion', 'updatedAt', 'categories']), 'categories')
  if (categories.schemaVersion !== 1) fail('categories.json schemaVersion must be 1')
  if (typeof categories.updatedAt !== 'string' || Number.isNaN(Date.parse(categories.updatedAt))) {
    fail('categories.json updatedAt must be an RFC 3339 timestamp')
  }
  if (!Array.isArray(categories.categories) || categories.categories.length === 0) {
    fail('categories.json categories must be a non-empty array')
  }
  const ids = new Set()
  const domainOwners = new Map()
  categories.categories.forEach((category, index) => validateCategory(category, `categories[${index}]`, ids, domainOwners))
  return ids
}

function validatePlugin(plugin, index, ids, categoryIds) {
  const path = `plugins[${index}]`
  if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) fail(`${path} must be an object`)
  exactKeys(plugin, new Set([
    'id', 'name', 'description', 'author', 'version', 'coreApiVersion', 'category',
    'contributions', 'homepage', 'repository', 'platforms',
  ]), path)
  if (typeof plugin.id !== 'string' || !ID_PATTERN.test(plugin.id)) fail(`${path}.id is invalid`)
  if (ids.has(plugin.id)) fail(`${path}.id duplicates ${plugin.id}`)
  ids.add(plugin.id)
  nonEmptyString(plugin.name, `${path}.name`)
  if (typeof plugin.version !== 'string' || !VERSION_PATTERN.test(plugin.version)) fail(`${path}.version is invalid`)
  nonEmptyString(plugin.coreApiVersion, `${path}.coreApiVersion`)
  if (plugin.category !== undefined) {
    // 字符串与字符串数组都收：写多个表示同时挂在多栏下，客户端会在每一栏里各列一次。
    const listed = Array.isArray(plugin.category) ? plugin.category : [plugin.category]
    if (listed.length === 0) fail(`${path}.category must be a slug, or a non-empty array of slugs`)
    const seen = new Set()
    listed.forEach((slug, categoryIndex) => {
      const label = Array.isArray(plugin.category) ? `${path}.category[${categoryIndex}]` : `${path}.category`
      if (typeof slug !== 'string' || slug.length > 32 || !SLUG_PATTERN.test(slug)) {
        fail(`${label} must be a lowercase slug of at most 32 characters`)
      }
      if (seen.has(slug)) fail(`${path}.category contains duplicate ${slug}`)
      seen.add(slug)
      if (!categoryIds.has(slug)) fail(`${label} references ${slug}, which categories.json does not declare`)
    })
  }
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

const categoryIds = await loadCategories()

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
index.plugins.forEach((plugin, pluginIndex) => validatePlugin(plugin, pluginIndex, ids, categoryIds))

if (checkAssets) {
  for (const plugin of index.plugins) {
    for (const [platform, artifact] of Object.entries(plugin.platforms)) {
      await verifyAsset(artifact, `${plugin.id}@${plugin.version} (${platform})`)
    }
  }
}

console.log(`Validated ${index.plugins.length} plugin(s) against ${categoryIds.size} categories${checkAssets ? ' and their release assets' : ''}.`)
