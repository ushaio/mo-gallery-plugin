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

官方插件源码位于本仓库 `plugins/` 目录；第三方插件在各自仓库。

1. 在插件目录运行构建、类型检查和 contract tests（官方插件：`cd plugins/<name> && pnpm install && pnpm build && pnpm test`）。
2. 使用 `emulsion-desktop/build/package-desktop-plugin.mjs` 生成签名 ZIP。
3. 创建中央仓库 Release，并使用不可变的版本化文件名上传各平台资产。
4. 计算 Release 资产的实际字节数和 SHA-256。
5. 在 `index.json` 中新增或更新插件条目，并更新 UTC `updatedAt`；若本次要新增分类，同时在
   `categories.json` 里加好条目并更新它的 UTC `updatedAt`。
6. 运行 `npm run check:assets`，确认索引和远程资产完全一致。
7. 提交 Pull Request；不要在同一个版本号下替换既有资产。

Node 插件由 Desktop 内置的 Node 22 运行时启动，同一纯 JavaScript ZIP 可以映射到多个
平台键。原生 executable 插件必须为每个平台提供对应产物。

## 索引约定

- 插件 ID 在整个市场中唯一，只能包含 ASCII 字母、数字、点、下划线和连字符。
- 版本使用 `major.minor.patch`，可以带 `v` 前缀和预发布后缀。
- `coreApiVersion` 当前为 `1`。
- `name`（必填）与 `description` 支持国际化：直接写一个字符串表示每个界面语言都用它；写成
  「界面语言代码 → 文案」就跟着界面语言切换，映射里 `zh` 与 `en` 必须都给——只给一种的话，
  另一种语言的界面会直接显示外语，而作者在索引里看不出这个问题，所以 `npm run check` 会挡住。
- `category` 可选，决定插件在客户端市场页的分栏（左栏垂直列出各分类，插件归到对应分类下）：
  取值是 `categories.json` 里声明过的分类 id；字符串与字符串数组都收，写多个表示同时挂在多栏下
  （「全部」视图里它会在每一栏各列一次）。省略时客户端按插件的 `contributions[].domain` 反推，
  映射写在 `categories.json` 的 `domains` 里，推不出来才落进「其他」栏。
- **新增分类请改 `categories.json`，不要改客户端代码**：那份文件就是分类 API，客户端直接拉它渲染
  左栏 —— 栏名（`name.zh` / `name.en`，可继续加语言键）与顺序（数组顺序）都由它决定。`npm run check`
  会拒绝没声明过的取值、同一插件里的重复取值，以及被两栏同时认领的能力域。
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
