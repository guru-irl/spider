import { expect, it } from "vitest";
import * as path from "node:path";
import { isAbsolutePathList } from "../absolute-paths.js";

it.each([
  { file: "C:\\extensions\\extra.ts", valid: true },
  { file: "C:/extensions/extra.ts", valid: true },
  { file: "//server/share/x.ts", valid: true },
  { file: "\\\\server", valid: false },
  { file: "\\\\server\\share\\extra.ts", valid: true },
  { file: "\\extra.ts", valid: false },
  { file: "/extra.ts", valid: false },
  { file: "C:extra.ts", valid: false },
  { file: "extra.ts", valid: false },
])("win32 requires drive-qualified or UNC paths: $file", ({ file, valid }) => {
  expect(isAbsolutePathList([file], path.win32)).toBe(valid);
});

it.each([
  { value: ["/extensions/extra.ts", "/other.ts"], valid: true },
  { value: [], valid: true },
  { value: ["//extensions/extra.ts"], valid: true },
  { value: ["relative.ts"], valid: false },
  { value: ["/extra.ts", "relative.ts"], valid: false },
  { value: [false], valid: false },
  { value: {}, valid: false },
  { value: null, valid: false },
])("POSIX absolute path list: $value", ({ value, valid }) => {
  expect(isAbsolutePathList(value, path.posix)).toBe(valid);
});
