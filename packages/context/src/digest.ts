// packages/context/src/digest.ts
// Minimal SessionDigest interface + a Phase-2 stub default. The real aux-model
// "organism" digest pass lands in Phase 6 (injected here); Phase 2 only defines
// the interface + a no-model-call default so `import` plumbing is testable and complete.

export interface DigestCandidate {
  kind: "memory" | "skill" | "todo";
  category?: string; // memory category
  content: string;
  link?: string;
  confidence?: number;
}

export interface DigestResult {
  candidates: DigestCandidate[];
  summary?: string;
  suggestedName?: string;
}

export interface NormalizedTranscript {
  sessionId: string;
  sourcePath: string;
  messages: Array<{ role: string; text: string }>;
}

export type SessionDigest = (
  t: NormalizedTranscript,
  opts: { auxModel?: string },
) => Promise<DigestResult>;

/**
 * Phase 2 stub: produces zero candidates and a truncated summary WITHOUT calling
 * any model. Phase 6 replaces this with the real aux-model organism digest.
 */
export const defaultDigest: SessionDigest = async (t) => {
  const joined = t.messages.map((m) => m.text).join(" ").slice(0, 500);
  return { candidates: [], summary: joined };
};
