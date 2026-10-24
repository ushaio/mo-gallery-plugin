# MO Gallery Desktop Alibaba Cloud OSS Plugin

Official Desktop storage plugin for Alibaba Cloud Object Storage Service (OSS),
maintained in the `mo-gallery-plugin` repository under `plugins/aliyun-oss`.

Build and test it from this directory:

```bash
pnpm install
pnpm build
pnpm test
```

`pnpm build` produces two bundles: `dist/main.js` for the self-contained Node 22
plugin process, and `ui/app.js` for the browser bundle loaded by `ui/index.html`.
`ui/index.html` and `ui/app.css` are hand-written source files; `ui/app.js` is
generated and git-ignored.

The `main.js` bundle marks `proxy-agent` as external. `ali-oss` reaches OSS
through `urllib`, which declares `proxy-agent` as an optional peer dependency and
only requires it lazily when `URLLIB_ENABLE_PROXY` or `enableProxy` is set; OSS
never sets either, so the reference is never evaluated at runtime.

The plugin SDK is referenced locally as
`file:../../../emulsion-desktop-v3/packages/plugin-sdk`, so this package requires
the mo-gallery multi-repository workspace layout.

See `CONTRIBUTING.md` at the repository root for the release flow (signed ZIP,
GitHub Release, marketplace index update).
