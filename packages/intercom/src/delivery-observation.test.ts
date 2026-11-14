import { expect, it } from "vitest";
import { createDeliveryObserver } from "./delivery-observation.js";

it("acknowledgement before teardown is not consumption", () => {
  const observer = createDeliveryObserver<string>();
  observer.register("mail", "generation-1");
  observer.accept("mail", "generation-1");
  expect(observer.settle("mail", "generation-1")).toMatchObject({ accepted: true, observed: false, state: "unknown" });
}, 5000);

it("sendMessage return and queue removal are not injection", () => {
  const observer = createDeliveryObserver<string>();
  observer.register("mail", "generation-1");
  expect(observer.snapshot("mail")).toMatchObject({ accepted: false, observed: false, state: "pending" });
  observer.accept("mail", "generation-1");
  expect(observer.snapshot("mail")).toMatchObject({ accepted: true, observed: false, state: "pending" });
  observer.observe("mail", "generation-1", "physical-entry");
  expect(observer.settle("mail", "generation-1")).toMatchObject({ accepted: true, observed: true, state: "injected", evidence: "physical-entry" });
}, 5000);

it("abort before entry emits not_injected only with excluded-generation proof", () => {
  const observer = createDeliveryObserver<string>();
  observer.register("mail", "generation-1");
  expect(observer.settle("mail", "generation-1", { excludedGeneration: "other", complete: true })).toMatchObject({ state: "unknown" });
  expect(observer.settle("mail", "generation-1", { excludedGeneration: "generation-1", complete: true })).toMatchObject({ state: "not_injected" });
}, 5000);

it("busy steer reload before drain keeps payload for same-id redelivery", () => {
  const observer = createDeliveryObserver<string>();
  observer.register("mail", "generation-1");
  observer.accept("mail", "generation-1");
  expect(observer.register("mail", "generation-2")).toBe(false);
  observer.settle("mail", "generation-1", { excludedGeneration: "generation-1", complete: true });
  expect(observer.register("mail", "generation-2")).toBe(true);
  observer.observe("mail", "generation-1", "stale-entry");
  expect(observer.snapshot("mail")).toMatchObject({ observed: false });
  observer.observe("mail", "generation-2", "new-entry");
  expect(observer.register("mail", "generation-3")).toBe(false);
  expect(observer.snapshot("mail")).toMatchObject({ state: "injected", evidence: "new-entry" });
}, 5000);

it("an early physical entry does not fabricate a protocol acknowledgement", () => {
  const observer = createDeliveryObserver<string>(); observer.register("mail", "generation");
  observer.observe("mail", "generation", "entry");
  expect(observer.snapshot("mail")).toMatchObject({ accepted: false, observed: true, state: "injected" });
  observer.accept("mail", "generation");
  expect(observer.snapshot("mail")).toMatchObject({ accepted: true, observed: true });
}, 5000);

it("RPC and intercom share observation settlement", () => {
  for (const id of ["rpc-request", "intercom-id"]) {
    const observer = createDeliveryObserver<string>();
    observer.register(id, "generation");
    observer.observe(id, "generation", "entry");
    observer.accept(id, "generation");
    expect(observer.settle(id, "generation")).toMatchObject({ accepted: true, observed: true, state: "injected" });
  }
}, 5000);
