import { mkdirSync } from "node:fs";
import { paths } from "@spider/db-core";

export const EMBED_MODEL = "BGE-small-en-v1.5";
export const EMBED_DIM = 384;

export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

interface EmbedderConfig {
  provider?: string;
  model?: string;
  modelsDir?: string;
}

// v1 describes this slot's shape and Embedder API. Incompatible future versions
// must use a new key. The fixed model is shared even across rebuilt bundle URLs.
const embedderKey = Symbol.for("spider.embedder.v1:" + EMBED_MODEL);
interface EmbedderSlot { promise: Promise<Embedder | null>; embedder?: Embedder; retryAt?: number; }
const UNAVAILABLE_COOLDOWN_MS = 10 * 60 * 1000;
const processCache = globalThis as typeof globalThis & { [key: symbol]: EmbedderSlot | undefined };

export function isEmbedderLoaded(): boolean {
  return processCache[embedderKey]?.embedder !== undefined;
}

export function resolveEmbedder(cfg?: EmbedderConfig, now: () => number = Date.now): Promise<Embedder | null> {
  const existing = processCache[embedderKey];
  if (existing && (existing.retryAt === undefined || now() < existing.retryAt)) return existing.promise;
  const slot: EmbedderSlot = { promise: Promise.resolve().then(() => initializeEmbedder(cfg)).then(embedder => {
    if (embedder) slot.embedder = embedder;
    else slot.retryAt = now() + UNAVAILABLE_COOLDOWN_MS;
    return embedder;
  }, error => {
    // Rejections retry on the next call; unavailable providers use the cooldown.
    if (processCache[embedderKey] === slot) delete processCache[embedderKey];
    throw error;
  }) };
  processCache[embedderKey] = slot;
  return slot.promise;
}

async function initializeEmbedder(cfg?: EmbedderConfig): Promise<Embedder | null> {
  const modelsDir = cfg?.modelsDir ?? paths.models;

  // PROVIDER 1: fastembed (onnxruntime, native — preferred).
  try {
    mkdirSync(modelsDir, { recursive: true });
    const { FlagEmbedding, EmbeddingModel } = await import("fastembed");
    const fe = await FlagEmbedding.init({
      model: EmbeddingModel.BGESmallENV15,
      cacheDir: modelsDir,
    });
    return {
      model: EMBED_MODEL,
      dim: EMBED_DIM,
      async embed(texts: string[]): Promise<Float32Array[]> {
        const out: Float32Array[] = [];
        for await (const batch of fe.embed(texts)) {
          for (const vec of batch) {
            out.push(Float32Array.from(vec as ArrayLike<number>));
          }
        }
        return out;
      },
    };
  } catch {
    // fall through to next provider
  }

  // PROVIDER 2: transformers.js (WASM).
  // @huggingface/transformers is an OPTIONAL runtime fallback (optionalDependencies);
  // absent → degrade to next provider / FTS-only. This was @xenova/transformers, which is
  // deprecated and pinned onnxruntime-web@1.14 → onnx-proto → protobufjs@6 (critical RCE)
  // plus sharp@0.32 (libvips CVEs). The successor package keeps the same pipeline() API.
  try {
    const spec = "@huggingface/transformers";
    const t: any = await import(spec); // variable specifier → tsc will NOT error if the pkg is absent
    const pipe = await t.pipeline("feature-extraction", "Xenova/bge-small-en-v1.5");
    return {
      model: EMBED_MODEL,
      dim: EMBED_DIM,
      async embed(texts: string[]): Promise<Float32Array[]> {
        const out: Float32Array[] = [];
        for (const text of texts) {
          const r = await pipe(text, { pooling: "mean", normalize: true });
          out.push(Float32Array.from(r.data as Iterable<number>));
        }
        return out;
      },
    };
  } catch {
    // fall through to FTS-only degrade
  }

  return null;
}
