import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@spider/db-core";

export function composeFetchCacheKey(source: string | undefined, url: string): string {
  return source === undefined ? url : `${source}::${url}`;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface FetchResult {
  markdown: string;
  source: string;
  cached: boolean;
}

export async function fetchAndConvert(
  url: string,
  source?: string,
  opts?: { cwd?: string; ttl?: number; force?: boolean },
): Promise<FetchResult> {
  const cacheDir = join(paths.scratch("project", opts?.cwd ?? process.cwd()), "fetch-cache");
  mkdirSync(cacheDir, { recursive: true });
  const key = composeFetchCacheKey(source, url);
  const cachePath = join(cacheDir, createHash("sha256").update(key).digest("hex") + ".md");
  const ttl = opts?.ttl ?? DEFAULT_TTL_MS;
  const eff = source ?? url;

  if (!opts?.force && existsSync(cachePath) && Date.now() - statSync(cachePath).mtimeMs < ttl) {
    return { markdown: readFileSync(cachePath, "utf-8"), source: eff, cached: true };
  }

  const res = await fetch(url);
  const ct = res.headers.get("content-type") ?? "";
  const body = await res.text();

  let markdown: string;
  if (/html/i.test(ct) || /^\s*</.test(body)) {
    const spec = "turndown";
    const mod: any = await import(spec);
    const Turndown = mod.default ?? mod;
    markdown = new Turndown().turndown(body);
  } else {
    markdown = body;
  }

  writeFileSync(cachePath, markdown, "utf-8");
  return { markdown, source: eff, cached: false };
}
