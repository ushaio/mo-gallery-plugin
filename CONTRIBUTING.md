# 插件收录与发布

## 准入要求

提交市场索引前，插件必须满足以下条件：

1. 使用 Desktop 当前支持的 manifest 和 Plugin Core API。
2. 每个 ZIP 根目录包含 `manifest.json`、`checksums.json`、`signature.sig` 以及入口产物。
3. `checksums.json` 覆盖包内除自身和签名外的全部文件。
4. `signature.sig` 使用 Desktop 信任的 Ed25519 发布密钥签署 `checksums.json` 的原始字节。
5. 包内没有符号链接、重复路径、绝对路径或目录穿越路径。
6. 插件源码、权限、凭据使用和网络访问已经完成评审。

## 发布流程

1. 在插件源码仓库运行构建、类型检查和 contract tests。
2. 使用 MO Gallery 的 `desktop/build/package-desktop-plugin.mjs` 生成签名 ZIP。
3. 创建中央仓库 Release，并使用不可变的版本化文件名上传各平台资产。
4. 计算 Release 资产的实际字节数和 SHA-256。
5. 在 `index.json` 中新增或更新插件条目，并更新 UTC `updatedAt`。
6. 运行 `npm run check:assets`，确认索引和远程资产完全一致。
7. 提交 Pull Request；不要在同一个版本号下替换既有资产。

Node 插件由 Desktop 内置的 Node 22 运行时启动，同一纯 JavaScript ZIP 可以映射到多个
平台键。原生 executable 插件必须为每个平台提供对应产物。

## 索引约定

- 插件 ID 在整个市场中唯一，只能包含 ASCII 字母、数字、点、下划线和连字符。
- 版本使用 `major.minor.patch`，可以带 `v` 前缀和预发布后缀。
- `coreApiVersion` 当前为 `1`。
- 平台键仅限 `windows-amd64`、`darwin-amd64`、`darwin-arm64`、
  `linux-amd64`、`linux-arm64`。
- `sha256` 使用 64 位小写十六进制，不带 `sha256:` 前缀。
- `size` 是 Release ZIP 的准确字节数，且必须大于 0、不超过 256 MiB。

## Pull Request 检查

- 说明插件用途、源码仓库和发布版本。
- 列出构建与 contract test 结果。
- 列出申请的 contributions、permissions 和 signing key ID。
- 确认所有资产都通过 `npm run check:assets`。
- 安全相关变更按 [SECURITY.md](SECURITY.md) 私下报告，不在公开 Issue 中披露密钥或漏洞细节。
