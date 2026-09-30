import { shouldCapture } from "@spider/memory";
import type { MemoryCandidate } from "./types.js";

/** Evidence must have a recognized shape; file and command claims are not verified here. */
export function isSupportedMemoryCandidate(candidate: MemoryCandidate): candidate is MemoryCandidate & { scope: "repo" | "global"; evidence: string } {
  if (candidate.scope !== "repo" && candidate.scope !== "global") return false;
  if (!candidate.justification?.trim() || !candidate.evidence?.trim()) return false;
  const evidence = candidate.evidence.trim();
  if (!/^(?:User(?: said)?:\s*["“].+["”]|(?:[^\s:]+\/)*[^\s:]+:\d+(?:-\d+)?(?:\s.*)?|Command output:\s*\S[\s\S]*)$/is.test(evidence)) return false;
  if (/^User(?: said)?:/i.test(evidence) && candidate.verifiedUserQuote !== true) return false;
  return shouldCapture(candidate.category, candidate.content, evidence, candidate.verifiedUserQuote).capture;
}
