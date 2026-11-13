import type { ArtifactManifest, Limits } from "./contracts";

export interface ArtifactLayout { chunkBytes: number; pageBytes: number }
export function artifactLayout(limits: Limits): ArtifactLayout {
  return { chunkBytes: limits.chunkBytes, pageBytes: Math.min(limits.manifestBytes, limits.replyBytes) };
}
export function parseArtifactLayout(value: unknown): ArtifactLayout {
  if (!value || typeof value !== "object" || !("chunkBytes" in value) || !("pageBytes" in value) ||
      typeof value.chunkBytes !== "number" || !Number.isSafeInteger(value.chunkBytes) || value.chunkBytes < 1 ||
      typeof value.pageBytes !== "number" || !Number.isSafeInteger(value.pageBytes) || value.pageBytes < 1) throw new Error("Invalid saved artifact layout");
  return { chunkBytes: value.chunkBytes, pageBytes: value.pageBytes };
}
export function withArtifactLayout(limits: Limits, layout: ArtifactLayout): Limits {
  return { ...limits, chunkBytes: layout.chunkBytes, manifestBytes: layout.pageBytes, replyBytes: Math.max(limits.replyBytes, layout.pageBytes) };
}
/** Private manifests were validated on creation. Preferred chunk size can change later. */
export function storedManifestLimits(manifest: ArtifactManifest, limits: Limits): Limits {
  let chunkBytes = limits.chunkBytes;
  if (Array.isArray(manifest.chunks)) for (const chunk of manifest.chunks)
    if (chunk && typeof chunk.rawLength === "number") chunkBytes = Math.max(chunkBytes, Math.min(chunk.rawLength, limits.replyBytes));
  return { ...limits, chunkBytes };
}
