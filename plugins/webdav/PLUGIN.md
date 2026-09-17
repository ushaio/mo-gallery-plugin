# WebDAV Desktop plugin (飞牛云 / 通用)

This is an external third-party Node storage plugin. The same `dist/main.js` runs
on Windows x64, macOS x64/arm64, and Linux x64/arm64 when Desktop supplies its
bundled Node 22 runtime.

The plugin is a hand-written WebDAV client on `node:http`/`node:https` with zero
runtime dependencies beyond `@mo-gallery/plugin-sdk`. It supports a
WebDAV root URL, optional base path, public URL prefixes, Basic Authentication,
streaming upload and download, PROPFIND-based listing with client-side cursor
pagination, server-side MOVE, delete, stat, ETag checksums, idempotent PUT
semantics, and retrying 5xx / network failures.

## fnOS (飞牛云)

For a fnOS source, enable WebDAV in fnOS file management, then set `url` to
`http://<fnos-ip>:5666/dav` and provide the fnOS username and password in the
credential fields. Set an optional `basePath` such as `photos` to keep uploads
in one directory. Use `publicUrl` only when objects are exposed through a
reverse proxy without authentication; when it is empty the object URL is the
WebDAV address itself.

Credentials are read only through the SDK credential reference adapter. They
are never included in plugin manifest data, RPC parameters, or logs.

Build with `pnpm build`; the script emits one bundled `dist/main.js` without
native dependencies. Copy that file together with `manifest.json` into a
package, generate `checksums.json`, and sign the checksum file with the release
Ed25519 key before distribution.
