# MO Gallery Plugin Marketplace

MO Gallery Desktop 的官方插件市场索引。Desktop 从以下两个固定地址读取插件清单
`index.json` 与市场分栏词表 `categories.json`（客户端把后者直接当分类 API 用，两个地址
由宿主写死，索引里改不了）：

```text
https://raw.githubusercontent.com/ushaio/mo-gallery-plugin/master/index.json
https://raw.githubusercontent.com/ushaio/mo-gallery-plugin/master/categories.json
```

这个仓库保存市场元数据、GitHub Release 资产，以及 `plugins/` 目录下的官方插件源码。
第三方插件源码在各自仓库维护；市场中的安装包仍须通过 Desktop 的 manifest、checksum、
Ed25519 签名、运行时和兼容性校验。

## 当前状态

索引使用 Schema 1。只有签名安装包已经发布并完成校验的插件才会加入索引。官方插件
源码位于本仓库 `plugins/` 目录，开发流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 图片预览扩展

[Hasselblad 3FR](plugins/hasselblad-3fr/README.md) 使用同一套 JSON-RPC 插件系统的
`image-preview@1` 能力，为资源库提供 3FR 内嵌 JPEG 预览；缩略图与详情预览由宿主接入。
它不是完整 RAW 显影器，也不是需要手动启动的资源分析任务。v0.1.0 已发布签名安装包并
收录进市场索引（同时归到「图片处理」与「格式扩展」两栏），需要支持 `image-preview@1` 的新版 Desktop。

### 资源库人脸（`faces@1`）

[Faces](plugins/faces/README.md) 把资源库的人脸功能做成插件：贡献 `faces@1` 域，用 YuNet 检测
人脸框与五点关键点、用 SFace 提取 128 维特征，模型权重仍由宿主下载校验后通过只读目录交给插件
（不塞进插件包，也不让每个用户重复下 39 MB）。它只声明 `addons:onnx`——加载 ONNX Runtime
原生模块所需的唯一放宽；插件不读资源库数据库、不写任何目录，素材身份、聚类与墓碑语义全部留在
宿主。**尚未收录进市场索引**：按本仓库规则，只有已发布签名安装包并完成校验的插件才能登记，
源码先就位，安装包发布后再补索引条目。

开发安装和测试方式见插件 README。

## 插件能力声明

`plugins[].permissions` 让插件在索引里公开它**进程**需要什么能力（插件进程按声明被关进对应的权限
范围里，宿主在安装与启动时都会校验）。当前登记过的能力有五条：`network:configured-endpoint`、
`sqlite:data:read`、`sqlite:data:read-write`、`sqlite:library:read`、`addons:onnx` —— 写别的会被
`npm run check` 直接拒绝，因为旧客户端遇到未登记的能力会拒绝安装。

需要 SQLite 的插件用插件私有数据目录（`<配置目录>/storage-plugins/<插件 id>/data/`）建库，并在
可选的 `sqlite` 块里写明会建哪几个库、要多大配额：

```json
{
  "permissions": ["sqlite:data:read-write"],
  "sqlite": { "databases": ["faces.sqlite"], "quotaBytes": 268435456 }
}
```

完整的能力表、作用域语义、界面文案与新增能力的流程见 [CAPABILITIES.md](CAPABILITIES.md)；
宿主的执行方式（拼哪些 Node 参数、环境变量、配额与失败语义）见
`emulsion-desktop-v3/docs/plugin-capabilities.md`。

## 市场分类

`categories.json` 是市场分栏的唯一来源：Desktop 拉取它渲染左栏，栏名取 `name` 里当前界面
语言的键（至少要有 `zh` / `en`，可以加语言键），顺序就是数组顺序。**加一栏只要在 GitHub 上
加一个条目，不需要发客户端版本。**

- `plugins[].category` 引用这里的 `id`，字符串与字符串数组都收；写数组表示一个插件同时挂在
  多栏下，Desktop 会在每一栏里各列一次（左栏计数也按栏各算一次）。
- 插件没写 `category` 时，Desktop 按它的 `contributions[].domain` 查 `domains` 反推分栏
  （`image-preview` → `image`、`library` → `library`、`storage` → `storage`；`ui` 刻意不映射）。
  这样即使读到 15 分钟内还没更新的本地缓存旧索引、或第三方索引没写分类，也不会整栏倒进「其他」。
- 未声明过的 slug 不会被丢弃：Desktop 会把它原样显示成一栏（排在已声明分类之后），
  所以索引先加分类、客户端后跟进也不会丢东西。

`npm run check` 会交叉校验这两份文件：引用没声明过的分类、同一插件里重复的分类、被两栏
同时认领的能力域，都会直接失败。

## 插件名称与介绍的语言

`plugins[].name` 与 `plugins[].description` 随界面语言切换：直接写一个字符串表示各语言共用同一句
（老索引、第三方索引不受影响）；写成「语言代码 → 文案」就按客户端当前界面语言取，取不到再退回
另一种。映射里 `zh` 与 `en` 都必须给 —— 只给一种时，另一种语言的界面会直接显示外语，而作者在
索引里看不出这个问题，所以 `npm run check` 会挡住。中英之外可以继续加语言键（如 `ja`）。

## 本地校验

需要 Node.js 22 或更高版本，不需要安装依赖：

```bash
npm run check
```

发布资产上传后，可以下载每个资产并核对实际大小和 SHA-256：

```bash
npm run check:assets
```

索引契约见 [schema/index.schema.json](schema/index.schema.json) 与
[schema/categories.schema.json](schema/categories.schema.json)，完整收录流程见
[CONTRIBUTING.md](CONTRIBUTING.md)。宿主的权威解析实现位于
`emulsion-desktop-v3/storage_plugins/marketplace.go`。

## 安全边界

- 索引只允许 `ushaio/mo-gallery-plugin` GitHub Release 下的 HTTPS 资产。
- 插件签名私钥不得进入仓库、Release 资产或 CI 日志。
- 更新索引不能替代安装包内的 `checksums.json` 与 `signature.sig`。
- 已发布的版本资产应保持不可变；修复内容必须发布新版本。
