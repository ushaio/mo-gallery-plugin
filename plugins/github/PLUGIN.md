# GitHub 仓库 Desktop plugin

External third-party Node storage plugin backed by the GitHub Contents API.
The same `dist/main.js` runs on Windows x64, macOS x64/arm64, and Linux
x64/arm64 with Desktop's bundled Node 22 runtime.

Configuration: `owner`, `repo` (required); `branch` (defaults to the
repository default branch), `basePath`, `apiUrl` (GitHub Enterprise), `rawUrl`
(public raw URL prefix). Credential: a Personal Access Token with Contents
read/write access.

Behavior notes for reviewers:

- `put` buffers the transfer (the Contents API embeds base64 JSON bodies) and
  rejects files above 100 MiB before writing.
- Idempotent replays (same idempotency key + size) return the stored object
  instead of creating an overwrite commit.
- `move` is download → new commit → delete commit (three API calls).
- `health` reports `degraded` when the token lacks push permission, and
  surfaces provider HTTP statuses (401/403/404) through `provider_error`.
- All requests use `Authorization: Bearer <token>` with
  `X-GitHub-Api-Version: 2022-11-28`; only the configured endpoint is
  contacted (`network:configured-endpoint`).

Credentials flow only through the SDK credential reference adapter and never
appear in manifest data, RPC parameters, or logs.
