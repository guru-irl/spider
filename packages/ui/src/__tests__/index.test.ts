import { describe, it, expect } from "vitest";
import * as ui from "../index";

describe("@spider/ui Phase 5 surface", () => {
  it("re-exports agent UI symbols", () => {
    for (const name of [
      "AgentStore", "AgentFooter", "Grid", "AgentDetail", "FrameScheduler",
      "diffLines", "hasChanges", "layoutGrid", "buildFooterModel",
      "renderGridCell", "renderProgressBar", "renderDiffView", "renderTable", "Spinner",
      "STATUS_GLYPH", "statusToken", "formatDuration",
    ]) {
      expect(ui).toHaveProperty(name);
    }
    // Phase 0 skeleton still present
    for (const name of ["Panel", "SectionRule", "StatusLine", "LiveWidget", "theme"]) {
      expect(ui).toHaveProperty(name);
    }
  });
});
