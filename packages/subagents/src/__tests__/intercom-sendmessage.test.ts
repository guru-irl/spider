// packages/subagents/src/__tests__/intercom-sendmessage.test.ts
// IMPORTANT 4: pi.sendMessage?.() silent message loss
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pollPendingMessages } from "../intercom";
import { MessageStore } from "../message-store";
import { openDbAt } from "@spider/db-core";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setGlobalDbPathForTests } from "@spider/db-core";

const scratch = join(dirname(fileURLToPath(import.meta.url)), "..", ".spider", "scratch", `intercom-send-${process.pid}`);

beforeEach(() => {
  mkdirSync(scratch, { recursive: true });
  setGlobalDbPathForTests(join(scratch, `g-${Date.now()}.db`));
});

afterEach(() => {
  setGlobalDbPathForTests(null);
  rmSync(scratch, { recursive: true, force: true });
});

describe("IMPORTANT 4: sendMessage availability", () => {
  it("if sendMessage is unavailable, message must remain pending (not marked delivered)", async () => {
    const globalDb = openDbAt(join(scratch, "global.db"), "global");
    const store = new MessageStore(globalDb);
    
    // Enqueue a message
    const msgId = store.enqueue({
      fromSession: "sender",
      toSession: "receiver",
      kind: "message",
      body: "test message",
    });
    
    // Verify it's pending
    const pending = store.pending("receiver");
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe(msgId);
    
    // Poll with pi that has NO sendMessage (host doesn't support it)
    const piWithoutSendMessage = {
      // No sendMessage property
    };
    
    await pollPendingMessages(globalDb, "receiver", piWithoutSendMessage);
    
    // Message must STILL be pending (not marked delivered)
    const stillPending = store.pending("receiver");
    expect(stillPending.length).toBe(1);
    expect(stillPending[0].id).toBe(msgId);
    
    globalDb.close();
  });
  
  it("if sendMessage is available, message is delivered and marked", async () => {
    const globalDb = openDbAt(join(scratch, "global.db"), "global");
    const store = new MessageStore(globalDb);
    
    // Enqueue a message
    const msgId = store.enqueue({
      fromSession: "sender",
      toSession: "receiver",
      kind: "message",
      body: "test message",
    });
    
    let deliveredMessage = null;
    const piWithSendMessage = {
      sendMessage: (msg: any) => {
        deliveredMessage = msg;
      },
    };
    
    await pollPendingMessages(globalDb, "receiver", piWithSendMessage);
    
    // Message should be delivered
    expect(deliveredMessage).not.toBeNull();
    
    // Message should be marked as delivered (no longer pending)
    const stillPending = store.pending("receiver");
    expect(stillPending.length).toBe(0);
    
    globalDb.close();
  });
  
  it("if sendMessage throws, message remains pending for retry", async () => {
    const globalDb = openDbAt(join(scratch, "global.db"), "global");
    const store = new MessageStore(globalDb);
    
    // Enqueue a message
    const msgId = store.enqueue({
      fromSession: "sender",
      toSession: "receiver",
      kind: "message",
      body: "test message",
    });
    
    const piWithFailingSendMessage = {
      sendMessage: () => {
        throw new Error("delivery failed");
      },
    };
    
    await pollPendingMessages(globalDb, "receiver", piWithFailingSendMessage);
    
    // Message should STILL be pending (for retry on next session_start)
    const stillPending = store.pending("receiver");
    expect(stillPending.length).toBe(1);
    expect(stillPending[0].id).toBe(msgId);
    
    globalDb.close();
  });
});
