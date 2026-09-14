import { mkdirSync } from "node:fs";
import { paths } from "@spider/db-core";

export const EMBED_MODEL = "BGE-small-en-v1.5";
export const EMBED_DIM = 384;

export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export async function resolveEmbedder(cfg?: {
  provider?: string;
  model?: string;
  modelsDir?: string;
}): Promise<Embedder | null> {
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
