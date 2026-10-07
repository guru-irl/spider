import { expect, it } from "vitest";
import { dashboardLabel } from "../dashboard-identities.js";
import { labelLeaks } from "./fixtures/label-privacy.js";

// Missing colon delimiters leaks these paths; treating every :// as a path
// damages URL schemes. Whitespace inside a path must not leave a private tail.
it.each([
  ["path:/srv/private/repo", "path:…/private/repo"],
  ["cwd:/srv/private/repo", "cwd:…/private/repo"],
  ["file:/srv/private/repo", "file:…/private/repo"],
  ["file:///srv/private/repo", "file://…/private/repo"],
  ["path:C:\\private\\src\\repo", "path:…/src/repo"],
  ["cwd:C:/private/src/repo", "cwd:…/src/repo"],
  ["file:C:\\private\\src\\repo", "file:…/src/repo"],
  ["path:\\\\server\\private\\src\\repo", "path:…/src/repo"],
  ["cwd:\\\\server\\private\\src\\repo", "cwd:…/src/repo"],
  ["file:\\\\server\\private\\src\\repo", "file:…/src/repo"],
  ["path:/synthetic/home with spaces/Private Docs/work", "path:~/Private Docs/work"],
  ["--cwd=/synthetic/home with spaces/Private Docs/work", "--cwd=~/Private Docs/work"],
  ["[/synthetic/home with spaces/Private Docs/work]", "[~/Private Docs/work]"],
  ["`/synthetic/home with spaces/Private Docs/work`", "`~/Private Docs/work`"],
  ["a,/synthetic/home with spaces/Private Docs/work", "a,~/Private Docs/work"],
  ["path:/srv/private folder/external project", "path:…/private folder/external project"],
  ["https://example.invalid/repo", "https://example.invalid/repo"],
  ["http://example.invalid/repo", "http://example.invalid/repo"],
  ["git+ssh://example.invalid/repo", "git+ssh://example.invalid/repo"],
  ["file:", "file:"],
  ["cwd:/srv/private path:/outside/secret", "cwd:…/outside/secret"],
  ["cwd:/synthetic/home with spaces/work path:/outside/secret", "cwd:~/outside/secret"],
  ["cwd:/srv/private https://example.invalid/repo", "cwd:…/example.invalid/repo"],
  ["https://example.invalid/repo cwd:/srv/private/repo", "https://example.invalid…/private/repo"],
])("embedded paths redact safely: %s", (input, expected) => {
  const home = "/synthetic/home with spaces";
  const result = dashboardLabel("role", input, home)!;
  expect(result).toBe(expected);
  expect(labelLeaks(expected, [home])).toEqual([]);
  expect(labelLeaks(result, [home])).toEqual([]);
});
