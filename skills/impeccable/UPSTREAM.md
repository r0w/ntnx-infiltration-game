# Impeccable provenance

- Source: https://github.com/pbakaus/impeccable
- Commit: `b49177d32788f2dc585c42831d845dacf1ebed2c`
- Imported directory: `.agent/skills/impeccable`
- Skill version: `4.10.0`; engine version: `0.1.27`
- License: Apache-2.0, included in `LICENSE`.

Local adaptations: Markdown command paths point to `skills/impeccable`,
version is stored under frontmatter metadata, provider-specific tool permissions
are omitted, and the Unix launcher is executable. Reference material and scripts
are otherwise retained from upstream. No provider hooks or global installation
are configured by this copy.

The launcher downloads its versioned engine on first use and verifies it against
the bundled checksums. Installing these files does not execute that download.

For updates, import a reviewed upstream revision, repeat these adaptations, and
update this record. Keep the license and review upstream script changes.
