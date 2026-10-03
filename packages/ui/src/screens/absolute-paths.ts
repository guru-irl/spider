import * as path from "node:path";

/** Validate file-path lists using one platform policy at every config boundary. */
export function isAbsolutePathList(value: unknown, pathApi: Pick<typeof path, "isAbsolute" | "sep"> = path): value is string[] {
  return Array.isArray(value) && value.every(p => typeof p === "string" && pathApi.isAbsolute(p)
    && (pathApi.sep !== "\\" || /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(p)));
}
