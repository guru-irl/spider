import { PassThrough } from "node:stream";
import { afterEach, expect, test } from "vitest";
import * as implementation from "../../../../../scripts/usage-dashboard-cdp.mjs";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function pipe(timeoutMs = 1000) {
  const input = new PassThrough();
  const output = new PassThrough();
  const commands: { id: number; method: string }[] = [];
  input.on("data", data => { commands.push(JSON.parse(data.toString().replace(/\0$/, ""))); });
  expect(implementation.createCdpTransport).toBeTypeOf("function");
  const transport = implementation.createCdpTransport({ input, output, timeoutMs });
  cleanups.push(() => { transport.close(); input.destroy(); output.destroy(); });
  return { transport, output, commands };
}
function frame(value: unknown) { return Buffer.from(JSON.stringify(value) + "\0"); }

// Dropping the partial remainder after a complete frame loses the large reply.
test("transport reassembles mixed and split frames including a 4.2 MB payload", async () => {
  const { transport, output, commands } = pipe();
  const first = transport.send("Runtime.evaluate");
  const large = transport.send("Page.captureScreenshot");
  const third = transport.send("Runtime.evaluate");
  const fourth = transport.send("Runtime.evaluate");
  const data = "x".repeat(4_272_716);
  const bigFrame = frame({ id: commands[1]!.id, result: { data } });
  output.write(Buffer.concat([frame({ id: commands[2]!.id, result: { value: 3 } }), frame({ id: commands[3]!.id, result: { value: 4 } }), bigFrame.subarray(0, 13)]));
  for (let offset = 13; offset < bigFrame.length; offset += 65536) output.write(bigFrame.subarray(offset, offset + 65536));
  const last = frame({ id: commands[0]!.id, result: { value: 1 } });
  for (const byte of last) output.write(Buffer.from([byte]));
  expect(await first).toEqual({ value: 1 });
  expect(await large).toEqual({ data });
  expect(await third).toEqual({ value: 3 });
  expect(await fourth).toEqual({ value: 4 });
});

// Resolving an error, stripping its method or leaking control codes is incorrect.
test("CDP errors reject with method, code and sanitized truncated detail", async () => {
  const { transport, output, commands } = pipe();
  const pending = transport.send("Runtime.evaluate");
  const rejection = expect(pending).rejects.toThrow(/Runtime\.evaluate.*-32000.*bad expression/);
  output.write(frame({ id: commands[0]!.id, error: { code: -32000, message: "\u001b[31mbad expression\n" + "x".repeat(1000) } }));
  await rejection;
  const error = await pending.catch((error: Error) => error);
  expect(error.message).not.toMatch(/[\x00-\x1f\x7f]|\[31m/);
  expect(error.message.length).toBeLessThan(500);
});

// A fail that only clears pending entries accepts doomed new commands.
test("above the buffer cap transport rejects pending and new commands immediately", async () => {
  const { transport, output } = pipe(5000);
  const pending = transport.send("Page.captureScreenshot");
  const rejection = expect(pending).rejects.toThrow("cdp-buffer-limit");
  output.write(Buffer.alloc(32 * 1024 * 1024 + 1, 120));
  await rejection;
  const start = Date.now();
  await expect(transport.send("Runtime.evaluate")).rejects.toThrow("cdp-buffer-limit");
  expect(Date.now() - start).toBeLessThan(1000);
});

test("command timeout is bounded and carries the method", async () => {
  const { transport } = pipe(30);
  await expect(transport.send("Runtime.evaluate")).rejects.toThrow(/cdp-command-timeout.*Runtime\.evaluate/);
});

test("invalid framing fails the transport for pending and future sends", async () => {
  const { transport, output } = pipe();
  const pending = transport.send("Browser.getVersion");
  const rejection = expect(pending).rejects.toThrow("cdp-invalid-frame");
  output.write("{bad}\0");
  await rejection;
  await expect(transport.send("Browser.getVersion")).rejects.toThrow("cdp-invalid-frame");
});

// A string-valued CDP code must not inject controls or arbitrarily long text.
test("CDP error codes are sanitized and bounded", async () => {
  const { transport, output, commands } = pipe();
  const pending = transport.send("Runtime.evaluate");
  const rejection = expect(pending).rejects.toThrow("cdp-command-failed");
  output.write(frame({ id: commands[0]!.id, error: { code: "\u001b[31mbad\n" + "x".repeat(1000), message: "fixture" } }));
  await rejection;
  const error = await pending.catch((error: Error) => error);
  expect(error.message).not.toMatch(/[\x00-\x1f\x7f]|\[31m/);
  expect(error.message.length).toBeLessThan(500);
});
