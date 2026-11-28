import { expect, test } from "vitest";
import { moonFrame } from "../components/spinner.js";

test("the moon spinner travels left to right over one second", () => {
  const expected = [
    "\uE3E3", "\uE3E1", "\uE3DF", "\uE3DD", "\uE3DB", "\uE3D9", "\uE3D7",
    "\uE3D5", "\uE3D3", "\uE3D1", "\uE3CF", "\uE3CD", "\uE3CB", "\uE3C9",
  ];
  expect(expected.map((_, i) => moonFrame("nerd", (i + 0.5) * 1000 / 14))).toEqual(expected);
  expect(moonFrame("nerd", 1000)).toBe("\uE3E3");
  expect(moonFrame("nerd")).toBe("\uE3E3");
  expect([125, 375, 625, 875].map(time => moonFrame("text", time))).toEqual(["◐", "◓", "◑", "◒"]);
});
