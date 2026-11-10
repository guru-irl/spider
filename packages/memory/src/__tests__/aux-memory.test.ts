import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { digestHistory } from "../aux";

it("normalizes whitespace before taking the existing digest prefixes", () => {
  const messages = [
    { role: "user" as const, content: "\n  " + "u\n".repeat(200) + "  \n" },
    { role: "assistant" as const, content: "\n  " + "a\n".repeat(200) + "  \n" },
    { role: "user" as const, content: "Recent message stays verbatim.\n" },
  ];
  const result = digestHistory(messages, 1);
  expect(result[0].content.split("\n").slice(1)).toEqual([
    "USER: " + messages[0].content.replace(/\n/g, " ").trim().slice(0, 300),
    "ASSISTANT: " + messages[1].content.replace(/\n/g, " ").trim().slice(0, 200),
  ]);
  expect(result[1]).toBe(messages[2]);
});

it("does not materialize old message bodies to produce short digest prefixes", () => {
  const source = new URL("../aux.ts", import.meta.url).href;
  const output = execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", `
    const { digestHistory } = await import(${JSON.stringify(source)});
    const messages = Array.from({ length: 32 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: i + 'text\\n'.repeat(200000) }));
    for (const message of messages) Buffer.byteLength(message.content);
    for (let i = 0; i < 3; i++) global.gc();
    const before = process.resourceUsage().maxRSS;
    const result = digestHistory(messages, 1);
    console.log(JSON.stringify({ count: result.length, growth: (process.resourceUsage().maxRSS - before) * 1024 }));
  `], { encoding: "utf8" });
  const result = JSON.parse(output.trim()) as { count: number; growth: number };
  expect(result.count).toBe(2);
  expect(result.growth).toBeLessThan(16 * 1024 * 1024);
});
