# Release process

Publish a GitHub release so people can install spider with pi. No npm account or npm token is needed for this path.
The workflow uses the repository token, with read access for verification and write access only for the release job.

## Cut a release

1. Change the version in `package.json` and `package-lock.json` in a PR. For example, run `npm version 0.1.1 --no-git-tag-version --ignore-scripts`. The first release already has version `0.1.0`.
2. Merge the PR after CI passes.
3. Switch to `main` and update it. Confirm the working tree is clean and the version is the one you intend to release.
4. Tag that merge commit as `v<version>` and push the tag.

For the first release, run these commands after the release setup PR merges:

```bash
git switch main
git pull --ff-only origin main
git diff --quiet
git diff --cached --quiet
test "$(node -p "require('./package.json').version")" = 0.1.0
git tag v0.1.0
git push origin refs/tags/v0.1.0
```

Stop if any command fails. Do not tag a feature branch or a commit that has not merged to `main`.
Watch the [Release workflow](../.github/workflows/release.yml), then check [GitHub releases](https://github.com/guru-irl/spider/releases).

The tag starts the same verification as [CI](../.github/workflows/ci.yml) through `workflow_call`.
It includes typechecks, twelve test shards, Herdr acceptance, Chrome checks, the lockfile registry guard, and bundle and package-content checks.
The release job runs only after every CI job succeeds. It also checks that the tag equals `v` followed by the version in `package.json`.

CI uploads the checked tarball as `release-package`. The release job downloads those bytes rather than building a different package.
It publishes the GitHub release directly with generated notes, the version's pi install command, the tarball, and `SHA256SUMS`.
There is no draft to publish by hand. Creating this release does not start npm publishing.

## Install or verify the release

The command in the release notes pins both the version and the package identity:

```bash
pi install npm:@guru-irl/spider@https://github.com/guru-irl/spider/releases/download/v0.1.0/guru-irl-spider-0.1.0.tgz
```

Keep `@guru-irl/spider@` before the URL. Without the name, pi installs the tarball but does not find its extension.
Use `pi list` to inspect the configured source. Start pi and run `/doctor` to check the installation.
See the [README](../README.md#install-update-and-remove) for update and removal commands.

To verify a downloaded asset on Linux:

```bash
gh release download v0.1.0 --repo guru-irl/spider --pattern '*.tgz' --pattern SHA256SUMS
sha256sum -c SHA256SUMS
```

On macOS, use `shasum -a 256 -c SHA256SUMS` instead.

## Recover from a failed release run

If verification fails before publication, fix the problem in a PR and merge the fix to `main`.
A packaging failure can mean a missing license, skill, runtime, dashboard asset, or a stale build identity.
Do not bypass the checks or upload a hand-built replacement.

To retry after a transient failure without changing the commit, rerun the failed workflow.
If the run created a partial release, delete that release before rerunning, because `gh release create` does not replace one.

If the commit needs a fix, delete any partial release and the failed tag, then tag the fixed merge commit.
Only reuse a version that has not been installed or distributed. For an already used release, publish a new version instead.
Tag deletion changes the public ref. Confirm the failed version is safe to remove before running these commands.

```bash
TAG=v0.1.0
# Run this only if a partial release exists.
gh release delete "$TAG" --repo guru-irl/spider --yes
git push origin --delete "$TAG"
git tag -d "$TAG"
# Merge the fix, then repeat the release commands on updated main.
```

Never force-update a release tag in place.

## Keep npm publishing manual

[Publish to npm](../.github/workflows/publish.yml) runs only through `workflow_dispatch` with a tag input.
It does not run when a GitHub release is created or published.
The npm token and deployment environment are not set up by this repository. Leave this workflow unused until they are configured.

Before the first npm publish:

1. Create a GitHub environment named `npm-publish` under the repository's settings.
2. Add required reviewers. GitHub otherwise creates a missing environment without protection rules when the job first runs.
3. Configure the `NPM_TOKEN` secret and the npm account's publishing permissions for `@guru-irl/spider`.
4. Run `publish.yml` manually with the released tag, then approve the environment deployment.

The workflow verifies the tag against `package.json`, rebuilds and checks the package, and refuses a version already on npm.
It publishes only the root package, not the workspace packages. Most workspaces are not marked private, so do not replace this with a workspace-wide publish.

## Build and verification reference

`npm ci` runs `prepare`, which builds the extension, dashboard, and Herdr runtimes, then runs `scripts/assert-bundle.mjs`.
The extension is `dist/extension.js`. The dashboard has `dist/dashboard/index.html` and hashed JavaScript and CSS assets.
The build keeps each component's output and refuses unexpected or stale files.

`scripts/check-package-files.cjs` checks the file list from `npm pack --json --ignore-scripts`.
It requires the extension, dashboard assets, README, license notices, and every `SKILL.md` in both bundled skill collections.
The tarball also includes the Herdr runtimes and their required assets and notices.
`scripts/assert-bundle.mjs --package <tarball> --commit <sha>` verifies the packed bytes and clean build identity.
Source maps and the development dashboard states page must not appear in the tarball.
The README web marks in `docs/assets/` are documentation assets and do not ship in the package.

All verification jobs use Node `26.x` on Linux. The declared `>=22.19.0` engine floor is not a tested version range.
Real Herdr core, remote, and native-window stories remain opt-in and do not run in CI.

The required branch-protection check is exactly `typecheck · test · build`, with U+00B7 middle dots and no workflow-name prefix.
Its aggregate job requires success from `checks`, all twelve test shards, Herdr acceptance, and the Chrome jobs, including after a failure or cancellation.
Configure that exact check under the branch protection rule for `main`.
