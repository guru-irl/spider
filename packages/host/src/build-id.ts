import { closeSync, openSync, readSync } from "node:fs";
import { parseBuildId, type BuildIdentity } from "../../../scripts/build-id.mjs";

declare const __SPIDER_BUILD__: BuildIdentity;

// Source-based development and tests are not a built bundle. Do not invent a build time.
export const LOADED_BUILD: Readonly<BuildIdentity> = Object.freeze(
  typeof __SPIDER_BUILD__ === "undefined"
    ? { sha: "unknown", dirty: false, builtAt: "unknown", version: "unknown" }
    : __SPIDER_BUILD__,
);

export interface LoadedBundle {
  identity: Readonly<BuildIdentity>;
  /** Must be captured by the extension entry, not resolved from cwd or the install directory. */
  url: string;
}

/** Read just the banner. Replacement on disk cannot change the session's loaded constant. */
export function bundleDoctorLine(bundle: LoadedBundle): string {
  const loaded = bundle.identity;
  const label = `${loaded.sha}${loaded.dirty ? "-dirty" : ""} built ${loaded.builtAt}, v${loaded.version}`;
  let fd: number | undefined;
  let reloadSupported = false;
  let hint = "";
  try {
    const url = new URL(bundle.url);
    reloadSupported = url.searchParams.has("build");
    hint = reloadSupported || process.env.PI_SUBAGENT_CHILD === "1" ? "" : " (loaded without reload support: for a linked checkout run npm run link, then restart pi once)";
    fd = openSync(url, "r");
    const head = Buffer.alloc(16 * 1024);
    const length = readSync(fd, head, 0, head.length, 0);
    const installed = parseBuildId(head.toString("utf8", 0, length));
    if (!installed) return `- bundle: build marker unavailable in bundle header; loaded ${label}${hint}`;
    if (installed.sha === loaded.sha && installed.dirty === loaded.dirty && installed.builtAt === loaded.builtAt && installed.version === loaded.version) {
      return `- bundle: current (${label})${hint}`;
    }
    const installedLabel = `${installed.sha}${installed.dirty ? "-dirty" : ""}`;
    const remedy = process.env.PI_SUBAGENT_CHILD === "1"
      ? "UPDATE AVAILABLE, the next dispatched subagent will load the new bundle"
      : reloadSupported ? "RELOAD NEEDED, /reload to load it" : "RESTART NEEDED, restart pi to load it";
    return `- bundle: ${remedy}; loaded ${label}; installed ${installedLabel} built ${installed.builtAt}, v${installed.version}${hint}`;
  } catch {
    return `- bundle: unreadable (cannot compare); loaded ${label}${hint}`;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
