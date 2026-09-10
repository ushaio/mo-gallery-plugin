# S3-compatible / Cloudflare R2 Desktop plugin

This is an external third-party Node storage plugin. The same `dist/main.js` runs
on Windows x64, macOS x64/arm64, and Linux x64/arm64 when Desktop supplies its
bundled Node 22 runtime.

The plugin uses the AWS SDK's pure JavaScript S3 client. It supports endpoint,
region, bucket, base path, path-style addressing, public URL prefixes,
temporary SigV4 URLs, checksum headers, idempotency metadata, retrying 5xx /
throttling responses, object metadata, streaming get, listing, move, and
delete.

## Cloudflare R2

For an R2 source, set `endpoint` to
`https://<account-id>.r2.cloudflarestorage.com`, `region` to `auto`, and
`bucket` to the R2 bucket name. Provide the R2 Access Key and Secret Key in
the credential fields. Keep `forcePathStyle` as `true` unless the endpoint
requires virtual-hosted addressing. Use `publicUrl` and `urlMode=public` only
when the bucket is exposed through an R2 custom domain or public URL; use
`urlMode=signed` for private buckets.

Credentials are read only through the SDK credential reference adapter. They
are never included in plugin manifest data, RPC parameters, or logs.

Build with `pnpm --filter @mo-gallery/desktop-plugin-s3 build`; the script emits
one bundled `dist/main.js` without native dependencies. Copy that file together
with `manifest.json` into a package, generate `checksums.json`, and sign the
checksum file with the release Ed25519 key before distribution.
