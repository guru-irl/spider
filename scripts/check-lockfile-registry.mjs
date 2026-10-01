#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const publicHost = "registry.npmjs.org";
const marker = "/npm/registry/";
const harmlessSettings = new Set(["save-exact", "engine-strict", "fund", "audit", "package-lock", "lockfile-version"]);
const hasSha512 = integrity => typeof integrity === "string" && /(?:^|\s)sha512-[A-Za-z0-9+/]+={0,2}(?:\s|$)/.test(integrity);
const isMap = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isTarball = pathname => /^\/(?:@[^/]+\/)?[^/]+\/-\/[^/]+\.tgz$/.test(pathname);

// CHECK is offline. Only --fix calls npm, using the caller's configured registry.
// Never surface npm's stdout/stderr: either can contain private hosts or secrets.
function upgradeIntegrity(entry, key) {
  const sha1s = typeof entry.integrity === "string"
    ? entry.integrity.split(/\s+/).filter(token => token.startsWith("sha1-")) : [];
  if (!sha1s.length) throw new Error("cannot upgrade to sha512 without existing SHA-1 integrity");
  const name = entry.name ?? key.split(/(?:node_modules|dependencies)\//).at(-1);
  if (typeof name !== "string" || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)
    || typeof entry.version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?$/i.test(entry.version)) {
    throw new Error("cannot upgrade to sha512 without a registry package name and version");
  }
  const cwd = realpathSync(process.cwd());
  const scratch = join(cwd, ".spider", "scratch");
  mkdirSync(scratch, { recursive: true });
  const work = mkdtempSync(join(scratch, "lockfile-integrity-"));
  try {
    const tarballs = join(work, "tarballs");
    const cache = join(work, "cache");
    const logs = join(work, "logs");
    const tmp = join(work, "tmp");
    for (const path of [tarballs, cache, logs, tmp]) mkdirSync(path);
    let packed;
    try {
      packed = JSON.parse(execFileSync("npm", ["pack", `${name}@${entry.version}`, "--json", "--ignore-scripts", "--pack-destination", tarballs], {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, npm_config_cache: cache, npm_config_logs_dir: logs, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
      }));
    } catch {
      throw new Error("cannot upgrade to sha512: npm pack failed or returned invalid metadata");
    }
    const item = Array.isArray(packed) && packed.length === 1 ? packed[0] : null;
    if (!item || item.name !== name || item.version !== entry.version || typeof item.filename !== "string"
      || !/^[a-z0-9._-]+\.tgz$/i.test(item.filename)) {
      throw new Error("cannot upgrade to sha512: invalid npm pack metadata");
    }
    let bytes;
    try { bytes = readFileSync(join(tarballs, item.filename)); }
    catch { throw new Error("cannot upgrade to sha512: npm pack tarball is missing"); }
    const sha1 = createHash("sha1").update(bytes).digest();
    if (item.shasum !== sha1.toString("hex") || sha1s.some(token => token !== `sha1-${sha1.toString("base64")}`)) {
      throw new Error("cannot upgrade to sha512: SHA-1 does not match downloaded bytes");
    }
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (item.integrity !== integrity) throw new Error("cannot upgrade to sha512: npm SHA-512 does not match downloaded bytes");
    entry.integrity = integrity;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--fix")) throw new Error("usage: node scripts/check-lockfile-registry.mjs [--fix]");
  const fix = args.includes("--fix");
  let lock;
  try { lock = JSON.parse(readFileSync("package-lock.json", "utf8")); }
  catch { throw new Error("cannot read or parse package-lock.json"); }
  if (!isMap(lock) || !(isMap(lock.packages) || (lock.lockfileVersion === 1 && isMap(lock.dependencies)))) {
    throw new Error("package-lock.json must contain a packages map (or v1 dependencies map)");
  }

  const errors = [];
  let changed = 0;
  function checkResolved(entry, key, repair) {
    const resolved = entry.resolved;
    // npm workspace links are the only permitted non-registry sources.
    if (entry.link === true && typeof resolved === "string" && /^(?:[a-z0-9._-]+\/)*[a-z0-9._-]+$/i.test(resolved)
      && !resolved.split("/").some(part => part === "." || part === "..")) return;
    let url;
    try { url = new URL(resolved); }
    catch {
      errors.push(`${key}: invalid resolved URL; only registry.npmjs.org tarballs are allowed`);
      return;
    }
    if (typeof resolved !== "string" || resolved !== resolved.trim() || /[\x00-\x20]/.test(resolved)
      || url.username || url.password || !["https:", "http:"].includes(url.protocol)) {
      errors.push(`${key}: only registry.npmjs.org tarballs without credentials are allowed`);
      return;
    }
    const start = url.pathname.indexOf(marker);
    const rest = start === -1 ? "" : url.pathname.slice(start + marker.length);
    if (repair && url.host !== publicHost && start !== -1 && rest && isTarball(`/${rest}`)) {
      entry.resolved = `https://${publicHost}/${rest}`;
      changed++;
      // Re-check the mapped source, including its tarball shape.
      url = new URL(entry.resolved);
    }
    if (repair) return;
    if (url.host !== publicHost) errors.push(`${key}: host is not registry.npmjs.org; only registry.npmjs.org tarballs are allowed`);
    else if (url.protocol !== "https:" || !isTarball(url.pathname) || url.search || url.hash) {
      errors.push(`${key}: only HTTPS registry.npmjs.org tarballs are allowed`);
    }
  }

  // Walk the whole document, including v1/v2 dependency trees and any extra maps.
  function walk(value, key = "(root)", repair = false) {
    if (value === null || typeof value !== "object") return;
    if (Object.hasOwn(value, "resolved")) checkResolved(value, key, repair);
    if ((Object.hasOwn(value, "integrity") || (typeof value.resolved === "string" && /^https?:/i.test(value.resolved))) && !hasSha512(value.integrity)) {
      if (repair) {
        try { upgradeIntegrity(value, key); changed++; }
        catch (error) { errors.push(`${key}: ${error.message}`); }
      } else errors.push(`${key}: integrity must include sha512; run with --fix to upgrade verified SHA-1 tarballs`);
    }
    for (const [child, entry] of Object.entries(value)) {
      walk(entry, key === "(root)" || key === "packages" ? child : `${key}/${child}`, repair);
    }
  }
  if (fix) {
    walk(lock, "(root)", true);
    if (changed) writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
  }
  // Always run the full offline CHECK after repairs, even when some repairs failed.
  walk(lock);

  let tracked;
  try {
    tracked = execFileSync("git", ["--no-optional-locks", "ls-files", "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error("cannot list Git-tracked .npmrc files");
  }
  for (const path of tracked.split("\0").filter(path => path && basename(path) === ".npmrc")) {
    let text;
    try { text = readFileSync(path, "utf8"); }
    catch { throw new Error("cannot read Git-tracked .npmrc file"); }
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const trimmed = line.trim();
      if (!trimmed || /^[#;]/.test(trimmed)) continue;
      const equals = trimmed.indexOf("=");
      const key = (equals === -1 ? trimmed : trimmed.slice(0, equals)).trim().replace(/^['"]|['"]$/g, "").replace(/\[\]$/, "");
      if (!harmlessSettings.has(key.toLowerCase())) {
        // Never echo keys or values: both may carry private hosts or credentials.
        errors.push(`${path}:${index + 1}: npmrc setting is not allowed`);
      }
    }
  }
  if (errors.length) {
    console.error("check-lockfile-registry: FAILED\n" + [...new Set(errors)].map(error => `- ${error}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`check-lockfile-registry: OK${changed ? ` (updated ${changed} lockfile fields)` : ""}`);
  }
} catch (error) {
  console.error(`check-lockfile-registry: ${error.message}`);
  process.exitCode = 1;
}
