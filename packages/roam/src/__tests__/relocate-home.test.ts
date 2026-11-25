import { afterEach, describe, expect, it } from "vitest";
import { createReplica } from "@spider/db-core/testutil";
import type { MachineId } from "@spider/db-core/roam/types";
import { createHomeStore } from "../relocate/home";
import type { MovingHome, RelocateId, RunningHome, SessionId } from "../relocate/types";

const HUB = "11111111-1111-4111-8111-111111111111" as MachineId;
const BOX = "22222222-2222-4222-8222-222222222222" as MachineId;
const OTHER = "33333333-3333-4333-8333-333333333333" as MachineId;
const SESSION = "session-1" as SessionId;
const MOVE = "v0-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as RelocateId;
const MOVE2 = "v0-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as RelocateId;
const fixtures: { close(): void }[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
function fixture(machine = HUB) {
  const replica = createReplica("global", machine); fixtures.push(replica);
  return { db: replica.db, homes: createHomeStore({ db: replica.db, hubMachineId: HUB, localMachineId: machine }) };
}
function next(home: RunningHome): MovingHome {
  return { ...home, epoch: home.epoch + 1, state: "moving", destination: BOX, moveId: MOVE, updatedAt: 123 };
}

describe("v0 hub home store", () => {
  it("only the Mac hub mutates homes", async () => {
    const box = fixture(BOX);
    box.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?, ?, 1, NULL, 10, 'running', NULL)").run(SESSION, BOX);
    const current = (await box.homes.read(SESSION)) as RunningHome;
    expect(current).toEqual({sessionId:SESSION,machineId:BOX,epoch:1,moveId:null,updatedAt:10,state:"running",destination:null});
    expect(await box.homes.list()).toEqual([current]);
    await expect(box.homes.initialize("another" as SessionId, BOX)).rejects.toThrow(/hub/i);
    await expect(box.homes.compareAndSwap(current, next(current))).rejects.toThrow(/hub/i);
    expect(await box.homes.list()).toEqual([current]);
    const lying = createHomeStore({db:box.db,hubMachineId:HUB,localMachineId:HUB});
    await expect(lying.initialize(SESSION,HUB)).rejects.toThrow(/identity/i);
    await expect(lying.compareAndSwap(current,next(current))).rejects.toThrow(/identity/i);
    expect(await box.homes.list()).toEqual([current]);
  });

  it("CAS includes epoch state destination and move ID", async () => {
    const { homes } = fixture();
    const running = await homes.initialize(SESSION, HUB);
    expect(running.epoch).toBe(1);
    const moving = next(running);
    expect(await homes.compareAndSwap(running,moving)).toEqual({kind:"applied",home:moving});
    const final: RunningHome = {...moving,machineId:BOX,epoch:3,state:"running",destination:null,updatedAt:124};
    for (const stale of [
      {...moving,epoch:1}, {...moving,machineId:OTHER},
      {...moving,state:"running" as const,destination:null},
      {...moving,destination:OTHER}, {...moving,moveId:MOVE2},
      {...moving,updatedAt:122},
    ]) {
      const desired = {...final,epoch:stale.epoch+1};
      expect(await homes.compareAndSwap(stale,desired)).toEqual({kind:"conflict",home:moving});
      expect(await homes.read(SESSION)).toEqual(moving);
    }
    expect(await homes.compareAndSwap(moving,final)).toEqual({kind:"applied",home:final});
    expect(await homes.compareAndSwap(moving,final)).toEqual({kind:"already-applied",home:final});
    expect((await homes.read(SESSION))?.epoch).toBe(3);
  });

  it("initialize preserves an ordinary legacy owner", async () => {
    const { db, homes } = fixture();
    db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES (?, ?, 7, NULL, 91)").run(SESSION,BOX);
    expect(await homes.read(SESSION)).toBeNull(); expect(await homes.list()).toEqual([]);
    await expect(homes.initialize(SESSION,OTHER)).rejects.toThrow(/owner/i);
    expect(db.prepare("SELECT * FROM session_homes").get()).toEqual({session_id:SESSION,machine_id:BOX,epoch:7,move_id:null,updated_at:91,state:null,destination:null});
    const adopted = await homes.initialize(SESSION,BOX);
    expect(adopted).toMatchObject({sessionId:SESSION,machineId:BOX,epoch:7,moveId:null,state:"running",destination:null});
    expect(await homes.initialize(SESSION,BOX)).toEqual(adopted);
    db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES ('unfinished', ?, 8, 'old-move', 12)").run(BOX);
    await expect(homes.initialize("unfinished" as SessionId,BOX)).rejects.toThrow(/legacy.*move/i);
    expect(db.prepare("SELECT state,epoch,move_id FROM session_homes WHERE session_id='unfinished'").get()).toEqual({state:null,epoch:8,move_id:"old-move"});
  });

  it("invalid identities and epoch overflow cannot write", async () => {
    const {db,homes} = fixture();
    await expect(homes.initialize("" as SessionId,HUB)).rejects.toThrow();
    await expect(homes.initialize(SESSION,"invalid" as MachineId)).rejects.toThrow();
    const current = await homes.initialize(SESSION,HUB);
    for (const invalid of [
      {...next(current),epoch:0}, {...next(current),epoch:2.5},
      {...next(current),epoch:Number.MAX_SAFE_INTEGER+1},
      {...next(current),epoch:3}, {...next(current),moveId:"bad" as RelocateId},
      {...next(current),destination:"bad" as MachineId},
      {...next(current),sessionId:"another" as SessionId},
    ]) { await expect(homes.compareAndSwap(current,invalid)).rejects.toThrow(); expect(await homes.read(SESSION)).toEqual(current); }
    db.prepare("UPDATE session_homes SET epoch=?").run(Number.MAX_SAFE_INTEGER);
    const maximum = (await homes.read(SESSION)) as RunningHome;
    await expect(homes.compareAndSwap(maximum,{...next(maximum),epoch:Number.MAX_SAFE_INTEGER+1})).rejects.toThrow();
    expect((await homes.read(SESSION))?.epoch).toBe(Number.MAX_SAFE_INTEGER);
    db.exec("UPDATE session_homes SET state='moving', destination=NULL");
    await expect(homes.read(SESSION)).rejects.toThrow();
    await expect(homes.list()).rejects.toThrow();
  });
});
