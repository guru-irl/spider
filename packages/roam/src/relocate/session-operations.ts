import type { MovingHome, RelocateHome, SessionId } from "./types";

export interface MoveTurn {
  readonly source: RelocateHome | null;
  readonly moving: MovingHome | null;
  readonly result: Promise<RelocateHome | null>;
}

export interface SessionOperations {
  enqueue<T>(id: SessionId, run: () => Promise<T>): Promise<T>;
  relocate<T>(id: SessionId, run: (mark: (home: RelocateHome) => void) => Promise<T>,
    read: () => Promise<RelocateHome | null>): Promise<T>;
  activeMove(id: SessionId): MoveTurn | null;
}

/** In-memory hub admission order. Mutation bodies still take the session process lock. */
export function createSessionOperations(): SessionOperations {
  const tails = new Map<SessionId, Promise<void>>();
  const moves = new Map<SessionId, MoveTurn>();

  function enqueue<T>(id: SessionId, run: () => Promise<T>): Promise<T> {
    const done = (tails.get(id) ?? Promise.resolve()).then(run).finally(() => {
      if (tails.get(id) === tail) tails.delete(id);
    });
    const tail = done.then(() => {}, () => {});
    tails.set(id, tail);
    return done;
  }

  return {
    enqueue,
    relocate(id, run, read) {
      return enqueue(id, async () => {
        let settle!: (home: RelocateHome | null) => void;
        const move = { source: null as RelocateHome | null, moving: null as MovingHome | null,
          result: new Promise<RelocateHome | null>(resolve => { settle = resolve; }) };
        moves.set(id, move);
        try {
          return await run(home => {
            if (home.state === "moving") move.moving = home;
            else move.source ??= home;
          });
        } finally {
          // Read before releasing the turn. A later force must not become this move's result.
          try { settle(await read()); }
          catch { settle(null); } // No verified result means no permission to follow the move.
          finally { moves.delete(id); }
        }
      });
    },
    activeMove: id => moves.get(id) ?? null,
  };
}
