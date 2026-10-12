# MO Gallery Desktop S3 Plugin

This is an official Desktop storage plugin (S3-compatible services and
Cloudflare R2), maintained in the `plugins/` directory of the
`mo-gallery-plugin` marketplace repository.

```bash
pnpm install
pnpm build
pnpm test
```

`pnpm build` emits two bundles:

- `dist/main.js` — the self-contained Node 22 plugin process.
- `ui/app.js` — the browser bundle for the plugin's own configuration
  interface, declared as `ui.entry` in the manifest. `ui/index.html` and
  `ui/app.css` are hand-written source files; `ui/app.js` is a build artifact
  and therefore git-ignored.

The generated package must pass the Desktop host's manifest, checksum, and
signature checks before it can be used in a production build. The local SDK
reference points at `../../../emulsion-desktop-v3/packages/plugin-sdk`
and requires the mo-gallery multi-repository workspace layout.

Release flow: see the repository's [CONTRIBUTING.md](../../CONTRIBUTING.md).
