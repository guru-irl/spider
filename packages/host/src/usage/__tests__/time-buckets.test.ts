import { expect, it } from "vitest";
import { normalizeTimeZone, resolveRange, timeBuckets } from "../time-buckets.js";
const D = 86_400_000, H = 3_600_000;
const ts = (s: string) => Date.parse(s);
it.each([
  ["2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z", "America/New_York", 23],
  ["2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z", "America/New_York", 25],
  ["2026-04-04T13:00:00Z", "2026-04-05T13:30:00Z", "Australia/Lord_Howe", 25],
  ["2026-10-01T18:15:00Z", "2026-10-02T18:15:00Z", "Asia/Kathmandu", 24],
])("unique monotonic hour buckets in %s to %s", (a,b,tz,count) => {
  const start=ts(a), end=ts(b), rows=timeBuckets({start,end},tz,"hour");
  expect(rows).toHaveLength(count); expect(new Set(rows.map(r=>r.key)).size).toBe(count);
  expect(rows.reduce((n,r)=>n+r.end-r.start,0)).toBe(end-start);
  expect(rows.every((r,i)=>r.start<r.end && (!i || r.start===rows[i-1]!.end))).toBe(true);
});
it("day boundaries survive skipped midnight and skipped dates", () => {
  const rows=timeBuckets({start:ts("2011-12-29T10:00:00Z"),end:ts("2011-12-31T10:00:00Z")},"Pacific/Apia","day");
  expect(rows.map(r=>r.key)).toEqual([ts("2011-12-29T10:00:00Z"),ts("2011-12-30T10:00:00Z")]);
  const midnight=timeBuckets({start:ts("2018-11-04T03:30:00Z"),end:ts("2018-11-04T05:00:00Z")},"America/Sao_Paulo","day");
  expect(midnight[0]!.key).toBe(ts("2018-11-04T03:00:00Z"));
});
it("aligned keys are not clipped and invalid zones become UTC",()=>{
  expect(normalizeTimeZone("Not/AZone")).toBe("UTC");
  expect(timeBuckets({start:H+123,end:2*H+456},"UTC","hour")).toEqual([{key:H,start:H+123,end:2*H},{key:2*H,start:2*H,end:2*H+456}]);
});
it("range presets ignore bounds and leave selection to the route parser",()=>{
  const now=ts("2026-10-08T12:30:00Z");
  const q=resolveRange(new URLSearchParams(`range=24h&from=bad&to=bad&tz=Not/AZone&buckets=${now},${now-H-1800000},1&unit=tokens`),now);
  expect(q).toMatchObject({range:"24h",from:now-D,to:now,tz:"UTC",unit:"tokens",buckets:[]});
  expect(resolveRange(new URLSearchParams(),now).from).toBe(now-7*D);
});
it("custom range rejects missing, nonnumeric, reversed and over-93-day bounds",()=>{
  for(const s of ["range=custom","range=custom&from=x&to=10","range=custom&from=20&to=10",`range=custom&from=0&to=${94*D}`,"range=7d&unit=bad"])
    expect(()=>resolveRange(new URLSearchParams(s),100*D)).toThrow("invalid-query");
  expect(resolveRange(new URLSearchParams(`range=month`),100*D,{start:99*D,end:120*D})).toMatchObject({from:99*D,to:100*D});
});
