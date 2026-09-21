# Changelog

本文件记录 **mo-gallery-plugin**（插件市场索引 `index.json` + 官方插件源码 `plugins/`）的发布更新日志；每个版本一个条目，包含 `feat`（新功能）与 `fix`（问题修复）两部分，条目使用有序列表。

## 写法约定

1. 本仓库的版本以**插件**为单位（如 `s3-compatible`、`webdav`、`github`），索引整体版本另计；条目请标注插件名与版本，例如 `s3-compatible v0.1.3`。
2. 开发中的改动先写在文件顶部的 `[Unreleased]` 下；发布时把它改成 `## [<插件名> v<x.y.z>] - YYYY-MM-DD`，并在最上方新增一个空的 `## [Unreleased]`。
3. 条目按 Conventional Commits 归类：`feat:` 归 `feat`，`fix:` 归 `fix`；索引收录、签名包发布等流程改动只有在影响使用者时才记入。
4. 一条 = 一个用户可感知的变化；同一功能的多条提交合并成一条，不要直接照抄 commit message。
5. `feat` 与 `fix` 两部分始终保留；确实没有对应改动时写 `1. 暂无`。
6. 发布前仍须执行 `npm run check`（发布资产用 `npm run check:assets`）。

> 本文件于 2026-09-18 启用，不回溯此前的历史。下面的 `[Unreleased]` 收录启用时仍在开发中（2026-09-15 起提交）的改动。

## [Unreleased]

### feat

1. 暂无

### fix

1. `s3-compatible`：流式传输改为按需计算校验和（`requestChecksumCalculation=WHEN_REQUIRED`），修复部分 S3 兼容存储的流式上传失败（`5960537`）
