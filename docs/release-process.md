# Release process

This is the operational reference for cutting a release and publishing to npm.
It exists because the pipeline depends on two pieces of manual, one-time repo
configuration that no workflow file can create or verify for itself — get
those wrong (or skip them) and the pipeline either cannot fire at all, or fires
with no approval gate. See the workflow files themselves
(`.github/workflows/release.yml`, `.github/workflows/publish.yml`,
`.github/workflows/ci.yml`) for the mechanics; this document is the setup steps
and the "why" that does not fit in a YAML comment.

## The flow, end to end

```
push a "vX.Y.Z" tag
        │
        ▼
release.yml runs: verify tag == package.json version, typecheck, test, build,
verify the npm tarball actually contains dist/extension.js, then create a
DRAFT GitHub Release (never a live one — see "Why a draft" below)
        │
        ▼
a human reviews the draft and publishes it by hand (repo Releases page, or
`gh release edit vX.Y.Z --draft=false` authenticated as themselves)
        │
        ▼
that "published" event triggers publish.yml: verify the release's tag ==
package.json version at that ref, typecheck, test, build, verify the version
is not already on npm, then `npm publish` — gated by the `npm-publish`
environment's required reviewers, if that environment has been configured
(see below; if it has not, this step runs unattended)
```

`publish.yml` can also be run directly via `workflow_dispatch` with a tag
input, independent of any GitHub Release, for a re-publish after a failure.

### Why a draft, not a live release

GitHub Actions does not start new workflow runs from events raised by the
default `GITHUB_TOKEN` — only `workflow_dispatch` and `repository_dispatch` are
excepted. `release.yml` authenticates its `gh release create` step with
`github.token`, i.e. `GITHUB_TOKEN`. If that step published the release
directly, the "release published" event it raised would never trigger
`publish.yml`, and the only working path to npm would be a manual
`workflow_dispatch` — with `publish.yml`'s header comment ("Runs once a GitHub
Release is PUBLISHED") describing an automation that could not happen.

Creating a **draft** instead sidesteps this entirely: a draft release does not
raise a "published" event, so nothing is expected to fire yet. The event that
actually triggers `publish.yml` is a human (or a PAT-authenticated `gh`)
publishing that draft — and because that action does not originate from
`GITHUB_TOKEN`, GitHub Actions treats it as a normal event and does start
`publish.yml`. This is why the manual "publish the draft" step below is not
optional busywork; it is the only step that can make the automated chain fire
at all.

## Cutting a release

1. Bump `package.json`'s `version` and commit it on `main` through the normal
   PR process (`ci.yml` gates this like any other change).
2. Tag the resulting commit `vX.Y.Z`, matching `package.json` exactly, and push
   the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. Watch `release.yml` run. If it fails at "Verify tag matches package.json
   version", the tag and the committed `package.json` disagree — fix and
   re-tag. If it fails at "Verify package contents", the tarball is missing a
   file `release.yml` expects (`dist/extension.js`, `README.md`, or `LICENSE`).
4. On success, a **draft** release named `vX.Y.Z` exists on the repo's Releases
   page with generated notes. Review it.
5. Publish the draft by hand: either "Publish release" in the GitHub UI, or
   `gh release edit vX.Y.Z --draft=false` while authenticated as yourself (not
   as an Action). This is the step that triggers `publish.yml`.
6. Watch `publish.yml` run. If the `npm-publish` environment is configured with
   required reviewers (see below), it pauses for approval first.
7. On success, `@guru-irl/spider@X.Y.Z` is live on the npm registry.

## One-time manual repo setup

Both of the following are GitHub repo *settings*, not files in this repo. They
must be configured before the flow above behaves as documented; nothing in the
workflows can create, verify, or fail loudly if either is missing or wrong.

### 1. The `npm-publish` deployment environment (gates `publish.yml`)

`publish.yml` sets `environment: npm-publish` on its one job. If a repo
Settings → Environments entry literally named `npm-publish` does not already
exist, **GitHub auto-creates one on first use, with no protection rules** — the
job runs straight through, unattended, and `npm publish` fires with no approval
step at all, silently defeating the gate the YAML implies exists. To make the
gate real, before the first release:

1. Repo Settings → Environments → New environment → name it exactly
   `npm-publish` (must match the YAML's `environment:` value exactly).
2. Add required reviewers (at minimum, yourself) under "Deployment protection
   rules", so the job pauses for a manual approval before `npm publish` runs.
3. Optionally restrict which refs can deploy to this environment (e.g. tags
   matching `v*`) for defense in depth.

If you want publishes to go out unattended instead, remove the
`environment: npm-publish` line from `publish.yml` — but then say so here.

### 2. The required status check for branch protection (protects `main`)

`ci.yml`'s one job is named:

```
typecheck · test · build
```

The two separators are **U+00B7 MIDDLE DOT** (UTF-8 bytes `C2 B7` each), not a
hyphen, an ASCII period, a bullet (U+2022), or a slash — copy it from this file
or from the YAML, do not retype it. It is also **not** prefixed with the
workflow name: the GitHub UI's branch-protection search box often surfaces
Actions checks with a `<workflow name> / <job name>` display form (e.g.
`CI / typecheck · test · build`), but the string a required-status-check rule
must match is the job name alone, exactly as above.

A rule saved with the wrong string (ASCII punctuation, or the `CI / ...`
display form) does not error — it simply never matches any real check run, so
`main` has no effective required check while the Settings UI still shows a rule
as configured. To set this up:

1. Repo Settings → Branches → branch protection rule for `main` → "Require
   status checks to pass before merging".
2. Add a required check and enter (paste, do not retype) `typecheck · test ·
   build`.
3. Confirm it: open a throwaway PR, let `ci.yml` run once, and check that the
   *same* check name shown against that PR is the one selected as required —
   GitHub will show it as satisfied only if the strings match exactly.

## What changed here, and what still is not exercised

- `release.yml` now creates the release with `--draft` (previously it did not,
  so it published live — see "Why a draft" above).
- `publish.yml` now verifies the tag/ref it is publishing against
  `package.json`'s version before doing anything else, matching the check
  `release.yml` already had. Without this, `workflow_dispatch` with an
  arbitrary `inputs.tag` could publish any version reachable at that ref.
- `release.yml`'s tarball-contents check now passes `--ignore-scripts` to both
  `npm pack` invocations. Without it, `npm pack` re-runs the `prepare` script
  (`npm run build`), and that build's own stdout lands before `npm pack
  --json`'s JSON on the same stream, so the `JSON.parse` gate failed on every
  run — this was an untested, always-broken gate on the only release path.
- None of the above has ever actually run end to end: as of this writing there
  are no tags in this repository (`git tag` lists none) and `package.json` is
  still at a pre-release `0.1.0`. The flow above is verified against the
  workflow definitions and reproduced locally where it does not require
  network access or a real GitHub Actions run (for example, the `npm pack
  --json` parse failure was reproduced directly, not inferred); it has not
  been verified by an actual tag push.
- All three workflows still pin `node-version: '26.x'` only. `package.json`'s
  `engines.node` floor of `>=22.19.0` is a declared minimum, not a tested one —
  see the root `README.md`.

## Known gaps before the first real publish

These are real, verified facts about what the tarball would contain today.
Fixing them requires editing `package.json`, which is out of scope for the
docs/CI work described in this file — they are recorded here (and in more
detail in the branch's own review notes) so a maintainer sees them before
relying on this pipeline for a real publish, not to prescribe an editorial
decision for `package.json`.

- **The skills library is not in the tarball.** `package.json`'s
  `pi.skills` points at `./packages/superpowers/skills`, but `files` (the
  publish allowlist) is `["dist", "scripts/postinstall.mjs", "README.md",
  "LICENSE"]`, which does not include it. Verified directly: `npm pack --json
  --ignore-scripts` lists exactly `LICENSE`, `README.md`, `dist/extension.js`,
  `package.json`, `scripts/postinstall.mjs` — five entries, no skills
  directory. A package installed from npm (as opposed to from git) would
  advertise a skills library it does not ship.
- **The ten workspace packages under `packages/*` have no `"private": true`.**
  Each is `@spider/<name>@0.0.0`. The one `npm publish` this repo's pipeline
  runs is unaffected (it publishes only the root package), but any future
  workspace-aware publish step (`npm publish -ws` or similar) would attempt to
  push ten unversioned packages with no guard against it.
