# MO Gallery Desktop S3 Plugin

This is an external Desktop plugin. It is intentionally outside the main
`mo-gallery-web` workspace and must be built and imported manually.

```bash
pnpm install
pnpm build
```

The generated package must pass the Desktop host's manifest, checksum, and
signature checks before it can be used in a production build. The local SDK
reference points at `../mo-gallery-web/packages/desktop-plugin-sdk` for the
current development layout.