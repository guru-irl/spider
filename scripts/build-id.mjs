import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

/** Capture once per build. Git is optional, including source archives and offline hosts. */
export function captureBuildId({ version, cwd, now = () => new Date(), git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }) }) {
  let sha = "unknown";
  let dirty = false;
  try {
    const top = git(["--no-optional-locks", "rev-parse", "--show-toplevel"]).trim();
    // An archive nested inside someone else's repository is not that checkout.
    if (cwd && realpathSync(top) === realpathSync(cwd)) {
      const commit = git(["--no-optional-locks", "rev-parse", "--short", "HEAD"]).trim();
      const status = git(["--no-optional-locks", "status", "--porcelain", "--untracked-files=no"]).trim();
      if (/^[0-9a-f]{7,40}$/.test(commit)) {
        sha = commit;
        dirty = status.length > 0;
      }
    }
  } catch {
    // Unknown means no reliable git identity. Never prevent a build without git.
  }
  return { sha, dirty, builtAt: now().toISOString(), version };
}

export function formatBuildId(identity) {
  const marker = `SPIDER_BUILD_ID=${identity.sha}${identity.dirty ? "-dirty" : ""}@${identity.builtAt} v${identity.version}`;
  if (!parseBuildId(marker)) throw new Error("Invalid spider build identity");
  return marker;
}

/** Parse data only, never execute or import the installed module. ISO dates are canonical. */
export function parseBuildId(text) {
  const match = /(?:^|[\s/])SPIDER_BUILD_ID=(unknown|[0-9a-f]{7,40})(-dirty)?@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=$|\s)/m.exec(text);
  if (!match) return null;
  const date = new Date(match[3]);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== match[3]) return null;
  return { sha: match[1], dirty: Boolean(match[2]), builtAt: match[3], version: match[4] };
}
