# Release process

This is the operational reference for cutting a release and publishing to npm.
The pipeline depends on two pieces of repo configuration that someone has to set
up by hand, once. No workflow file can create or check them. If they are wrong
or missing, the pipeline either never starts, or starts and publishes with no
approval step. The workflow files (`.github/workflows/release.yml`,
`.github/workflows/publish.yml`, `.github/workflows/ci.yml`) show how each step
works. This document gives the setup steps and the reasons that do not fit in a
YAML comment.

## The flow, end to end

```
push a "vX.Y.Z" tag
        │
        ▼
release.yml runs: verify tag == package.json version, typecheck, test, build,
verify the npm tarball contains the extension and dashboard assets, both bundled
skill collections, README.md, LICENSE and packages/pstack/LICENSE, then create a
DRAFT GitHub Release (never a live one; see "Why a draft" below)
        │
        ▼
a human reviews the draft and publishes it by hand (repo Releases page, or
`gh release edit vX.Y.Z --draft=false` authenticated as themselves)
        │
        ▼
that "published" event triggers publish.yml: verify the release's tag ==
package.json version at that ref, typecheck, test, build, verify the version
is not already on npm, then `npm publish` (gated by the `npm-publish`
environment's required reviewers, if that environment has been configured)
(see below; if it has not, this step runs unattended)
```

You can also run `publish.yml` directly through `workflow_dispatch` with a tag
input, without any GitHub Release. Use this to publish again after a failure.

### Why a draft, not a live release

GitHub Actions does not start new workflow runs from events raised by the
default `GITHUB_TOKEN`. The only exceptions are `workflow_dispatch` and `repository_dispatch`.
The `gh release create` step in `release.yml` authenticates with
`github.token`, which is the `GITHUB_TOKEN`. If that step published the release
directly, the "release published" event would never trigger `publish.yml`.
The only way to reach npm would then be a manual `workflow_dispatch`, and the
header comment in `publish.yml` ("Runs once a GitHub Release is PUBLISHED")
would describe an automation that could never happen.

A **draft** avoids the problem. A draft release raises no "published" event, so
nothing is expected to run yet. What triggers `publish.yml` is a human (or `gh`
authenticated with a PAT) publishing that draft. That action does not come from
the `GITHUB_TOKEN`, so GitHub Actions treats it as a normal event and starts
`publish.yml`. This is why the manual "publish the draft" step below is
required. It is the only step that can start the automated chain.

## Build and package layout

`npm run build` runs two separate Vite builds in order: the extension, then
`npm run build:dashboard`. It then runs `scripts/assert-bundle.mjs`. The output
root contains `dist/extension.js` and `dist/dashboard/`. The dashboard directory
contains `index.html` and `assets/` with hashed JavaScript and CSS files. Neither
build removes the other's output. If old files are left over, the bundle guard
fails rather than deleting them without telling you. Production dashboard output
can go only to `dist/dashboard/`. Development and e2e builds must use an
explicit absolute directory under `.spider/scratch/`.

The npm package also contains `packages/superpowers/skills`,
`packages/pstack/skills` and `packages/pstack/LICENSE`. Pi discovers both skill
collections through `pi.skills`. The tarball check requires every `SKILL.md`
from both source folders, so a release with any skill left out fails the gate.

## Cutting a release

1. Bump `version` in `package.json` and commit it on `main` through the normal
   PR process. `ci.yml` checks this change like any other.
2. Tag the resulting commit `vX.Y.Z`, matching `package.json` exactly, and push
   the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. Watch `release.yml` run. If it fails at "Verify tag matches package.json
   version", the tag and the committed `package.json` disagree. Fix the
   mismatch and tag again. If it fails at "Verify package contents", the
   tarball is missing a required file: `dist/extension.js`,
   `dist/dashboard/index.html`, hashed JavaScript and CSS in
   `dist/dashboard/assets/`, every bundled `SKILL.md`,
   `packages/pstack/LICENSE`, `README.md`, or `LICENSE`.
   The check also fails if the tarball contains source maps or the development
   states page.
4. When the run succeeds, a **draft** release named `vX.Y.Z` appears on the
   repo's Releases page with generated notes. Review it.
5. Publish the draft by hand. Either click "Publish release" in the GitHub UI,
   or run `gh release edit vX.Y.Z --draft=false` while signed in as yourself
   (not as an Action). This step triggers `publish.yml`.
6. Watch `publish.yml` run. If the `npm-publish` environment has required
   reviewers (see below), the run first waits for approval.
7. When the run succeeds, `@guru-irl/spider@X.Y.Z` is live on the npm registry.

## One-time manual repo setup

Both items below are GitHub repo *settings*, not files in this repo. Configure
them before you rely on the flow above. If either is missing or wrong, nothing
in the workflows can create it, check it, or fail with a clear error.

### 1. The `npm-publish` deployment environment (gates `publish.yml`)

The one job in `publish.yml` sets `environment: npm-publish`. If the repo has no
entry under Settings → Environments named exactly `npm-publish`, **GitHub
creates one the first time the job runs, with no protection rules**. The job
then runs straight through with nobody watching, and `npm publish` runs with no
approval step. The approval gate that the YAML suggests does not exist, and
nothing reports it. To make the gate real, do this before the first release:

1. Go to repo Settings → Environments → New environment and name it exactly
   `npm-publish`. The name must match the YAML's `environment:` value exactly.
2. Under "Deployment protection rules", add required reviewers (at least
   yourself). The job then waits for a manual approval before `npm publish`
   runs.
3. Optionally, limit which refs can deploy to this environment (for example,
   tags matching `v*`) as a second layer of protection.

If you want publishes to run without approval instead, remove the
`environment: npm-publish` line from `publish.yml` and record that choice here.

### 2. The required status check for branch protection (protects `main`)

The one job in `ci.yml` is named:

```
typecheck · test · build
```

Each of the two separators is a **U+00B7 MIDDLE DOT** (UTF-8 bytes `C2 B7`).
They are not hyphens, ASCII periods, bullets (U+2022), or slashes. Copy the name
from this file or from the YAML. Do not retype it. The name also has **no**
workflow-name prefix. The branch-protection search box in the GitHub UI often
lists Actions checks as `<workflow name> / <job name>` (for example,
`CI / typecheck · test · build`). A required-status-check rule must match the
job name alone, exactly as shown above.

A rule saved with the wrong string (ASCII punctuation, or the `CI / ...`
display form) gives no error. It never matches a real check run, so `main` has
no working required check, while the Settings UI still shows the rule as
configured. To set up the check:

1. Go to repo Settings → Branches → the branch protection rule for `main`, and
   turn on "Require status checks to pass before merging".
2. Add a required check, and paste (do not retype) `typecheck · test ·
   build`.
3. Confirm it. Open a throwaway PR, let `ci.yml` run once, and check that the
   check name shown on that PR is *the same* one you selected as required.
   GitHub shows the check as satisfied only if the strings match exactly.

## What changed here, and what still is not exercised

- `release.yml` now creates the release with `--draft`. Before this change it
  did not, so it published a live release. See "Why a draft" above.
- `publish.yml` now checks the tag or ref it is publishing against the version
  in `package.json` before it does anything else. `release.yml` already had the
  same check. Without it, `workflow_dispatch` with an arbitrary `inputs.tag`
  could publish any version reachable at that ref.
- The tarball-contents check in `release.yml` now passes `--ignore-scripts` to
  both `npm pack` calls. Without the flag, `npm pack` runs the `prepare` script
  (`npm run build`) again. That build prints to stdout ahead of the JSON from `npm pack
  --json` on the same stream, so the `JSON.parse` gate failed on
  every run. The only release path had a gate that was never tested and always
  broken.
- None of the above has run end to end yet. At the time of writing, this
  repository has no tags (`git tag` lists none), and `package.json` is still at
  a pre-release `0.1.0`. The flow above was checked against the workflow
  definitions. Steps that need no network access and no real GitHub Actions run
  were reproduced locally. For example, the `npm pack
  --json` parse failure was
  reproduced directly, not inferred. No real tag push has tested the flow.
- All three workflows still pin `node-version: '26.x'` only. The
  `engines.node` floor of `>=22.19.0` in `package.json` is a declared minimum,
  not a tested one. See the root `README.md`.

## Known gaps before the first real publish

- **The ten workspace packages under `packages/*` have no `"private": true`.**
  Each one is `@spider/<name>@0.0.0`. The one `npm publish` that this repo's
  pipeline runs is not affected, because it publishes only the root package.
  But a future publish step that covers workspaces (`npm publish -ws` or
  similar) would try to push ten unversioned packages, and nothing would stop
  it.
