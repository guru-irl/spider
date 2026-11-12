import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { setGlobalDbPathForTests } from "@spider/db-core";
import { createReplica } from "@spider/db-core/testutil";
import { addMemory, tagMemory } from "@spider/memory";
import { readInjectionSnapshot } from "../injection-snapshot";

const local = "11111111-1111-4111-8111-111111111111";
const remote = "22222222-2222-4222-8222-222222222222";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => {
  setGlobalDbPathForTests(null);
  for (const fixture of fixtures.splice(0)) fixture.close();
});

it("host injects only local and untagged memory", () => {
  const global = createReplica("global", local);
  fixtures.push(global);
  execFileSync("git", ["init", "-q", global.root]);
  setGlobalDbPathForTests(global.db.raw.name);
  const everywhere = addMemory(global.db, "global", { category: "preference", content: "universal setting" });
  const here = addMemory(global.db, "global", { category: "preference", content: "local setting" });
  const there = addMemory(global.db, "global", { category: "preference", content: "foreign setting" });
  tagMemory(global.db, here.uuid, local);
  tagMemory(global.db, there.uuid, remote);
  const snapshot = readInjectionSnapshot(global.root);
  expect(snapshot.text).toContain(everywhere.content);
  expect(snapshot.text).toContain(here.content);
  expect(snapshot.text).not.toContain(there.content);
}, 5000);
