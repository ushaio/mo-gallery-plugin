# MO Gallery Plugin Marketplace

MO Gallery Desktop 的官方插件市场索引。Desktop 从以下固定地址读取
`index.json`：

```text
https://raw.githubusercontent.com/ushaio/mo-gallery-plugin/master/index.json
```

这个仓库只保存市场元数据和 GitHub Release 资产，不保存插件源码。插件源码在各自
仓库维护；市场中的安装包仍须通过 Desktop 的 manifest、checksum、Ed25519 签名、
运行时和兼容性校验。

## 当前状态

索引使用 Schema 1。仓库初始化时保持空索引；插件只有在签名安装包已经发布并完成
校验后才能加入。当前候选插件包括：

- `s3-compatible`：源码位于 `mo-gallery-plugin-s3`，尚未发布到市场。
- GitHub storage plugin：源码仓库尚未完成 SDK 化实现，不应加入索引。

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
`mo-gallery-web/desktop/storage_plugins/marketplace.go`。

## 安全边界

- 索引只允许 `ushaio/mo-gallery-plugin` GitHub Release 下的 HTTPS 资产。
- 插件签名私钥不得进入仓库、Release 资产或 CI 日志。
- 更新索引不能替代安装包内的 `checksums.json` 与 `signature.sig`。
- 已发布的版本资产应保持不可变；修复内容必须发布新版本。
