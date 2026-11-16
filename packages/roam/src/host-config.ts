import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertTestConfigPath } from "@spider/db-core";
import { parseHerdrConfig } from "@spider/herdr/config";
import type { HerdrConfig } from "@spider/herdr/contracts";

function readOwnedJson(file: string): unknown {
  assertTestConfigPath(file);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 ||
      typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Unsafe Herdr configuration");
  return JSON.parse(readFileSync(file, "utf8"));
}
export function loadHerdrConfig(root: string): HerdrConfig {
  const settings = join(root, "config.json");
  const value = existsSync(settings) ? readOwnedJson(settings) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid global configuration");
  const configured = (value as Record<string, unknown>)["herdr.config"];
  if (configured !== undefined && (typeof configured !== "string" || !configured)) throw new Error("Invalid Herdr configuration path");
  const file = configured === undefined ? join(root, "herdr", "config.json") : resolve(root, configured as string);
  const config = parseHerdrConfig(readOwnedJson(file));
  if (resolve(config.globalRoot) !== root) throw new Error("Herdr configuration belongs to another global root");
  return config;
}
