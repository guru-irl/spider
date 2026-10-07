import { expect, test } from "vitest";
import { dashboardLabel } from "../dashboard-identities.js";

test("absolute path labels normalize before home comparison; relative values stay literal", () => {
  for (const field of ["project", "repo"] as const) {
    for (const [path, expected] of [
      ["~/team/../team/project", "~/team/project"],
      ["/synthetic/home/team/../team/project", "~/team/project"],
      ["/synthetic/home/../../private/team/project", "…/team/project"],
      ["team/./project", "team/./project"], ["../team/project", "../team/project"],
      ["../../team/../project", "../../team/../project"], ["../..", "../.."],
      ["/synthetic/home/team with spaces/../team with spaces/project name", "~/team with spaces/project name"],
      ["../team with spaces/project name", "../team with spaces/project name"],
    ]) expect(dashboardLabel(field, path!, "/synthetic/home")).toBe(expected);
    expect(dashboardLabel(field, "C:\\Users\\Seat\\team\\..\\project name", "c:\\users\\seat")).toBe("~/project name");
    expect(dashboardLabel(field, "\\\\server\\share\\home\\team\\..\\project", "\\\\server\\share\\home")).toBe("~/project");
    expect(dashboardLabel(field, "C:team\\..\\project", "C:\\home")).toBe("C:team\\..\\project");
  }
  expect(dashboardLabel("model", 'note="/private/team/project"')).toBe('note="…/team/project"');
  expect(dashboardLabel("provider", "file:/private/team/../team/project")).toBe("file:…/team/project");
});

test("drive-relative values are not absolute path labels", () => {
  expect(dashboardLabel("project", "C:project", "C:\\home")).toBe("C:project");
});

test("forward-slash UNC paths use Windows normalization and home case folding", () => {
  expect(dashboardLabel("project", "//SERVER/share/home/team/../project", "//server/share/home")).toBe("~/project");
});

// Redacting ordinary relative paths loses useful labels without improving privacy.
test("free text preserves dot-relative paths and normalizes tilde paths", () => {
  expect(dashboardLabel("model", "x=../../a/b/c", "/synthetic/home")).toBe("x=../../a/b/c");
  expect(dashboardLabel("provider", "see ./a/b/c now", "/synthetic/home")).toBe("see ./a/b/c now");
  expect(dashboardLabel("model", "see ~/a/b", "/synthetic/home")).toBe("see ~/a/b");
  expect(dashboardLabel("model", "see ~/a/../b", "/synthetic/home")).toBe("see ~/b");
});

test("project and repo identifiers with slashes are not paths", () => {
  for (const field of ["project", "repo"] as const) {
    for (const value of ["owner/repo", "owner/repo/branch", "owner\\repo", ".", "..", "team/./project", "C:project"]) {
      expect(dashboardLabel(field, value, "/synthetic/home")).toBe(value);
    }
    expect(dashboardLabel(field, "/private/team/project", "/synthetic/home")).toBe("…/team/project");
    expect(dashboardLabel(field, "~/team/project", "/synthetic/home")).toBe("~/team/project");
    expect(dashboardLabel(field, "~", "/synthetic/home")).toBe("~/");
  }
});

test.each(["/", "", "C:", "C:\\", "C:/", "//"])("root or empty home %j never maps paths to tilde", home => {
  expect(dashboardLabel("project", "/private/team/project", home)).toBe("…/team/project");
  expect(dashboardLabel("model", "at /private/team/project", home)).toBe("at …/team/project");
  expect(dashboardLabel("project", "~/private/team/project", home)).toBe("…/team/project");
  expect(dashboardLabel("model", "at C:\\private\\team\\project", home)).toBe("at …/team/project");
  expect(dashboardLabel("model", "at ~/team/project", home)).toBe("at …/team/project");
});

// Removing normalization or allowing parents above a root leaks traversal segments.
test.each([
  ["~/a/../b", "~/b"], ["~/a/../../b", "…/b"], ["~/./a/b/..", "~/a"],
  ["~/a/..", "~/"], ["/a/../../x/y/z", "…/y/z"], ["/a/./b", "…/a/b"],
  ["/a/b/..", "…/a"], ["C:\\a\\..\\..\\x\\y\\z", "…/y/z"],
  ["/synthetic/home/a/../b", "~/b"],
  ["/synthetic/home/../../x/y/z", "…/y/z"],
  ["/synthetic/home-another/x", "…/home-another/x"],
  ["/synthetic/home/../home-another/x", "…/home-another/x"],
  ["note=[/private/team/project],file:/private/team/project", "note=[…/team/project"],
])("embedded paths normalize dot segments and clamp at their root: %s", (input, expected) => {
  expect(dashboardLabel("model", input, "/synthetic/home")).toBe(expected);
});

test.each(["C:\\", "C:/", "//", "/"])("filesystem or drive root %j is not a home mapping", home => {
  expect(dashboardLabel("project", "C:\\private\\team\\project", home)).toBe("…/team/project");
  expect(dashboardLabel("project", "~/private/team/project", home)).toBe("…/team/project");
});
