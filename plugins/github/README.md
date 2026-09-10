# GitHub 仓库 Desktop plugin

This is an external third-party Node storage plugin. The same `dist/main.js` runs
on Windows x64, macOS x64/arm64, and Linux x64/arm64 when Desktop supplies its
bundled Node 22 runtime.

The plugin stores objects as commits in a GitHub repository through the
Contents API (`/repos/{owner}/{repo}/contents/...`). It supports GitHub.com and
GitHub Enterprise Server (set `apiUrl` to `https://<host>/api/v3`), branch
selection with automatic default-branch detection, a base path prefix, public
raw URLs (`raw.githubusercontent.com` by default), idempotent uploads,
streaming downloads, listing, move (download → new commit → delete commit), and
delete.

## 表单字段

| 字段 | 必填 | 说明 |
|---|---|---|
| 仓库所有者（owner） | 是 | GitHub 用户名或组织名 |
| 仓库名称（repo） | 是 | 目标仓库名 |
| 分支（branch） | 否 | 留空自动使用仓库默认分支 |
| 基础路径（basePath） | 否 | 对象写入的目录前缀 |
| API 地址（apiUrl） | 否 | GitHub Enterprise 填 `https://<域名>/api/v3` |
| 原始文件地址前缀（rawUrl） | 否 | 留空使用 `raw.githubusercontent.com/{owner}/{repo}` |
| 访问令牌（token） | 是 | Personal Access Token：classic 勾选 `repo`，或 fine-granted 授予 Contents read/write |

## 限制

- The Contents API refuses files at 100 MiB; the plugin rejects larger uploads
  with a clear error instead of a failed commit. Use the S3 plugin for large
  originals.
- Every upload, move, or delete creates a Git commit on the target branch.
- Returned URLs are raw file URLs: public repositories can be fetched directly;
  private repository URLs require the token (set `rawUrl` to a proxy if you
  need unauthenticated access).

Credentials are read only through the SDK credential reference adapter. They
are never included in plugin manifest data, RPC parameters, or logs.

Build with `pnpm --filter @mo-gallery/desktop-plugin-github build`; the script
emits one bundled `dist/main.js` without native dependencies. Copy that file
together with `manifest.json` into a package, generate `checksums.json`, and
sign the checksum file with the release Ed25519 key before distribution.
