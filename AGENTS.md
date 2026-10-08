# Repository Guidelines

## Purpose

This repository is the official MO Gallery Desktop plugin marketplace source.
It stores `index.json`, validation tooling, GitHub Release assets, and the
official plugin sources under `plugins/`. Third-party plugin source code
belongs in each plugin's own repository.

## Authoritative Contract

- Keep Schema 1 compatible with `emulsion-desktop/storage_plugins/marketplace.go`.
- The host implementation is authoritative when documentation and code differ.
- Only list signed, immutable packages already uploaded to this repository's Releases.
- Do not list planned, locally built, or unsigned plugins.
- Capability declarations (`plugins[].permissions`, `CAPABILITIES.md`) are a two-repo
  contract: the host whitelist and startup-flag enforcement live in
  `emulsion-desktop-v3` (`docs/plugin-capabilities.md`). Register a new id on both
  sides in the same change, and never weaken the enum to "any string" — clients
  refuse unknown capabilities at install time.

## Required Checks

- Run `npm run check` for every index or validator change.
- Run `npm run check:assets` before publishing an index update with Release assets.
- Keep plugin IDs unique and update `updatedAt` in UTC when the catalog changes.
- Do not replace an existing asset under the same plugin version.

## Security

- Never commit signing private keys, credentials, tokens, or unpublished reports.
- Do not weaken URL, platform, digest, size, or schema checks without a coordinated
  host change and security review.
- Marketplace hashes do not replace package checksums or Ed25519 signatures.

## Changes

- Use Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, and `chore:`.
- Keep catalog updates focused and include test and asset verification results.
