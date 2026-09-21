# Image similarity — independent `library@1` plugin

Image-only perceptual comparison for Emulsion Desktop 0.8.3. This is an independently installed Node 22 system plugin, **not** a built-in host algorithm or storage source. No dependencies, downloads, network calls, CLIP/ViT/DINO models, credentials, file paths, database access, or delete RPCs are used by this implementation. A separate process is **not an OS sandbox**; install only trusted packages.

## Behavior

- Command `find-similar-images`: integer `threshold`, default **8**, range **0..64**.
- Host supplies active-image IDs, source versions and area-filtered 32×32 grayscale thumbnails in batches of at most 32. All DCT, median thresholding, pHash versioning, Hamming comparison and grouping are in this plugin.
- Stable separable DCT uses 63 AC bits (DC bit is zero). Equal hashes, especially flat-image **zero** hashes, do not establish exact file duplicates.
- Exact BK-tree candidate lookup over representatives. Every member is within the threshold of the first image; members need not match one another. This deliberately does not merge transitive chains and does not enumerate every similar pair. Results are review candidates, never automatic deletion recommendations.
- Large groups are split into chunks of 256 assets, repeating their representative. No members are silently omitted.
- `autoRunAfterScan: true` opts the command into the generic host trigger once per active library session after the first successful scan. Disabled/uninstalled extensions do not run; later scans do not re-run automatically. Manual refresh creates a new task.
- Cancellation/timeout terminates the dedicated process. Progress is host-reported after each batch. Closing a library cancels and waits for its tasks.

## Limits and failures

Host: 20,000 active images/task, two concurrent tasks/processes, 16 retained task records/session, 10-minute total timeout, 30-second batch/RPC timeout, result pages of 1–32 groups capped at 1 MiB, 10,000 groups and 40,000 result asset references. Plugin: five million BK-tree operation budget; Node heap capped at 128 MiB. Exceeding a task budget fails explicitly, without partial successful results.

Only ready host thumbnails up to 8 MiB and 2048×2048 pixels are processed. Missing/unreadable thumbnails fail the task with an actionable error; rebuild thumbnails and retry. Original images are never decoded by this plugin. Semantic similarity and crop-invariant matching are not provided.

Opaque per-image cache values (up to 256 bytes each, 8 MiB total) are host-mediated, namespaced by plugin ID/version/library and invalidated on image source version. Plugin values include their hash algorithm version. Existing legacy `similarity.db` files are left untouched but no longer opened or used; their old hashes are intentionally not imported into the new algorithm.

## Generic host interface

Required Wails methods:

- `ListLibraryExtensions()`
- `StartLibraryExtensionTask(pluginId, commandId, parameters)`
- `GetLibraryExtensionTask(taskId)`
- `ListLibraryExtensionResults(taskId, offset, limit)`
- `CancelLibraryExtensionTask(taskId)`

Additional generic management/UI methods: `ListLibraryExtensionTasks()`, `SetLibraryExtensionEnabled(pluginId, enabled)` (persisted), and `TrashLibraryExtensionAssets(taskId, ids)`. Trash is an explicit user-initiated **host operation**, scoped to a completed task and its current session/approved active images; it delegates to the existing host trash implementation. Existing `TrashLocalAssets` remains available. The plugin cannot request deletion.

Wire protocol: newline JSON-RPC 2.0 over stdin/stdout. `plugin.getManifest`, `library.getCommands`, and `library.run` are the only accepted methods. `library.run` phases are `start` (command/parameters), repeated `batch` (images, returning opaque cache values), `finish` (total groups), and `results` (offset/limit, returning ID-only groups). The host resolves result metadata and validates membership/current state. No arbitrary method forwarding is exposed. Reusable TypeScript contracts and `serveLibraryPlugin` are in the Desktop-only `packages/plugin-sdk/src/library.ts`.

## Test, build and install

From the multi-repository workspace (PowerShell):

```powershell
$env:TEMP = $env:PI_SCRATCH_DIR
$env:TMP = $env:PI_SCRATCH_DIR
$env:GOCACHE = Join-Path $env:PI_SCRATCH_DIR 'gocache'
node --test .\mo-gallery-plugin\plugins\image-similarity\tests\contract.test.mjs
$stage = Join-Path $env:PI_SCRATCH_DIR 'image-similarity-package'
node .\mo-gallery-plugin\plugins\image-similarity\scripts\build.mjs --out $stage
```

No transpilation or dependency installation is required. Build writes a package-root `manifest.json` and `dist/*.mjs` in the selected staging directory; source remains in this repository. In an existing **development build only**, use the system-plugin directory installer on `$stage`. Production builds require the existing checksum/Ed25519-signed ZIP installation flow, with no trust-policy changes.

For an authorized release operator, the existing `emulsion-desktop/build/package-desktop-plugin.mjs` accepts `--root <stage> --output <versioned.zip> --private-key <operator-provided-key.pem> --key-id <trusted-key-id>`. Do not store signing keys in the repository. Follow the repository `CONTRIBUTING.md`, publish immutable signed assets, then validate assets before adding a marketplace entry. **This implementation does not publish, sign, or add an `index.json` entry.**
