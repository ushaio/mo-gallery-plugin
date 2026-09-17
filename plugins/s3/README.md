# MO Gallery Desktop S3 Plugin

This is an official Desktop storage plugin (S3-compatible services and
Cloudflare R2), maintained in the `plugins/` directory of the
`mo-gallery-plugin` marketplace repository.

```bash
pnpm install
pnpm build
```

The generated package must pass the Desktop host's manifest, checksum, and
signature checks before it can be used in a production build. The local SDK
reference points at `../../../emulsion-desktop/packages/plugin-sdk`
and requires the mo-gallery multi-repository workspace layout.

Release flow: see the repository's [CONTRIBUTING.md](../../CONTRIBUTING.md).
