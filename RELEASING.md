# Releasing

Releases are **tag-triggered from CI**, published on GitHub only — there is no
npm package. Pushing a `vX.Y.Z` tag runs `.github/workflows/release.yml`, which
runs the check suite and creates a GitHub Release whose body is the CHANGELOG
section for the version.

## Steps

1. **Bump the version** in `package.json` (keep `0.x` semver).

2. **Add a CHANGELOG entry.** Create a new `## X.Y.Z - YYYY-MM-DD` heading at
   the top of `CHANGELOG.md` (above `## [Unreleased]`, or move the Unreleased
   content into it). Group changes under `### Added`, `### Fixed`, and
   `### Changed`. For **breaking** changes in 0.x — anything that changes
   default behavior for existing users — use `### Changed (Breaking)`.

3. **Commit** the changes on `main`:

   ```bash
   git add package.json CHANGELOG.md
   git commit -m "chore: release vX.Y.Z"
   git push origin main
   ```

4. **Tag and push the tag:**

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

5. **Watch the release workflow.** It verifies the tag matches `package.json`
   and that `CHANGELOG.md` contains the version, runs `npm run check`, and
   creates a GitHub Release whose body is the CHANGELOG section for the
   version.

## Notes

- The tag must be exactly `v` + the `package.json` version (e.g. version
  `0.1.0` → tag `v0.1.0`); the workflow fails otherwise.
- To re-run a release for an existing tag without pushing it again, use the
  workflow's `workflow_dispatch` input: `gh workflow run release.yml -f tag=v0.1.0`.
- "Unreleased" entries are never tagged; move their content into the dated
  release section before tagging.
- Users install from GitHub: `pi install git:github.com/beremaran/pi-agent-tree`.
