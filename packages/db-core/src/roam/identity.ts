import { createHash } from "node:crypto";

function decodeUnreserved(path: string): string {
  return path.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => {
    const character = String.fromCharCode(parseInt(hex, 16));
    return /^[A-Za-z0-9._~-]$/.test(character) ? character : `%${hex.toUpperCase()}`;
  });
}

/** Normalize a network Git origin without retaining credentials. */
export function canonicalOrigin(value: string): string | null {
  if (!value || /^[a-z]:[\\/]/i.test(value) || /[\s\x00-\x1f\x7f]/.test(value)) return null;
  let url: URL;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      url = new URL(value);
      if (url.protocol !== "https:" && url.protocol !== "ssh:") return null;
    } else {
      const scp = /^(?:[^@/:]+@)?(\[[^\]]+\]|[^@/:]+):(.+)$/.exec(value);
      if (!scp) return null;
      url = new URL(`ssh://${scp[1]}/${scp[2]}`);
    }
  } catch {
    return null;
  }
  if (!url.hostname || /%(?![0-9a-f]{2})/i.test(url.pathname)) return null;
  let path = decodeUnreserved(url.pathname).replace(/^\/+|\/+$/g, "");
  path = path.replace(/\.git$/, "");
  if (!path) return null;

  const port = url.port && !(url.protocol === "ssh:" && url.port === "22") ? `:${url.port}` : "";
  let host = url.hostname.toLowerCase();
  const parts = path.split("/");
  const legacy = /^([^.]+)\.legacy\.example$/.exec(host);
  if (!port && legacy && parts.length === 4 && parts[0] === "DefaultCollection" && parts[2] === "_git") {
    host = "code.example";
    path = [legacy[1], parts[1], parts[3]].join("/");
  } else if (!port && host === "code.example" && parts.length === 4 && parts[2] === "_git") {
    path = [parts[0], parts[1], parts[3]].join("/");
  } else if (!port && host === "ssh.code.example" && parts.length === 4 && parts[0] === "v3") {
    host = "code.example";
    path = parts.slice(1).join("/");
  }
  return `${host}${port}/${path}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function repoIdentity(input: { origin: string | null; roots: readonly string[]; explicitKey?: string }): string {
  if (input.explicitKey !== undefined) {
    if (!input.explicitKey.trim()) throw new Error("An explicit repository key must not be empty");
    return input.explicitKey;
  }
  const origin = input.origin === null ? null : canonicalOrigin(input.origin);
  if (origin) return `origin:${digest(origin)}`;
  const roots = [...new Set(input.roots)].sort();
  if (roots.length === 0 || roots.some(root => !root)) throw new Error("An unborn repository requires an explicit key");
  return `root:${digest(roots.join("\n"))}`;
}
