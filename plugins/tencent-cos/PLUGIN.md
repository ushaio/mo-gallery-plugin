# Tencent Cloud COS Desktop plugin

This is an external third-party Node storage plugin. The same `dist/main.js` runs
on Windows x64, macOS x64/arm64, and Linux x64/arm64 when Desktop supplies its
bundled Node 22 runtime.

The plugin uses `cos-nodejs-sdk-v5`, the SDK Tencent publishes for Node. It
supports region, bucket, endpoint, base path, public URL prefixes, temporary
signed URLs, checksum headers, idempotency metadata, object metadata, streaming
get, listing, move, and delete.

## Configuration

Point the source at a COS bucket by giving the bucket's full name **including the
APPID suffix**, for example `my-photos-1250000000`, plus the bucket region such
as `ap-shanghai`. COS validates that shape (`name-1250000000`) on every request,
so a bucket name without the suffix is rejected by the service rather than by the
plugin.

`endpoint` is optional and exists for private or dedicated domains. Leave it
empty to reach `https://<bucket>.cos.<region>.myqcloud.com`.

The plugin deliberately has **no** path-style switch. The COS SDK refuses to
construct a client when `ForcePathStyle` is set, so the option could never take
effect and is not offered in the form.

Provide the account SecretId and SecretKey in the credential fields. Temporary
credentials from STS additionally need the session token.

## Signed URL lifetimes

`urlMode=public` builds plain object URLs from `publicUrl` when it is set,
otherwise from the endpoint. `urlMode=signed` signs each URL through the SDK with
`signedUrlExpiresSeconds`, which is clamped to the 60–86400 second range and
defaults to 900.

Credentials are read only through the SDK credential reference adapter. They are
never included in plugin manifest data, RPC parameters, or logs.

## Configuration interface

This plugin ships its own web configuration interface (`ui@1`) instead of letting
the host render a plain JSON-Schema form. That buys three things a schema cannot
express: region/bucket presets per provider, fields that only appear when they
are relevant (`publicUrl` only for `urlMode=public`, the signed-URL lifetime only
for `urlMode=signed`), and a working **Test connection** button that round-trips
through the plugin process. The layout follows the host's own source form: fields
pair up two per row from 640px upwards, collapse to a single column at the
window's minimum width, and long values (endpoint, name) span the full row.

- `src/ui.ts` — interface logic, bundled to `ui/app.js` by `pnpm build:ui`. It
  uses `createPluginUiClient()` from `@mo-gallery/plugin-sdk/ui` and must not
  import Node APIs.
- `ui/index.html`, `ui/app.css` — hand-written source files.
- Form defaults mirror `readConfig()` in `src/plugin.ts`, so what the form shows
  is exactly what the process would fall back to (`urlMode=public`,
  `signedUrlExpiresSeconds=900`).

The interface runs in a sandboxed iframe with no same-origin access and a CSP
that blocks every network request. It can only read and write the configuration
of the single source it was opened for. Credentials are write-only: they are
submitted to the host but never sent back into the interface, and empty
credential inputs are dropped host-side so saving the form cannot erase a stored
key.

The manifest still declares `permissions: ["network:configured-endpoint"]`
alongside the `ui` contribution. That list describes what the plugin *process*
needs, not the interface — the iframe sandbox and its CSP are what constrain the
interface — so the two are independent.

Build with `pnpm --filter @mo-gallery/desktop-plugin-tencent-cos build`. For
release, copy `dist/main.js`, `ui/` and `manifest.json` into a package, generate
`checksums.json`, and sign the checksum file with the release Ed25519 key before
distribution. The packaging step derives the interface directory from the
manifest's own `ui.entry`, so the entry may live anywhere inside the package.
