import { Theme } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import glass from "../../../herdr/assets/themes/dracula-plus-glass.json" with { type: "json" };
import { piTheme } from "./theme-adapter.js";

const colors = Object.fromEntries(Object.entries(glass.colors).map(([role, value]) => [role, glass.vars[value as keyof typeof glass.vars] ?? value]));

it.each([
  ["truecolor", /^\x1b\[38;2;\d+;\d+;\d+m/u],
  ["256color", /^\x1b\[38;5;\d+m/u],
] as const)("interpolates the robot pulse in %s", (mode, ansi) => {
  const theme = new Theme(colors as ConstructorParameters<typeof Theme>[0], colors as ConstructorParameters<typeof Theme>[1], mode);
  const tint = piTheme(theme).activityTint!;
  const robot = "◇";
  expect(tint(robot, 0)).toBe(theme.fg("dim", robot));
  expect(tint(robot, 1)).toBe(theme.fg("accent", robot));
  const halfway = tint(robot, 0.5);
  expect(halfway).toMatch(ansi);
  expect(halfway).not.toBe(tint(robot, 0));
  expect(halfway).not.toBe(tint(robot, 1));
});
