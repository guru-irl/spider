import type { FlowRole, Role } from "./dashboard-v4-contract.js";

export function runRoleGroup(role: string | null, agent: string | null): Extract<FlowRole, "workers" | "reviewers" | "scouts" | "other-runs"> {
  switch (role ?? agent) {
    case "worker": case "implementer": return "workers";
    case "reviewer": return "reviewers";
    case "scout": return "scouts";
    default: return "other-runs";
  }
}
export function fourRoleGroup(role: FlowRole): Role {
  return role === "own" || role === "workers" || role === "reviewers" ? role : "others";
}
