import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
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
const EMBEDDER_WAIT_MS = 5000;
const EXTRACTION_GRACE_MS = 2 * 60 * 1000;
// Recovery is process-wide too, including across bundle reloads and retries.
const quarantineKey = Symbol.for("spider.embedder.quarantine.v1:" + EMBED_MODEL);
const recoveryCache = globalThis as typeof globalThis & { [key: symbol]: boolean | undefined };
const processCache = globalThis as typeof globalThis & { [key: symbol]: EmbedderSlot | undefined };

export function isEmbedderLoaded(): boolean {
  return processCache[embedderKey]?.embedder !== undefined;
}

/** Hot paths never wait for setup. The shared initialization continues in the background. */
export function getReadyEmbedder(cfg?: EmbedderConfig): Embedder | null {
  const ready = processCache[embedderKey]?.embedder;
  if (ready) return ready;
  void resolveEmbedder(cfg).catch(() => { /* Retryable initialization failure; use FTS for this call. */ });
  return null;
}

/** A timed-out caller does not cancel or replace the process-wide initialization. */
export async function waitForEmbedder(
  getEmbedder: () => Promise<Embedder | null> = resolveEmbedder,
): Promise<Embedder | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(getEmbedder),
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), EMBEDDER_WAIT_MS);
        timer.unref?.();
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

function quarantineBrokenModel(modelDir: string): void {
  // Defensive when a rename fails before a persistent broken marker is created.
  if (recoveryCache[quarantineKey]) return;
  try {
    // Both lexical and physical containment are required. Never move a symlink
    // or a directory reached through one that escapes spider's models root.
    const root = resolve(paths.models);
    if (!isWithin(root, resolve(modelDir)) || lstatSync(root).isSymbolicLink()
      || lstatSync(modelDir).isSymbolicLink() || !lstatSync(modelDir).isDirectory()
      || !isWithin(realpathSync(root), realpathSync(modelDir))) return;
    // A previous process's marker keeps recovery bounded until the user clears it.
    if (readdirSync(root).some(name => name.startsWith(`${basename(modelDir)}.broken-`))) return;
    // fastembed reuses an existing archive, including an interrupted download.
    // Validate both candidates before moving either. Never follow an archive symlink.
    const archive = `${modelDir}.tar.gz`;
    const archiveStat = lstatSync(archive, { throwIfNoEntry: false });
    if (archiveStat && (!isWithin(root, resolve(archive)) || archiveStat.isSymbolicLink()
      || !archiveStat.isFile() || !isWithin(realpathSync(root), realpathSync(archive)))) return;
    const now = Date.now();
    const newest = Math.max(lstatSync(modelDir).mtimeMs, archiveStat?.mtimeMs ?? 0,
      ...readdirSync(modelDir).map(name => lstatSync(join(modelDir, name)).mtimeMs));
    if (now - newest < EXTRACTION_GRACE_MS) return;
    const suffix = `.broken-${now}`;
    // Defensive collision check, including orphaned archive markers.
    if (existsSync(modelDir + suffix) || existsSync(archive + suffix)) return;
    recoveryCache[quarantineKey] = true;
    renameSync(modelDir, modelDir + suffix);
    if (archiveStat) renameSync(archive, archive + suffix);
  } catch {
    // Recovery is best-effort. Do not repeatedly attempt a failing rename.
  }
}

function isModelLoadError(error: unknown, modelDir: string, existed: boolean): boolean {
  if (!(error instanceof Error)) return false;
  // fastembed's init mixes retrieval and loading, with no structured stage
  // errors. Network/extraction failures must never quarantine the cache.
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === "string" && /^(E[A-Z0-9]+|Z_[A-Z_]+|TAR_[A-Z_]+|ERR_[A-Z0-9_]+)$/.test(code)) return false;
  if (/network|https?:|download|extract|\btar\b|socket|connection/i.test(error.message)) return false;
  // An existing directory skips retrieval in fastembed. For a newly extracted
  // directory, accept only recognizable tokenizer/config/model load failures.
  return existed || error instanceof SyntaxError
    || (/^(Tokenizer|Config|Tokens map|Model) file not found at /.test(error.message) && error.message.includes(modelDir + sep))
    || (error.message.includes(`Load model from ${modelDir + sep}`) && error.message.includes("failed"));
}

async function initializeEmbedder(cfg?: EmbedderConfig): Promise<Embedder | null> {
  const modelsDir = cfg?.modelsDir ?? paths.models;

  // PROVIDER 1: fastembed (onnxruntime, native — preferred).
  try {
    mkdirSync(modelsDir, { recursive: true });
    const { FlagEmbedding, EmbeddingModel } = await import("fastembed");
    const modelDir = join(modelsDir, EmbeddingModel.BGESmallENV15);
    const existed = existsSync(modelDir);
    let fe: Awaited<ReturnType<typeof FlagEmbedding.init>>;
    try {
      fe = await FlagEmbedding.init({
        model: EmbeddingModel.BGESmallENV15,
        cacheDir: modelsDir,
        showDownloadProgress: false,
      });
    } catch (error) {
      if (isModelLoadError(error, modelDir, existed)) quarantineBrokenModel(modelDir);
      throw error;
    }
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
