import type { AdapterMachineRecoveryOutcome } from "./move-ports";

/** The runtime takes the hub single-instance lock before making recovery effects. */
export type DisabledForgetResult = AdapterMachineRecoveryOutcome | { ok: false; reason: "hub-running" | "not-disabled" };
export type RunDisabledForget = (input: { machine: string; confirmed: true }) => Promise<DisabledForgetResult>;
