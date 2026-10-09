import { expect, it } from "vitest";
import { hashRoute, routeHash } from "../web/navigation.js";

it("Session hash round trip retains an explicit range independently of the Overview range", () => {
  const route = { page: "session" as const, id: "synthetic-session", tz: "America/New_York", unit: "tokens" as const, range: { from: 1000, to: 9000 } };
  expect(routeHash(route)).toBe("#/session/synthetic-session?unit=tokens&tz=America%2FNew_York&from=1000&to=9000");
  expect(hashRoute("#/session/synthetic-session?unit=tokens&tz=America%2FNew_York&from=1000&to=9000")).toEqual(route);
});
it("old Session hashes omit the range so the server chooses a nonempty default", () => {
  const route = hashRoute("#/session/synthetic-session?unit=credits&tz=UTC");
  expect(route).toEqual({ page: "session", id: "synthetic-session", unit: "credits", tz: "UTC" });
  expect(routeHash(route)).toBe("#/session/synthetic-session?unit=credits&tz=UTC");
});
it.each(["from=1", "from=2&to=1", "from=1.5&to=9", "from=-1&to=9", "from=1e3&to=2000", "from=1&to=8640000000000001", "from=1&from=2&to=9"])("invalid Session hash range is not forwarded (%s)", range => {
  expect(hashRoute(`#/session/synthetic-session?${range}`)).toEqual({ page: "session", id: "synthetic-session", unit: "credits", tz: "UTC" });
});
