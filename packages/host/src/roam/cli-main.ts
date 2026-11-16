import { main as roamMain } from "@spider/roam/cli";
import { startProductionHub as startHub } from "@spider/roam/production-hub";
import { createHostMoveBindings } from "./move-runtime";
import { runDisabledForget } from "./disabled-forget";
export function startProductionHub(root: string, options?: Parameters<typeof startHub>[1]): ReturnType<typeof startHub> {
  return startHub(root, { ...options, moveFactory: options?.moveFactory ?? createHostMoveBindings });
}
export function main(argv: readonly string[], io: Parameters<typeof roamMain>[1], options?: Parameters<typeof roamMain>[2]): Promise<number> {
  return roamMain(argv, io, { ...options, moveFactory: options?.moveFactory ?? createHostMoveBindings, runDisabledForget: options?.runDisabledForget ?? runDisabledForget });
}
