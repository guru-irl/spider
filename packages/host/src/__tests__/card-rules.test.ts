import { writeFileSync } from "node:fs";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { icon, type IconStyle } from "@spider/ui";
import { expect, test } from "vitest";
import { cardFixtures } from "./card-fixtures";

const fixtures = cardFixtures();
const styles = ["text", "nerd"] as const satisfies readonly IconStyle[];
const galleryPath = process.env.SPIDER_CARD_GALLERY;
if (galleryPath) {
  const sections = fixtures.map(({ name, render }) =>
    `### ${name}\n\n${render(90, false, "text").map(line => stripTerminalSequences(line).trimEnd()).join("\n")}`,
  );
  writeFileSync(galleryPath, sections.join("\n\n") + "\n");
}

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
          const body = plain.slice(titleIndex + 1).map(line => line.slice(pad));
          if (!fixture.callDetails && !fixture.callOnly) check("blank-under-title", Boolean(body[0]));
          if (fixture.callDetails) {
            const gap = body.indexOf("");
            check("call separator", fixture.callOnly ? gap === -1 : gap > 0 && Boolean(body[gap + 1]));
            const commandRows = gap === -1 ? body : body.slice(0, gap);
            check("command gutter", commandRows[0]?.startsWith(` ${icon(style, "gutter")}`) === true, commandRows[0]);
          }
          for (const line of body.filter(Boolean)) check("columns", /^ {1}(?:\S| {2}\S)/u.test(line), line);
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
