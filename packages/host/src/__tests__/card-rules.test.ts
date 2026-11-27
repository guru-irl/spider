import { writeFileSync } from "node:fs";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { icon, type IconStyle } from "@spider/ui";
import { expect, test } from "vitest";
import { cardFixtures } from "./card-fixtures";

const fixtures = cardFixtures();
const styles = ["text", "nerd"] as const satisfies readonly IconStyle[];
type Fixture = ReturnType<typeof cardFixtures>[number];

/** Validate blank rows and markers after stripping the shell's padding. */
function bodyViolations(body: string[], fixture: Pick<Fixture, "name" | "verb" | "groups" | "callDetails" | "itemBoundary" | "taskStarts">, style: IconStyle): Array<[string, string]> {
  const failures: Array<[string, string]> = [];
  const statusGlyphs = ["✓", "✗", "❓", "○", "●", "◆", "⚠", icon(style, "warning"), icon(style, "failure"), icon(style, "gutter")].map(glyph => glyph.trimEnd());
  for (const [i, line] of body.entries()) {
    if (!line) {
      if (i === 0 || i === body.length - 1 || !body[i - 1] || !body[i + 1]) failures.push(["doubled spacer", String(i)]);
      const callGap = fixture.callDetails && i === body.indexOf("");
      const itemGap = fixture.groups > 1 && fixture.itemBoundary?.test(body[i + 1] ?? "");
      if (!callGap && !itemGap && fixture.verb !== "escalation") failures.push(["blank inside item", `${i}: ${body[i + 1] ?? "<end>"}`]);
      continue;
    }
    if (!/^ {1}(?:\S| {2}\S)/u.test(line)) failures.push(["columns", line]);
    const marker = line.trimStart();
    // Nerd task and gutter share a glyph. Only the fixture's actual task text is exempt.
    const taskText = marker.startsWith(icon(style, "task")) ? marker.slice(icon(style, "task").length).trimStart().replace(/…$/u, "").trimEnd() : "";
    const nerdTask = fixture.verb === "run" && style === "nerd" && taskText && fixture.taskStarts?.some(task => task.startsWith(taskText));
    const restartAnnotation = fixture.name === "control config list" && marker.startsWith(`${icon(style, "warning")}restart`);
    if (line.startsWith("   ") && !nerdTask && !restartAnnotation && statusGlyphs.some(glyph => marker === glyph || marker.startsWith(`${glyph} `))) failures.push(["glyph column", line]);
  }
  return failures;
}

const galleryPath = process.env.SPIDER_CARD_GALLERY;
if (galleryPath) {
  const sections = fixtures.map(({ name, render }) =>
    `### ${name}\n\n${render(90, false, "text").map(line => stripTerminalSequences(line).trimEnd()).join("\n")}`,
  );
  writeFileSync(galleryPath, sections.join("\n\n") + "\n");
}

test("layout checks reject misplaced glyphs and invalid blank rows", () => {
  const single = { name: "probe", verb: "run", groups: 1, callDetails: false };
  for (const style of styles) {
    for (const glyph of ["✓", icon(style, "warning"), icon(style, "failure"), icon(style, "gutter")]) {
      expect(bodyViolations([`   ${glyph} misplaced`], single, style)).toContainEqual(["glyph column", `   ${glyph} misplaced`]);
    }
  }
  expect(bodyViolations([" item", "", " detail"], single, "text").map(([rule]) => rule)).toContain("blank inside item");
  expect(bodyViolations([" item", "", "", " next"], single, "text").map(([rule]) => rule)).toContain("doubled spacer");
  expect(bodyViolations([" item", ""], single, "text").map(([rule]) => rule)).toContain("doubled spacer");
  const multi = { ...single, groups: 2, itemBoundary: /^ next item/u };
  expect(bodyViolations([" item", "", " next item"], multi, "text")).toEqual([]);
  expect(bodyViolations([" item", "", " ⎿ detail"], multi, "text").map(([rule]) => rule)).toContain("blank inside item");
  expect(bodyViolations([" ⎿ command", "", " ✓ result"], { ...single, callDetails: true }, "text")).toEqual([]);
  expect(bodyViolations([" ⚠ warning", "", "   paragraph"], { ...single, verb: "escalation" }, "text")).toEqual([]);
});

test.each([
  ["exec detached", "detached", "exit.json"],
  ["exec timeout", "timed out", "exit 1"],
  ["exec signal", "signal SIGTERM", "exec"],
  ["exec stderr", "warning: missing file", "ready"],
  ["run no name", "failed · worker ·", "⤴"],
  ["run thinking notice", "thinking capped to high", "running"],
  ["message remote refusal", "→ subagent · refused", "owning database"],
  ["message unavailable", "recipient unavailable", "Recipient is unavailable"],
  ["message no reply yet", "no reply yet, delivery unknown", "tia-3"],
  ["kill several", "audit · failed", "Permission denied"],
  ["kill error", "No matching run", "kill"],
  ["remember with message", "Staged; see memory entry", "staged"],
  ["todo view another session", "0/1 completed · docs", "#460"],
  ["control doctor failed", "issues found", "storage: unavailable"],
  ["control models errors", "Invalid model configuration", "gpt-6.2-sol"],
  ["control config errors", "Invalid configuration", "ui.icons"],
  ["control upstream-watch candidates", "Fix packaging", "1 candidates"],
  ["control upstream-watch marked", "Marked superpowers", "2a8368ee"],
  ["notification: run no name", "run · worker", "⤴ Finished"],
  ["notification: chain stopped", "chain stopped at step 2 of 3", "provider failed"],
  ["notification: organism partial", "partial", "Review timed out"],
  ["notification: organism failed", "failed", "Review failed"],
  ["notification: escalation blocked", "❌ blocked", "The rebuild"],
  ["notification: escalation question", "❓ question", "The rebuild"],
  ["run paragraph breaks", "Read the logs", "Manifest missing"],
  ["search paragraph breaks", "Check files before upload", "Check the manifest after building"],
  ["loop paragraphs", "Loop check-release", "Next check is scheduled"],
  ["message paragraphs", "Please check the two paths", "Then read the logs"],
  ["remember paragraphs", "Check the output directory", "Then check the manifest"],
  ["recall paragraphs", "Check the output directory", "Then check the manifest"],
  ["todo paragraphs", "Check the packaging job", "Then read the logs"],
  ["skill view paragraphs", "Use the packaging report", "Check the build output"],
  ["skill distill paragraphs", "Write a short skill", "Include the manifest"],
  ["control memory status paragraphs", "Check the output directory", "Then check the manifest"],
])("fixture %s exercises its branch", (name, first, second) => {
  const fixture = fixtures.find(f => f.name === name);
  expect(fixture).toBeDefined();
  const text = fixture!.render(120, true, "text").map(stripTerminalSequences).join("\n");
  expect(text).toContain(first);
  expect(text).toContain(second);
});

for (const fixture of fixtures) {
  test(`${fixture.name} follows the card rules`, () => {
    // Report the first failing example per rule so a heading failure never masks a gutter failure.
    const failures = new Map<string, string>();
    for (const width of [20, 30, 80, 120]) {
      for (const expanded of [false, true]) {
        for (const style of styles) {
          const layout = `${width} columns, ${style}, ${expanded ? "expanded" : "collapsed"}`;
          const check = (rule: string, passes: boolean, sample?: string) => {
            if (!passes && !failures.has(rule)) failures.set(rule, `${layout}${sample === undefined ? "" : `: ${JSON.stringify(sample)}`}`);
          };
          const rendered = fixture.render(width, expanded, style);
          for (const line of rendered) check("width", visibleWidth(line) <= width, stripTerminalSequences(line));
          const plain = rendered.map(line => stripTerminalSequences(line).trimEnd());
          const titleIndex = plain.findIndex(Boolean);
          const pad = fixture.notification ? 1 : 0;
          const title = plain[titleIndex]?.slice(pad) ?? "";
          const titlePrefix = `${icon(style, "spider")} spider · ${fixture.verb}`;
          // The full escalation title cannot fit in 20 columns even without its subject.
          if (width >= 30) {
            check("title", title === titlePrefix || title.startsWith(`${titlePrefix} `), title);
            check("italic verb", Boolean(rendered[titleIndex]?.includes(`\x1b[3m\x1b[36m${fixture.verb}\x1b[39m\x1b[23m`)), title);
          }
          if (fixture.notification) check("one-spacer", titleIndex === 1, `${titleIndex} blank rows`);
          else check("title starts at top", titleIndex === 0, `${titleIndex} blank rows`);
          const body = plain.slice(titleIndex + 1, fixture.notification ? -1 : undefined).map(line => line.slice(pad));
          if (!fixture.callDetails && !fixture.callOnly) check("blank-under-title", Boolean(body[0]));
          if (fixture.callDetails) {
            const gap = body.indexOf("");
            check("call separator", fixture.callOnly ? gap === -1 : gap > 0 && Boolean(body[gap + 1]));
            const commandRows = gap === -1 ? body : body.slice(0, gap);
            check("command gutter", commandRows[0]?.startsWith(` ${icon(style, "gutter")}`) === true, commandRows[0]);
          }
          for (const [rule, sample] of bodyViolations(body, fixture, style)) check(rule, false, sample);
          for (const line of plain) {
            check("no-bar", !line.includes("│"), line);
            for (const id of fixture.runIds) check("no-ids", !line.includes(id) && !line.includes(id.slice(0, 8)), line);
            if (fixture.groups === 1) check("no-single-rule", !line.includes("──"), line);
          }
        }
      }
    }
    expect(Object.fromEntries(failures)).toEqual({});
  });
}
