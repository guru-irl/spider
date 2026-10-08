import { vi } from "vitest";
import type { PlainDocument } from "./plain-dom.js";
export function observeFontTransport(document: PlainDocument): { family: string; source: string; weight: string }[] {
  const faces: { family: string; source: string; weight: string }[] = [];
  vi.stubGlobal("FontFace", class {
    constructor(readonly family: string, readonly source: string, readonly descriptors: { weight: string }) {}
    async load() { return this; }
  });
  Object.assign(document.fonts ??= { async load() { return []; } }, { add(face: { family: string; source: string; descriptors: { weight: string } }) { faces.push({ family: face.family, source: face.source, weight: face.descriptors.weight }); } });
  return faces;
}
