import type { SchedulerTimeMath } from "./index";
import { formatInZone, parseAt, resolveTimeZone } from "./zoned";
import { nextCronAt, parseCron } from "./cron";

export function createTimeMath(): SchedulerTimeMath {
  return { resolveTimeZone, parseAt, formatInZone, parseCron, nextCronAt };
}
