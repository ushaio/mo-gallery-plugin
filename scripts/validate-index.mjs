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
const DESKTOP_VERSION_PATTERN = /^\d+\.\d+(?:\.\d+){0,2}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
// 分类栏词表不写在这里：`categories.json` 自己就是分类 API（客户端直接拉这份文件渲染左栏），
// 校验只负责挡住「拼错 / 大小写混用 / 用了没声明的栏」——错值到了客户端会被静默归进
// 「其他」，届时没人看得出是索引写错了。
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const LOCALE_PATTERN = /^[a-z]{2}(?:-[A-Za-z]{2,8})*$/
// 能力 id 不写在这里：本表是官方登记过的全部能力（宿主与根目录 CAPABILITIES.md 同步），
// 客户端遇到没登记的能力会直接拒绝安装，所以校验必须比「格式对不对」更严——拼错一个字母就是装不上。
const KNOWN_PERMISSIONS = new Set([
  'network:configured-endpoint',
  'sqlite:data:read',
  'sqlite:data:read-write',
  'sqlite:library:read',
  'addons:onnx',
])
// `addons:onnx` 的域白名单，宿主对应 `storage_plugins/capabilities.go` 的
// `registeredCapabilities["addons:onnx"].domains`。加一个域必须两边同改：这里拦住的是
// 「市场能过、宿主不认」，反过来宿主不认时用户已经装上了。
const ONNX_ADDON_DOMAINS = new Set(['faces', 'embedding'])
const RELEASE_PREFIX = 'https://github.com/ushaio/mo-gallery-plugin/releases/download/'
const checkAssets = process.argv.includes('--check-assets')

function fail(message) {
  throw new Error(message)
}

function nonEmptyString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${path} must be a non-empty string`)
}

// name / description 这类「随界面语言变化的文案」：字符串与「语言代码 → 文案」两种写法都收。
// 写成映射时中英都必须给——只给一种，另一种界面会直接显示外语，而作者在索引里看不出这个问题。
function localizedText(value, path, required) {
  if (value === undefined) {
    if (required) fail(`${path} must be a non-empty string or a locale map`)
    return
  }
  if (typeof value === 'string') {
    nonEmptyString(value, path)
    return
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${path} must be a non-empty string or a locale map`)
  }
  for (const [locale, text] of Object.entries(value)) {
    if (!LOCALE_PATTERN.test(locale)) fail(`${path} has an invalid locale key ${locale}`)
    nonEmptyString(text, `${path}.${locale}`)
  }
  nonEmptyString(value.zh, `${path}.zh`)
  nonEmptyString(value.en, `${path}.en`)
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

// 能力 id 必须逐字命中 KNOWN_PERMISSIONS：客户端对未登记的能力会直接拒绝安装，
// 所以拼错、漏拼、多写一段都不是「格式警告」，而是装不上的硬错误。
function validatePermissions(plugin, path) {
  if (plugin.permissions === undefined) return
  if (!Array.isArray(plugin.permissions)) fail(`${path}.permissions must be an array`)
  // 空数组等价于「不需要任何能力」，语义上应当省略字段，免得市场页渲染出一个空的权限块。
  if (plugin.permissions.length === 0) fail(`${path}.permissions must be omitted when the plugin needs no capability`)
  if (plugin.permissions.length > 8) fail(`${path}.permissions may declare at most 8 capabilities`)
  const seen = new Set()
  plugin.permissions.forEach((permission, permissionIndex) => {
    const label = `${path}.permissions[${permissionIndex}]`
    nonEmptyString(permission, label)
    if (seen.has(permission)) fail(`${path}.permissions contains duplicate ${permission}`)
    seen.add(permission)
    if (!KNOWN_PERMISSIONS.has(permission)) {
      fail(`${label} declares ${permission}, which is not a registered capability (see CAPABILITIES.md)`)
    }
  })
  // --allow-addons 会让 Node 自己警告权限模型失效，只发给已通过评审、且宿主侧契约写在
  // capabilities.go 里的域（当前是 faces 与 embedding）；索引里提前挡掉，别让用户装完才发现
  // 宿主拒绝启动。两个名字必须与宿主 `registeredCapabilities["addons:onnx"].domains` 保持一致。
  if (seen.has('addons:onnx')) {
    const contributions = Array.isArray(plugin.contributions) ? plugin.contributions : []
    if (!contributions.some(contribution => contribution && ONNX_ADDON_DOMAINS.has(contribution.domain))) {
      fail(`${path}.permissions declares addons:onnx without a ${[...ONNX_ADDON_DOMAINS].join('/')} contribution`)
    }
  }
}

const SQLITE_DATABASE_PATTERN = /^[A-Za-z0-9._-]{1,64}\.(?:sqlite|db|sqlite3)$/
const SQLITE_QUOTA_MIN_BYTES = 1024 * 1024
const SQLITE_QUOTA_MAX_BYTES = 1024 * 1024 * 1024
const SQLITE_QUOTA_DEFAULT_BYTES = 256 * 1024 * 1024

// 范围块只是 permissions 的补充说明（写在哪、写多大），所以它不能独立存在：
// 没有 sqlite: 能力却声明库文件与配额，说明 manifest 自相矛盾。
function validateSqliteScope(plugin, path) {
  if (plugin.sqlite === undefined) return
  const scopePath = `${path}.sqlite`
  if (!plugin.sqlite || typeof plugin.sqlite !== 'object' || Array.isArray(plugin.sqlite)) fail(`${scopePath} must be an object`)
  exactKeys(plugin.sqlite, new Set(['databases', 'quotaBytes']), scopePath)
  const permissions = Array.isArray(plugin.permissions) ? plugin.permissions : []
  if (!permissions.some(permission => typeof permission === 'string' && permission.startsWith('sqlite:'))) {
    fail(`${scopePath} is declared without any sqlite: capability`)
  }
  if (plugin.sqlite.databases !== undefined) {
    if (!Array.isArray(plugin.sqlite.databases) || plugin.sqlite.databases.length === 0) {
      fail(`${scopePath}.databases must be a non-empty array`)
    }
    if (plugin.sqlite.databases.length > 8) fail(`${scopePath}.databases accepts at most 8 file names`)
    const seen = new Set()
    plugin.sqlite.databases.forEach((database, databaseIndex) => {
      const label = `${scopePath}.databases[${databaseIndex}]`
      if (typeof database !== 'string' || !SQLITE_DATABASE_PATTERN.test(database)) {
        fail(`${label} must be a file name ending in .sqlite, .db or .sqlite3`)
      }
      if (seen.has(database)) fail(`${scopePath}.databases contains duplicate ${database}`)
      seen.add(database)
    })
  }
  if (plugin.sqlite.quotaBytes !== undefined) {
    const quota = plugin.sqlite.quotaBytes
    // 上限存在的意义是不让插件把用户磁盘吃满；下限是给 SQLite 留出 page + journal 的最小空间。
    if (!Number.isSafeInteger(quota) || quota < SQLITE_QUOTA_MIN_BYTES || quota > SQLITE_QUOTA_MAX_BYTES) {
      fail(`${scopePath}.quotaBytes must be an integer between ${SQLITE_QUOTA_MIN_BYTES} and ${SQLITE_QUOTA_MAX_BYTES}`)
    }
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
    'contributions', 'permissions', 'sqlite', 'homepage', 'repository', 'platforms', 'minDesktopVersion',
  ]), path)
  if (typeof plugin.id !== 'string' || !ID_PATTERN.test(plugin.id)) fail(`${path}.id is invalid`)
  if (ids.has(plugin.id)) fail(`${path}.id duplicates ${plugin.id}`)
  ids.add(plugin.id)
  localizedText(plugin.name, `${path}.name`, true)
  if (typeof plugin.version !== 'string' || !VERSION_PATTERN.test(plugin.version)) fail(`${path}.version is invalid`)
  nonEmptyString(plugin.coreApiVersion, `${path}.coreApiVersion`)
  if (plugin.minDesktopVersion !== undefined) {
    // 最低桌面端版本：宿主按它决定「能不能装」，旧客户端不认识这个字段会忽略它（域校验兜底），
    // 所以这里只挡写法——写错一个点，用户得到的是一条永远装不上的条目。
    if (typeof plugin.minDesktopVersion !== 'string' || !DESKTOP_VERSION_PATTERN.test(plugin.minDesktopVersion)) {
      fail(`${path}.minDesktopVersion must look like 0.8.6`)
    }
  }
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
  localizedText(plugin.description, `${path}.description`, false)
  if (plugin.author !== undefined && typeof plugin.author !== 'string') fail(`${path}.author must be a string`)
  for (const field of ['homepage', 'repository']) {
    if (plugin[field] !== undefined) {
      try { new URL(plugin[field]) } catch { fail(`${path}.${field} must be an absolute URL`) }
    }
  }
  if (plugin.contributions !== undefined) {
    if (!Array.isArray(plugin.contributions)) fail(`${path}.contributions must be an array`)
    plugin.contributions.forEach((item, contributionIndex) => validateContribution(item, `${path}.contributions[${contributionIndex}]`))
  }
  // 先校验 contributions，再校验 permissions：addons:onnx 的合法性取决于是否贡献了 faces 域。
  validatePermissions(plugin, path)
  validateSqliteScope(plugin, path)
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
