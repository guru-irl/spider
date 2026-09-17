import { describe, it, expect } from "vitest";
import { parseCandidates } from "../aux-model.js";

// Synthetic model-reply fixtures only — no raw user/session data.
const OK = JSON.stringify({
  memory: [{ category: "preference", content: "user prefers terse answers" }],
  skills: [],
  todos: [],
});

describe("parseCandidates — F4 JSON contract hardening", () => {
  it("does NOT discard a reply that merely quotes 'Nothing to save.' inside real JSON", () => {
    const raw = 'I will not just say "Nothing to save." — here is what I found:\n```json\n' + OK + "\n```";
    const r = parseCandidates(raw);
    expect(r.memory).toHaveLength(1);
  });

  it("still treats an EXACT trimmed case-insensitive 'Nothing to save.' as a valid empty response", () => {
    expect(parseCandidates("Nothing to save.")).toEqual({ memory: [], todos: [], skills: [] });
    expect(parseCandidates("  NOTHING TO SAVE.  ")).toEqual({ memory: [], todos: [], skills: [] });
    expect(parseCandidates("nothing to save")).toEqual({ memory: [], todos: [], skills: [] }); // optional trailing period
  });

  it("tolerates a bare ``` fence with no language tag", () => {
    const raw = "```\n" + OK + "\n```";
    const r = parseCandidates(raw);
    expect(r.memory).toHaveLength(1);
  });

  it("tolerates prose preamble + bare (unfenced) JSON", () => {
    const raw = "Sure, here's what I found:\n" + OK;
    const r = parseCandidates(raw);
    expect(r.memory).toHaveLength(1);
  });

  it("tolerates bare JSON followed by trailing prose", () => {
    const raw = OK + "\n\nLet me know if you want more detail.";
    const r = parseCandidates(raw);
    expect(r.memory).toHaveLength(1);
  });

  it("still parses an uppercase ```JSON fence", () => {
    const raw = "```JSON\n" + OK + "\n```";
    const r = parseCandidates(raw);
    expect(r.memory).toHaveLength(1);
  });

  describe("strict mode", () => {
    it("default (non-strict) call keeps prior tolerant behavior: malformed reply -> emptyResult()", () => {
      const r = parseCandidates("I'm not sure what you mean, could you clarify?");
      expect(r).toEqual({ memory: [], todos: [], skills: [] });
    });

    it("strict:true throws a short, safe error on a wholly malformed/non-JSON reply", () => {
      expect(() => parseCandidates("I'm not sure what you mean, could you clarify?", { strict: true })).toThrow();
      try {
        parseCandidates("I'm not sure what you mean, could you clarify?", { strict: true });
        expect.unreachable();
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg.length).toBeLessThan(200); // short, not a raw dump
        expect(msg).not.toContain("I'm not sure what you mean"); // never echo the raw reply
      }
    });

    it("strict:true still accepts a valid empty JSON response (distinguishable from malformed)", () => {
      const r = parseCandidates(JSON.stringify({ memory: [], skills: [], todos: [] }), { strict: true });
      expect(r).toEqual({ memory: [], todos: [], skills: [] });
    });

    it("strict:true still accepts the exact 'Nothing to save.' response", () => {
      const r = parseCandidates("Nothing to save.", { strict: true });
      expect(r).toEqual({ memory: [], todos: [], skills: [] });
    });

    it("strict:true still parses prose-wrapped / unlabelled-fence JSON without throwing", () => {
      const raw = "Sure, here's what I found:\n" + OK;
      const r = parseCandidates(raw, { strict: true });
      expect(r.memory).toHaveLength(1);
    });
  });
});
