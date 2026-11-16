export interface PausableProducer {
  pause(): void | Promise<void>;
  resume(): void | Promise<void>;
}

/** Each activation supplies its own producers; no process-global gate is shared. */
export function createProducerDrain(input: {
  usage: PausableProducer;
  embeddings: PausableProducer;
  organism: PausableProducer;
  others: readonly PausableProducer[];
}): { drain(): Promise<void>; resume(): Promise<void> } {
  const producers = [input.usage, input.embeddings, input.organism, ...input.others];
  if (producers.some(producer => !producer || typeof producer.pause !== "function" || typeof producer.resume !== "function")) {
    throw new Error("Producer evidence is unavailable");
  }
  async function drain(): Promise<void> {
    // A rejection must not let another producer keep writing after we return.
    const results = await Promise.allSettled(producers.map(async producer => producer.pause()));
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, `Producer drain failed: ${errors.map(String).join("; ")}`);
  }
  async function resume(): Promise<void> {
    try {
      for (const producer of producers) await producer.resume();
    } catch (error) {
      try { await drain(); }
      catch (drainError) { throw new AggregateError([error, drainError], `Producer resume and drain failed: ${String(error)}; ${String(drainError)}`); }
      throw error;
    }
  }
  return { drain, resume };
}
