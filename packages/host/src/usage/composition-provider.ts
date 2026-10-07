import type { CompositionProvider } from "./dashboard-contract.js";

export const phase2CompositionProvider: CompositionProvider = {
  availability: () => ({ status: "unavailable", phase: 2, reason: "not-built", message: "Not available yet (Phase 2)" }),
};
