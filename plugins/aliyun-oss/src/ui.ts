import { createPluginUiClient, type PluginUiInitPayload } from '@mo-gallery/plugin-sdk/ui'

/**
 * 阿里云 OSS 的配置界面。
 *
 * 这个文件由宿主在沙箱 iframe 中加载，**不是**插件进程的一部分：
 * 它没有 Node API、没有凭据、也不能联网（宿主下发的 CSP 是 connect-src 'none'）。
 * 所有动作都通过 `createPluginUiClient()` 回到宿主，详见
 * `@mo-gallery/plugin-sdk/ui` 与 emulsion-desktop-v3 的 storage_plugins/README.md。
 *
 * 默认值必须与进程侧 `src/plugin.ts` 的 `readConfig()` 保持一致，否则界面显示的
 * 和实际写入对象存储的会不一致。
 */

type Locale = 'zh' | 'en'

interface Copy {
  zh: string
  en: string
}

interface FieldSpec {
  key: string
  label: Copy
  hint?: Copy
  placeholder?: Copy
  kind: 'text' | 'number' | 'select' | 'password'
  options?: Array<{ value: string; label: Copy }>
  required?: boolean
  /** 取值联动：不满足时整行隐藏（例如 urlMode=public 才需要公开地址）。 */
  visibleWhen?: (values: Record<string, string>) => boolean
  /** 宽字段：在两列网格里横跨整行（端点、公开地址这类长 URL）。 */
  wide?: boolean
}

const text = {
  groupBasic: { zh: '基本信息', en: 'Basics' },
  groupConnection: { zh: '连接', en: 'Connection' },
  groupAccess: { zh: '访问地址', en: 'Access URL' },
  groupCredentials: { zh: '凭据', en: 'Credentials' },
  name: { zh: '名称', en: 'Name' },
  namePlaceholder: { zh: '例如：主图床', en: 'e.g. primary image host' },
  region: { zh: '地域', en: 'Region' },
  regionHint: { zh: '存储桶所在地域，例如 oss-cn-hangzhou、oss-cn-beijing、oss-cn-shenzhen。', en: 'The bucket region, for example oss-cn-hangzhou, oss-cn-beijing, or oss-cn-shenzhen.' },
  bucket: { zh: '存储桶', en: 'Bucket' },
  bucketHint: { zh: '存储桶名称，例如 my-photos；不需要写地域后缀。', en: 'The bucket name, for example my-photos; no region suffix is needed.' },
  endpoint: { zh: '服务端点', en: 'Endpoint' },
  endpointHint: { zh: '留空使用默认域名 <bucket>.<region>.aliyuncs.com；私有化或专属域名时填写。', en: 'Leave empty for the default <bucket>.<region>.aliyuncs.com host; set it for private or dedicated domains.' },
  urlMode: { zh: '访问地址模式', en: 'URL mode' },
  urlModePublic: { zh: 'public · 公开读域名', en: 'public · public-read domain' },
  urlModeSigned: { zh: 'signed · 私有读签名', en: 'signed · private bucket' },
  urlModeHint: { zh: '存储桶公开读用 public；私有读用 signed。', en: 'Use public for public-read buckets; use signed for private buckets.' },
  publicUrl: { zh: '公开访问地址', en: 'Public URL prefix' },
  publicUrlHint: { zh: 'CDN 加速域名或公开读的存储桶域名；留空则使用端点地址。', en: 'CDN or public-read bucket domain; leave empty to use the endpoint.' },
  expires: { zh: '签名地址有效期（秒）', en: 'Signed URL lifetime (seconds)' },
  expiresHint: { zh: '范围 60–86400，默认 900。', en: 'Allowed range is 60–86400; default is 900.' },
  basePath: { zh: '基础路径', en: 'Base path' },
  basePathHint: { zh: '可选。所有照片对象都会写入此前缀目录。', en: 'Optional prefix for all uploaded photo objects.' },
  accessKeyId: { zh: 'AccessKey ID', en: 'AccessKey ID' },
  accessKeySecret: { zh: 'AccessKey Secret', en: 'AccessKey Secret' },
  stsToken: { zh: 'STS Token（可选）', en: 'STS token (optional)' },
  credentialsHint: {
    zh: '凭据只写入本机安全存储，界面读不回；留空表示保持原凭据。',
    en: 'Credentials go to the local secure store and are never read back; leave a field empty to keep the saved value.',
  },
  test: { zh: '测试连接', en: 'Test connection' },
  save: { zh: '保存存储源', en: 'Save source' },
  cancel: { zh: '取消', en: 'Cancel' },
  testing: { zh: '正在测试连接…', en: 'Testing connection…' },
  testOk: { zh: '连接正常。', en: 'Connection is healthy.' },
  testFailed: { zh: '连接失败', en: 'Connection failed' },
  saving: { zh: '正在保存…', en: 'Saving…' },
  saved: { zh: '已保存存储源', en: 'Storage source saved' },
  requiredName: { zh: '请填写名称。', en: 'A name is required.' },
  requiredRegion: { zh: '请填写地域，例如 oss-cn-hangzhou。', en: 'Region is required, for example oss-cn-hangzhou.' },
  requiredBucket: { zh: '请填写存储桶名称。', en: 'A bucket name is required.' },
  requiredCredentials: { zh: '新建存储源需要填写 AccessKey ID 与 AccessKey Secret。', en: 'A new source needs an AccessKey ID and an AccessKey Secret.' },
}

const CONFIG_FIELDS: FieldSpec[] = [
  { key: 'region', kind: 'text', label: text.region, hint: text.regionHint, placeholder: { zh: 'oss-cn-hangzhou', en: 'oss-cn-hangzhou' }, required: true },
  { key: 'bucket', kind: 'text', label: text.bucket, hint: text.bucketHint, placeholder: { zh: 'my-photos', en: 'my-photos' }, required: true },
  {
    key: 'endpoint', kind: 'text', label: text.endpoint, hint: text.endpointHint, wide: true,
    // OSS 会自动拼 <bucket>.<region>.aliyuncs.com，端点只在私有化/专属域名时填写。
    placeholder: { zh: 'https://oss-cn-hangzhou.aliyuncs.com', en: 'https://oss-cn-hangzhou.aliyuncs.com' },
  },
  {
    key: 'urlMode', kind: 'select', label: text.urlMode, hint: text.urlModeHint,
    options: [{ value: 'public', label: text.urlModePublic }, { value: 'signed', label: text.urlModeSigned }],
  },
  {
    // 不设 wide：与「访问地址模式」同处一行（signed 模式下与签名有效期配对），
    // 否则它前面的选择框会在两列网格里空出半格。
    key: 'publicUrl', kind: 'text', label: text.publicUrl, hint: text.publicUrlHint,
    placeholder: { zh: 'https://img.example.com', en: 'https://img.example.com' },
    visibleWhen: values => values.urlMode === 'public',
  },
  {
    key: 'signedUrlExpiresSeconds', kind: 'number', label: text.expires, hint: text.expiresHint,
    placeholder: { zh: '900', en: '900' },
    visibleWhen: values => values.urlMode === 'signed',
  },
  { key: 'basePath', kind: 'text', label: text.basePath, hint: text.basePathHint, placeholder: { zh: 'photos', en: 'photos' } },
]

/**
 * 分组只是展示顺序：连接相关的字段（含上传前缀）在一块，访问地址相关的在一块。
 * 用显式键名而不是数组下标，改动字段顺序时不会静默串组。
 */
const CONNECTION_KEYS = ['region', 'bucket', 'endpoint', 'basePath']
const ACCESS_KEYS = ['urlMode', 'publicUrl', 'signedUrlExpiresSeconds']

function configField(key: string): FieldSpec {
  const spec = CONFIG_FIELDS.find(item => item.key === key)
  if (!spec) throw new Error(`unknown config field: ${key}`)
  return spec
}

const CREDENTIAL_FIELDS: FieldSpec[] = [
  { key: 'accessKeyId', kind: 'password', label: text.accessKeyId, required: true },
  { key: 'accessKeySecret', kind: 'password', label: text.accessKeySecret, required: true },
  { key: 'stsToken', kind: 'password', label: text.stsToken },
]

/** 名称不属于 config（进程侧不读它），单独成一条字段规格。 */
const NAME_FIELD: FieldSpec = {
  key: 'name', kind: 'text', label: text.name, placeholder: text.namePlaceholder, required: true, wide: true,
}

/** 与进程侧 readConfig() 一致的默认值。 */
const DEFAULTS: Record<string, string> = {
  urlMode: 'public',
  signedUrlExpiresSeconds: '900',
}

const client = createPluginUiClient()
const root = document.getElementById('app')
if (!root) throw new Error('missing #app root')

let context: PluginUiInitPayload | undefined
let editing = false
let built = false

const locale = (): Locale => (context?.locale === 'en' ? 'en' : 'zh')
const pick = (value: Copy) => value[locale()]

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

/** 文本节点带 data-copy 键，locale/theme 变化时只需重刷文本，不动输入值。 */
function copyNode(key: string, value: Copy): HTMLParagraphElement | HTMLSpanElement {
  const node = element('span')
  node.dataset.copy = key
  node.textContent = pick(value)
  return node
}

interface FieldRef {
  spec: FieldSpec
  row: HTMLDivElement
  input: HTMLInputElement | HTMLSelectElement
}

const fieldRefs = new Map<string, FieldRef>()
let statusNode: HTMLParagraphElement | undefined

function buildField(spec: FieldSpec, value: string): FieldRef {
  const row = element('div', spec.wide ? 'mo-field mo-wide' : 'mo-field')
  const label = element('label', 'mo-label')
  label.htmlFor = `f-${spec.key}`
  label.textContent = `${pick(spec.label)}${spec.required ? ' *' : ''}`
  label.dataset.copyLabel = `${spec.key}`

  let input: HTMLInputElement | HTMLSelectElement
  if (spec.kind === 'select') {
    const select = element('select', 'mo-input')
    for (const option of spec.options ?? []) {
      const node = element('option')
      node.value = option.value
      node.dataset.copy = `opt-${spec.key}-${option.value}`
      node.textContent = pick(option.label)
      select.appendChild(node)
    }
    input = select
  } else {
    const textInput = element('input', 'mo-input')
    textInput.type = spec.kind === 'password' ? 'password' : spec.kind === 'number' ? 'number' : 'text'
    if (spec.kind === 'password') textInput.autocomplete = 'new-password'
    if (spec.placeholder) {
      textInput.placeholder = pick(spec.placeholder)
      textInput.dataset.copyPlaceholder = `${spec.key}`
    }
    input = textInput
  }
  input.id = `f-${spec.key}`
  input.value = value
  input.addEventListener('input', () => {
    markDirty()
    syncVisibility()
  })
  input.addEventListener('change', syncVisibility)

  row.append(label, input)
  if (spec.hint) {
    const hint = element('p', 'mo-hint')
    hint.dataset.copy = `hint-${spec.key}`
    hint.textContent = pick(spec.hint)
    row.appendChild(hint)
  }
  const ref: FieldRef = { spec, row, input }
  fieldRefs.set(spec.key, ref)
  return ref
}

/**
 * 标题 + 字段网格。字段放在网格里而不是直接塞进 section，是为了在窗口变宽时
 * 走两列（与宿主自己的表单同一断点 sm:640px），窗口收窄时自动回到单列。
 */
function section(title: Copy): { root: HTMLElement; grid: HTMLElement } {
  const wrapper = element('section', 'mo-section')
  const heading = element('h2', 'mo-section-title')
  heading.dataset.copy = `section-${title.en}`
  heading.textContent = pick(title)
  const grid = element('div', 'mo-grid')
  wrapper.append(heading, grid)
  return { root: wrapper, grid }
}

function currentValues(): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [key, ref] of fieldRefs) values[key] = ref.input.value
  return values
}

function syncVisibility(): void {
  const values = currentValues()
  for (const ref of fieldRefs.values()) {
    const visible = ref.spec.visibleWhen ? ref.spec.visibleWhen(values) : true
    ref.row.classList.toggle('mo-hidden', !visible)
  }
}

function markDirty(): void {
  client.setDirty(true)
}

function setBusy(busy: boolean): void {
  for (const button of root!.querySelectorAll('button')) button.disabled = busy
}

function setStatus(message: string, state: 'ok' | 'error' | 'pending' | ''): void {
  if (!statusNode) return
  statusNode.textContent = message
  statusNode.dataset.state = state
}

/** 与宿主表单同样逐字段原样提交：留空的键交给进程侧 readConfig() 按默认值处理。 */
function configPayload(values: Record<string, string>): Record<string, string> {
  const config: Record<string, string> = {}
  for (const spec of CONFIG_FIELDS) config[spec.key] = values[spec.key] ?? ''
  return config
}

function credentialPayload(values: Record<string, string>): Record<string, string> {
  const credentials: Record<string, string> = {}
  for (const spec of CREDENTIAL_FIELDS) credentials[spec.key] = values[spec.key] ?? ''
  return credentials
}

function validationError(values: Record<string, string>): string | undefined {
  if (!(values.name ?? '').trim()) return pick(text.requiredName)
  if (!(values.region ?? '').trim()) return pick(text.requiredRegion)
  if (!(values.bucket ?? '').trim()) return pick(text.requiredBucket)
  if (!editing && (!(values.accessKeyId ?? '').trim() || !(values.accessKeySecret ?? '').trim())) return pick(text.requiredCredentials)
  return undefined
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function testConnection(): Promise<void> {
  const values = currentValues()
  const invalid = validationError(values)
  if (invalid) {
    setStatus(invalid, 'error')
    return
  }
  setBusy(true)
  setStatus(pick(text.testing), 'pending')
  try {
    // 宿主用合成来源跑一次 source.validate + plugin.health，不落库；
    // 编辑已有来源时留空的凭据由宿主回落到已保存的值。
    const health = await client.testSource({ config: configPayload(values), credentials: credentialPayload(values) })
    if (health.status === 'ready') setStatus(pick(text.testOk), 'ok')
    else setStatus(`${pick(text.testFailed)}${health.message ? `：${health.message}` : ''}`, 'error')
  } catch (error) {
    setStatus(describeError(error), 'error')
  } finally {
    setBusy(false)
  }
}

async function save(): Promise<void> {
  const values = currentValues()
  const invalid = validationError(values)
  if (invalid) {
    setStatus(invalid, 'error')
    return
  }
  setBusy(true)
  setStatus(pick(text.saving), 'pending')
  try {
    await client.saveSource({
      name: (values.name ?? '').trim(),
      config: configPayload(values),
      credentials: credentialPayload(values),
    })
    client.setDirty(false)
    client.notify(pick(text.saved), 'success')
    client.close()
  } catch (error) {
    setStatus(describeError(error), 'error')
    setBusy(false)
  }
}

function refreshCopy(): void {
  for (const node of root!.querySelectorAll<HTMLElement>('[data-copy]')) {
    const key = node.dataset.copy ?? ''
    const found = copyByKey(key)
    if (found) node.textContent = pick(found)
  }
  for (const ref of fieldRefs.values()) {
    const label = ref.row.querySelector<HTMLElement>('.mo-label')
    if (label) label.textContent = `${pick(ref.spec.label)}${ref.spec.required ? ' *' : ''}`
    if (ref.spec.placeholder && ref.input instanceof HTMLInputElement) {
      ref.input.placeholder = pick(ref.spec.placeholder)
    }
  }
}

function copyByKey(key: string): Copy | undefined {
  if (key.startsWith('hint-')) return CONFIG_FIELDS.find(f => f.key === key.slice(5))?.hint
  if (key.startsWith('opt-')) {
    const [, fieldKey, optionValue] = key.split('-')
    return CONFIG_FIELDS.find(f => f.key === fieldKey)?.options?.find(o => o.value === optionValue)?.label
  }
  const entries: Array<[string, Copy]> = [
    ['section-Basics', text.groupBasic],
    ['section-Connection', text.groupConnection],
    ['section-Access URL', text.groupAccess],
    ['section-Credentials', text.groupCredentials],
    ['credentialsHint', text.credentialsHint],
    ['action-cancel', text.cancel],
    ['action-test', text.test],
    ['action-save', text.save],
  ]
  return entries.find(([name]) => name === key)?.[1]
}

function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = theme
}

/**
 * 把宿主下发的设计令牌写到自己文档的 `:root` 上。界面是不透明源的沙箱 iframe，
 * 读不到宿主的样式表 —— 这条通道让 app.css 能直接用 `var(--foreground)` 这类与
 * desktop 同名的变量，从而复用桌面端的字体 / 配色 / 圆角，而不是自备一套。
 * 老宿主不下发令牌时什么都不做，样式退回 app.css 里的兜底值。
 */
function applyTokens(tokens: Record<string, string> | undefined): void {
  if (!tokens) return
  const root = document.documentElement
  for (const [name, value] of Object.entries(tokens)) {
    // 只收下「宿主变量名」这种形状的键，避免任何意外内容出现在样式表里。
    if (typeof value !== 'string' || !value.trim()) continue
    if (!/^[a-z][a-z0-9-]*$/.test(name)) continue
    root.style.setProperty(`--${name}`, value)
  }
}

function render(next: PluginUiInitPayload): void {
  const previousLocale = context?.locale
  context = next
  editing = next.editing
  applyTheme(next.theme)
  applyTokens(next.tokens)

  if (!built) {
    built = true
    const initial = (key: string) => next.config[key] ?? DEFAULTS[key] ?? ''
    const append = (target: HTMLElement, spec: FieldSpec, value?: string) =>
      target.appendChild(buildField(spec, value ?? initial(spec.key)).row)

    const basic = section(text.groupBasic)
    // 名称不在 config 里：新增时沿用插件名，编辑时是已存来源的名称。
    append(basic.grid, NAME_FIELD, next.sourceName || next.pluginName)

    const connection = section(text.groupConnection)
    for (const key of CONNECTION_KEYS) append(connection.grid, configField(key))

    const access = section(text.groupAccess)
    for (const key of ACCESS_KEYS) append(access.grid, configField(key))

    const credentials = section(text.groupCredentials)
    const credentialsHint = element('p', 'mo-hint')
    credentialsHint.dataset.copy = 'credentialsHint'
    credentialsHint.textContent = pick(text.credentialsHint)
    credentials.root.insertBefore(credentialsHint, credentials.grid)
    for (const spec of CREDENTIAL_FIELDS) append(credentials.grid, spec)

    statusNode = element('p', 'mo-status')
    statusNode.setAttribute('role', 'status')
    statusNode.setAttribute('aria-live', 'polite')

    const actions = element('div', 'mo-actions')
    const cancel = element('button', 'mo-btn')
    cancel.type = 'button'
    cancel.dataset.copy = 'action-cancel'
    cancel.textContent = pick(text.cancel)
    cancel.addEventListener('click', () => client.close())
    const test = element('button', 'mo-btn')
    test.type = 'button'
    test.dataset.copy = 'action-test'
    test.textContent = pick(text.test)
    test.addEventListener('click', () => void testConnection())
    const submit = element('button', 'mo-btn mo-btn-primary')
    submit.type = 'button'
    submit.dataset.copy = 'action-save'
    submit.textContent = pick(text.save)
    submit.addEventListener('click', () => void save())
    actions.append(cancel, test, submit)

    const form = element('div', 'mo-form')
    form.append(basic.root, connection.root, access.root, credentials.root, statusNode, actions)
    root!.replaceChildren(form)
    syncVisibility()
    return
  }

  // 主题或语言变化会再推一次 init；只刷新文案与主题，不动用户已填的值。
  if (previousLocale !== undefined && previousLocale !== next.locale) refreshCopy()
  syncVisibility()
}

client.onInit(render)
