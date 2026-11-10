# Mote Release Checklist

The Git checkout is the release source of truth. Do not overwrite it from a stale local mirror.

1. Inspect `git status`, review the complete diff, and compare `main` with the remote.
2. Run `npm ci`, `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`.
3. Update the version in `manifest.json`, `package.json`, both root entries in `package-lock.json`, and `versions.json`. Keep the declared minimum Obsidian version accurate.
4. Update `CHANGELOG.md`, release notes, and user documentation for changed interactions.
5. Back up the active vault's plugin installation before local testing. Determine the current vault path from the running Obsidian app; never assume an old NAS or sync path is still active. Copy only `main.js`, `manifest.json`, and `styles.css`, preserving `data.json` and all notes.
6. Test in Obsidian: new capture, edit/cancel, text selection, sidebar locations and reopening, search/review, report/calendar navigation, and URL tags. Test destructive operations using an isolated in-memory vault. Native iOS/Android behavior is separate from desktop or simulated tests.
7. Confirm repeated production builds give the same `main.js` SHA-256. Stage only reviewed source, tests, documentation, metadata, and the three plugin assets.
8. Commit, create an annotated tag matching the manifest **without a `v` prefix**, and push the tag. The GitHub Actions release workflow verifies lint, types, and tests, builds the plugin, checks that the tag matches the manifest, attests the artifacts, and opens a **draft** release with all three assets. Review the draft before publishing it. Include a manual-install ZIP if desired; it must not contain user data.
9. Download the draft assets and compare SHA-256 with the local files. Publish the release, then push `main` to the same commit so the default-branch manifest cannot point to a missing release.
10. Verify the published release is not a draft or prerelease, its tag and `main` identify the same commit, and its manifest matches the tag. Download published assets again and compare hashes. Only then report success.

For a beta, use a separate branch and prerelease tag. Do not change the stable default-branch manifest to a prerelease version. Preserve previous releases for rollback.

### Betas on a phone

Ship betas as a normal semver prerelease (`0.3.1-beta.1`), tagged on a branch, and tell testers to install through BRAT. Two Obsidian behaviours decide this:

- Obsidian accepts a prerelease `version` in `manifest.json`; the plugin loads normally.
- Obsidian's own update check does **not** rank it correctly. It parses versions with `split(".")` + `parseInt` (`hG`/`pG` in `app.js`), so `0.3.1-beta.1` becomes `[0,3,1,1]` — longer than the stable `[0,3,1]`, so the built-in updater never offers the eventual `0.3.1`. BRAT compares with real semver instead, where `0.3.1-beta.1 < 0.3.1`, so it upgrades correctly.

So: prereleases are installed **and upgraded** through BRAT, never through Obsidian's built-in update check. If you would rather testers can move to stable without BRAT, the alternative is a plain patch bump (ship `0.3.1` itself) and keep the branch unreleased until it is ready.

Keep the stable `main` manifest on a stable version. After a beta graduates, bump the branch to the stable version, tag it, and publish as a normal release.

Releases are produced by `.github/workflows/release.yml` when a tag is pushed. It always opens a **draft**; edit the draft to mark it prerelease and publish it. Local `.tmp/` artifacts and `RELEASE_NOTES_*.md` are intentionally ignored by Git.
