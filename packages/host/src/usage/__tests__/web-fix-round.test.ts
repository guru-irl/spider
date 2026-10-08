import { expect, it } from "vitest";
import { hashRoute, routeHash } from "../web/navigation.js";

it.each(["_session", "-session", ".session", ":session", "a".repeat(128)])("hash accepts supported detail id %s", id => {
  expect(hashRoute(`#/session/${encodeURIComponent(id)}`)).toMatchObject({ page: "session", id });
});
it.each([
  "#view=cache&filters=" + encodeURIComponent(JSON.stringify([{field:"role",value:"worker"}])).replace("worker", "%E0%A4%A"), "#view=cache&bad=%E0%A4%A", "#view=cache&view=cache", "#view=cache&unknown=yes", "#view=session&id=bad%20id", "#view=session&id=" + "a".repeat(129),
  "#view=cache&" + "&".repeat(16384),
  ...[Array(17).fill({ field: "role", value: "worker" }), [{ field: "role", kind: "wrong", value: "worker" }], [{ field: "role", kind: "missing", value: "worker" }], [{ field: "role", value: "a".repeat(1025) }], { field: "role" }].map(f => "#view=cache&filters=" + encodeURIComponent(JSON.stringify(f))),
  "#view=cache&start=1", "#view=cache&start=1&end=9007199254740992", "#view=cache&start=1&end=8640000000000001",
])("each validator rejects a malformed hash with a valid view: %s", hash => expect(hashRoute(hash).page).toBe("overview"));

it("new route hashes omit the unused mode while accepting legacy hashes", () => {
  expect(routeHash({page:"calibration"})).not.toContain("mode=");
  expect(hashRoute("#view=cache&mode=table")).toMatchObject({page:"overview"});
});
