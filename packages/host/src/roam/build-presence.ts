import { SCHEMA_VERSION } from "@spider/db-core";
import type { PresenceMetadata } from "@spider/herdr/sessions/presence";
import { LOADED_BUILD } from "../build-id.js";

export function loadedBuildPresence(): PresenceMetadata {
  return { build: LOADED_BUILD, capabilities: { roamSchema: SCHEMA_VERSION } };
}
