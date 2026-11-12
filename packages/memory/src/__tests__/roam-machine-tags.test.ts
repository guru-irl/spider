import { afterEach, expect, it } from "vitest";
import { createReplica } from "@spider/db-core/testutil";
import { addMemory, tagMemory } from "../store";
import { assembleSnapshot } from "../snapshot";

const local = "11111111-1111-4111-8111-111111111111";
const remote = "22222222-2222-4222-8222-222222222222";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

it("machine tags filter injection without editing prose", () => {
  const global = createReplica("global", local);
  const repo = createReplica("repo", local);
  fixtures.push(global, repo);
  const everywhere = addMemory(global.db, "global", { category: "preference", content: "applies everywhere" });
  const here = addMemory(repo.db, "repo", { category: "preference", content: "only this machine" });
  const elsewhere = addMemory(repo.db, "repo", { category: "preference", content: "only another machine" });
  const before = repo.db.prepare("SELECT * FROM memory WHERE uuid = ?").get(elsewhere.uuid) as Record<string, unknown>;
  tagMemory(repo.db, here.uuid, local);
  tagMemory(repo.db, elsewhere.uuid, remote);
  const after = repo.db.prepare("SELECT * FROM memory WHERE uuid = ?").get(elsewhere.uuid) as Record<string, unknown>;
  expect(after).toEqual({ ...before, machine_id: remote });
  const text = assembleSnapshot({ global: global.db, repo: repo.db }, { machineId: local });
  expect(text).toContain(everywhere.content);
  expect(text).toContain(here.content);
  expect(text).not.toContain(elsewhere.content);
  tagMemory(repo.db, elsewhere.uuid, null);
  expect(assembleSnapshot({ repo: repo.db }, { machineId: local })).toContain(elsewhere.content);
}, 5000);
