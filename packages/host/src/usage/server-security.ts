import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export function usageSecurityHeaders(html: string): Readonly<Record<string, string>> {
  const hashes = (tag: string) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi"))]
    .map(match => `'sha256-${createHash("sha256").update(match[1]!.replace(/\r\n?/g, "\n")).digest("base64")}'`).join(" ") || "'none'";
  return {
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin", "Cross-Origin-Opener-Policy": "same-origin",
    "Content-Security-Policy": ["default-src 'none'", `script-src ${hashes("script")}`, `style-src ${hashes("style")} https://fonts.googleapis.com`,
      "style-src-attr 'none'", "font-src https://fonts.gstatic.com", "connect-src 'self'", "img-src 'self'", "object-src 'none'",
      "base-uri 'none'", "form-action 'none'", "frame-src 'none'", "frame-ancestors 'none'"].join("; "),
  };
}

/** Parse once, without URL normalization. Security and routing must use this same path. */
export function parseUsageTarget(target: string | undefined): { readonly pathname: string; readonly search: string; readonly searchParams: URLSearchParams } | undefined {
  if (typeof target !== "string" || !target.startsWith("/") || target.startsWith("//") || /[\\#\x00-\x20\x7f]/.test(target)) return undefined;
  const queryAt = target.indexOf("?");
  const pathname = queryAt < 0 ? target : target.slice(0, queryAt);
  const search = queryAt < 0 ? "" : target.slice(queryAt);
  if (pathname.includes("//") || /%(?:2f|5c)/i.test(pathname) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(target)) return undefined;
  try {
    const decoded = decodeURIComponent(pathname);
    if ([...pathname.matchAll(/%([0-9a-f]{2})/gi)]
      .some(match => /^[A-Za-z0-9._~-]$/.test(String.fromCharCode(parseInt(match[1]!, 16))))) return undefined;
    if (decoded.split("/").some(segment => segment === "." || segment === "..")) return undefined;
    return Object.freeze({ pathname, search, searchParams: new URLSearchParams(search) });
  } catch { return undefined; }
}
/** Compare credential bytes, never serialized errors or request data. */
export function equalCredential(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function isBrowserMint(req: IncomingMessage): boolean {
  return req.rawHeaders.some((value, index) => index % 2 === 0 &&
    (["cookie", "origin"].includes(value.toLowerCase()) || value.toLowerCase().startsWith("sec-fetch-")));
}
export function hasLocalHost(req: IncomingMessage, port: number): boolean {
  let hosts = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index]!.toLowerCase();
    if (name === "host") {
      hosts++;
      if (req.rawHeaders[index + 1] !== `127.0.0.1:${port}`) return false;
    }
    if (name === "forwarded" || name.startsWith("x-forwarded-") || name === "x-real-ip") return false;
  }
  return hosts === 1;
}
export function hasSafeBrowserMetadata(req: IncomingMessage, port: number, path: string): boolean {
  let origins = 0;
  let sites = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index]!.toLowerCase();
    const value = req.rawHeaders[index + 1];
    if (name === "origin" && (++origins > 1 || value !== `http://127.0.0.1:${port}`)) return false;
    if (name === "sec-fetch-site" && (++sites > 1 ||
      (value !== "same-origin" && !(value === "none" && (path === "/" || path === "/bootstrap"))))) return false;
  }
  return true;
}
/** Only Host, forwarding and browser origin/metadata. The caller supplies the already validated path. */
export function validateTransport(req: IncomingMessage, port: number, path: string): boolean {
  return hasLocalHost(req, port) && hasSafeBrowserMetadata(req, port, path);
}
/** Only local-channel bearer authentication. Protected resources must use requireSession in the server. */
export function hasMintBearer(req: IncomingMessage, secret: string): boolean {
  const authorizations = req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === "authorization").length;
  return authorizations === 1 && !isBrowserMint(req) && equalCredential(req.headers.authorization, `Bearer ${secret}`);
}
