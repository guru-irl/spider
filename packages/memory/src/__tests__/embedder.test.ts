import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { resolveEmbedder, isEmbedderLoaded, EMBED_DIM, getReadyEmbedder, waitForEmbedder } from "../embeddings/embedder";
import { paths } from "@spider/db-core";
import { existsSync, lutimesSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Mock only optional model providers. Cache ownership, resolution, and vector
// conversion run as shipped. Never download a model or run real inference.
const provider = vi.hoisted(() => ({
  inits: 0, fail: false, error: undefined as Error | undefined,
  pending: undefined as Promise<void> | undefined,
  onInit: undefined as ((options: { cacheDir: string; showDownloadProgress?: boolean }) => void) | undefined,
}));
vi.mock("fastembed", () => ({
  EmbeddingModel: { BGESmallENV15: "fast-bge-small-en-v1.5" },
  FlagEmbedding: { init: async (options: { cacheDir: string; showDownloadProgress?: boolean }) => {
    provider.inits++;
    provider.onInit?.(options);
    await provider.pending;
    if (provider.error) throw provider.error;
    if (provider.fail) throw new Error("fixture initialization rejected");
    return { async *embed(texts: string[]) { yield texts.map(() => new Float32Array(384)); } };
  } },
}));
vi.mock("@huggingface/transformers", () => ({ pipeline: async () => { throw new Error("fixture fallback unavailable"); } }));
const globalCache = globalThis as typeof globalThis & Record<symbol, unknown>;
const key = Symbol.for("spider.embedder.v1:BGE-small-en-v1.5");
const quarantineKey = Symbol.for("spider.embedder.quarantine.v1:BGE-small-en-v1.5");
beforeEach(() => {
  delete globalCache[key]; delete globalCache[quarantineKey];
  provider.inits = 0; provider.fail = false; provider.error = undefined; provider.pending = undefined; provider.onInit = undefined;
});
afterEach(() => {
  delete globalCache[key]; delete globalCache[quarantineKey]; vi.resetModules(); vi.restoreAllMocks(); vi.useRealTimers();
  rmSync(paths.models, { recursive: true, force: true });
  rmSync(join(paths.globalRoot, "outside-models"), { recursive: true, force: true });
});

const modelName = "fast-bge-small-en-v1.5";
function age(path: string): void {
  const old = new Date(Date.now() - 5 * 60 * 1000);
  utimesSync(path, old, old);
}
function oldModel(base = paths.models): string {
  const dir = join(base, modelName);
  mkdirSync(dir, { recursive: true });
  age(dir);
  return dir;
}
function brokenEntries(base = paths.models): string[] {
  return readdirSync(base).filter(name => name.includes(".broken-"));
}

describe("embedder", () => {
  it("starts initialization once without waiting and exposes the ready instance synchronously", async () => {
    let ready!: () => void;
    provider.pending = new Promise(resolve => { ready = resolve; });
    expect(getReadyEmbedder()).toBeNull();
    expect(getReadyEmbedder()).toBeNull();
    const pending = resolveEmbedder();
    ready();
    const embedder = await pending;
    expect(embedder).not.toBeNull();
    expect(getReadyEmbedder()).toBe(embedder);
    expect(provider.inits).toBe(1);
  });

  it("bounds a pending provider wait without cancelling initialization", async () => {
    vi.useFakeTimers();
    let ready!: () => void;
    provider.pending = new Promise(resolve => { ready = resolve; });
    const pending = resolveEmbedder();
    let result: unknown = "pending";
    const bounded = waitForEmbedder(() => pending).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(result).toBeNull();
    await bounded;
    ready();
    const embedder = await pending;
    expect(getReadyEmbedder()).toBe(embedder);
    expect(provider.inits).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats a rejected provider wait as unavailable and clears its timer", async () => {
    vi.useFakeTimers();
    expect(await waitForEmbedder(() => Promise.reject(new Error("fixture unavailable")))).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("quarantines a broken model under the fixture models path only once and retries", async () => {
    const dir = join(paths.models, "fast-bge-small-en-v1.5");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tokenizer.json"), "broken fixture");
    age(join(dir, "tokenizer.json")); age(dir);
    provider.error = new Error(`Tokenizer file not found at ${join(dir, "tokenizer_config.json")}`);
    let time = 0;
    expect(await resolveEmbedder(undefined, () => time)).toBeNull();
    expect(existsSync(dir)).toBe(false);
    const quarantined = readdirSync(paths.models).filter(name => name.startsWith("fast-bge-small-en-v1.5.broken-"));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(paths.models, quarantined[0], "tokenizer.json"), "utf8")).toBe("broken fixture");
    // The next attempt can download again, but a second failure cannot loop.
    mkdirSync(dir); age(dir);
    time += 10 * 60 * 1000;
    expect(await resolveEmbedder(undefined, () => time)).toBeNull();
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(paths.models).filter(name => name.includes(".broken-"))).toHaveLength(1);
    provider.error = undefined;
    time += 10 * 60 * 1000;
    expect(await resolveEmbedder(undefined, () => time)).not.toBeNull();
  });

  it.each(["network", "outside", "symlink", "symlink-root", "outside-alias", "escaping-parent"])("leaves a %s cache untouched", async kind => {
    // Lexical, realpath and lstat checks each need a realistic independent case.
    mkdirSync(paths.models, { recursive: true });
    const outside = join(paths.globalRoot, "outside-models");
    let base = kind === "outside" ? outside : paths.models;
    if (kind === "symlink-root") {
      rmSync(paths.models, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, paths.models, "dir");
    } else if (kind === "outside-alias") {
      symlinkSync(paths.models, outside, "dir");
      base = outside; // Lexically outside, physically inside the models root.
    } else if (kind === "escaping-parent") {
      mkdirSync(outside, { recursive: true });
      base = join(paths.models, "alias");
      symlinkSync(outside, base, "dir"); // Lexically inside, physically outside.
    }
    const dir = oldModel(base);
    if (kind === "symlink") {
      rmSync(dir, { recursive: true });
      const target = join(paths.models, "link-target");
      mkdirSync(target); age(target);
      symlinkSync(target, dir, "dir"); // Both containment checks pass; lstat must refuse it.
      const old = new Date(Date.now() - 5 * 60 * 1000);
      lutimesSync(dir, old, old); // Age the link itself so the grace guard cannot mask lstat.
    }
    provider.error = kind === "network" ? new Error("network connection reset") : new Error(`Model file not found at ${join(dir, "model_optimized.onnx")}`);
    expect(await resolveEmbedder({ modelsDir: base })).toBeNull();
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(base).some(name => name.includes(".broken-"))).toBe(false);
  });

  it("renames a truncated archive alongside the partial model so the next attempt retrieves afresh", async () => {
    const dir = oldModel();
    writeFileSync(`${dir}.tar.gz`, "truncated fixture archive");
    age(`${dir}.tar.gz`);
    provider.error = new Error("Protobuf parsing failed");
    let time = 0;
    expect(await resolveEmbedder(undefined, () => time)).toBeNull();
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(`${dir}.tar.gz`)).toBe(false);
    const broken = brokenEntries();
    expect(broken).toHaveLength(2);
    const model = broken.find(name => name.startsWith(`${modelName}.broken-`))!;
    const archive = broken.find(name => name.startsWith(`${modelName}.tar.gz.broken-`))!;
    expect(archive.split(".broken-")[1]).toBe(model.split(".broken-")[1]);
    expect(readFileSync(join(paths.models, archive), "utf8")).toBe("truncated fixture archive");
    let downloads = 0;
    provider.error = undefined;
    provider.onInit = () => {
      if (!existsSync(dir) && !existsSync(`${dir}.tar.gz`)) {
        downloads++;
        mkdirSync(dir); writeFileSync(join(dir, "model_optimized.onnx"), "new fixture model");
      }
    };
    time += 10 * 60 * 1000;
    expect(await resolveEmbedder(undefined, () => time)).not.toBeNull();
    expect(downloads).toBe(1);
    expect(readFileSync(join(dir, "model_optimized.onnx"), "utf8")).toBe("new fixture model");
  });

  it("does not quarantine again when another process already left a broken sibling", async () => {
    const dir = oldModel();
    mkdirSync(`${dir}.broken-previous-process`);
    writeFileSync(`${dir}.tar.gz`, "fixture archive");
    provider.error = new Error("Protobuf parsing failed");
    expect(await resolveEmbedder()).toBeNull();
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(`${dir}.tar.gz`)).toBe(true);
    expect(brokenEntries()).toEqual([`${modelName}.broken-previous-process`]);
  });

  it.each([
    { fresh: true, message: "zlib: unexpected end of file", code: "Z_BUF_ERROR", quarantine: false },
    { fresh: true, message: "missing-model", code: undefined, quarantine: true },
    { fresh: false, message: "Protobuf parsing failed", code: undefined, quarantine: true },
    { fresh: false, message: "x", code: "ECONNRESET", quarantine: false },
    { fresh: true, message: "opaque failure", code: undefined, quarantine: false },
  ])("classifies load failures safely: %j", async ({ fresh, message, code, quarantine }) => {
    const dir = join(paths.models, modelName);
    if (fresh) provider.onInit = () => { oldModel(); };
    else oldModel();
    const text = message === "missing-model" ? `Model file not found at ${join(dir, "model_optimized.onnx")}` : message;
    provider.error = Object.assign(new Error(text), code ? { code } : {});
    expect(await resolveEmbedder()).toBeNull();
    expect(existsSync(dir)).toBe(!quarantine);
    expect(brokenEntries()).toHaveLength(quarantine ? 1 : 0);
  });

  it("quarantines an existing model for a corrupt tokenizer GenericFailure", async () => {
    const dir = oldModel();
    provider.error = Object.assign(new Error("Error loading from fileEOF while parsing a string"), { code: "GenericFailure" });
    expect(await resolveEmbedder()).toBeNull();
    expect(existsSync(dir)).toBe(false);
    expect(brokenEntries()).toHaveLength(1);
  });

  it.each(["EMFILE", "ENOMEM", "EBUSY", "EIO", "Z_BUF_ERROR", "TAR_BAD_ARCHIVE", "ERR_STREAM_PREMATURE_CLOSE"])("does not quarantine an existing model for environmental %s errors", async code => {
    const dir = oldModel();
    provider.error = Object.assign(new Error("x"), { code });
    expect(await resolveEmbedder()).toBeNull();
    expect(existsSync(dir)).toBe(true);
    expect(brokenEntries()).toEqual([]);
  });

  it.each(["directory", "entry"])("does not quarantine a cache with a recently modified %s", async recent => {
    const dir = oldModel();
    if (recent === "directory") utimesSync(dir, new Date(), new Date());
    else {
      writeFileSync(join(dir, "model_optimized.onnx"), "extraction in progress");
      age(dir); // File writes need not update the directory's mtime.
    }
    provider.error = new Error("Protobuf parsing failed");
    expect(await resolveEmbedder()).toBeNull();
    expect(existsSync(dir)).toBe(true);
    expect(brokenEntries()).toEqual([]);
  });

  it("leaves an aged model and a recently written archive untouched", async () => {
    const dir = oldModel();
    const archive = `${dir}.tar.gz`;
    writeFileSync(archive, "download in progress");
    provider.error = new Error("Protobuf parsing failed");
    expect(await resolveEmbedder()).toBeNull();
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(archive)).toBe(true);
    expect(readFileSync(archive, "utf8")).toBe("download in progress");
    expect(brokenEntries()).toEqual([]);
  });

  it.each(["symlink", "directory"])("leaves an unsafe %s archive and model untouched", async kind => {
    const dir = oldModel();
    const archive = `${dir}.tar.gz`;
    if (kind === "symlink") {
      const outside = join(paths.globalRoot, "outside-models");
      mkdirSync(outside); writeFileSync(join(outside, "archive"), "outside fixture");
      symlinkSync(join(outside, "archive"), archive);
    } else mkdirSync(archive);
    provider.error = new Error("Protobuf parsing failed");
    expect(await resolveEmbedder()).toBeNull();
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(archive)).toBe(true);
    expect(brokenEntries()).toEqual([]);
  });

  it("disables background provider download progress", async () => {
    provider.onInit = options => {
      if (options.showDownloadProgress !== false) throw new Error("background progress would write to stderr");
    };
    expect(await resolveEmbedder()).not.toBeNull();
  });

  it("does not keep a short-lived process alive for a pending bounded wait", async () => {
    const timeout = vi.spyOn(globalThis, "setTimeout");
    let ready!: (embedder: null) => void;
    const bounded = waitForEmbedder(() => new Promise(resolve => { ready = resolve; }));
    const timer = timeout.mock.results[0].value as ReturnType<typeof setTimeout>;
    try { expect(timer.hasRef()).toBe(false); }
    finally { await Promise.resolve(); ready(null); await bounded; }
  });

  it("reports dim=384 and converts provider vectors", async () => {
    const e = await resolveEmbedder();
    expect(e?.dim).toBe(EMBED_DIM);
    const vectors = await e!.embed(["hello world"]);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(vectors[0].length).toBe(384);
  });

  it("shares one initialization across concurrent calls from two module instances", async () => {
    vi.resetModules();
    const secondModule = await import("../embeddings/embedder");
    // No await between calls: all three must share the still-pending slot.
    const first = resolveEmbedder();
    const second = secondModule.resolveEmbedder();
    const third = resolveEmbedder();
    expect(second).toBe(first);
    expect(third).toBe(first);
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(provider.inits).toBe(1);
    expect(globalCache[key]).toBeDefined();
  });

  it("an initialization rejection does not poison the process-wide promise", async () => {
    const failure = new Error("fixture config rejected");
    const pending = resolveEmbedder({ get modelsDir(): string { throw failure; } });
    await expect(pending).rejects.toBe(failure);
    expect(globalCache[key]).toBeUndefined();
    expect(await resolveEmbedder()).not.toBeNull();
    expect(provider.inits).toBe(1);
  });

  it("shares an unavailable result for ten minutes across module instances, then retries", async () => {
    vi.resetModules();
    const secondModule = await import("../embeddings/embedder");
    let time = 1000;
    const now = () => time;
    provider.fail = true;
    const first = resolveEmbedder(undefined, now);
    expect(await first).toBeNull();
    expect(isEmbedderLoaded()).toBe(false);
    expect(provider.inits).toBe(1);
    provider.fail = false;
    time = 1000 + 9 * 60 * 1000;
    expect(secondModule.resolveEmbedder(undefined, now)).toBe(first);
    expect(await resolveEmbedder(undefined, now)).toBeNull();
    time = 1000 + 10 * 60 * 1000 - 1;
    expect(await secondModule.resolveEmbedder(undefined, now)).toBeNull();
    expect(provider.inits).toBe(1);
    time++;
    expect(await secondModule.resolveEmbedder(undefined, now)).not.toBeNull();
    expect(isEmbedderLoaded()).toBe(true);
    expect(provider.inits).toBe(2);
  });
});
