import { expect, it } from "vitest";
import { dashboardLabel } from "../dashboard-identities.js";
import { labelLeaks } from "./fixtures/label-privacy.js";

const home = "/synthetic/home dir";
// Every delimiter input remains pinned. The approved scheme now consumes
// one whole whitespace run instead of preserving individual delimiters.
it.each([...":;&|><=,()[]{}\"'`"].map(delimiter => [delimiter]))("redacts both sides of delimiter %s", delimiter => {
  const expected = `~/a${delimiter}~/b`;
  const result = dashboardLabel("role", `${home}/a${delimiter}${home}/b`, home)!;
  expect(result).toBe(expected);
  expect(labelLeaks(expected, [home])).toEqual([]);
  expect(labelLeaks(result, [home])).toEqual([]);
});
it.each([
  [`PATH=${home}/bin:${home}/.local/bin`, "PATH=~/.local/bin"],
  [`x=${home}/a;y=${home}/b`, "x=~/a;y=~/b"],
  [`see ${home}/a&&${home}/b`, "see ~/a&&~/b"],
  [`env ${home}/a>${home}/b`, "env ~/a>~/b"],
  [`cwd:${home}/a:/opt/x`, "cwd:~/opt/x"],
  [`{${home}/x}`, "{~/x}"],
  [`-C${home}/repo`, "-C~/repo"],
  ...["@", "!", "*", "+", "a.", "~"].map(prefix => [`${prefix}${home}/x`, `${prefix === "~" ? "" : prefix}~/x`]),
  ["~/Private/work", "~/Private/work"],
  ["C://Users/someone/x", "…/someone/x"],
  [home, "~"],
  ["file://C:/private/src/repo", "file://…/src/repo"],
  ["file:///C:/private/src/repo", "file://…/src/repo"],
  ["file://\\\\server\\private\\src\\repo", "file://…/src/repo"],
  ["vscode://file/C:/private/src/repo", "vscode://file…/src/repo"],
  ["cwd:C:/private/src/repo;\\\\server\\private\\src\\repo", "cwd:…/src/repo"],
  [`file://${home}/x`, "file://~/x"],
  [`FILE://${home}/x`, "FILE://~/x"],
  [`VsCoDe://FiLe${home}/src/x.ts`, "VsCoDe://FiLe~/src/x.ts"],
  [`https://host${home}/repo`, "https://host~/repo"],
  [`git+ssh://host${home}/repo`, "git+ssh://host~/repo"],
  ["https://host/public/repo", "https://host…/public/repo"],
  ["Review /srv/a/b/c then compare docs/x/y", "Review …/x/y"],
  ["Review /srv/a/b/c docs/x/y", "Review …/x/y"],
  [`Review ${home}/x then compare docs/x/y`, "Review ~/x/y"],
  [`@${home}/x!${home}/y*${home}/z+${home}/w`, "@~/z+~/w"],
])("tokenizer preserves prose and URL prefixes: %s", (input, expected) => {
  const result = dashboardLabel("runName", input!, home)!;
  expect(result).toBe(expected);
  expect(labelLeaks(expected!, [home])).toEqual([]);
  expect(labelLeaks(result, [home])).toEqual([]);
});

// Breaks when processing precedes the input cap, or whitespace/lookahead scans
// backtrack. No DB or background work shares this measurement.
it("caps adversarial input before linear tokenization", () => {
  const cases = [
    "/srv/private/" + " ".repeat(32768),
    "/srv/private/" + "a".repeat(32768),
    "/srv/private/" + " : /".repeat(8192),
    " ".repeat(32768),
    "https://host/" + "a".repeat(32768),
  ];
  for (const input of cases) {
    const start = performance.now();
    const result = dashboardLabel("role", input, home);
    const elapsed = performance.now() - start;
    console.info(`linear tokenizer: ${input.length} chars in ${elapsed.toFixed(3)} ms`);
    expect(elapsed).toBeLessThan(50);
    expect([...result!].length).toBeLessThanOrEqual(160);
  }
  // A tail outside the cap cannot change the path suffix visible in the label.
  expect(dashboardLabel("role", "/" + "a".repeat(4095) + "/TAIL/SUFFIX", home)).not.toContain("TAIL");
});
