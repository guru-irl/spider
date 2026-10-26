// Ported test cases from https://github.com/michael-denyer/pstack-claude,
// tests/pi/interaction.test.mjs at 046341e. MIT licensed.
// Copyright (c) 2026 Lauren Tan
// Copyright (c) 2026 Michael Denyer
import { describe, expect, it } from "vitest";
import { parseLoop } from "../parser";

describe("loop grammar", () => {
  it.each([
    ["", { kind: "list" }],
    ["  ", { kind: "list" }],
    ["stop", { kind: "stop", target: "defaults" }],
    [" stop  ", { kind: "stop", target: "defaults" }],
    ["5m check CI", { kind: "fixed", seconds: 300, token: "5m", prompt: "check CI" }],
    ["1h check deploy", { kind: "fixed", seconds: 3600, token: "1h", prompt: "check deploy" }],
    ["10s poll", { kind: "fixed", seconds: 10, token: "10s", prompt: "poll" }],
    ["0s poll", { kind: "fixed", seconds: 0, token: "0s", prompt: "poll" }],
    ["24d check", { kind: "fixed", seconds: 2073600, token: "24d", prompt: "check" }],
    ["5m", { kind: "usage" }],
    ["5m   ", { kind: "usage" }],
    ["watch PR 42", { kind: "dynamic", prompt: "watch PR 42" }],
    ["  5m  first\nsecond  ", { kind: "fixed", seconds: 300, token: "5m", prompt: "first\nsecond" }],
    // Only whole numbers and lowercase s/m/h/d are interval tokens in pstack.
    ["1.5m check", { kind: "dynamic", prompt: "1.5m check" }],
    ["5M check", { kind: "dynamic", prompt: "5M check" }],
    ["-5m check", { kind: "dynamic", prompt: "-5m check" }],
    ["stop now", { kind: "stop", target: "name", name: "now" }],
    ["stop all", { kind: "stop", target: "all" }],
    ["stop build", { kind: "stop", target: "name", name: "build" }],
  ])("parses %j", (input, expected) => {
    expect(parseLoop(input as string)).toEqual(expected);
  });

  it.each(["stop bad name", "stop .bad", "stop -bad", "stop " + "a".repeat(41)])("rejects invalid stop grammar %j", input => {
    expect(parseLoop(input).kind).toBe("usage");
  });

  it.each(["25d check", "2073601s check", "999999999999999999999999h check"])("refuses unsafe timer interval %s", input => {
    expect(parseLoop(input)).toEqual({ kind: "usage", reason: "Intervals over 24 days are not supported." });
  });
});
