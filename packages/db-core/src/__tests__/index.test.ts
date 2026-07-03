import { describe, it, expect } from "vitest";
import * as dbcore from "../index";

describe("@spider/db-core public API", () => {
  it("exports the canonical symbols", () => {
    for (const name of [
      "openGlobal", "openProject", "openDbAt", "openProjectByPath", "migrate", "resolveProject", "registerProject",
      "appendRunEvent", "bus", "paths",
    ]) {
      expect(dbcore).toHaveProperty(name);
    }
    expect(dbcore.bus).toHaveProperty("on");
    expect(dbcore.bus).toHaveProperty("emit");
    expect(dbcore.paths).toHaveProperty("globalRoot");
  });
});
