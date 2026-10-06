# MO Gallery Plugin Marketplace

MO Gallery Desktop 的官方插件市场索引。Desktop 从以下固定地址读取
`index.json`：

```text
https://raw.githubusercontent.com/ushaio/mo-gallery-plugin/master/index.json
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
收录进市场索引（归到「图片处理」栏），需要支持 `image-preview@1` 的新版 Desktop。

开发安装和测试方式见插件 README。

## 本地校验

需要 Node.js 22 或更高版本，不需要安装依赖：

```bash
npm run check
```

发布资产上传后，可以下载每个资产并核对实际大小和 SHA-256：

```bash
npm run check:assets
```

索引契约见 [schema/index.schema.json](schema/index.schema.json)，完整收录流程见
[CONTRIBUTING.md](CONTRIBUTING.md)。宿主的权威解析实现位于
`emulsion-desktop-v3/storage_plugins/marketplace.go`。

## 安全边界

- 索引只允许 `ushaio/mo-gallery-plugin` GitHub Release 下的 HTTPS 资产。
- 插件签名私钥不得进入仓库、Release 资产或 CI 日志。
- 更新索引不能替代安装包内的 `checksums.json` 与 `signature.sig`。
- 已发布的版本资产应保持不可变；修复内容必须发布新版本。
