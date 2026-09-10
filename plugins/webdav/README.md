# mo-gallery-plugin-webdav

MO Gallery Desktop 的通用 WebDAV 存储源插件。任何标准 WebDAV 服务器都可以作为照片存储端点：

- **飞牛云（fnOS）** — 内置推荐场景，WebDAV 地址通常为 `http://<IP>:5666/dav`
- 坚果云 — `https://dav.jianguoyun.com/dav/`
- Nextcloud / ownCloud — `https://<域名>/remote.php/dav/files/<用户名>`
- 群晖 DSM、Alist、Apache/nginx WebDAV 等所有标准实现

插件以独立 Node.js 进程运行（宿主使用打包的 Node 22），通过 JSON-RPC over stdio
与 Desktop 宿主通信，遵循 `storage@1` 能力域（core API `1`）。

## 构建

本仓库刻意位于 mo-gallery-web workspace 之外（与 mo-gallery-plugin-s3 一致）：

```bash
pnpm install
pnpm build    # tsc 类型检查 + esbuild 产出 dist/main.js（自包含 bundle）
pnpm test     # 契约测试：fake WebDAV 服务器 + SDK fake-host
```

运行时零第三方依赖（仅 `@mo-gallery/desktop-plugin-sdk`），WebDAV 客户端基于
`node:http`/`node:https` 手写实现。

## 飞牛云（fnOS）配置示例

| 配置项 | 值 |
|---|---|
| WebDAV 地址 | `http://192.168.1.10:5666/dav` |
| 用户名 / 密码 | fnOS 账号（或在 fnOS 中创建的应用密码） |
| 基础路径（可选） | `photos` |

fnOS 需先在「文件管理 → WebDAV」中启用服务并允许该账号访问。

## 通用配置

| 字段 | 必填 | 说明 |
|---|---|---|
| `url` | ✅ | WebDAV 根地址（不需要尾部斜杠） |
| `basePath` | 可选 | 上传对象的子目录前缀（由宿主解析进 key，插件不二次拼接） |
| `publicUrl` | 可选 | 服务器经反向代理公开暴露对象时的公开 URL 前缀；填写后对象 URL 使用该前缀 |

凭据：`username` / `password`（Basic Auth），存于操作系统凭据库，通过环境变量
注入插件进程；凭据绝不出现在 manifest、RPC 参数或日志中（SDK logger 自动脱敏）。

## 能力映射

| capability | WebDAV 方法 |
|---|---|
| `plugin.health` / `source.validate` | `PROPFIND depth:0`（10s 超时） |
| `object.put` | `PUT`（流式上传，ETag 或 sha256 校验） |
| `object.get` | `GET`（流式回传 transfer 通道） |
| `object.stat` | `PROPFIND depth:0` |
| `object.list` | `PROPFIND depth:1` + 客户端游标分页 |
| `object.move` | `MOVE`（服务端移动） |
| `object.delete` | `DELETE` |
| `object.getUrl` | 直链 / 公开前缀 URL |
| `checksum` | ETag（md5 强校验可用时） |
| `idempotency` | PUT 同 key 覆写语义 |

已知限制：Basic Auth 保护的服务器上，`object.getUrl` 返回的直链在浏览器中打开
需要手动输入凭据；需要免认证直链时配置 `publicUrl`（配反向代理公开暴露对象）。

## 发布

上架市场需要：`desktop/build/package-desktop-plugin.mjs` 用发布 Ed25519 私钥生成
签名 ZIP → 上传 `ushaio/mo-gallery-plugin` Release → 更新 `index.json`。详见
[PLUGIN.md](./PLUGIN.md) 与 mo-gallery-web 仓库 `docs/plugin-system/marketplace-repository.md`。
