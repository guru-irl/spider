// packages/host/src/__tests__/exec-outcome-parity.test.ts
//
// A-M2 (branch-review A-architecture.md): two branch-new duplicate sources of truth
// with NO parity guard, both forced by the DAG (packages/ui cannot import
// packages/context — see A-architecture.md invariant 1 — so a shared import is not an
// option; this file's own tests must never import across that boundary either, so it
// reads raw SOURCE TEXT instead, the same technique already used in this codebase for
// an analogous cross-file invariant — see db-core's schema-migration-parity.test.ts):
//
//   1. `ExecOutcome` is declared twice, identically:
//        packages/context/src/executor.ts
//        packages/ui/src/renderers/types.ts ("Mirrors executor.ts's ExecOutcome")
//      Adding a 7th outcome to one and not the other silently drops the UI into its
//      fallback branch with no compile- or test-time signal.
//
//   2. The outcome-derivation fallback expression is copy-pasted byte-for-byte across
//      a package boundary:
//        packages/context/src/actions/exec.ts   (model-facing text)
//        packages/host/src/render-result.ts     (UI-facing details)
//      If one is edited and the other isn't, the model reads one outcome and the user
//      sees another for the SAME exec result.
//
// This test reads all four files as plain text and fails, by name, the moment either
// pair drifts — it is deliberately NOT a compile-time/import-based check (impossible
// here without violating the DAG) and deliberately NOT testing behavior (that's what
// actions-exec.test.ts / render-result.test.ts / exec-renderer.test.ts already do).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
function read(relFromRepoRoot: string): string {
  return readFileSync(join(REPO_ROOT, relFromRepoRoot), "utf8");
}

/** Extract the RHS of `export type ExecOutcome = "a" | "b" | …;` as a sorted array of
 *  the quoted literal members, order-independent (only the SET must match). */
function execOutcomeMembers(src: string, label: string): string[] {
  const m = /export type ExecOutcome = ([^;]+);/.exec(src);
  expect(m, `could not find 'export type ExecOutcome = …;' in ${label}`).toBeTruthy();
  return m![1]
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

/** Extract the outcome-derivation fallback expression, from its `const outcome: string
 *  =` declaration through the closing `: "exited");` of the ternary — whitespace
 *  collapsed so incidental reformatting (not a real drift) never trips this. */
function outcomeDerivationExpr(src: string, label: string): string {
  const m = /const outcome: string =[\s\S]*?: "exited"\);/.exec(src);
  expect(m, `could not find the outcome-derivation expression in ${label}`).toBeTruthy();
  return m![0].replace(/\s+/g, " ").trim();
}

describe("A-M2: ExecOutcome duplicate declaration parity (forced by the DAG, no shared import possible)", () => {
  it("context/src/executor.ts and ui/renderers/types.ts declare the EXACT SAME set of ExecOutcome members", () => {
    const contextSrc = read("packages/context/src/executor.ts");
    const uiSrc = read("packages/ui/src/renderers/types.ts");
    const fromContext = execOutcomeMembers(contextSrc, "executor.ts");
    const fromUi = execOutcomeMembers(uiSrc, "ui/renderers/types.ts");
    expect(
      fromUi,
      `ui/renderers/types.ts's ExecOutcome (${JSON.stringify(fromUi)}) has drifted from ` +
        `executor.ts's (${JSON.stringify(fromContext)}) — a duplicate declaration is forced ` +
        `by the DAG (@spider/ui cannot import @spider/context), so it must be updated by hand ` +
        `whenever the other one changes.`,
    ).toEqual(fromContext);
  });
});

describe("A-M2: outcome-derivation expression parity (byte-for-byte duplicate across a package boundary)", () => {
  it("context/src/actions/exec.ts (model-facing) and host/src/render-result.ts (UI-facing) derive 'outcome' with the IDENTICAL fallback expression", () => {
    const execSrc = read("packages/context/src/actions/exec.ts");
    const renderSrc = read("packages/host/src/render-result.ts");
    const fromExec = outcomeDerivationExpr(execSrc, "actions/exec.ts");
    const fromRender = outcomeDerivationExpr(renderSrc, "render-result.ts");
    expect(
      fromRender,
      "render-result.ts's outcome-derivation expression has drifted from actions/exec.ts's " +
        "— the model and the user would then read a DIFFERENT outcome for the SAME exec " +
        "result. Keep both copies textually identical (a shared import is not an option " +
        "here: host -> context is allowed, but this specific helper is intentionally " +
        "package-private on each side per the DAG note in A-architecture.md).",
    ).toBe(fromExec);
  });
});

// B-F14 (branch-review B-release.md / branch.delta.md): `executor.ts`'s own `exitCode`
// JSDoc says exitCode is a real number for `"exited"`/`"aborted"` and `null` for "the
// three remaining outcomes" — but `ExecOutcome` has SIX members total, so the
// remainder (signal, spawn-error, timeout, unknown) is FOUR, not three. Machine-checked
// here (not just eyeballed) so the comment can never silently drift from the type again:
// the count of ExecOutcome members MINUS the two real-number ones (exited, aborted) must
// match whatever number the JSDoc actually states.
describe("B-F14: executor.ts's exitCode JSDoc states the CORRECT count of null-exitCode outcomes", () => {
  it("'null for the N remaining outcomes' matches ExecOutcome's actual member count minus the two real-number outcomes (exited, aborted)", () => {
    const src = read("packages/context/src/executor.ts");
    const members = execOutcomeMembers(src, "executor.ts");
    const realNumberOutcomes = 2; // "exited" and "aborted" — see the same JSDoc block
    const expectedRemaining = members.length - realNumberOutcomes;
    const m = /for the (\w+) remaining outcomes/.exec(src);
    expect(m, "could not find the '`null` for the <N> remaining outcomes' JSDoc sentence in executor.ts").toBeTruthy();
    const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
    const stated = WORDS[m![1].toLowerCase()];
    expect(
      stated,
      `JSDoc says "${m![1]}" remaining outcomes; ExecOutcome actually has ${members.length} members total, ` +
        `${realNumberOutcomes} of which carry a real number (exited, aborted), leaving ${expectedRemaining}.`,
    ).toBe(expectedRemaining);
  });
});
